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
          v = render(raw_v)
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

          out[k] = render(raw_v)
        end
        out
      end

      # Applies capture-time redaction, the attribute replacer and the policy
      # to a log record's attributes. Nested Hashes and Arrays are walked, so
      # every member is judged on its dotted effective key, as go/logredact.go
      # does. The walk fails closed. One budget of 2048 nodes is shared by the
      # whole call and spent before a node is examined. A Hash whose effective
      # key has more than 16 parts, or an Array nested 16 deep, is not
      # entered. A reference back into the value being walked, the attributes
      # themselves included, is cut. What the walk did not examine is dropped,
      # and so is a Hash or Array that classification emptied.
      def classify_log_attributes(attrs, replacer: nil)
        return {} if attrs.nil? || attrs.empty?

        walk = LogWalk.new(PII::MAX_COMPOSITE_NODES, { attrs => true }.compare_by_identity, replacer)
        walk_hash(attrs, [], walk).first
      end

      private

      LogWalk = Struct.new(:budget, :active, :replacer) do
        # Takes one node from the budget and reports whether any remained.
        def spend?
          return false if budget <= 0

          self.budget -= 1
          true
        end
      end
      private_constant :LogWalk

      # Renders a Secret, Masked or Fields value, also inside a Hash or Array.
      def render(value)
        case value
        when Hash then Redact.render(value)
        when Array then value.any? { |v| Redact.redactable?(v) || v.is_a?(Hash) || v.is_a?(Array) } ? Redact.render(value) : value
        else Redact.redactable?(value) ? Redact.render(value) : value
        end
      end

      # Classifies one Hash's members. Returns what survives, and whether any
      # member was dropped.
      def walk_hash(mapping, groups, walk)
        out = {}
        changed = false
        mapping.each do |raw_k, raw_v|
          return [out, true] unless walk.spend? # the budget is spent: drop the remaining members

          k = raw_k.to_s
          # Capture-time redaction first, so the replacer never sees a raw Secret or Masked.
          val = Redact.redactable?(raw_v) ? Redact.render(raw_v) : raw_v

          if walk.replacer
            replaced = walk.replacer.call(groups, k, val)
            k, val = replaced
            k = k.to_s
            if replaced.nil? || k.empty?
              changed = true
              next
            end
          end

          case decide(Spec::Signal::LOGS, (groups + [k]).join("."))
          when :drop
            changed = true
          when :rewrite
            out[k] = tokenize(val)
          else
            member, keep, member_changed = walk_value(val, groups + [k], 0, walk)
            changed ||= member_changed
            out[k] = member if keep
          end
        end
        [out, changed]
      end

      # Classifies one value held under the effective key path. Returns the
      # classified value, whether to keep it, and whether classification
      # dropped anything. depth counts Array nesting, and a Hash member starts
      # again at zero, so a Hash is bounded by the length of its effective key
      # and an Array by its nesting.
      def walk_value(value, path, depth, walk)
        value = Redact.render(value) if Redact.redactable?(value)
        case value
        when nil, true, false, Integer, Float, String then return [value, true, false]
        when Hash, Array then nil
        else return [value.to_s, true, false]
        end

        if depth >= PII::MAX_COMPOSITE_DEPTH || path.length > PII::MAX_COMPOSITE_DEPTH || !walk.spend? || walk.active.key?(value)
          return [nil, false, true]
        end

        walk.active[value] = true
        begin
          out, changed = value.is_a?(Hash) ? walk_hash(value, path, walk) : walk_array(value, path, depth, walk)
          [out, !out.empty? || !changed, changed]
        ensure
          walk.active.delete(value)
        end
      end

      def walk_array(list, path, depth, walk)
        kept = []
        changed = false
        list.each do |el|
          unless walk.spend?
            changed = true # the budget is spent: drop the remaining elements
            break
          end
          member, keep, member_changed = walk_value(el, path, depth + 1, walk)
          changed ||= member_changed
          kept << member if keep
        end
        [kept, changed]
      end
    end
  end
end
