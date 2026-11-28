//go:build opsintegration

package ops_test

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/common/model"
	"gopkg.in/yaml.v3"

	"github.com/jamesainslie/libo11y/ops/internal/fixture"
	"github.com/jamesainslie/libo11y/ops/internal/gatewaybin"
	"github.com/jamesainslie/libo11y/ops/internal/lint"
)

// The backends ops/test/compose.yaml publishes on loopback.
const (
	grafanaURL    = "http://127.0.0.1:13000"
	prometheusURL = "http://127.0.0.1:19090"
	lokiURL       = "http://127.0.0.1:13100"
	tempoURL      = "http://127.0.0.1:13200"
	collectorURL  = "http://127.0.0.1:13133"
	// gatewayPromPort is where Prometheus (ops/test/prometheus.yml)
	// scrapes the gateway's Prometheus reader.
	gatewayPromPort = 19464
)

// The second session the browser check opens. Its one view has an ID with
// characters a URL query must escape, so the explorer's data link shows
// whether Grafana percent-encodes it once.
const (
	browserSession = "ops-it-browser-session"
	browserViewID  = "v2 a&b/c"
)

// The windows Grafana gives a panel query. dsQuery sends intervalMs as
// grafanaStep, so Grafana steps range queries every 15s and floors the
// range's end to a step: the last point it evaluates can be up to one step
// before now. ops/datasources/example.yaml sets no timeInterval, so
// Grafana assumes a 15s scrape interval, whatever Prometheus really
// scrapes at, and resolves $__rate_interval from it. dsQuery asks for the
// last hour.
const (
	grafanaStep           = 15 * time.Second
	grafanaScrapeInterval = 15 * time.Second
	grafanaRateInterval   = max(grafanaStep+grafanaScrapeInterval, 4*grafanaScrapeInterval)
	grafanaRange          = time.Hour
)

// grafanaWindows are the values Grafana gives its built-in window variables
// in dsQuery's queries.
var grafanaWindows = map[string]string{
	"__rate_interval":    model.Duration(grafanaRateInterval).String(),
	"__rate_interval_ms": strconv.FormatInt(grafanaRateInterval.Milliseconds(), 10),
	"__interval":         model.Duration(grafanaStep).String(),
	"__interval_ms":      strconv.FormatInt(grafanaStep.Milliseconds(), 10),
	"__range":            model.Duration(grafanaRange).String(),
	"__range_s":          strconv.FormatInt(int64(grafanaRange.Seconds()), 10),
	"__range_ms":         strconv.FormatInt(grafanaRange.Milliseconds(), 10),
}

// client bounds every call to a backend, so one hung request fails the
// test long before go test's own timeout.
var client = &http.Client{Timeout: 15 * time.Second}

// grafanaBuiltins are the built-in variables Grafana fills in itself when
// it runs a query. The test leaves them for Grafana, so the windows a
// panel really gets, such as $__rate_interval from the scrape interval, are
// the ones tested.
var grafanaBuiltins = []string{"__rate_interval", "__interval", "__interval_ms", "__range", "__range_s", "__range_ms"}

// The datasource UIDs ops/datasources/example.yaml provisions.
var datasourceUIDs = map[string]string{"prometheus": "prometheus", "loki": "loki", "tempo": "tempo"}

// mustHaveData lists the panels the fixture traffic must light up, by
// dashboard UID and panel title. Every other panel must answer without an
// error, but may be empty.
var mustHaveData = map[string][]string{
	"libo11y-rum-overview": {"Views per minute", "Errors by source", "LCP p75"},
	"libo11y-rum-vitals":   {"LCP p75"},
	"libo11y-rum-errors":   {"Error inbox (kept sessions)", "Sessions with errors or frustration"},
	"libo11y-rum-session-explorer": {
		"Views in this session", "Traces in this session", "Session timeline",
		"Spans of the selected view", "Events of the selected view",
	},
	"libo11y-rum-gateway": {"Requests per second", "Sink latency"},
}

// TestIntegration runs the gateway built from this checkout in front of
// the backends in ops/test/compose.yaml, sends it three sessions of fixture
// traffic, and then checks the pack as an operator installs it: Loki keeps
// session and view IDs out of its index, Grafana provisions every
// dashboard, every panel query answers through Grafana's query API, the
// panels the fixture covers show data, and Prometheus loads every rule.
// The browser subtest checks what only Grafana's frontend does: the
// explorer's data link and its app variable.
//
// It needs the compose environment; run it with make ops-integration.
func TestIntegration(t *testing.T) {
	for name, u := range map[string]string{
		"loki":       lokiURL + "/ready",
		"tempo":      tempoURL + "/ready",
		"prometheus": prometheusURL + "/-/ready",
		"grafana":    grafanaURL + "/api/health",
		"collector":  collectorURL + "/",
	} {
		waitFor(t, name+" ready", 3*time.Minute, func() (bool, string) {
			status, body, err := get(u)
			if err != nil {
				return false, err.Error()
			}
			return status == http.StatusOK, fmt.Sprintf("%d %s", status, body)
		})
	}

	bin := gatewaybin.Build(t)
	gw := gatewaybin.Start(t, bin, gatewaybin.Options{
		Config:   "test/gateway.yaml",
		PromHost: "0.0.0.0",
		PromPort: gatewayPromPort,
		Budget:   9 * time.Minute,
	})

	// Three sessions a minute apart, so range queries have more than one
	// point. The counters must move between scrapes for rates and
	// quantiles to have a value, so the first session is scraped before
	// the others are sent. The last session is the one the explorer opens;
	// it ends before now, so every record is inside the query range. The
	// gateway serves its Prometheus reader on every interface, because
	// Prometheus scrapes it from a container through host-gateway; a host
	// firewall that blocks the Docker bridge makes the first wait time out.
	now := time.Now()
	send(t, gw.Addr, fixture.TrafficFor(now.Add(-2*time.Minute), newSessionID(t)))
	first := waitForValue(t, `sum(o11y_rum_views_total{service_name="shop-web"})`, 0, 0)
	send(t, gw.Addr, fixture.TrafficFor(now.Add(-time.Minute), newSessionID(t)))
	send(t, gw.Addr, fixture.TrafficFor(now.Add(-15*time.Second), fixture.SessionID))
	send(t, gw.Addr, []fixture.Request{fixture.ViewSummary(now.Add(-10*time.Second), browserSession, browserViewID)})
	// Two more sessions with as many views as the first, and one more view.
	waitForValue(t, `sum(o11y_rum_views_total{service_name="shop-web"})`, 3*first, 0)

	waitFor(t, "the session's events in Loki", 90*time.Second, func() (bool, string) {
		n, detail := lokiLines(t, fmt.Sprintf(`{service_name="shop-web"} | session_id=%q`, fixture.SessionID), now)
		return n > 0, detail
	})
	waitFor(t, "the browser session's view in Loki", 90*time.Second, func() (bool, string) {
		n, detail := lokiLines(t, fmt.Sprintf(`{service_name="shop-web"} | session_id=%q`, browserSession), now)
		return n > 0, detail
	})
	waitFor(t, "the session's traces in Tempo", 90*time.Second, func() (bool, string) {
		q := url.Values{"q": {fmt.Sprintf(`{ span.session.id = %q }`, fixture.SessionID)}}
		var r struct {
			Traces []json.RawMessage `json:"traces"`
		}
		detail, err := getJSON(tempoURL+"/api/search?"+q.Encode(), &r)
		if err != nil {
			return false, err.Error()
		}
		return len(r.Traces) > 0, detail
	})

	t.Run("loki keeps session and view IDs out of the index", func(t *testing.T) {
		q := url.Values{"start": {strconv.FormatInt(now.Add(-time.Hour).UnixNano(), 10)}, "end": {strconv.FormatInt(time.Now().UnixNano(), 10)}}
		var r struct {
			Data []string `json:"data"`
		}
		if _, err := getJSON(lokiURL+"/loki/api/v1/labels?"+q.Encode(), &r); err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(r.Data, "service_name") {
			t.Errorf("Loki's labels %v lack service_name, the one label the pack selects streams by", r.Data)
		}
		for _, l := range []string{"session_id", "o11y_rum_view_id"} {
			if slices.Contains(r.Data, l) {
				t.Errorf("Loki indexes %s as a stream label (labels %v); it must stay structured metadata", l, r.Data)
			}
		}
	})

	dashboards := loadDashboards(t)
	t.Run("grafana provisions every dashboard", func(t *testing.T) {
		for _, d := range dashboards {
			var r struct {
				Dashboard struct {
					UID    string            `json:"uid"`
					Panels []json.RawMessage `json:"panels"`
				} `json:"dashboard"`
				Meta struct {
					Provisioned bool `json:"provisioned"`
				} `json:"meta"`
			}
			if _, err := getJSON(grafanaURL+"/api/dashboards/uid/"+d.UID, &r); err != nil {
				t.Errorf("%s: %v", d.UID, err)
				continue
			}
			if r.Dashboard.UID != d.UID || !r.Meta.Provisioned || len(r.Dashboard.Panels) != len(d.Panels) {
				t.Errorf("%s: Grafana has uid %q, provisioned %v and %d panels; want the file's %d panels, provisioned",
					d.UID, r.Dashboard.UID, r.Meta.Provisioned, len(r.Dashboard.Panels), len(d.Panels))
			}
		}
	})

	vars := map[string]string{
		"app": "shop-web", "platform": "web", "gateway": "o11yrum-gateway",
		"session_id": fixture.SessionID, "view_id": fixture.View0,
	}
	for name, uid := range datasourceUIDs {
		vars[name] = uid
	}
	waitForRangeSamples(t, dashboards, vars)
	for _, name := range grafanaBuiltins {
		vars[name] = "$" + name
	}
	t.Run("every panel query answers through grafana", func(t *testing.T) {
		for _, d := range dashboards {
			addAllValues(vars, d)
			want := mustHaveData[d.UID]
			seen := map[string]bool{}
			for _, p := range d.Panels {
				if len(p.Panels) > 0 {
					t.Errorf("%s: row %q is collapsed; the test walks only top-level panels", d.UID, p.Title)
				}
				if len(p.Targets) == 0 {
					continue
				}
				hasData := false
				var sent []string
				for _, target := range p.Targets {
					res, err := dsQuery(t, p, target, vars)
					if err != nil {
						t.Errorf("%s: %q: %v", d.UID, p.Title, err)
						continue
					}
					hasData = hasData || res.hasData()
					sent = append(sent, res.diagnose())
					if d.UID == "libo11y-rum-session-explorer" && p.Title == "Views in this session" {
						if got := res.labelValues("o11y_rum_view_id"); !slices.Equal(got, []string{fixture.View0, fixture.View1}) {
							t.Errorf("%s: %q: views %v, want %v and %v", d.UID, p.Title, got, fixture.View0, fixture.View1)
						}
					}
				}
				if slices.Contains(want, p.Title) {
					seen[p.Title] = true
					if !hasData {
						t.Errorf("%s: %q answered with no data; the fixture traffic should fill it\n%s", d.UID, p.Title, strings.Join(sent, "\n"))
					}
				}
			}
			for _, title := range want {
				if !seen[title] {
					t.Errorf("%s has no panel %q with a query", d.UID, title)
				}
			}
		}
	})

	t.Run("prometheus loads every rule", func(t *testing.T) {
		want := ruleGroups(t)
		waitFor(t, "every rule evaluated with health ok", 60*time.Second, func() (bool, string) {
			var r struct {
				Data struct {
					Groups []struct {
						Name  string `json:"name"`
						Rules []struct {
							Name      string `json:"name"`
							Health    string `json:"health"`
							LastError string `json:"lastError"`
						} `json:"rules"`
					} `json:"groups"`
				} `json:"data"`
			}
			if _, err := getJSON(prometheusURL+"/api/v1/rules", &r); err != nil {
				return false, err.Error()
			}
			var got []string
			var problems []string
			for _, g := range r.Data.Groups {
				got = append(got, fmt.Sprintf("%s/%d", g.Name, len(g.Rules)))
				for _, rule := range g.Rules {
					if rule.Health != "ok" {
						problems = append(problems, fmt.Sprintf("%s/%s: %s %s", g.Name, rule.Name, rule.Health, rule.LastError))
					}
				}
			}
			sort.Strings(got)
			if !slices.Equal(got, want) {
				return false, fmt.Sprintf("groups %v, want %v", got, want)
			}
			return len(problems) == 0, strings.Join(problems, "\n")
		})
	})

	t.Run("browser", func(t *testing.T) {
		checkInBrowser(t)
	})
}

// newSessionID returns a random session ID, so a rerun against the same
// backends sends sessions of its own.
func newSessionID(t *testing.T) string {
	t.Helper()
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return "ops-it-" + hex.EncodeToString(b)
}

// send posts requests to the gateway, each of which must be accepted.
func send(t *testing.T, addr string, reqs []fixture.Request) {
	t.Helper()
	for _, r := range reqs {
		gatewaybin.Post(t, addr, r, nil, http.StatusOK)
	}
}

// waitFor polls check every two seconds until it reports done, and fails
// the test with the last detail when timeout passes first.
func waitFor(t *testing.T, what string, timeout time.Duration, check func() (done bool, detail string)) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		done, detail := check()
		if done {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("waited %s for %s; last: %s", timeout, what, detail)
		}
		time.Sleep(2 * time.Second)
	}
}

// addAllValues sets each of the dashboard's variables that vars does not
// set yet to its All value.
func addAllValues(vars map[string]string, d dashboard) {
	for _, v := range d.Templating.List {
		if _, set := vars[v.Name]; !set && v.AllValue != "" {
			vars[v.Name] = v.AllValue
		}
	}
}

// waitForRangeSamples waits until every range selector in the Prometheus
// queries of the panels mustHaveData lists has at least two samples per
// series in the window Grafana gives it, evaluated one Grafana step
// before now. rate() and increase() answer only from two samples, and
// the gateway's series are as young as the fixture traffic, so without
// this wait the last point Grafana evaluates, floored to a step, can see
// only the first scrape. Grafana evaluates later, and the gateway is
// scraped continuously, so the windows Grafana evaluates hold at least
// two samples too. Waiting for every series, not only one, also checks
// that every label set the fixture sends is scraped. vars are the
// dashboard variables, expanded as the panel subtest expands them; the
// built-ins become the windows Grafana resolves.
func waitForRangeSamples(t *testing.T, dashboards []dashboard, vars map[string]string) {
	t.Helper()
	pv := maps.Clone(vars)
	maps.Copy(pv, grafanaWindows)
	var queries []string
	for _, d := range dashboards {
		addAllValues(pv, d)
		want := mustHaveData[d.UID]
		for _, p := range d.Panels {
			if !slices.Contains(want, p.Title) {
				continue
			}
			for _, target := range p.Targets {
				expr, _ := target["expr"].(string)
				if ds := targetDatasource(p, target); ds == nil || ds.Type != "prometheus" || expr == "" {
					continue
				}
				expanded, err := lint.Expand(expr, pv)
				if err != nil {
					t.Fatalf("%s: %q: %v", d.UID, p.Title, err)
				}
				qs, err := sampleCountQueries(expanded)
				if err != nil {
					t.Fatalf("%s: %q: %v", d.UID, p.Title, err)
				}
				for _, q := range qs {
					if !slices.Contains(queries, q) {
						queries = append(queries, q)
					}
				}
			}
		}
	}
	for _, q := range queries {
		waitForValue(t, q, 1, grafanaStep)
	}
}

// waitForValue waits until the Prometheus instant query, evaluated lag
// before now, returns a value above floor, and returns it.
func waitForValue(t *testing.T, query string, floor float64, lag time.Duration) float64 {
	t.Helper()
	var got float64
	what := fmt.Sprintf("%s above %g in Prometheus", query, floor)
	if lag > 0 {
		what += fmt.Sprintf(" %s before now", lag)
	}
	waitFor(t, what, 90*time.Second, func() (bool, string) {
		var r struct {
			Data struct {
				Result []struct {
					Value [2]any `json:"value"`
				} `json:"result"`
			} `json:"data"`
		}
		at := time.Now().Add(-lag)
		q := url.Values{"query": {query}, "time": {strconv.FormatFloat(float64(at.UnixMilli())/1000, 'f', 3, 64)}}
		detail, err := getJSON(prometheusURL+"/api/v1/query?"+q.Encode(), &r)
		if err != nil {
			return false, err.Error()
		}
		if len(r.Data.Result) == 0 {
			return false, detail
		}
		s, _ := r.Data.Result[0].Value[1].(string)
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return false, detail
		}
		got = v
		return v > floor, detail
	})
	return got
}

// lokiLines counts the log lines a LogQL query finds since an hour before
// now.
func lokiLines(t *testing.T, query string, now time.Time) (int, string) {
	t.Helper()
	q := url.Values{
		"query": {query},
		"start": {strconv.FormatInt(now.Add(-time.Hour).UnixNano(), 10)},
		"end":   {strconv.FormatInt(time.Now().Add(time.Minute).UnixNano(), 10)},
		"limit": {"100"},
	}
	var r struct {
		Data struct {
			Result []struct {
				Values [][2]string `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	detail, err := getJSON(lokiURL+"/loki/api/v1/query_range?"+q.Encode(), &r)
	if err != nil {
		return 0, err.Error()
	}
	n := 0
	for _, s := range r.Data.Result {
		n += len(s.Values)
	}
	return n, detail
}

// dashboard is the part of a generated dashboard the test reads.
type dashboard struct {
	UID        string  `json:"uid"`
	Panels     []panel `json:"panels"`
	Templating struct {
		List []struct {
			Name     string `json:"name"`
			AllValue string `json:"allValue"`
		} `json:"list"`
	} `json:"templating"`
}

type panel struct {
	Type       string           `json:"type"`
	Title      string           `json:"title"`
	Datasource *datasource      `json:"datasource"`
	Targets    []map[string]any `json:"targets"`
	// Panels holds the panels of a collapsed row.
	Panels []json.RawMessage `json:"panels"`
}

type datasource struct {
	Type string `json:"type"`
	UID  string `json:"uid"`
}

// loadDashboards reads every committed dashboard in ops/dashboards.
func loadDashboards(t *testing.T) []dashboard {
	t.Helper()
	files, err := filepath.Glob("dashboards/*.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("no dashboards in dashboards/")
	}
	var out []dashboard
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var d dashboard
		if err := json.Unmarshal(raw, &d); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		out = append(out, d)
	}
	return out
}

// ruleGroups lists the groups of ops/alerts/*.rules.yaml as name/rule
// count, sorted.
func ruleGroups(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob("alerts/*.rules.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var rf struct {
			Groups []struct {
				Name  string           `yaml:"name"`
				Rules []map[string]any `yaml:"rules"`
			} `yaml:"groups"`
		}
		if err := yaml.Unmarshal(raw, &rf); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		for _, g := range rf.Groups {
			out = append(out, fmt.Sprintf("%s/%d", g.Name, len(g.Rules)))
		}
	}
	sort.Strings(out)
	return out
}

// queryResult is one target's result from /api/ds/query.
type queryResult struct {
	Status int    `json:"status"`
	Error  string `json:"error"`
	Frames []struct {
		Schema struct {
			Fields []struct {
				Name   string            `json:"name"`
				Labels map[string]string `json:"labels"`
			} `json:"fields"`
		} `json:"schema"`
		Data struct {
			Values [][]any `json:"values"`
		} `json:"data"`
	} `json:"frames"`

	// sent and raw are the query as sent and Grafana's answer, for failure
	// messages.
	sent, raw string
}

// diagnose describes the query and its answer, and for Prometheus what
// Prometheus itself answers now to the query with the windows Grafana
// resolves, so an empty panel shows whether Grafana or the data is short.
func (r queryResult) diagnose() string {
	var b strings.Builder
	fmt.Fprintf(&b, "  sent: %s\n  grafana: %s", r.sent, trim(r.raw, 1500))
	var q struct {
		Datasource struct {
			Type string `json:"type"`
		} `json:"datasource"`
		Expr string `json:"expr"`
	}
	if json.Unmarshal([]byte(r.sent), &q) == nil && q.Datasource.Type == "prometheus" {
		expr, err := lint.Expand(q.Expr, grafanaWindows)
		detail := ""
		if err != nil {
			expr = q.Expr
		} else {
			var direct any
			detail, err = getJSON(prometheusURL+"/api/v1/query?"+url.Values{"query": {expr}}.Encode(), &direct)
		}
		if err != nil {
			detail = err.Error()
		}
		fmt.Fprintf(&b, "\n  prometheus %s: %s", expr, trim(detail, 1500))
	}
	return b.String()
}

func trim(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

// hasData reports whether any frame has at least one row or point.
func (r queryResult) hasData() bool {
	for _, f := range r.Frames {
		for _, col := range f.Data.Values {
			if len(col) > 0 {
				return true
			}
		}
	}
	return false
}

// labelValues lists the distinct values of a label across the result's
// fields, sorted.
func (r queryResult) labelValues(label string) []string {
	var out []string
	for _, f := range r.Frames {
		for _, field := range f.Schema.Fields {
			if v, ok := field.Labels[label]; ok && !slices.Contains(out, v) {
				out = append(out, v)
			}
		}
	}
	sort.Strings(out)
	return out
}

// dsQuery runs one panel target through Grafana's query API, with the
// dashboard's variables expanded and the datasource variable resolved to
// its provisioned UID, as the dashboard would when it renders.
func dsQuery(t *testing.T, p panel, target map[string]any, vars map[string]string) (queryResult, error) {
	t.Helper()
	q := map[string]any{}
	for k, v := range target {
		q[k] = v
	}
	ds := targetDatasource(p, target)
	if ds == nil {
		return queryResult{}, fmt.Errorf("target %v has no datasource", target["refId"])
	}
	uid, err := lint.Expand(ds.UID, vars)
	if err != nil {
		return queryResult{}, err
	}
	q["datasource"] = map[string]string{"type": ds.Type, "uid": uid}
	for _, k := range []string{"expr", "query"} {
		s, ok := q[k].(string)
		if !ok {
			continue
		}
		if q[k], err = lint.Expand(s, vars); err != nil {
			return queryResult{}, err
		}
	}
	q["intervalMs"] = grafanaStep.Milliseconds()
	q["maxDataPoints"] = 500
	body, err := json.Marshal(map[string]any{"queries": []any{q}, "from": "now-1h", "to": "now"})
	if err != nil {
		return queryResult{}, err
	}
	status, resp, err := post(grafanaURL+"/api/ds/query", body)
	if err != nil {
		return queryResult{}, err
	}
	ref, _ := target["refId"].(string)
	var r struct {
		Results map[string]queryResult `json:"results"`
	}
	if err := json.Unmarshal(resp, &r); err != nil {
		return queryResult{}, fmt.Errorf("HTTP %d, not JSON: %s", status, resp)
	}
	res, ok := r.Results[ref]
	if sent, err := json.Marshal(q); err == nil {
		res.sent = string(sent)
	}
	res.raw = string(resp)
	if status != http.StatusOK || !ok || res.Error != "" {
		query := q["expr"]
		if query == nil {
			query = q["query"]
		}
		return res, fmt.Errorf("HTTP %d for %s %q: %s", status, ds.Type, query, resp)
	}
	return res, nil
}

// targetDatasource is the datasource a target queries: its own, or else
// the panel's. It is nil when neither sets one.
func targetDatasource(p panel, target map[string]any) *datasource {
	if raw, ok := target["datasource"].(map[string]any); ok {
		typ, _ := raw["type"].(string)
		uid, _ := raw["uid"].(string)
		return &datasource{Type: typ, UID: uid}
	}
	return p.Datasource
}

func get(u string) (int, []byte, error) {
	resp, err := client.Get(u) //nolint:noctx // client bounds the call
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	return resp.StatusCode, body, err
}

func post(u string, body []byte) (int, []byte, error) {
	resp, err := client.Post(u, "application/json", bytes.NewReader(body)) //nolint:noctx // client bounds the call
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	out, err := io.ReadAll(resp.Body)
	return resp.StatusCode, out, err
}

// getJSON decodes a 200 response into v and returns the body, trimmed, for
// failure messages.
func getJSON(u string, v any) (string, error) {
	status, body, err := get(u)
	if err != nil {
		return "", err
	}
	detail := string(body)
	if len(detail) > 2000 {
		detail = detail[:2000] + "..."
	}
	if status != http.StatusOK {
		return detail, fmt.Errorf("GET %s: %d: %s", u, status, detail)
	}
	if err := json.Unmarshal(body, v); err != nil {
		return detail, fmt.Errorf("GET %s: %w: %s", u, err, detail)
	}
	return detail, nil
}
