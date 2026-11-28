# syntax=docker/dockerfile:1
#
# The o11yrum-gateway image: one static binary on distroless, running as an
# unprivileged numeric user, with nothing it writes to at runtime. Build it
# from the repository root with go/ as the context, so the module's
# `replace ../` directive resolves to the libo11y core in the same commit:
#
#   docker buildx build -f go/o11yrum/Dockerfile --build-arg VERSION=v0.1.0 go
#
# Dockerfile.dockerignore, beside this file, admits only the sources the
# command builds from.

FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src
ENV GOWORK=off GOTOOLCHAIN=local CGO_ENABLED=0
COPY go.mod go.sum ./
COPY o11yrum/go.mod o11yrum/go.sum ./o11yrum/
RUN --mount=type=cache,target=/go/pkg/mod \
	cd o11yrum && go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
	--mount=type=cache,target=/root/.cache/go-build \
	cd o11yrum && GOOS=$TARGETOS GOARCH=$TARGETARCH \
	go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" \
	-o /out/o11yrum-gateway ./cmd/o11yrum-gateway

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/o11yrum-gateway /o11yrum-gateway
# Numeric, so Kubernetes can enforce runAsNonRoot against it.
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/o11yrum-gateway"]
CMD ["-config", "/etc/o11yrum/config.yaml"]
