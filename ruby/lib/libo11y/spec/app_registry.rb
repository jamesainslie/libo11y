# frozen_string_literal: true

require_relative "generated/tables"
require_relative "go_quote"
require_relative "yaml_v3"

module Libo11y
  module Spec
    module AppRegistry
      PARSE_MESSAGES = {
        "empty" => "the file holds no YAML document",
        "second-document" => "an application registry holds one YAML document, found a second",
        "duplicate-key" => "a mapping repeats a key",
        "unknown-key" => "a key the schema does not define",
        "type" => "a value of the wrong YAML type",
        "syntax" => "the file is not valid YAML"
      }.freeze

      Attribute = Data.define(:type, :sensitivity, :cardinality, :values, :brief)
      Registry = Data.define(:schema, :namespace, :attributes)
      Compiled = Data.define(:namespace, :classes, :source)

      Violation = Data.define(:rule_id, :attribute, :detail) do
        def to_s
          if attribute.nil?
            "#{rule_id}: #{detail}"
          else
            "#{rule_id}: attribute #{attribute}: #{detail}"
          end
        end
      end

      class ParseError < StandardError
        attr_reader :kind

        def initialize(kind, detail = nil)
          @kind = kind
          msg = detail.nil? ? PARSE_MESSAGES.fetch(kind) : detail
          super("parsing application registry: #{kind}: #{msg}")
        end
      end

      class ValidationError < StandardError
        attr_reader :violations

        def initialize(violations)
          @violations = violations.freeze
          super("invalid application registry: #{violations.join("; ")}")
        end
      end

      REGISTRY_FIELDS = Set["schema", "namespace", "attributes"].freeze
      ATTRIBUTE_FIELDS = Set["type", "sensitivity", "cardinality", "values", "brief"].freeze
      NAMESPACE_RE = /\A[a-z][a-z0-9]*(_[a-z0-9]+)*\z/
      NAME_RE = /\A[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+\z/
      ATTRIBUTE_TYPES = Set["string", "boolean", "int", "double", "string[]", "boolean[]", "int[]", "double[]"].freeze
      SENSITIVITIES = Set["public", "internal", "pii", "secret"].freeze
      CARDINALITIES = Set["enum", "bounded", "unbounded"].freeze

      GO_WS_CLASS = "\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000"
      GO_TRIM_RE = /\A[#{GO_WS_CLASS}]+|[#{GO_WS_CLASS}]+\z/

      class Decoder
        attr_reader :duplicate, :unknown, :wrong_type

        def initialize(aliases)
          @aliases = aliases
          @expanding = {}
          @decodes = 0
          @alias_decodes = 0
          @alias_depth = 0
          @duplicate = false
          @unknown = false
          @wrong_type = false
        end

        def count
          @decodes += 1
          @alias_decodes += 1 if @alias_depth.positive?
          return unless @alias_decodes > 100 && @decodes > 1000 &&
                        (@alias_decodes.to_f / @decodes) > YamlV3.allowed_alias_ratio(@decodes)

          raise YamlV3::SyntaxError, "document contains excessive aliasing"
        end

        def decode_registry(raw)
          schema = ""
          namespace = ""
          attributes = {}

          decode_struct(raw, REGISTRY_FIELDS) do |field_name, val|
            if field_name == "attributes"
              attributes = decode_attributes(val)
              next
            end
            s = decode_string(val)
            next if s.nil?

            if field_name == "schema"
              schema = s
            else
              namespace = s
            end
          end

          Registry.new(schema: schema, namespace: namespace, attributes: attributes.freeze)
        end

        def problem
          return "duplicate-key" if @duplicate
          return "unknown-key" if @unknown
          return "type" if @wrong_type

          nil
        end

        private

        def decode_node(raw, &block)
          count
          return block.call(raw) unless raw.is_a?(YamlV3::AliasNode)

          aid = raw.object_id
          raise YamlV3::SyntaxError, "anchor '#{raw.anchor}' value contains itself" if @expanding[aid]

          target = @aliases.fetch(aid)
          @expanding[aid] = true
          @alias_depth += 1
          begin
            decode_node(target, &block)
          ensure
            @alias_depth -= 1
            @expanding.delete(aid)
          end
        end

        def resolve(node)
          YamlV3.resolve_scalar(node.tag, node.value, node.quoted_or_block)
        end

        def null_or_wrong_scalar?(node)
          return false unless node.is_a?(YamlV3::ScalarNode)

          @wrong_type = true unless resolve(node).is_null
          true
        end

        def node_identity(node)
          case node
          when YamlV3::ScalarNode then "scalar:#{node.value}"
          when YamlV3::AliasNode then "alias:#{node.anchor}"
          when YamlV3::MappingNode then "map:"
          else "seq:"
          end
        end

        def duplicates?(mp)
          seen = {}
          mp.pairs.each do |pair|
            ident = node_identity(pair[0])
            if seen[ident]
              @duplicate = true
              return true
            end
            seen[ident] = true
          end
          false
        end

        def decode_string(raw)
          decode_node(raw) do |node|
            if node.is_a?(YamlV3::ScalarNode)
              v = resolve(node)
              v.is_null ? nil : v.text
            else
              @wrong_type = true unless node.is_a?(YamlV3::MappingNode) && duplicates?(node)
              nil
            end
          end
        end

        def decode_strings(raw)
          decode_node(raw) do |node|
            return nil if null_or_wrong_scalar?(node)

            unless node.is_a?(YamlV3::SequenceNode)
              @wrong_type = true unless node.is_a?(YamlV3::MappingNode) && duplicates?(node)
              return nil
            end
            out = []
            node.items.each do |item|
              s = decode_string(item)
              out << s unless s.nil?
            end
            out.freeze
          end
        end

        def decode_mapping(raw, merged = nil, &on_key)
          decode_node(raw) do |node|
            return if null_or_wrong_scalar?(node)

            unless node.is_a?(YamlV3::MappingNode)
              @wrong_type = true
              return
            end
            return if duplicates?(node)

            merge_node = nil
            has_merge = false
            node.pairs.each do |k, v|
              if YamlV3.merge_key?(k)
                merge_node = v
                has_merge = true
                next
              end
              name = decode_string(k)
              next if name.nil?

              if merged
                next if merged[name]

                merged[name] = true
              end
              on_key.call(name, v)
            end
            merge_into(node, merge_node, merged, &on_key) if has_merge && !merge_node.nil?
          end
        end

        def merge_into(parent, source, merged, &on_key)
          keys = merged || {}
          if merged.nil?
            parent.pairs.each do |pair|
              ks = decode_node(pair[0]) do |n|
                next nil unless n.is_a?(YamlV3::ScalarNode)

                v = resolve(n)
                !v.is_null && v.is_string ? v.text : nil
              end
              keys[ks] = true unless ks.nil?
            end
          end

          is_map = lambda do |n|
            target = n.is_a?(YamlV3::AliasNode) ? @aliases[n.object_id] : n
            target.is_a?(YamlV3::MappingNode)
          end

          if source.is_a?(YamlV3::SequenceNode)
            source.items.each do |item|
              raise YamlV3::SyntaxError, "map merge requires map or sequence of maps as the value" unless is_map.call(item)

              decode_mapping(item, keys, &on_key)
            end
            return
          end
          raise YamlV3::SyntaxError, "map merge requires map or sequence of maps as the value" unless is_map.call(source)

          decode_mapping(source, keys, &on_key)
        end

        def decode_struct(raw, fields, &on_field)
          done = {}
          decode_mapping(raw) do |name, val|
            unless fields.include?(name)
              @unknown = true
              next
            end
            if done[name]
              @wrong_type = true
              next
            end
            done[name] = true
            on_field.call(name, val)
          end
        end

        def decode_attribute(raw)
          attr_type = ""
          sensitivity = ""
          cardinality = ""
          values = [].freeze
          brief = ""

          decode_struct(raw, ATTRIBUTE_FIELDS) do |field_name, val|
            if field_name == "values"
              parsed = decode_strings(val)
              values = parsed unless parsed.nil?
              next
            end
            s = decode_string(val)
            next if s.nil?

            case field_name
            when "type" then attr_type = s
            when "sensitivity" then sensitivity = s
            when "cardinality" then cardinality = s
            when "brief" then brief = s
            end
          end

          Attribute.new(type: attr_type, sensitivity: sensitivity, cardinality: cardinality, values: values, brief: brief)
        end

        def decode_attributes(raw)
          out = {}
          decode_mapping(raw) do |name, val|
            out[name] = decode_attribute(val)
          end
          out
        end
      end

      module_function

      def go_trim_space(str)
        str.gsub(GO_TRIM_RE, "")
      end

      def parse(text)
        docs = YamlV3.parse_documents(text)
        raise ParseError, "empty" if docs.empty?

        first = docs[0]
        decoder = Decoder.new(first.aliases)
        decoder.count
        reg = decoder.decode_registry(first.root)
        problem = decoder.problem
        raise ParseError, problem unless problem.nil?
        raise ParseError, "second-document" if docs.length > 1

        reg
      rescue YamlV3::SyntaxError => e
        raise ParseError.new("syntax", e.message)
      end

      def parse_bytes(raw)
        text = YamlV3.decode_input(raw)
        parse(text)
      rescue YamlV3::SyntaxError => e
        raise ParseError.new("syntax", e.message)
      end

      def validate(reg)
        violations = []
        fail_rule = lambda do |rule, attr, detail|
          violations << Violation.new(rule_id: rule, attribute: attr, detail: detail)
        end

        if reg.schema != APP_REGISTRY_SCHEMA
          fail_rule.call(
            "libo11y_app_schema_unknown",
            nil,
            "schema #{GoQuote.quote(reg.schema)}, want #{GoQuote.quote(APP_REGISTRY_SCHEMA)}"
          )
        end
        if !NAMESPACE_RE.match?(reg.namespace)
          fail_rule.call(
            "libo11y_app_namespace_invalid",
            nil,
            "namespace #{GoQuote.quote(reg.namespace)} is not one snake_case segment"
          )
        elsif APP_RESERVED_NAMESPACES.include?(reg.namespace)
          fail_rule.call(
            "libo11y_app_namespace_reserved",
            nil,
            "namespace #{GoQuote.quote(reg.namespace)} belongs to libo11y, OpenTelemetry, or semconv"
          )
        end

        names = reg.attributes.keys.sort_by { |s| s.encode(Encoding::UTF_8).b }
        fail_rule.call("libo11y_app_attributes_empty", nil, "the registry declares no attributes") if names.empty?

        names.each do |name|
          a = reg.attributes[name]
          unless name.start_with?("#{reg.namespace}.")
            fail_rule.call("libo11y_app_attr_outside_namespace", name, "not under the #{reg.namespace} namespace")
          end
          fail_rule.call("libo11y_attr_naming", name, "not a dotted snake_case name with at least two segments") unless NAME_RE.match?(name)
          fail_rule.call("libo11y_app_type_unknown", name, "type #{GoQuote.quote(a.type)}") unless ATTRIBUTE_TYPES.include?(a.type)

          if a.sensitivity.empty?
            fail_rule.call("libo11y_sensitivity_missing", name, "no sensitivity class")
          elsif !SENSITIVITIES.include?(a.sensitivity)
            fail_rule.call("libo11y_sensitivity_unknown", name, "sensitivity #{GoQuote.quote(a.sensitivity)}")
          end

          if a.cardinality.empty?
            fail_rule.call("libo11y_cardinality_missing", name, "no cardinality budget")
          elsif !CARDINALITIES.include?(a.cardinality)
            fail_rule.call("libo11y_cardinality_unknown", name, "cardinality #{GoQuote.quote(a.cardinality)}")
          end

          if a.cardinality == "enum" && a.values.empty?
            fail_rule.call("libo11y_app_enum_values_missing", name, "an enum declares its values")
          elsif a.cardinality != "enum" && !a.values.empty?
            fail_rule.call("libo11y_app_values_without_enum", name, "values need cardinality enum")
          end

          seen = {}
          a.values.each do |v|
            trimmed = go_trim_space(v)
            fail_rule.call("libo11y_enum_value_whitespace", name, "value #{GoQuote.quote(v)}") if v != trimmed
            fail_rule.call("libo11y_enum_duplicate_value", name, "value #{GoQuote.quote(v)}") if seen[trimmed]
            seen[trimmed] = true
          end
        end

        violations.freeze
      end

      def compile(reg, source: nil)
        violations = validate(reg)
        raise ValidationError, violations unless violations.empty?

        classes = {}
        reg.attributes.keys.sort_by { |s| s.encode(Encoding::UTF_8).b }.each do |name|
          classes[name] = reg.attributes[name].sensitivity
        end
        Compiled.new(namespace: reg.namespace, classes: classes.freeze, source: source)
      end

      def load_file(path)
        raw = File.binread(path)
        compile(parse_bytes(raw), source: path.to_s)
      end
    end
  end
end
