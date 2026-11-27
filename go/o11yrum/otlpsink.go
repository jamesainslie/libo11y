package o11yrum

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"strings"
	"time"

	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
)

// OTLPSinkConfig configures the built-in OTLP/HTTP sink.
type OTLPSinkConfig struct {
	// Endpoint is the collector's base URL, such as
	// http://collector:4318. The sink appends /v1/traces and /v1/logs.
	Endpoint string `yaml:"endpoint"`
	// Headers are sent with every request, such as a tenant header.
	Headers map[string]string `yaml:"headers"`
	// Timeout bounds one export. Default 5s.
	Timeout time.Duration `yaml:"timeout"`
	// Compression is "gzip" (the default) or "none".
	Compression string `yaml:"compression"`
}

// SinksConfig configures the built-in sinks.
type SinksConfig struct {
	// OTLP is the OTLP/HTTP sink. An empty endpoint leaves it to the
	// command to decide.
	OTLP OTLPSinkConfig `yaml:"otlp"`
}

// defaultOTLPTimeout bounds one export when the config sets no timeout.
const defaultOTLPTimeout = 5 * time.Second

// maxCollectorResponse caps how much of a collector's answer is read, so
// the connection can be reused without trusting the collector's size.
const maxCollectorResponse = 64 << 10

// OTLPSink posts batches to an OTLP/HTTP collector as protobuf.
type OTLPSink struct {
	base    string
	headers map[string]string
	gzip    bool
	client  *http.Client
}

var _ Sink = (*OTLPSink)(nil)

// NewOTLPSink validates cfg and returns a sink for it.
func NewOTLPSink(cfg OTLPSinkConfig) (*OTLPSink, error) {
	if cfg.Endpoint == "" {
		return nil, errors.New("o11yrum: otlp sink: endpoint is empty")
	}
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("o11yrum: otlp sink: endpoint %q is not an http or https URL", cfg.Endpoint)
	}
	switch cfg.Compression {
	case "", "gzip", "none":
	default:
		return nil, fmt.Errorf("o11yrum: otlp sink: compression %q must be gzip or none", cfg.Compression)
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = defaultOTLPTimeout
	}
	return &OTLPSink{
		base:    strings.TrimRight(cfg.Endpoint, "/"),
		headers: maps.Clone(cfg.Headers),
		gzip:    cfg.Compression != "none",
		client:  &http.Client{Timeout: timeout, Transport: newCollectorTransport()},
	}, nil
}

// maxIdleCollectorConns is how many idle connections the sink keeps to its
// one collector. net/http's default of two would open and close a
// connection for nearly every export under load.
const maxIdleCollectorConns = 100

func newCollectorTransport() *http.Transport {
	tr := http.DefaultTransport.(*http.Transport).Clone() //nolint:forcetypeassert // the standard library's default
	tr.MaxIdleConns = maxIdleCollectorConns
	tr.MaxIdleConnsPerHost = maxIdleCollectorConns
	return tr
}

// Close closes the sink's idle connections. Call it after the last
// export.
func (s *OTLPSink) Close() error {
	s.client.CloseIdleConnections()
	return nil
}

// Name returns "otlp".
func (s *OTLPSink) Name() string { return "otlp" }

// Export posts b to the collector. Any answer other than 2xx is an error.
func (s *OTLPSink) Export(ctx context.Context, b Batch) error {
	var (
		body []byte
		err  error
		path string
	)
	switch b.Signal {
	case SignalTraces:
		path = "/v1/traces"
		body, err = ptraceotlp.NewExportRequestFromTraces(b.Traces).MarshalProto()
	case SignalLogs:
		path = "/v1/logs"
		body, err = plogotlp.NewExportRequestFromLogs(b.Logs).MarshalProto()
	default:
		return fmt.Errorf("signal %q is not exported", b.Signal)
	}
	if err != nil {
		return fmt.Errorf("encoding the batch: %w", err)
	}
	if s.gzip {
		if body, err = gzipBytes(body); err != nil {
			return fmt.Errorf("compressing the batch: %w", err)
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.base+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	for k, v := range s.headers {
		req.Header.Set(k, v)
	}
	req.Header.Set("Content-Type", "application/x-protobuf")
	if s.gzip {
		req.Header.Set("Content-Encoding", "gzip")
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxCollectorResponse))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("collector answered %s", resp.Status)
	}
	return nil
}

func gzipBytes(b []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(b); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
