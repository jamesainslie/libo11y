# frozen_string_literal: true

module Libo11y
  # Base class for all libo11y setup and configuration errors.
  class Error < StandardError; end

  class AlreadySetup < Error
    def initialize(message = "o11y: already set up")
      super
    end
  end

  class NoServiceName < Error
    def initialize(message = "o11y: service name required: set service_name or OTEL_SERVICE_NAME")
      super
    end
  end

  class NoEnvironment < Error
    def initialize(message = "o11y: deployment environment required: set environment or deployment.environment.name")
      super
    end
  end

  class InvalidEnvironment < Error
    def initialize(message = "o11y: deployment environment not in the allowed set")
      super
    end
  end

  class PIIHashKey < Error
    def initialize(message = "o11y: PIIHash requires pii_hash_key with a key of at least 32 bytes")
      super
    end
  end

  class InvalidAppRegistry < Error
    def initialize(message = "o11y: invalid application registry")
      super
    end
  end

  class CanaryRejected < Error; end
  class UnsupportedProtocol < Error; end
  class ExporterError < Error; end

  class InvalidCarrier < Error
    def initialize(message = "o11y: invalid carrier")
      super
    end
  end
end
