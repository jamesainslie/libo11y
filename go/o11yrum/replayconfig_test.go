package o11yrum

import (
	"context"
	"strings"
	"testing"
	"time"
)

const replayApp = "apps:\n  - service_name: shop-web\n    origins: [https://shop.example]\n    replay: {enabled: true}\n"

func TestReplayDefaults(t *testing.T) {
	cfg, err := ParseConfig([]byte(replayApp))
	if err != nil {
		t.Fatal(err)
	}
	r := cfg.Replay
	if r.MaxBodyBytes != 1<<20 || r.MaxDecompressedBytes != 16<<20 || r.MaxEvents != 20000 {
		t.Fatalf("defaults %+v", r)
	}
	a := cfg.Apps[0]
	if !a.Replay.Enabled || a.Replay.UnmaskedText {
		t.Fatalf("app replay %+v", a.Replay)
	}
	if ns := a.replayNamespace(); ns != "shop-web" {
		t.Fatalf("namespace %q", ns)
	}
	off, err := ParseConfig([]byte("apps:\n  - service_name: a\n    origins: [https://a.example]\n"))
	if err != nil {
		t.Fatal(err)
	}
	if off.Apps[0].Replay.Enabled {
		t.Fatal("replay is on without being asked for")
	}
}

func TestReplayValidation(t *testing.T) {
	for name, tc := range map[string]struct{ yaml, want string }{
		"bad namespace":      {"apps:\n  - service_name: a\n    origins: [https://a.example]\n    replay: {enabled: true, namespace: ../x}\n", "replay.namespace"},
		"service needs ns":   {"apps:\n  - service_name: a/b\n    origins: [https://a.example]\n    replay: {enabled: true}\n", "set replay.namespace"},
		"negative body":      {"replay: {max_body_bytes: -1}\n" + replayApp, "replay.max_body_bytes"},
		"negative events":    {"replay: {max_events: -1}\n" + replayApp, "replay.max_events"},
		"inverted caps":      {"replay: {max_body_bytes: 100, max_decompressed_bytes: 10}\n" + replayApp, "replay.max_decompressed_bytes"},
		"unknown replay key": {"replay: {bogus: 1}\n" + replayApp, "bogus"},
		"unknown app key":    {"apps:\n  - service_name: a\n    origins: [https://a.example]\n    replay: {enabled: true, unmask: true}\n", "unmask"},
	} {
		_, err := ParseConfig([]byte(tc.yaml))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err %v, want it to mention %q", name, err, tc.want)
		}
	}
	// A namespace is checked only for an app that records.
	if _, err := ParseConfig([]byte("apps:\n  - service_name: a/b\n    origins: [https://a.example]\n")); err != nil {
		t.Errorf("an app without replay needs no namespace: %v", err)
	}
	if _, err := ParseConfig([]byte("apps:\n  - service_name: a/b\n    origins: [https://a.example]\n    replay: {enabled: true, namespace: shop}\n")); err != nil {
		t.Errorf("an explicit namespace: %v", err)
	}
}

func TestReplayConfigClone(t *testing.T) {
	cfg, err := ParseConfig([]byte(replayApp))
	if err != nil {
		t.Fatal(err)
	}
	c := cfg.clone()
	c.Apps[0].Replay.UnmaskedText = true
	if cfg.Apps[0].Replay.UnmaskedText {
		t.Fatal("clone shares the app's replay settings")
	}
}

func TestReplayKeys(t *testing.T) {
	const session = "0b7e5c1e-6f2a-4c55-9b1e-1f2d3c4b5a69"
	if got := replayKey("shop-web", session, 7); got != "replay/shop-web/"+session+"/000007.json.gz" {
		t.Fatal(got)
	}
	if got := replayMetaKey("shop-web", session, 7); got != "replay/shop-web/"+session+"/000007.meta.json" {
		t.Fatal(got)
	}
	if got := replayKey("shop-web", session, 999999); !strings.HasSuffix(got, "/999999.json.gz") {
		t.Fatal(got)
	}
	for s, want := range map[string]bool{
		session:                                true,
		"0B7E5C1E-6F2A-4C55-9B1E-1F2D3C4B5A69": false,
		"0b7e5c1e6f2a4c559b1e1f2d3c4b5a69":     false,
		session + " ":                          false,
		"0b7e5c1e-6f2a-4c55-9b1e-1f2d3c4b5a6g": false,
		"../x":                                 false,
		"":                                     false,
	} {
		if validSessionID(s) != want {
			t.Errorf("%q: want %v", s, want)
		}
	}
}

// putGetOnly is a store without List and Delete.
type putGetOnly struct{}

func (putGetOnly) Put(context.Context, string, []byte) error { return nil }
func (putGetOnly) Get(context.Context, string) ([]byte, error) {
	return nil, ErrNotFound
}

func TestNewHandlerRefusesReplayWithoutListingStore(t *testing.T) {
	cfg, err := ParseConfig([]byte(replayApp))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewHandler(WithConfig(cfg), WithObjectStore(putGetOnly{})); err == nil || !strings.Contains(err.Error(), "List and Delete") {
		t.Fatalf("store without List and Delete: %v", err)
	}
	if _, err := NewHandler(WithConfig(cfg)); err == nil || !strings.Contains(err.Error(), "object store") {
		t.Fatalf("no store: %v", err)
	}
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(WithConfig(cfg), WithObjectStore(store))
	if err != nil {
		t.Fatal(err)
	}
	if ns := h.apps["shop-web"].replayNS; ns != "shop-web" {
		t.Fatalf("replayNS %q", ns)
	}
}

func TestReplayMaxConcurrent(t *testing.T) {
	cfg, err := ParseConfig([]byte(replayApp))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Replay.MaxConcurrent != 8 {
		t.Fatalf("default %d", cfg.Replay.MaxConcurrent)
	}
	if _, err := ParseConfig([]byte("replay: {max_concurrent: -1}\n" + replayApp)); err == nil || !strings.Contains(err.Error(), "replay.max_concurrent") {
		t.Fatalf("negative: %v", err)
	}
}

func TestReplayRetentionDefaults(t *testing.T) {
	cfg, err := ParseConfig([]byte(replayApp))
	if err != nil {
		t.Fatal(err)
	}
	r := cfg.Replay
	if r.Retention != 720*time.Hour {
		t.Errorf("retention %v, want 720h", r.Retention)
	}
	if r.SweepInterval == nil || *r.SweepInterval != time.Hour {
		t.Errorf("sweep interval %v, want 1h", r.SweepInterval)
	}
	if r.sweepEvery() != time.Hour {
		t.Errorf("sweepEvery %v", r.sweepEvery())
	}
	if r.ReadListen != "" || r.ReadTokenFile != "" {
		t.Errorf("the read API is on by default: %+v", r)
	}
	off, err := ParseConfig([]byte("replay: {sweep_interval: 0s, retention: 48h}\n" + replayApp))
	if err != nil {
		t.Fatal(err)
	}
	if off.Replay.sweepEvery() != 0 || off.Replay.Retention != 48*time.Hour {
		t.Errorf("explicit values %+v", off.Replay)
	}
	// A Config built in code takes the defaults for zero fields too.
	code := &Config{Apps: []AppConfig{{ServiceName: "a", AllowMissingOrigin: true}}}
	code.applyDefaults()
	if code.Replay.Retention != 720*time.Hour || code.Replay.sweepEvery() != time.Hour {
		t.Errorf("code-built defaults %+v", code.Replay)
	}
}

func TestReplayReadValidation(t *testing.T) {
	for name, tc := range map[string]struct{ yaml, want string }{
		"negative retention":    {"replay: {retention: -1h}\n" + replayApp, "replay.retention"},
		"negative sweep":        {"replay: {sweep_interval: -1m}\n" + replayApp, "replay.sweep_interval"},
		"listen without tokens": {"replay: {read_listen: \"127.0.0.1:9090\"}\n" + replayApp, "replay.read_token_file"},
		"same as listen":        {"listen: \":8080\"\nreplay: {read_listen: \":8080\", read_token_file: t}\n" + replayApp, "replay.read_listen"},
		"default listen":        {"replay: {read_listen: \"0.0.0.0:8080\", read_token_file: t}\n" + replayApp, "listen"},
		"wildcard ingest":       {"listen: \":9000\"\nreplay: {read_listen: \"127.0.0.1:9000\", read_token_file: t}\n" + replayApp, "replay.read_listen"},
		"wildcard read":         {"listen: \"10.0.0.5:9000\"\nreplay: {read_listen: \"[::]:9000\", read_token_file: t}\n" + replayApp, "replay.read_listen"},
		"bad read address":      {"replay: {read_listen: \"no-port\", read_token_file: t}\n" + replayApp, "replay.read_listen"},
	} {
		_, err := ParseConfig([]byte(tc.yaml))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err %v, want it to mention %q", name, err, tc.want)
		}
	}
	for name, yaml := range map[string]string{
		"own port":       "listen: \":8080\"\nreplay: {read_listen: \"127.0.0.1:9090\", read_token_file: t}\n" + replayApp,
		"both ephemeral": "listen: \"127.0.0.1:0\"\nreplay: {read_listen: \"127.0.0.1:0\", read_token_file: t}\n" + replayApp,
		"other host":     "listen: \"10.0.0.5:8080\"\nreplay: {read_listen: \"127.0.0.1:8080\", read_token_file: t}\n" + replayApp,
	} {
		if _, err := ParseConfig([]byte(yaml)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestReplayConfigCloneSweepInterval(t *testing.T) {
	every := time.Minute
	cfg := &Config{Replay: ReplayConfig{SweepInterval: &every}}
	c := cfg.clone()
	*c.Replay.SweepInterval = time.Hour
	if every != time.Minute {
		t.Fatal("clone shares the sweep interval")
	}
}
