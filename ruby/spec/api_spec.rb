# frozen_string_literal: true

require "spec_helper"
require "etc"
require "open3"
require "rbconfig"

RSpec.describe "The public API's edges" do
  describe "exe/libo11y" do
    def run_cli(*)
      Open3.capture3(RbConfig.ruby, "-I", File.expand_path("../lib", __dir__), File.expand_path("../exe/libo11y", __dir__), *)
    end

    it "prints its usage on standard output and exits 0 when asked for help" do
      %w[-h --help help].each do |flag|
        out, err, status = run_cli(flag)

        expect([out, err, status.exitstatus]).to eq(["usage: libo11y registry check FILE...\n", "", 0])
      end
    end

    it "prints its usage on standard error and exits 2 for anything else it does not know" do
      [[], %w[registry], %w[registry check], %w[registry lint x.yaml]].each do |args|
        out, err, status = run_cli(*args)

        expect([out, err, status.exitstatus]).to eq(["", "usage: libo11y registry check FILE...\n", 2])
      end
    end
  end

  describe "Libo11y.force_emit and Libo11y.start_record" do
    it "need a block, so the scope they open always closes" do
      expect { Libo11y.force_emit }.to raise_error(ArgumentError, /block/)
      expect { Libo11y.start_record }.to raise_error(ArgumentError, /block/)
      expect(Libo11y.force_emit?).to be(false)
      expect(Libo11y.current_record).to be_nil
    end

    it "restore the enclosing scope" do
      Libo11y.start_record do |outer|
        Libo11y.start_record { |inner| expect(Libo11y.current_record).to equal(inner) }
        expect(Libo11y.current_record).to equal(outer)
      end
      expect(Libo11y.force_emit { Libo11y.force_emit? }).to be(true)
      expect(Libo11y.force_emit?).to be(false)
    end
  end

  describe "Libo11y.init with an Options object" do
    let(:options) { Libo11y::Options.new(service_name: "from-options", environment: "test", env: Libo11y::HERMETIC, console_enabled: false) }

    it "lets keywords replace single options and leaves the object alone" do
      tel = Libo11y.init(options, service_name: "from-keywords")

      expect(tel.resource.attributes["service.name"]).to eq("from-keywords")
      expect(options.service_name).to eq("from-options")
      tel.shutdown
    end

    it "refuses a keyword that is not an option" do
      expect { Libo11y.init(options, servce_name: "typo") }.to raise_error(ArgumentError, /servce_name/)
      expect { Libo11y.init(servce_name: "typo") }.to raise_error(ArgumentError, /servce_name/)
    end
  end

  describe Libo11y::Testing::OtlpHttpReceiver do
    it "hands out copies of what it has received" do
      receiver = described_class.new
      begin
        first = receiver.trace_requests
        first << :mine

        expect(receiver.trace_requests).to eq([])
        expect([receiver.metric_requests, receiver.log_requests, receiver.received_headers]).to all(eq([]))
      ensure
        receiver.stop
      end
    end
  end

  describe "runtime metrics" do
    it "report resident memory in whole pages of the system's page size", if: File.readable?("/proc/self/statm") do
      bytes = Libo11y::Internal::RuntimeMetrics.read_rss_bytes

      expect(bytes).to be_positive
      expect(bytes % Etc.sysconf(Etc::SC_PAGESIZE)).to eq(0)
      expect(Libo11y::Internal::RuntimeMetrics::PAGE_SIZE).to eq(Etc.sysconf(Etc::SC_PAGESIZE))
    end
  end
end
