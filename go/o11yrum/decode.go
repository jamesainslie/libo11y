package o11yrum

import (
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"mime"
	"strings"

	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/pmetric/pmetricotlp"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
)

// decoded is one OTLP request body. Only the field of the request's signal
// is set.
type decoded struct {
	json    bool // the request was OTLP/JSON, so the response is too
	traces  ptrace.Traces
	logs    plog.Logs
	metrics pmetric.Metrics
}

var (
	errContentType          = errors.New("unsupported content type")
	errEncoding             = errors.New("unsupported content encoding")
	errTooLarge             = errors.New("request body too large")
	errDecompressedTooLarge = errors.New("decompressed body too large")
	errDecode               = errors.New("malformed OTLP payload")
)

// decodeBody reads one OTLP/HTTP request body. The compressed cap is
// enforced while reading, and the decompressed cap while inflating, so a
// gzip bomb stops at maxInflated bytes.
func decodeBody(sig Signal, contentType, encoding string, body io.Reader, maxBody, maxInflated int64) (decoded, error) {
	mt, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return decoded{}, errContentType
	}
	var isJSON bool
	switch mt {
	case "application/json":
		isJSON = true
	case "application/x-protobuf", "application/protobuf":
	default:
		return decoded{}, errContentType
	}
	raw, err := readCapped(body, encoding, maxBody, maxInflated)
	if err != nil {
		return decoded{}, err
	}
	d := decoded{json: isJSON}
	switch sig {
	case SignalTraces:
		req := ptraceotlp.NewExportRequest()
		err = unmarshal(req.UnmarshalJSON, req.UnmarshalProto, isJSON, raw)
		d.traces = req.Traces()
	case SignalLogs:
		req := plogotlp.NewExportRequest()
		err = unmarshal(req.UnmarshalJSON, req.UnmarshalProto, isJSON, raw)
		d.logs = req.Logs()
	case SignalMetrics:
		req := pmetricotlp.NewExportRequest()
		err = unmarshal(req.UnmarshalJSON, req.UnmarshalProto, isJSON, raw)
		d.metrics = req.Metrics()
	default:
		return decoded{}, fmt.Errorf("%w: unknown signal %q", errDecode, sig)
	}
	if err != nil {
		return decoded{}, fmt.Errorf("%w: %w", errDecode, err)
	}
	return d, nil
}

// readCapped reads a request body with an optional gzip encoding. The
// body as sent may hold at most maxBody bytes, and at most maxInflated
// once inflated, so a gzip bomb stops at maxInflated bytes.
func readCapped(body io.Reader, encoding string, maxBody, maxInflated int64) ([]byte, error) {
	var inflate bool
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "", "identity":
	case "gzip", "x-gzip":
		inflate = true
	default:
		return nil, errEncoding
	}
	raw, err := io.ReadAll(io.LimitReader(body, maxBody+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errDecode, err)
	}
	if int64(len(raw)) > maxBody {
		return nil, errTooLarge
	}
	if inflate {
		return gunzip(raw, maxInflated)
	}
	if int64(len(raw)) > maxInflated {
		return nil, errDecompressedTooLarge
	}
	return raw, nil
}

// gunzip inflates raw, refusing more than maxInflated bytes of output.
func gunzip(raw []byte, maxInflated int64) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errDecode, err)
	}
	inflated, err := io.ReadAll(io.LimitReader(zr, maxInflated+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errDecode, err)
	}
	if int64(len(inflated)) > maxInflated {
		return nil, errDecompressedTooLarge
	}
	return inflated, nil
}

func unmarshal(fromJSON, fromProto func([]byte) error, isJSON bool, raw []byte) error {
	if isJSON {
		return fromJSON(raw)
	}
	return fromProto(raw)
}
