# frozen_string_literal: true

require "spec_helper"
require "pathname"
require "tempfile"

RSpec.describe "Application registries at setup" do
  let(:yaml) do
    <<~YAML
      schema: libo11y.app-registry/v1
      namespace: acme
      attributes:
        acme.api.token: {type: string, sensitivity: secret, cardinality: unbounded}
    YAML
  end

  def load(*sources)
    Libo11y::Internal::SensitivityPolicy.load_app_registries(sources)
  end

  it "reads a registry from a path, a Pathname, YAML text and a compiled registry" do
    Tempfile.create(["registry", ".yaml"]) do |file|
      file.write(yaml)
      file.flush
      compiled = Libo11y::Spec::AppRegistry.compile(Libo11y::Spec::AppRegistry.parse(yaml))

      [file.path, Pathname.new(file.path), yaml, compiled].each do |source|
        expect(load(source)).to eq("acme.api.token" => Libo11y::Spec::Sensitivity::SECRET)
      end
    end
  end

  it "says a file is missing when a path does not exist" do
    expect { load("/nonexistent/o11y-registry.yaml") }
      .to raise_error(Libo11y::InvalidAppRegistry, %r{No such file or directory.*/nonexistent/o11y-registry\.yaml})
    expect { load(Pathname.new("/nonexistent/o11y-registry.yaml")) }.to raise_error(Libo11y::InvalidAppRegistry, /No such file/)
  end

  it "refuses a namespace declared twice, whatever form the registries come in" do
    compiled = Libo11y::Spec::AppRegistry.compile(Libo11y::Spec::AppRegistry.parse(yaml))

    expect { load(compiled, compiled) }.to raise_error(Libo11y::InvalidAppRegistry, /duplicate namespace "acme"/)
    expect { load(yaml, compiled) }.to raise_error(Libo11y::InvalidAppRegistry, /duplicate namespace "acme" declared in <inline> and/)
  end

  it "refuses a source that is neither" do
    expect { load(42) }.to raise_error(Libo11y::InvalidAppRegistry, /Integer/)
  end

  describe "double-quoted escapes" do
    # A registry with two attributes: the first with the given brief lines,
    # the second with a double-quoted brief.
    def registry(first_brief, second_brief = nil)
      text = "schema: libo11y.app-registry/v1\nnamespace: acme\nattributes:\n  acme.id:\n    type: string\n    sensitivity: internal\n    " \
             "cardinality: unbounded\n#{first_brief}"
      return text if second_brief.nil?

      "#{text}  acme.other:\n    type: string\n    sensitivity: internal\n    cardinality: unbounded\n    brief: #{second_brief}\n"
    end

    def parse(text)
      Libo11y::Spec::AppRegistry.parse(text)
    end

    def brief(reg, key)
      reg.attributes.fetch(key).brief
    end

    it "are checked after an apostrophe in a plain scalar" do
      text = registry("    brief: The portal's opaque user ID.\n", '"hello \/ world"')

      expect { parse(text) }.to raise_error(Libo11y::Spec::AppRegistry::ParseError, /unknown escape character/)
    end

    it "are checked after an apostrophe in a block scalar" do
      text = registry("    brief: |\n      The user's ID.\n      It isn't shown.\n", '"hello \/ world"')

      expect { parse(text) }.to raise_error(Libo11y::Spec::AppRegistry::ParseError, /unknown escape character/)
    end

    it "are not looked for inside a block scalar or a plain scalar" do
      block = parse(registry("    brief: >-\n      A path such as \"C:\\/tmp\" isn't an escape here.\n", '"ok"'))
      plain = parse(registry("    brief: The value \"a\\/b\" isn't quoted here.\n", '"ok"'))

      expect(brief(block, "acme.id")).to include('"C:\/tmp"')
      expect(brief(plain, "acme.id")).to include('"a\/b"')
      expect(brief(plain, "acme.other")).to eq("ok")
    end

    it "accept an escaped apostrophe after an apostrophe elsewhere" do
      reg = parse(registry("    brief: The portal's ID.\n", '"it\\\'s"'))

      expect(brief(reg, "acme.other")).to eq("it's")
    end

    it "are read in a quoted scalar that follows a tag or an anchor" do
      tagged = parse(registry("    brief: !!str \"it\\'s tagged\"\n", '&note "it\\\'s anchored"'))

      expect(brief(tagged, "acme.id")).to eq("it's tagged")
      expect(brief(tagged, "acme.other")).to eq("it's anchored")
      expect { parse(registry("    brief: !!str \"a \\/ b\"\n")) }
        .to raise_error(Libo11y::Spec::AppRegistry::ParseError, /unknown escape character/)
    end

    it "are checked in a flow mapping and after a comment that holds a quote" do
      flow = "schema: libo11y.app-registry/v1\nnamespace: acme\nattributes:\n  # the caller's id\n  " \
             "acme.id: {type: string, sensitivity: internal, cardinality: unbounded, brief: \"a \\/ b\"}\n"

      expect { parse(flow) }.to raise_error(Libo11y::Spec::AppRegistry::ParseError, /unknown escape character/)
    end
  end
end
