# frozen_string_literal: true

require "json"
require "socket"
require "opentelemetry/sdk"
require_relative "../errors"
require_relative "../spec"
require_relative "env"
require_relative "identity"

module Libo11y
  module Internal
    module ResourceBuilder
      UNKNOWN_VERSION = "0.0.0-unknown"
      CGROUP_ID_RE = /\b([0-9a-f]{64})\b/i

      Result = Data.define(:resource, :attributes, :service_name, :environment, :service_version, :instance_id, :version_fallback)

      module_function

      def detect_container_id
        return nil unless File.readable?("/proc/self/cgroup")

        File.foreach("/proc/self/cgroup") do |line|
          m = CGROUP_ID_RE.match(line)
          return m[1].downcase if m
        end
        nil
      rescue StandardError
        nil
      end

      def load_build_info(opt)
        return {} if opt.nil?
        return opt.transform_keys(&:to_s) if opt.is_a?(Hash)

        if opt.is_a?(String) && File.file?(opt)
          JSON.parse(File.read(opt))
        else
          {}
        end
      rescue StandardError
        {}
      end

      # Composes, validates and classifies the resource. Precedence, lowest to
      # highest: what libo11y detects and the build info, then the
      # environment (OTEL_RESOURCE_ATTRIBUTES, then OTEL_SERVICE_NAME), then
      # the resource_attributes option, then the named options. A blank
      # option sets nothing.
      def build(options, env_map, policy, recorder)
        build_info = options.build_info_enabled ? load_build_info(options.build_info) : {}
        attrs = detected_attributes(build_info)

        attrs.merge!(Env.parse_resource_attributes(env_map["OTEL_RESOURCE_ATTRIBUTES"]))
        env_name = Env.value(env_map, "OTEL_SERVICE_NAME")
        attrs["service.name"] = env_name if env_name

        attrs.merge!((options.resource_attributes || {}).transform_keys(&:to_s))
        {
          "service.name" => options.service_name,
          "service.namespace" => options.service_namespace,
          "deployment.environment.name" => options.environment,
          "service.version" => options.version,
          "service.instance.id" => options.service_instance_id
        }.each do |key, option|
          text = option.to_s.strip
          attrs[key] = text unless text.empty?
        end
        attrs["service.version"] ||= build_info["version"] || build_info["service.version"]

        enforce_identity(attrs, options, recorder)

        version_fallback = attrs["service.version"].to_s.strip.empty?
        attrs["service.version"] = UNKNOWN_VERSION if version_fallback
        if attrs["service.instance.id"].to_s.strip.empty?
          attrs["service.instance.id"] = Identity.derive_instance_id(
            pod_uid: attrs["k8s.pod.uid"].to_s, pod_name: attrs["k8s.pod.name"].to_s, namespace: attrs["k8s.namespace.name"].to_s
          ) || Identity.random_instance_id
        end
        attrs.delete("deployment.environment.name") if attrs["deployment.environment.name"].to_s.strip.empty?

        service_name = attrs["service.name"]
        environment = attrs["deployment.environment.name"].to_s
        version = attrs["service.version"]
        instance_id = attrs["service.instance.id"]

        # Classify the entire resource through the sensitivity policy once at construction
        classified, = policy.classify_flat(Spec::Signal::RESOURCE, attrs)

        # Keep only valid OTel attribute values
        sanitized = {}
        classified.each do |k, v|
          sanitized[k.to_s] = normalize_otel_value(v) unless v.nil?
        end

        sanitized_frozen = sanitized.freeze
        otel_res = OpenTelemetry::SDK::Resources::Resource.create(sanitized_frozen)
        schema_url = Spec::SCHEMA_URL
        otel_res.define_singleton_method(:schema_url) { schema_url }
        otel_res.define_singleton_method(:attributes) { sanitized_frozen }

        Result.new(
          resource: otel_res,
          attributes: sanitized_frozen,
          service_name: service_name,
          environment: environment,
          service_version: version,
          instance_id: instance_id,
          version_fallback: version_fallback
        )
      end

      def detected_attributes(build_info)
        attrs = {
          "telemetry.sdk.name" => "opentelemetry",
          "telemetry.sdk.language" => "ruby",
          "telemetry.sdk.version" => OpenTelemetry::SDK::VERSION,
          "telemetry.distro.name" => "libo11y",
          "telemetry.distro.version" => Libo11y::VERSION,
          "process.runtime.name" => RUBY_ENGINE,
          "process.runtime.version" => RUBY_VERSION,
          "process.runtime.description" => RUBY_DESCRIPTION
        }
        hostname = host_name
        attrs["host.name"] = hostname if hostname
        cid = detect_container_id
        attrs["container.id"] = cid if cid
        attrs["vcs.ref.head.revision"] = build_info["vcs_revision"].to_s if build_info["vcs_revision"]
        attrs[Spec::ATTR_BUILD_TIME] = build_info["build_time"].to_s if build_info["build_time"]
        attrs[Spec::ATTR_BUILD_MODIFIED] = build_info["build_modified"] unless build_info["build_modified"].nil?
        attrs
      end

      def host_name
        name = Socket.gethostname
        name.nil? || name.empty? ? nil : name
      rescue StandardError
        nil
      end

      # Applies the tier-0 identity contract. Under strict identity a
      # violation raises. Otherwise each one is counted on
      # o11y.schema.violations.
      def enforce_identity(attrs, options, recorder)
        name = attrs["service.name"].to_s.strip
        if name.empty? || name == "unknown_service" || name.start_with?("unknown_service:")
          raise NoServiceName if options.strict_identity

          recorder&.record(Spec::Signal::RESOURCE, "identity_service_name")
          attrs["service.name"] = "unknown_service" if name.empty?
        else
          attrs["service.name"] = name
        end

        environment = attrs["deployment.environment.name"].to_s.strip
        allowed = Spec::ENVIRONMENT_VALUES.to_a.map(&:to_s) | Array(options.extra_environments).map(&:to_s)
        if environment.empty?
          raise NoEnvironment if options.strict_identity

          recorder&.record(Spec::Signal::RESOURCE, "identity_environment")
        elsif !allowed.include?(environment)
          if options.strict_identity
            raise InvalidEnvironment,
                  "o11y: deployment environment not in the allowed set: #{Spec::GoQuote.quote(environment)} (allowed: #{allowed.sort.join(", ")})"
          end

          recorder&.record(Spec::Signal::RESOURCE, "identity_environment_invalid")
        end
        attrs["deployment.environment.name"] = environment
      end

      def normalize_otel_value(v)
        case v
        when String, Integer, Float, TrueClass, FalseClass then v
        when Array then v.map(&:to_s)
        else v.to_s
        end
      end
    end
  end
end
