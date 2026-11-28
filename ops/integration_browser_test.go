//go:build opsintegration

package ops_test

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/chromedp/chromedp"

	"github.com/jamesainslie/libo11y/ops/internal/fixture"
)

// Grafana's end-to-end selectors for a variable picker: the button that
// shows the current value, and one option of the open list.
const (
	pickerValue  = `[data-testid="data-testid Dashboard template variables Variable Value DropDown value link text %s"]`
	pickerOption = `[data-testid="data-testid Dashboard template variables Variable Value DropDown option text %s"]`
)

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
	ctx, cancelTimeout := context.WithTimeout(browser, 2*time.Minute)
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

	t.Run("the view link percent-encodes the view ID once", func(t *testing.T) {
		var hrefs []string
		waitFor(t, "the explorer's view links", 60*time.Second, func() (bool, string) {
			var err error
			hrefs, err = chromedp.Run(ctx, chromedp.Evaluate[[]string](
				`Array.from(document.querySelectorAll('a[href*="var-view_id="]')).map(a => a.getAttribute('href'))`))
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

	t.Run("the loki app variable lists the app", func(t *testing.T) {
		err := chromedp.Do(ctx,
			chromedp.Click(fmt.Sprintf(pickerValue, "All")),
			chromedp.WaitVisible(fmt.Sprintf(pickerOption, fixture.Service)),
		)
		if err != nil {
			options, _ := chromedp.Run(ctx, chromedp.Evaluate[[]string](
				`Array.from(document.querySelectorAll('[data-testid^="data-testid Dashboard template variables Variable Value DropDown option text"]')).map(e => e.textContent)`)) // best effort, for the message
			t.Fatalf("the app variable's options do not include %q: %v (options seen: %v)", fixture.Service, err, options)
		}
	})

	if t.Failed() {
		html, _ := chromedp.Run(ctx, chromedp.OuterHTML("body")) // best effort, for the message
		if len(html) > 20000 {
			html = html[:20000] + "..."
		}
		t.Logf("explorer page body:\n%s", html)
	}
}
