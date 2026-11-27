package o11yrum

import (
	"bytes"
	"compress/gzip"
	"testing"

	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/pmetric/pmetricotlp"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
)

func FuzzDecodeTracesJSON(f *testing.F)   { fuzzDecode(f, SignalTraces, "application/json") }
func FuzzDecodeTracesProto(f *testing.F)  { fuzzDecode(f, SignalTraces, "application/x-protobuf") }
func FuzzDecodeLogsJSON(f *testing.F)     { fuzzDecode(f, SignalLogs, "application/json") }
func FuzzDecodeLogsProto(f *testing.F)    { fuzzDecode(f, SignalLogs, "application/x-protobuf") }
func FuzzDecodeMetricsJSON(f *testing.F)  { fuzzDecode(f, SignalMetrics, "application/json") }
func FuzzDecodeMetricsProto(f *testing.F) { fuzzDecode(f, SignalMetrics, "application/x-protobuf") }

func FuzzDecodeGzip(f *testing.F) {
	f.Add(gzSeed([]byte(`{"resourceLogs":[]}`)))
	f.Add(gzSeed(seeds(SignalLogs, "application/json")[0]))
	f.Add([]byte("not gzip"))
	f.Fuzz(func(t *testing.T, b []byte) {
		_, _ = decodeBody(SignalLogs, "application/json", "gzip", bytes.NewReader(b), 512<<10, 5<<20)
	})
}

// fuzzDecode checks that decoding never panics and that a successful decode
// re-encodes to a payload that decodes to the same record count.
func fuzzDecode(f *testing.F, sig Signal, ctype string) {
	for _, s := range seeds(sig, ctype) {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		d, err := decodeBody(sig, ctype, "", bytes.NewReader(b), 512<<10, 5<<20)
		if err != nil {
			return
		}
		again, err := decodeBody(sig, ctype, "", bytes.NewReader(reencode(t, sig, d)), 1<<30, 1<<30)
		if err != nil {
			t.Fatalf("re-encoded payload does not decode: %v", err)
		}
		if count(sig, d) != count(sig, again) {
			t.Fatalf("record count changed across a round trip")
		}
	})
}

// seeds returns one small valid request for the signal in the encoding
// ctype names, an empty request, and the empty JSON object.
func seeds(sig Signal, ctype string) [][]byte {
	isJSON := ctype == "application/json"
	var full, empty []byte
	var err error
	switch sig {
	case SignalTraces:
		full, err = marshalAs(ptraceotlp.NewExportRequestFromTraces(sampleTraces()), isJSON)
		if err == nil {
			empty, err = marshalAs(ptraceotlp.NewExportRequest(), isJSON)
		}
	case SignalLogs:
		full, err = marshalAs(plogotlp.NewExportRequestFromLogs(sampleLogs()), isJSON)
		if err == nil {
			empty, err = marshalAs(plogotlp.NewExportRequest(), isJSON)
		}
	default:
		full, err = marshalAs(pmetricotlp.NewExportRequestFromMetrics(sampleMetrics()), isJSON)
		if err == nil {
			empty, err = marshalAs(pmetricotlp.NewExportRequest(), isJSON)
		}
	}
	if err != nil {
		panic(err)
	}
	return [][]byte{full, empty, []byte("{}")}
}

// otlpRequest is the marshalling half of the pdata export requests.
type otlpRequest interface {
	MarshalJSON() ([]byte, error)
	MarshalProto() ([]byte, error)
}

func marshalAs(req otlpRequest, isJSON bool) ([]byte, error) {
	if isJSON {
		return req.MarshalJSON()
	}
	return req.MarshalProto()
}

// reencode marshals d back in the encoding it was decoded from.
func reencode(t *testing.T, sig Signal, d decoded) []byte {
	t.Helper()
	var req otlpRequest
	switch sig {
	case SignalTraces:
		req = ptraceotlp.NewExportRequestFromTraces(d.traces)
	case SignalLogs:
		req = plogotlp.NewExportRequestFromLogs(d.logs)
	default:
		req = pmetricotlp.NewExportRequestFromMetrics(d.metrics)
	}
	b, err := marshalAs(req, d.json)
	if err != nil {
		t.Fatalf("re-encoding: %v", err)
	}
	return b
}

func gzSeed(b []byte) []byte {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	_, _ = w.Write(b)
	_ = w.Close()
	return buf.Bytes()
}
