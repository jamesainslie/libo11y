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

      Result = Data.define(:resource, :attributes, :service_name, :environment, :service_version, :instance_id)

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

      def build(options, env_map, policy, recorder)
        env_res = Env.parse_resource_attributes(env_map["OTEL_RESOURCE_ATTRIBUTES"])
        opt_res = (options.resource_attributes || {}).transform_keys(&:to_s)
        build_info = options.build_info_enabled ? load_build_info(options.build_info) : {}

        # Service name precedence: option > OTEL_SERVICE_NAME > OTEL_RESOURCE_ATTRIBUTES > resource_attributes
        service_name = options.service_name ||
                       env_map["OTEL_SERVICE_NAME"] ||
                       env_res["service.name"] ||
                       opt_res["service.name"]
        service_name = service_name.to_s.strip

        if service_name.empty? || service_name == "unknown_service" || service_name.start_with?("unknown_service:")
          raise NoServiceName if options.strict_identity

          recorder&.record(Spec::Signal::RESOURCE, "identity_service_name")
          service_name = "unknown_service" if service_name.empty?

        end

        # Environment precedence: option > OTEL_RESOURCE_ATTRIBUTES > resource_attributes
        environment = options.environment ||
                      env_res["deployment.environment.name"] ||
                      opt_res["deployment.environment.name"]
        environment = environment.to_s.strip

        allowed_envs = Spec::ENVIRONMENT_VALUES.dup
        Array(options.extra_environments).each { |e| allowed_envs.add(e.to_s) }

        if environment.empty?
          raise NoEnvironment if options.strict_identity

          recorder&.record(Spec::Signal::RESOURCE, "identity_environment")

        elsif !allowed_envs.include?(environment)
          raise InvalidEnvironment, "o11y: deployment environment #{environment.inspect} not in the allowed set" if options.strict_identity

          recorder&.record(Spec::Signal::RESOURCE, "identity_environment_invalid")

        end

        # Service version
        version = options.version ||
                  opt_res["service.version"] ||
                  env_res["service.version"] ||
                  build_info["version"] ||
                  build_info["service.version"]
        version = version.to_s.strip
        version_fallback = version.empty?
        version = UNKNOWN_VERSION if version_fallback

        # Instance ID
        pod_uid = opt_res["k8s.pod.uid"] || env_res["k8s.pod.uid"] || ""
        pod_name = opt_res["k8s.pod.name"] || env_res["k8s.pod.name"] || ""
        k8s_ns = opt_res["k8s.namespace.name"] || env_res["k8s.namespace.name"] || ""
        instance_id = options.service_instance_id ||
                      opt_res["service.instance.id"] ||
                      env_res["service.instance.id"] ||
                      Identity.derive_instance_id(pod_uid: pod_uid, pod_name: pod_name, namespace: k8s_ns) ||
                      Identity.random_instance_id

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

        begin
          hostname = Socket.gethostname
          attrs["host.name"] = hostname unless hostname.nil? || hostname.empty?
        rescue StandardError
          nil
        end

        cid = detect_container_id
        attrs["container.id"] = cid if cid

        if options.build_info_enabled && !build_info.empty?
          attrs["vcs.ref.head.revision"] = build_info["vcs_revision"].to_s if build_info["vcs_revision"]
          attrs[Spec::ATTR_BUILD_TIME] = build_info["build_time"].to_s if build_info["build_time"]
          attrs[Spec::ATTR_BUILD_MODIFIED] = build_info["build_modified"] unless build_info["build_modified"].nil?
        end

        # Merge env resource attributes, then explicit resource attributes
        attrs.merge!(env_res)
        attrs.merge!(opt_res)

        attrs["service.name"] = service_name
        attrs["service.version"] = version
        attrs["service.instance.id"] = instance_id
        attrs["deployment.environment.name"] = environment unless environment.empty?
        attrs["service.namespace"] = options.service_namespace.to_s if options.service_namespace && !options.service_namespace.to_s.empty?

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
          instance_id: instance_id
        )
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
