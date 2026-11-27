package uaparse

import (
	"os"
	"strings"
	"testing"
)

// corpus reads testdata/agents.txt: one family|os|device|user agent case
// per line, with # comments.
func corpus(t testing.TB) [][4]string {
	t.Helper()
	raw, err := os.ReadFile("testdata/agents.txt")
	if err != nil {
		t.Fatal(err)
	}
	var cases [][4]string
	for line := range strings.SplitSeq(string(raw), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "|", 4)
		if len(parts) != 4 {
			t.Fatalf("malformed corpus line %q", line)
		}
		cases = append(cases, [4]string(parts))
	}
	return cases
}

func TestCorpus(t *testing.T) {
	for _, c := range corpus(t) {
		want := Result{Family: c[0], OS: c[1], Device: c[2]}
		if got := Parse(Hints{UA: c[3]}); got != want {
			t.Errorf("%+v, want %+v\n%s", got, want, c[3])
		}
	}
}

func TestClientHintsWin(t *testing.T) {
	ua := "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
	got := Parse(Hints{UA: ua, CHMobile: "?1", CHPlatform: `"Android"`})
	if got.OS != "Android" || got.Device != "mobile" {
		t.Fatalf("%+v", got)
	}
	got = Parse(Hints{UA: ua, CHPlatform: `"Windows"`})
	if got.OS != "Windows" || got.Device != "desktop" {
		t.Fatalf("%+v", got)
	}
	got = Parse(Hints{UA: ua, CHPlatform: `"Chrome OS"`})
	if got.OS != "ChromeOS" {
		t.Fatalf("%+v", got)
	}
	// An unknown platform hint falls back to the user agent.
	got = Parse(Hints{UA: ua, CHPlatform: `"Fuchsia"`})
	if got.OS != "Linux" {
		t.Fatalf("%+v", got)
	}
}
