namespace Libo11y;

public class O11yException : Exception
{
    public O11yException(string message, Exception? inner = null) : base(message, inner) { }
}

public sealed class AlreadySetupException(string message = "o11y: already set up")
    : O11yException(message);

public sealed class NoServiceNameException(
    string message = "o11y: service name required: set ServiceName or OTEL_SERVICE_NAME")
    : O11yException(message);

public sealed class NoEnvironmentException(
    string message = "o11y: deployment environment required: set Environment or deployment.environment.name")
    : O11yException(message);

public sealed class InvalidEnvironmentException(
    string message = "o11y: deployment environment not in the allowed set")
    : O11yException(message);

public sealed class PiiHashKeyException(
    string message = "o11y: PiiHash requires PiiHashKey with a key of at least 32 bytes")
    : O11yException(message);

public sealed class InvalidAppRegistryException(
    string message = "o11y: invalid application registry", Exception? inner = null)
    : O11yException(message, inner);

public sealed class CanaryRejectedException(string message, Exception? inner = null)
    : O11yException(message, inner);

public sealed class UnsupportedProtocolException(string message)
    : O11yException(message);

public sealed class InvalidOptionException(string message, Exception? inner = null)
    : O11yException(message, inner);

public sealed class ExporterException(string message, Exception? inner = null)
    : O11yException(message, inner);

public sealed class InvalidCarrierException(string message = "o11y: invalid carrier", Exception? inner = null)
    : O11yException(message, inner);
