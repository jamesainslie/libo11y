//go:build opsintegration

package ops_test

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/chromedp/chromedp"

	"github.com/jamesainslie/libo11y/ops/internal/fixture"
)

// appVariable is the explorer's app variable as Grafana's dashboard scene
// holds it after running its query.
type appVariable struct {
	Query   any      `json:"query"`
	Options []string `json:"options"`
	Loading bool     `json:"loading"`
	Error   string   `json:"error"`
}

// appVariableState reads the app variable from the dashboard scene, which
// Grafana exposes as window.__grafanaSceneContext. The option list is what
// the picker offers, so this checks the label_values() query ran against
// Loki without opening the picker.
const appVariableState = `(() => {
  const v = window.__grafanaSceneContext?.state?.$variables?.getByName?.('app');
  if (!v) return { loading: true, error: '', options: [] };
  return {
    query: v.state.query, loading: !!v.state.loading,
    error: v.state.error ? String(v.state.error) : '',
    options: (v.state.options ?? []).map(o => String(o.value)),
  };
})()`

// viewIDParam reads the view_id query parameter of a link, still encoded.
var viewIDParam = regexp.MustCompile(`[?&]var-view_id=([^&]*)`)

// checkInBrowser opens the session explorer in headless Chrome and checks
// the two things only Grafana's frontend does with the committed JSON:
// it interpolates the "Select this view" data link, percent-encoding the
// view ID once, and it runs the app variable's label_values(service_name)
// string against Loki. It needs Chrome or Chromium on PATH.
func checkInBrowser(t *testing.T) {
	opts := append(chromedp.DefaultExecAllocatorOptions[:], chromedp.NoSandbox, chromedp.WindowSize(1600, 1200))
	actx, cancelAlloc := chromedp.NewExecAllocator(t.Context(), opts...)
	defer cancelAlloc()
	browser, cancel := chromedp.NewContext(actx)
	defer cancel()
	// The first Do starts Chrome for the life of browser; the timeout only
	// bounds the actions after it.
	if err := chromedp.Do(browser); err != nil {
		t.Fatalf("start Chrome or Chromium: %v", err)
	}
	ctx, cancelTimeout := context.WithTimeout(browser, time.Minute)
	defer cancelTimeout()

	explorer := grafanaURL + "/d/libo11y-rum-session-explorer?" + url.Values{
		"orgId":          {"1"},
		"from":           {"now-1h"},
		"to":             {"now"},
		"var-session_id": {browserSession},
	}.Encode()
	if err := chromedp.Do(ctx, chromedp.Navigate(explorer)); err != nil {
		t.Fatalf("open %s: %v", explorer, err)
	}

	t.Run("the loki app variable lists the app", func(t *testing.T) {
		vctx, cancelV := context.WithTimeout(browser, 45*time.Second)
		defer cancelV()
		waitFor(t, "the app variable to list "+fixture.Service, 30*time.Second, func() (bool, string) {
			v, err := chromedp.Run(vctx, chromedp.Evaluate[appVariable](appVariableState))
			if err != nil {
				return false, err.Error()
			}
			done := !v.Loading && v.Error == "" && slices.Contains(v.Options, fixture.Service)
			return done, fmt.Sprintf("%+v", v)
		})
	})

	t.Run("the view link percent-encodes the view ID once", func(t *testing.T) {
		lctx, cancelL := context.WithTimeout(browser, 75*time.Second)
		defer cancelL()
		// Only the data links carry a view ID; the page's own links keep
		// var-view_id empty.
		var hrefs []string
		waitFor(t, "the explorer's view links", 60*time.Second, func() (bool, string) {
			var err error
			hrefs, err = chromedp.Run(lctx, chromedp.Evaluate[[]string](
				`Array.from(document.querySelectorAll('a[href*="var-view_id="]')).map(a => a.getAttribute('href')).filter(h => /[?&]var-view_id=[^&]/.test(h))`))
			if err != nil {
				return false, err.Error()
			}
			return len(hrefs) > 0, fmt.Sprintf("links %v", hrefs)
		})
		want := strings.ReplaceAll(url.QueryEscape(browserViewID), "+", "%20")
		for _, h := range hrefs {
			m := viewIDParam.FindStringSubmatch(h)
			if m == nil || m[1] != want {
				t.Errorf("link %q: var-view_id is not %q, the view ID %q encoded once", h, want, browserViewID)
				continue
			}
			if !strings.Contains(h, "var-session_id="+browserSession) {
				t.Errorf("link %q does not keep the session", h)
			}
		}
	})

	if t.Failed() {
		// A fresh timeout, because a failed wait may have used up its own.
		dump, cancelDump := context.WithTimeout(browser, 15*time.Second)
		defer cancelDump()
		state, err := chromedp.Run(dump, chromedp.Evaluate[string](pageState))
		if err != nil {
			state = err.Error()
		}
		t.Logf("explorer page state:\n%s", state)
	}
}

// pageState describes the explorer page for a failure message: the
// dashboard's variables as Grafana's scene holds them, the links on the
// page, and the visible text.
const pageState = `(() => {
  const out = {};
  try {
    const vars = window.__grafanaSceneContext?.state?.$variables?.state?.variables ?? [];
    out.variables = vars.map(v => ({
      name: v.state.name, value: v.state.value, text: v.state.text,
      options: (v.state.options ?? []).map(o => o.value), error: v.state.error ? String(v.state.error) : undefined,
      loading: v.state.loading, query: v.state.query,
    }));
  } catch (e) { out.variables = String(e); }
  out.links = Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).filter(h => h.includes('var-')).slice(0, 40);
  out.text = (document.body?.innerText ?? '').slice(0, 6000);
  return JSON.stringify(out, null, 2);
})()`
