# frozen_string_literal: true

require_relative "lib/libo11y/version"

Gem::Specification.new do |spec|
  spec.name = "libo11y"
  spec.version = Libo11y::VERSION
  spec.authors = ["James Ainslie"]
  spec.summary = "Opinionated, elegant observability for Ruby built purely on OpenTelemetry."
  spec.description = "One-call OpenTelemetry setup with unified configuration, W3C context propagation, " \
                     "sensitivity redaction, application attribute registries, and three-way " \
                     "log/trace/metric correlation."
  spec.homepage = "https://github.com/jamesainslie/libo11y"
  spec.license = "Apache-2.0"
  spec.required_ruby_version = ">= 3.3.0"

  spec.metadata["homepage_uri"] = spec.homepage
  spec.metadata["source_code_uri"] = "#{spec.homepage}/tree/main/ruby"
  spec.metadata["changelog_uri"] = "#{spec.homepage}/blob/main/ruby/CHANGELOG.md"
  spec.metadata["bug_tracker_uri"] = "#{spec.homepage}/issues"
  spec.metadata["rubygems_mfa_required"] = "true"

  spec.files = Dir.glob("lib/**/*.rb", base: __dir__) + %w[exe/libo11y LICENSE README.md CHANGELOG.md]
  spec.bindir = "exe"
  spec.executables = ["libo11y"]
  spec.require_paths = ["lib"]

  spec.add_dependency "opentelemetry-api", "~> 1.11"
  spec.add_dependency "opentelemetry-common", "~> 0.25"
  spec.add_dependency "opentelemetry-exporter-otlp", "~> 0.37"
  spec.add_dependency "opentelemetry-exporter-otlp-logs", "~> 0.7"
  spec.add_dependency "opentelemetry-exporter-otlp-metrics", "~> 0.15"
  spec.add_dependency "opentelemetry-logs-api", "~> 0.7"
  spec.add_dependency "opentelemetry-logs-sdk", "~> 0.8"
  spec.add_dependency "opentelemetry-metrics-api", "~> 0.10"
  spec.add_dependency "opentelemetry-metrics-sdk", "~> 0.22"
  spec.add_dependency "opentelemetry-sdk", "~> 1.13"
end
