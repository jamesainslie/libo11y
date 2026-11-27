package o11yrum

import (
	"bytes"
	"compress/gzip"
	"errors"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/pmetric/pmetricotlp"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
)

func sampleLogs() plog.Logs {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "shop-web")
	lr := rl.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	lr.Attributes().PutStr("event.name", "o11y.rum.session.start")
	lr.Attributes().PutStr("session.id", "s1")
	lr.Attributes().PutStr("o11y.rum.platform", "web")
	return ld
}

func sampleTraces() ptrace.Traces {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "shop-web")
	s := rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
	s.SetName("GET /api/cart")
	s.SetTraceID(pcommon.TraceID{1})
	s.SetSpanID(pcommon.SpanID{1})
	s.SetStartTimestamp(1_000)
	s.SetEndTimestamp(2_000)
	return td
}

func sampleMetrics() pmetric.Metrics {
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	rm.Resource().Attributes().PutStr("service.name", "shop-web")
	m := rm.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	m.SetName("shop.cart.adds")
	sum := m.SetEmptySum()
	sum.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	sum.SetIsMonotonic(true)
	sum.DataPoints().AppendEmpty().SetIntValue(3)
	return md
}

func gz(t testing.TB, b []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if _, err := w.Write(b); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestDecodeBody(t *testing.T) {
	req := plogotlp.NewExportRequestFromLogs(sampleLogs())
	jsonBody, err := req.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	protoBody, err := req.MarshalProto()
	if err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct {
		ctype, enc string
		body       []byte
		maxBody    int64
		maxInfl    int64
		wantErr    error
		wantJSON   bool
	}{
		"json":              {"application/json", "", jsonBody, 1 << 20, 1 << 20, nil, true},
		"json with charset": {"application/json; charset=utf-8", "", jsonBody, 1 << 20, 1 << 20, nil, true},
		"protobuf":          {"application/x-protobuf", "", protoBody, 1 << 20, 1 << 20, nil, false},
		"gzip json":         {"application/json", "gzip", gz(t, jsonBody), 1 << 20, 1 << 20, nil, true},
		"gzip protobuf":     {"application/x-protobuf", "GZIP", gz(t, protoBody), 1 << 20, 1 << 20, nil, false},
		"identity":          {"application/json", "identity", jsonBody, 1 << 20, 1 << 20, nil, true},
		"hex ids accepted":  {"application/json", "", []byte(`{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"a"}}]},"scopeLogs":[{"logRecords":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174"}]}]}]}`), 1 << 20, 1 << 20, nil, true},
		"text/plain":        {"text/plain", "", jsonBody, 1 << 20, 1 << 20, errContentType, false},
		"no content type":   {"", "", jsonBody, 1 << 20, 1 << 20, errContentType, false},
		"br":                {"application/json", "br", jsonBody, 1 << 20, 1 << 20, errEncoding, false},
		"compressed cap":    {"application/json", "", jsonBody, int64(len(jsonBody) - 1), 1 << 20, errTooLarge, false},
		"at compressed cap": {"application/json", "", jsonBody, int64(len(jsonBody)), int64(len(jsonBody)), nil, true},
		"decompressed cap":  {"application/json", "gzip", gz(t, jsonBody), 1 << 20, int64(len(jsonBody) - 1), errDecompressedTooLarge, false},
		"garbage proto":     {"application/x-protobuf", "", []byte{0xff, 0xff, 0xff}, 1 << 20, 1 << 20, errDecode, false},
		"garbage json":      {"application/json", "", []byte("{"), 1 << 20, 1 << 20, errDecode, false},
		"corrupt gzip":      {"application/json", "gzip", []byte("not gzip"), 1 << 20, 1 << 20, errDecode, false},
	} {
		t.Run(name, func(t *testing.T) {
			d, err := decodeBody(SignalLogs, tc.ctype, tc.enc, bytes.NewReader(tc.body), tc.maxBody, tc.maxInfl)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			if err != nil {
				return
			}
			if d.json != tc.wantJSON || d.logs.LogRecordCount() != 1 {
				t.Errorf("json=%v records=%d", d.json, d.logs.LogRecordCount())
			}
		})
	}
}

func TestDecodeBodyTracesAndMetrics(t *testing.T) {
	traceReq := ptraceotlp.NewExportRequestFromTraces(sampleTraces())
	metricReq := pmetricotlp.NewExportRequestFromMetrics(sampleMetrics())
	tj, _ := traceReq.MarshalJSON()
	tp, _ := traceReq.MarshalProto()
	mj, _ := metricReq.MarshalJSON()
	mp, _ := metricReq.MarshalProto()
	for name, tc := range map[string]struct {
		sig   Signal
		ctype string
		body  []byte
	}{
		"traces json":      {SignalTraces, "application/json", tj},
		"traces protobuf":  {SignalTraces, "application/x-protobuf", tp},
		"metrics json":     {SignalMetrics, "application/json", mj},
		"metrics protobuf": {SignalMetrics, "application/protobuf", mp},
	} {
		t.Run(name, func(t *testing.T) {
			d, err := decodeBody(tc.sig, tc.ctype, "", bytes.NewReader(tc.body), 1<<20, 1<<20)
			if err != nil {
				t.Fatal(err)
			}
			if got := count(tc.sig, d); got != 1 {
				t.Errorf("decoded %d records, want 1", got)
			}
		})
	}
	if _, err := decodeBody(SignalTraces, "application/json", "", bytes.NewReader([]byte("[")), 1<<20, 1<<20); !errors.Is(err, errDecode) {
		t.Errorf("garbage traces: err = %v", err)
	}
	if _, err := decodeBody(SignalMetrics, "application/x-protobuf", "", bytes.NewReader([]byte{0xff}), 1<<20, 1<<20); !errors.Is(err, errDecode) {
		t.Errorf("garbage metrics: err = %v", err)
	}
}

// count returns the records a decoded request holds for its signal.
func count(sig Signal, d decoded) int {
	switch sig {
	case SignalTraces:
		return d.traces.SpanCount()
	case SignalLogs:
		return d.logs.LogRecordCount()
	default:
		return d.metrics.DataPointCount()
	}
}
