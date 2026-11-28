# frozen_string_literal: true

require_relative "../errors"
require_relative "../options"
require_relative "../redact"
require_relative "../spec"
require_relative "pii"

module Libo11y
  module Internal
    class ViolationRecorder
      def initialize
        @mutex = Mutex.new
        @pending = []
        @sink = nil
      end

      def attach(sink)
        pending = nil
        @mutex.synchronize do
          @sink = sink
          pending = @pending
          @pending = []
        end
        pending.each { |sig, rule| sink.call(sig, rule) }
      end

      def record(signal, rule)
        sink = nil
        @mutex.synchronize do
          if @sink.nil?
            @pending << [signal, rule]
            return
          end
          sink = @sink
        end
        sink.call(signal, rule)
      end
    end

    class SensitivityPolicy
      RULE_SECRET = "secret_attribute"
      RULE_PII = "pii_attribute"

      attr_reader :pii_mode

      def self.load_app_registries(spec_sources)
        return {} if spec_sources.nil?

        sources = spec_sources.is_a?(Array) ? spec_sources : [spec_sources]
        by_ns = {}
        classes = {}
        sources.each do |src|
          compiled = case src
                     when Spec::AppRegistry::Compiled
                       src
                     when String
                       if File.file?(src)
                         Spec::AppRegistry.load_file(src)
                       else
                         Spec::AppRegistry.compile(Spec::AppRegistry.parse(src), source: "<inline>")
                       end
                     else
                       raise InvalidAppRegistry, "o11y: invalid application registry source #{src.class}"
                     end
          prev = by_ns[compiled.namespace]
          if prev
            raise InvalidAppRegistry,
                  "o11y: invalid application registry: duplicate namespace #{compiled.namespace.inspect} declared in #{prev} and #{compiled.source}"
          end
          by_ns[compiled.namespace] = compiled.source
          classes.merge!(compiled.classes)
        rescue SystemCallError, Spec::AppRegistry::ParseError, Spec::AppRegistry::ValidationError => e
          raise InvalidAppRegistry, "o11y: invalid application registry: #{e.message}"
        end
        classes
      end

      def initialize(pii_mode: PIIMode::DROP, pii_hash_key: nil, app_classes: nil, recorder: nil)
        mode = pii_mode.is_a?(Symbol) ? pii_mode : pii_mode.to_s.to_sym
        raise Error, "o11y: invalid pii_mode #{pii_mode.inspect}" unless PIIMode::ALL.include?(mode)

        key_bytes = pii_hash_key.nil? ? "".b : pii_hash_key.b
        raise PIIHashKey if mode == PIIMode::HASH && key_bytes.bytesize < PII::MIN_PII_HASH_KEY_LEN

        @pii_mode = mode
        @key = key_bytes
        @app = app_classes ? app_classes.dup.freeze : {}.freeze
        @recorder = recorder
      end

      def silent
        SensitivityPolicy.new(pii_mode: @pii_mode, pii_hash_key: @key, app_classes: @app, recorder: nil)
      end

      def lookup(key)
        Spec::SENSITIVITY_OF[key] || @app[key]
      end

      def action_for(cls)
        return :drop if cls == Spec::Sensitivity::SECRET

        if cls == Spec::Sensitivity::PII
          return :keep if @pii_mode == PIIMode::ALLOW
          return :rewrite if @pii_mode == PIIMode::HASH

          return :drop
        end
        :keep
      end

      def decide(signal, key)
        cls = lookup(key)
        act = action_for(cls)
        if act != :keep && @recorder
          rule = cls == Spec::Sensitivity::SECRET ? RULE_SECRET : RULE_PII
          @recorder.record(signal, rule)
        end
        act
      end

      def metric_keep?(key)
        cls = lookup(key)
        return false if cls == Spec::Sensitivity::SECRET
        return @pii_mode == PIIMode::ALLOW if cls == Spec::Sensitivity::PII

        true
      end

      def tokenize(value)
        PII.token(@key, value)
      end

      def classify_flat(signal, attrs)
        return [{}, false] if attrs.nil? || attrs.empty?

        changed = false
        out = {}
        attrs.each do |raw_k, raw_v|
          k = raw_k.to_s
          v = Redact.contains_redactable?(raw_v) ? Redact.render(raw_v) : raw_v
          changed = true unless v.equal?(raw_v)
          act = decide(signal, k)
          if act == :drop
            changed = true
            next
          elsif act == :rewrite
            changed = true
            out[k] = tokenize(v)
          else
            out[k] = v
          end
        end
        [out, changed]
      end

      def classify_metric_attrs(attrs)
        return {} if attrs.nil? || attrs.empty?

        out = {}
        attrs.each do |raw_k, raw_v|
          k = raw_k.to_s
          next unless metric_keep?(k)

          out[k] = Redact.contains_redactable?(raw_v) ? Redact.render(raw_v) : raw_v
        end
        out
      end

      def classify_log_attributes(attrs, replacer: nil)
        return {} if attrs.nil? || attrs.empty?

        budget = [PII::MAX_COMPOSITE_NODES]
        active = {}
        walk_hash(attrs, [], 0, budget, active, replacer)
      end

      private

      def spend?(budget)
        return false if budget[0] <= 0

        budget[0] -= 1
        true
      end

      def walk_hash(mapping, groups, depth, budget, active, replacer)
        out = {}
        mapping.each do |raw_k, raw_v|
          k = raw_k.to_s
          val = Redact.contains_redactable?(raw_v) ? Redact.render(raw_v) : raw_v

          if replacer
            replaced = replacer.call(groups, k, val)
            next if replaced.nil?

            k, val = replaced
            k = k.to_s
            next if k.empty?
          end

          full_key = groups.empty? ? k : "#{groups.join(".")}.#{k}"
          act = decide(Spec::Signal::LOGS, full_key)
          next if act == :drop

          if act == :rewrite
            out[k] = tokenize(val)
            next
          end

          out[k] = walk_value(val, groups + [k], depth + 1, budget, active, replacer)
        end
        out
      end

      def walk_value(value, groups, depth, budget, active, replacer)
        return PII::CANONICAL_TRUNCATED if depth > PII::MAX_COMPOSITE_DEPTH || !spend?(budget)

        value = Redact.render(value) if Redact.contains_redactable?(value)
        return value if value.nil? || value.is_a?(TrueClass) || value.is_a?(FalseClass) ||
                        value.is_a?(Integer) || value.is_a?(Float) || value.is_a?(String)

        oid = value.object_id
        return PII::CANONICAL_TRUNCATED if active[oid]

        active[oid] = true
        begin
          if value.is_a?(Hash)
            return walk_hash(value, groups, depth, budget, active, replacer)
          elsif value.is_a?(Array)
            return value.map { |el| walk_value(el, groups, depth + 1, budget, active, replacer) }
          end
        ensure
          active.delete(oid)
        end
        value.to_s
      end
    end
  end
end
