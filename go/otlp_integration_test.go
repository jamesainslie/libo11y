package o11y_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	collectorlogs "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	collectormetrics "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logpb "go.opentelemetry.io/proto/otlp/logs/v1"
	metricpb "go.opentelemetry.io/proto/otlp/metrics/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

// Wire-test sentinels: values distinctive enough that a substring match
// anywhere in a payload can only mean the raw value leaked.
const (
	wirePII    = "10.9.8.7"
	wireSecret = "s3cr3t-wire-sentinel"
)

// otlpSink collects every resource-level payload an in-process receiver
// decodes, across all three signals.
type otlpSink struct {
	mu      sync.Mutex
	traces  []*tracepb.ResourceSpans
	metrics []*metricpb.ResourceMetrics
	logs    []*logpb.ResourceLogs
}

func (s *otlpSink) addTraces(rs []*tracepb.ResourceSpans) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.traces = append(s.traces, rs...)
}

func (s *otlpSink) addMetrics(rm []*metricpb.ResourceMetrics) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metrics = append(s.metrics, rm...)
}

func (s *otlpSink) addLogs(rl []*logpb.ResourceLogs) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logs = append(s.logs, rl...)
}

func (s *otlpSink) snapshot() ([]*tracepb.ResourceSpans, []*metricpb.ResourceMetrics, []*logpb.ResourceLogs) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*tracepb.ResourceSpans(nil), s.traces...),
		append([]*metricpb.ResourceMetrics(nil), s.metrics...),
		append([]*logpb.ResourceLogs(nil), s.logs...)
}

type traceSvc struct {
	collectortrace.UnimplementedTraceServiceServer
	sink *otlpSink
}

func (s traceSvc) Export(_ context.Context, req *collectortrace.ExportTraceServiceRequest) (*collectortrace.ExportTraceServiceResponse, error) {
	s.sink.addTraces(req.GetResourceSpans())
	return &collectortrace.ExportTraceServiceResponse{}, nil
}

type metricSvc struct {
	collectormetrics.UnimplementedMetricsServiceServer
	sink *otlpSink
}

func (s metricSvc) Export(_ context.Context, req *collectormetrics.ExportMetricsServiceRequest) (*collectormetrics.ExportMetricsServiceResponse, error) {
	s.sink.addMetrics(req.GetResourceMetrics())
	return &collectormetrics.ExportMetricsServiceResponse{}, nil
}

type logSvc struct {
	collectorlogs.UnimplementedLogsServiceServer
	sink *otlpSink
}

func (s logSvc) Export(_ context.Context, req *collectorlogs.ExportLogsServiceRequest) (*collectorlogs.ExportLogsServiceResponse, error) {
	s.sink.addLogs(req.GetResourceLogs())
	return &collectorlogs.ExportLogsServiceResponse{}, nil
}

// startGRPCReceiver serves the three OTLP collector services on an ephemeral
// loopback port and returns its host:port.
func startGRPCReceiver(t *testing.T) (string, *otlpSink) {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	sink := &otlpSink{}
	srv := grpc.NewServer()
	collectortrace.RegisterTraceServiceServer(srv, traceSvc{sink: sink})
	collectormetrics.RegisterMetricsServiceServer(srv, metricSvc{sink: sink})
	collectorlogs.RegisterLogsServiceServer(srv, logSvc{sink: sink})
	served := make(chan struct{})
	go func() {
		defer close(served)
		_ = srv.Serve(lis)
	}()
	t.Cleanup(func() {
		srv.Stop()
		<-served
	})
	return lis.Addr().String(), sink
}

// protoHandler decodes one OTLP/HTTP protobuf request into a fresh message,
// hands it to store, and answers with an empty protobuf response.
func protoHandler[M proto.Message](newMsg func() M, store func(M)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		msg := newMsg()
		if err := proto.Unmarshal(body, msg); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		store(msg)
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
	}
}

// startHTTPReceiver serves the OTLP/HTTP protobuf paths on an ephemeral
// loopback port and returns its host:port.
func startHTTPReceiver(t *testing.T) (string, *otlpSink) {
	t.Helper()
	sink := &otlpSink{}
	mux := http.NewServeMux()
	mux.Handle("POST /v1/traces", protoHandler(
		func() *collectortrace.ExportTraceServiceRequest { return &collectortrace.ExportTraceServiceRequest{} },
		func(m *collectortrace.ExportTraceServiceRequest) { sink.addTraces(m.GetResourceSpans()) }))
	mux.Handle("POST /v1/metrics", protoHandler(
		func() *collectormetrics.ExportMetricsServiceRequest {
			return &collectormetrics.ExportMetricsServiceRequest{}
		},
		func(m *collectormetrics.ExportMetricsServiceRequest) { sink.addMetrics(m.GetResourceMetrics()) }))
	mux.Handle("POST /v1/logs", protoHandler(
		func() *collectorlogs.ExportLogsServiceRequest { return &collectorlogs.ExportLogsServiceRequest{} },
		func(m *collectorlogs.ExportLogsServiceRequest) { sink.addLogs(m.GetResourceLogs()) }))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return strings.TrimPrefix(srv.URL, "http://"), sink
}

// anyValueString renders an OTLP AnyValue through its typed accessors, so
// leak checks compare raw values rather than protobuf debug text. Composite
// values are flattened so a sentinel nested anywhere still shows up.
func anyValueString(v *commonpb.AnyValue) string {
	switch x := v.GetValue().(type) {
	case *commonpb.AnyValue_StringValue:
		return x.StringValue
	case *commonpb.AnyValue_BoolValue:
		return strconv.FormatBool(x.BoolValue)
	case *commonpb.AnyValue_IntValue:
		return strconv.FormatInt(x.IntValue, 10)
	case *commonpb.AnyValue_DoubleValue:
		return strconv.FormatFloat(x.DoubleValue, 'g', -1, 64)
	case *commonpb.AnyValue_BytesValue:
		return hex.EncodeToString(x.BytesValue) + " " + string(x.BytesValue)
	case *commonpb.AnyValue_ArrayValue:
		parts := make([]string, 0, len(x.ArrayValue.GetValues()))
		for _, e := range x.ArrayValue.GetValues() {
			parts = append(parts, anyValueString(e))
		}
		return "[" + strings.Join(parts, ",") + "]"
	case *commonpb.AnyValue_KvlistValue:
		parts := make([]string, 0, len(x.KvlistValue.GetValues()))
		for _, kv := range x.KvlistValue.GetValues() {
			parts = append(parts, kv.GetKey()+"="+anyValueString(kv.GetValue()))
		}
		return "{" + strings.Join(parts, ",") + "}"
	default:
		return ""
	}
}

func pbAttrs(kvs []*commonpb.KeyValue) map[string]string {
	out := make(map[string]string, len(kvs))
	for _, kv := range kvs {
		out[kv.GetKey()] = anyValueString(kv.GetValue())
	}
	return out
}

type wireExporters struct {
	trace  sdktrace.SpanExporter
	metric sdkmetric.Exporter
	log    sdklog.Exporter
}

// closeOnCleanup shuts the exporters down at test end. The SDK already shuts
// them down on its own Shutdown; this covers the paths where New fails or the
// test stops early, and a second shutdown is harmless.
func (e wireExporters) closeOnCleanup(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = e.trace.Shutdown(ctx)
		_ = e.metric.Shutdown(ctx)
		_ = e.log.Shutdown(ctx)
	})
}

func grpcExporters(t *testing.T, addr string) wireExporters {
	t.Helper()
	ctx := context.Background()
	te, err := otlptracegrpc.New(ctx, otlptracegrpc.WithEndpoint(addr), otlptracegrpc.WithInsecure())
	if err != nil {
		t.Fatal(err)
	}
	me, err := otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithEndpoint(addr), otlpmetricgrpc.WithInsecure())
	if err != nil {
		t.Fatal(err)
	}
	le, err := otlploggrpc.New(ctx, otlploggrpc.WithEndpoint(addr), otlploggrpc.WithInsecure())
	if err != nil {
		t.Fatal(err)
	}
	exp := wireExporters{te, me, le}
	exp.closeOnCleanup(t)
	return exp
}

func httpExporters(t *testing.T, addr string) wireExporters {
	t.Helper()
	ctx := context.Background()
	te, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpoint(addr), otlptracehttp.WithInsecure())
	if err != nil {
		t.Fatal(err)
	}
	me, err := otlpmetrichttp.New(ctx, otlpmetrichttp.WithEndpoint(addr), otlpmetrichttp.WithInsecure())
	if err != nil {
		t.Fatal(err)
	}
	le, err := otlploghttp.New(ctx, otlploghttp.WithEndpoint(addr), otlploghttp.WithInsecure())
	if err != nil {
		t.Fatal(err)
	}
	exp := wireExporters{te, me, le}
	exp.closeOnCleanup(t)
	return exp
}

// wireChecker holds the per-payload assertions shared by the wire tests.
type wireChecker struct {
	t *testing.T
}

// resource asserts identity is present, the schema URL is stamped, and no
// PII or secret reached the resource. Under WithoutOTELEnv the env-only keys
// are shadowed with empty values; those are expected and not a leak.
func (c wireChecker) resource(where string, attrs []*commonpb.KeyValue, schemaURL string) {
	c.t.Helper()
	res := pbAttrs(attrs)
	if res["service.name"] == "" || res["deployment.environment.name"] == "" {
		c.t.Errorf("%s: resource lacks identity: %v", where, res)
	}
	if _, leaked := res["host.ip"]; leaked {
		c.t.Errorf("%s: resource carries host.ip", where)
	}
	if schemaURL != spec.SchemaURL {
		c.t.Errorf("%s: schema URL %q, want %q", where, schemaURL, spec.SchemaURL)
	}
	c.noLeak(where+" resource", res)
}

// noLeak asserts no attribute key is a classified key and no value carries
// either sentinel.
func (c wireChecker) noLeak(where string, attrs map[string]string) {
	c.t.Helper()
	for k, v := range attrs {
		if k == "test.secret" {
			c.t.Errorf("%s: secret key %s exported (value %q)", where, k, v)
		}
		if strings.Contains(v, wirePII) || strings.Contains(v, wireSecret) {
			c.t.Errorf("%s: %s=%s leaked", where, k, v)
		}
	}
}

// noLeakText asserts a free-text field (a log body, a span name) carries
// neither sentinel.
func (c wireChecker) noLeakText(where, text string) {
	c.t.Helper()
	if strings.Contains(text, wirePII) || strings.Contains(text, wireSecret) {
		c.t.Errorf("%s: %q leaked", where, text)
	}
}

func (c wireChecker) spans(traces []*tracepb.ResourceSpans) {
	c.t.Helper()
	for _, rs := range traces {
		c.resource("traces", rs.GetResource().GetAttributes(), rs.GetSchemaUrl())
		for _, ss := range rs.GetScopeSpans() {
			for _, s := range ss.GetSpans() {
				c.noLeakText("span name", s.GetName())
				c.noLeak("span "+s.GetName(), pbAttrs(s.GetAttributes()))
				for _, e := range s.GetEvents() {
					c.noLeak("span event "+e.GetName(), pbAttrs(e.GetAttributes()))
				}
				for _, l := range s.GetLinks() {
					c.noLeak("span link", pbAttrs(l.GetAttributes()))
				}
			}
		}
	}
}

func TestOTLPWirePayloads(t *testing.T) {
	t.Parallel()
	for name, setup := range map[string]func(*testing.T) (wireExporters, *otlpSink){
		"grpc": func(t *testing.T) (wireExporters, *otlpSink) {
			addr, sink := startGRPCReceiver(t)
			return grpcExporters(t, addr), sink
		},
		"http": func(t *testing.T) (wireExporters, *otlpSink) {
			addr, sink := startHTTPReceiver(t)
			return httpExporters(t, addr), sink
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			exp, sink := setup(t)
			sdk, err := o11y.New(context.Background(),
				o11y.WithServiceName("otlp-wire"), o11y.WithEnvironment(spec.EnvironmentTest),
				o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics(),
				o11y.WithTraceExporter(exp.trace),
				o11y.WithMetricReader(sdkmetric.NewPeriodicReader(exp.metric, sdkmetric.WithInterval(time.Hour))),
				o11y.WithLogExporter(exp.log),
				o11y.WithResourceAttributes(attribute.String("host.ip", wirePII)),
				o11y.WithSensitivityForTest(secretTable))
			if err != nil {
				t.Fatal(err)
			}
			ctx, span := sdk.TracerProvider().Tracer("t").Start(context.Background(), "op",
				trace.WithAttributes(attribute.String("host.ip", wirePII), attribute.String("test.secret", wireSecret)))
			span.AddEvent("step", trace.WithAttributes(attribute.String("test.secret", wireSecret)))
			hist, err := sdk.MeterProvider().Meter("t").Float64Histogram("work.duration")
			if err != nil {
				t.Fatal(err)
			}
			hist.Record(ctx, 0.5, metric.WithAttributes(
				attribute.String("host.ip", wirePII), attribute.String("test.secret", wireSecret)))
			sdk.Logger().InfoContext(ctx, "inside", "host.ip", wirePII, "test.secret", wireSecret)
			sdk.Event(ctx, spec.EventRequestSummary, slog.String("http.request.method", "GET"))
			span.End()

			flushCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := sdk.Shutdown(flushCtx); err != nil {
				t.Fatalf("Shutdown: %v", err)
			}
			traces, metrics, logs := sink.snapshot()
			if len(traces) == 0 || len(metrics) == 0 || len(logs) == 0 {
				t.Fatalf("received traces=%d metrics=%d logs=%d", len(traces), len(metrics), len(logs))
			}
			wantTrace := span.SpanContext().TraceID()
			check := wireChecker{t: t}

			check.spans(traces)

			var sawCorrelated, sawEvent bool
			for _, rl := range logs {
				check.resource("logs", rl.GetResource().GetAttributes(), rl.GetSchemaUrl())
				for _, sl := range rl.GetScopeLogs() {
					for _, lr := range sl.GetLogRecords() {
						attrs := pbAttrs(lr.GetAttributes())
						check.noLeak("log", attrs)
						check.noLeakText("log body", anyValueString(lr.GetBody()))
						if anyValueString(lr.GetBody()) == "inside" && bytes.Equal(lr.GetTraceId(), wantTrace[:]) {
							sawCorrelated = true
						}
						if (attrs[spec.EventNameKey] == spec.EventRequestSummary || lr.GetEventName() == spec.EventRequestSummary) &&
							bytes.Equal(lr.GetTraceId(), wantTrace[:]) {
							sawEvent = true
						}
					}
				}
			}
			if !sawCorrelated {
				t.Error("the log record written inside the span does not carry the span's trace ID")
			}
			if !sawEvent {
				t.Error("the request summary event was not exported with the span's trace ID")
			}

			var sawExemplar bool
			for _, rm := range metrics {
				check.resource("metrics", rm.GetResource().GetAttributes(), rm.GetSchemaUrl())
				for _, sm := range rm.GetScopeMetrics() {
					for _, m := range sm.GetMetrics() {
						if m.GetName() != "work.duration" {
							continue
						}
						for _, dp := range m.GetHistogram().GetDataPoints() {
							check.noLeak("metric point", pbAttrs(dp.GetAttributes()))
							for _, ex := range dp.GetExemplars() {
								check.noLeak("exemplar", pbAttrs(ex.GetFilteredAttributes()))
								if bytes.Equal(ex.GetTraceId(), wantTrace[:]) {
									sawExemplar = true
								}
							}
						}
					}
				}
			}
			if !sawExemplar {
				t.Error("no exemplar links the histogram to the span's trace")
			}
		})
	}
}

// TestOTLPWireViaEnvironmentConfiguration drives the autoexport path: no
// injected exporter, the OTLP endpoint and protocol come from the standard
// environment variables. It cannot run in parallel because of t.Setenv.
func TestOTLPWireViaEnvironmentConfiguration(t *testing.T) {
	addr, sink := startHTTPReceiver(t)
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://"+addr)
	t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
	t.Setenv("OTEL_TRACES_EXPORTER", "otlp")
	t.Setenv("OTEL_METRICS_EXPORTER", "otlp")
	t.Setenv("OTEL_LOGS_EXPORTER", "otlp")
	t.Setenv("OTEL_METRIC_EXPORT_INTERVAL", "3600000")
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("otlp-env"), o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics())
	if err != nil {
		t.Fatal(err)
	}
	ctx, span := sdk.TracerProvider().Tracer("t").Start(context.Background(), "op",
		trace.WithAttributes(attribute.String("host.ip", wirePII)))
	sdk.Logger().InfoContext(ctx, "inside", "host.ip", wirePII)
	span.End()
	flushCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := sdk.Shutdown(flushCtx); err != nil {
		t.Fatal(err)
	}
	traces, _, logs := sink.snapshot()
	if len(traces) == 0 {
		t.Fatal("autoexport path exported no spans")
	}
	if len(logs) == 0 {
		t.Fatal("autoexport path exported no logs")
	}
	check := wireChecker{t: t}
	check.spans(traces)
	for _, rl := range logs {
		check.resource("logs", rl.GetResource().GetAttributes(), rl.GetSchemaUrl())
		for _, sl := range rl.GetScopeLogs() {
			for _, lr := range sl.GetLogRecords() {
				check.noLeak("log", pbAttrs(lr.GetAttributes()))
			}
		}
	}
}
