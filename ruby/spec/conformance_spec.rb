# frozen_string_literal: true

require "json"
require "open3"
require "spec_helper"

RSpec.describe "Cross-language conformance" do
  let(:conformance_dir) { File.expand_path("../../conformance", __dir__) }

  describe "vectors/instance-id.json" do
    it "reproduces every K8s pod instance ID vector" do
      vectors = JSON.parse(File.read(File.join(conformance_dir, "vectors", "instance-id.json")))
      vectors.each do |v|
        got = Libo11y::Internal::Identity.derive_instance_id(
          pod_uid: v["k8s_pod_uid"],
          pod_name: v["k8s_pod_name"],
          namespace: v["k8s_namespace_name"]
        )
        expect(got).to eq(v["want"]), "vector #{v["name"]}"
      end
    end
  end

  describe "vectors/endpoint-sanitize.json" do
    it "reproduces every endpoint sanitization vector" do
      vectors = JSON.parse(File.read(File.join(conformance_dir, "vectors", "endpoint-sanitize.json")))
      vectors.each do |v|
        expect(Libo11y::Internal::Endpoint.sanitize(v["in"])).to eq(v["want"]), "input #{v["in"].inspect}"
      end
    end
  end

  describe "vectors/pii-hash.json" do
    it "reproduces every canonical rendering and HMAC-SHA256 token" do
      data = JSON.parse(File.read(File.join(conformance_dir, "vectors", "pii-hash.json")))
      key = [data["key_hex"]].pack("H*")
      data["cases"].each do |c|
        val = c["kind"] == "bytes" ? c["value"].unpack1("m0").b : c["value"]
        expect(Libo11y::Internal::PII.canonical_value(val)).to eq(c["canonical"]), "canonical: #{c["name"]}"
        expect(Libo11y::Internal::PII.token(key, val)).to eq(c["token"]), "token: #{c["name"]}"
      end
    end
  end

  describe "appregistry/*" do
    it "passes all shared application registry conformance cases" do
      yamls = Dir.glob(File.join(conformance_dir, "appregistry", "*.yaml"))
      expect(yamls.length).to be >= 46
      yamls.each do |yml|
        want = File.read(yml.sub(/\.yaml\z/, ".want")).strip
        got = begin
          reg = Libo11y::Spec::AppRegistry.parse_bytes(File.binread(yml))
          violations = Libo11y::Spec::AppRegistry.validate(reg)
          violations.empty? ? "ok #{reg.attributes.size} #{reg.namespace}" : violations.join("\n")
        rescue Libo11y::Spec::AppRegistry::ParseError => e
          "parse: #{e.kind}"
        end
        expect(got).to eq(want), "case #{File.basename(yml)}"
      end
    end
  end

  describe "exe/libo11y registry check CLI" do
    let(:cli) { File.expand_path("../exe/libo11y", __dir__) }

    it "exits 0 on valid registry, 1 on policy violation, 2 on parse error" do
      valid = File.join(conformance_dir, "appregistry", "valid.yaml")
      out, _err, status = Open3.capture3("ruby", "-I", File.expand_path("../lib", __dir__), cli, "registry", "check", valid)
      expect(status.exitstatus).to eq(0)
      expect(out).to include(": ok (")

      invalid = File.join(conformance_dir, "appregistry", "namespace-reserved.yaml")
      out, _err, status = Open3.capture3("ruby", "-I", File.expand_path("../lib", __dir__), cli, "registry", "check", invalid)
      expect(status.exitstatus).to eq(1)
      expect(out).to include("libo11y_app_namespace_reserved")

      broken = File.join(conformance_dir, "appregistry", "empty.yaml")
      _out, err, status = Open3.capture3("ruby", "-I", File.expand_path("../lib", __dir__), cli, "registry", "check", broken)
      expect(status.exitstatus).to eq(2)
      expect(err).to include("parsing application registry:")
    end
  end
end
