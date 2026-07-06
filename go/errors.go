package o11y

import "errors"

// ErrAlreadySetup is returned by [Setup] when a process-global SDK has
// already been installed. Use [New] to build additional, independent SDKs
// that do not touch process globals.
var ErrAlreadySetup = errors.New("o11y: already set up")

// ErrNoServiceName is returned by [New] and [Setup] when no service name is
// resolvable. Provide one with [WithServiceName], or set the standard
// OTEL_SERVICE_NAME (or service.name in OTEL_RESOURCE_ATTRIBUTES)
// environment variable.
var ErrNoServiceName = errors.New("o11y: service name required: set WithServiceName or OTEL_SERVICE_NAME")

// ErrNoEnvironment is returned when no deployment environment is resolvable.
// Provide one with [WithEnvironment], or set deployment.environment.name in
// OTEL_RESOURCE_ATTRIBUTES. Use [WithoutStrictIdentity] to downgrade
// identity requirements to observed violations during migration.
var ErrNoEnvironment = errors.New("o11y: deployment environment required: set WithEnvironment or deployment.environment.name")

// ErrInvalidEnvironment is returned when the resolved deployment environment
// is not in the allowed set. Extend the set with [WithEnvironmentValues].
var ErrInvalidEnvironment = errors.New("o11y: deployment environment not in the allowed set")
