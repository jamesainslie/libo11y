# syntax=docker/dockerfile:1
#
# The o11yrum-gateway image: one static binary on distroless, running as an
# unprivileged numeric user, with nothing it writes to at runtime. Build it
# with go/o11yrum as the context. The module has no replace directive, so
# the build resolves the libo11y core at the version go.mod requires, as
# `go install` does:
#
#   docker buildx build -f go/o11yrum/Dockerfile --build-arg VERSION=v0.1.0 go/o11yrum
#
# Dockerfile.dockerignore, beside this file, admits only the module's
# go.mod, go.sum and non-test Go sources.

FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src
ENV GOWORK=off GOTOOLCHAIN=local CGO_ENABLED=0
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
	go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
	--mount=type=cache,target=/root/.cache/go-build \
	GOOS=$TARGETOS GOARCH=$TARGETARCH \
	go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" \
	-o /out/o11yrum-gateway ./cmd/o11yrum-gateway

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/o11yrum-gateway /o11yrum-gateway
# Numeric, so Kubernetes can enforce runAsNonRoot against it.
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/o11yrum-gateway"]
CMD ["-config", "/etc/o11yrum/config.yaml"]
