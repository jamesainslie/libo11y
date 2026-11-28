// Package gatewaybin builds o11yrum-gateway from this checkout, runs it for
// a test, and posts fixture traffic to it as a browser would. The catalog
// test and the integration test share it, so both always exercise the
// gateway in the same checkout as the pack.
package gatewaybin

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jamesainslie/libo11y/ops/internal/fixture"
)

// UserAgent is the desktop Chrome user agent fixture traffic is sent with,
// so the gateway derives a browser family and a device class.
const UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

// Build builds o11yrum-gateway from go/o11yrum in this checkout and returns
// its path, or returns O11YRUM_GATEWAY_BIN when it is set. It skips the
// test when go is not on PATH.
func Build(t testing.TB) string {
	t.Helper()
	if bin := os.Getenv("O11YRUM_GATEWAY_BIN"); bin != "" {
		return bin
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go is not on PATH, so the gateway cannot be built; set O11YRUM_GATEWAY_BIN")
	}
	src, err := moduleDir()
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "o11yrum-gateway")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "go", "build", "-C", src, "-o", bin, "./cmd/o11yrum-gateway")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build o11yrum-gateway: %v\n%s", err, out)
	}
	return bin
}

// moduleDir finds go/o11yrum from this source file, so Build works from any
// package's test directory.
func moduleDir() (string, error) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return "", errors.New("gatewaybin: cannot locate its own source file")
	}
	dir := filepath.Join(filepath.Dir(file), "..", "..", "..", "go", "o11yrum")
	if _, err := os.Stat(filepath.Join(dir, "go.mod")); err != nil {
		return "", fmt.Errorf("gatewaybin: the gateway module is not at %s: %w", dir, err)
	}
	return dir, nil
}

// Options say how a gateway process runs.
type Options struct {
	// Config is the path of the gateway's YAML configuration.
	Config string
	// PromHost and PromPort are where the gateway's Prometheus reader
	// listens.
	PromHost string
	PromPort int
	// Budget bounds the whole life of the process, so a hung test cannot
	// leave it running. Zero means three minutes. Start also ends it 30
	// seconds before the test's own deadline.
	Budget time.Duration
}

// Process is one running gateway.
type Process struct {
	// Addr is the address the gateway serves its public handler on.
	Addr string

	cmd    *exec.Cmd
	cancel context.CancelFunc
	ctx    context.Context
	budget time.Duration
	done   chan struct{} // closed when stderr is fully read
	log    *syncBuffer

	stopOnce sync.Once
	stopErr  error
}

// Start launches the gateway and stops it when the test ends, failing the
// test when it cannot start or does not exit cleanly. The budget ends
// before the test's deadline, because a test binary that times out never
// runs its cleanups.
func Start(t testing.TB, bin string, o Options) *Process {
	t.Helper()
	if dl, ok := t.(interface{ Deadline() (time.Time, bool) }); ok {
		if d, ok := dl.Deadline(); ok {
			left := max(time.Until(d)-30*time.Second, time.Second)
			if o.Budget == 0 || left < o.Budget {
				o.Budget = left
			}
		}
	}
	p, err := Launch(bin, o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := p.Stop(); err != nil {
			t.Error(err)
		}
	})
	return p
}

// Launch starts the gateway and waits until it logs the address it
// listens on. The caller's own OTEL_* settings would change what the
// gateway exports, so only a Prometheus reader and no trace or log export
// reach it.
func Launch(bin string, o Options) (*Process, error) {
	budget := o.Budget
	if budget == 0 {
		budget = 3 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	cmd := exec.CommandContext(ctx, bin, "-config", o.Config)
	cmd.Env = append(slices.DeleteFunc(os.Environ(), func(kv string) bool { return strings.HasPrefix(kv, "OTEL_") }),
		"OTEL_METRICS_EXPORTER=prometheus",
		"OTEL_EXPORTER_PROMETHEUS_HOST="+o.PromHost,
		"OTEL_EXPORTER_PROMETHEUS_PORT="+strconv.Itoa(o.PromPort),
		"OTEL_TRACES_EXPORTER=none",
		"OTEL_LOGS_EXPORTER=none",
	)
	killWithParent(cmd)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	p := &Process{cmd: cmd, cancel: cancel, ctx: ctx, budget: budget, done: make(chan struct{}), log: &syncBuffer{}}
	listening := make(chan string, 1)
	go p.read(stderr, listening)
	select {
	case p.Addr = <-listening:
		return p, nil
	case <-p.done:
		_ = cmd.Wait() // the exit is reported with the log below
		cancel()
		return nil, fmt.Errorf("the gateway exited before listening:\n%s", p.log.String())
	case <-time.After(30 * time.Second):
		_ = p.Stop() // the timeout is the error worth reporting
		return nil, fmt.Errorf("the gateway did not start listening:\n%s", p.log.String())
	}
}

// read copies stderr into the log and sends the listening address once.
func (p *Process) read(stderr io.Reader, listening chan<- string) {
	defer close(p.done)
	const prefix = "o11yrum-gateway: listening on "
	sc := bufio.NewScanner(stderr)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		p.log.WriteLine(line)
		if a, ok := strings.CutPrefix(line, prefix); ok {
			select {
			case listening <- a:
			default:
			}
		}
	}
	if err := sc.Err(); err != nil {
		p.log.WriteLine("(reading stderr: " + err.Error() + ")")
	}
	// Keep draining, so the gateway never blocks on a full pipe.
	_, _ = io.Copy(io.Discard, stderr)
}

// Log is everything the gateway wrote to stderr so far.
func (p *Process) Log() string { return p.log.String() }

// stopGrace is how long Stop waits after SIGINT before it kills the
// gateway.
const stopGrace = 30 * time.Second

// Stop sends SIGINT, waits for the gateway to drain and exit, and reports
// an unclean exit or a kill by the process budget. A gateway that has not
// exited stopGrace after SIGINT is killed. Later calls return the first
// call's result.
func (p *Process) Stop() error {
	p.stopOnce.Do(func() { p.stopErr = p.stop() })
	return p.stopErr
}

func (p *Process) stop() error {
	defer p.cancel()
	_ = p.cmd.Process.Signal(os.Interrupt) // an exited process is reported by Wait
	select {
	case <-p.done:
	case <-time.After(stopGrace):
		_ = p.cmd.Process.Kill() // Wait reports the kill
		<-p.done
	}
	err := p.cmd.Wait()
	if err != nil && p.ctx.Err() != nil {
		return fmt.Errorf("the gateway outlived its %s budget and was killed:\n%s", p.budget, p.log.String())
	}
	if err != nil {
		return fmt.Errorf("the gateway exited with %w:\n%s", err, p.log.String())
	}
	return nil
}

// syncBuffer collects the gateway's stderr for failure messages.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) WriteLine(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.b.WriteString(line)
	s.b.WriteByte('\n')
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// Post sends one fixture request as a browser on the fixture's origin
// would, behind a loopback edge that forwards the client address and
// country, and checks the status. sent_at is the wall clock at sending,
// so the gateway never shifts back-dated records for clock skew. h
// overrides the default headers.
func Post(t testing.TB, addr string, r fixture.Request, h http.Header, want int) {
	t.Helper()
	target := fmt.Sprintf("http://%s%s?sent_at=%d", addr, r.Path, time.Now().UnixMilli())
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, target, bytes.NewReader(r.Body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", fixture.Origin)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("CF-IPCountry", "CA")
	req.Header.Set("X-Forwarded-For", "203.0.113.5")
	maps.Copy(req.Header, h)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close() // the body is read; a close error changes nothing
	if err != nil {
		t.Fatalf("POST %s: read the response: %v", r.Path, err)
	}
	if resp.StatusCode != want {
		t.Fatalf("POST %s: %d, want %d: %s", r.Path, resp.StatusCode, want, body)
	}
}
