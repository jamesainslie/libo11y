package uaparse

import (
	"slices"
	"testing"
)

var (
	families = []string{"", "chrome", "edge", "firefox", "safari", "opera", "samsung", "other"}
	oses     = []string{"", "Windows", "macOS", "iOS", "Android", "Linux", "ChromeOS"}
	devices  = []string{"desktop", "mobile", "tablet", "tv", "bot", "unknown"}
)

// FuzzParse checks that every input maps into the bounded vocabularies.
func FuzzParse(f *testing.F) {
	for _, c := range corpus(f) {
		f.Add(c[3], "", "")
	}
	f.Add("", "?1", `"Android"`)
	f.Add("Mozilla/5.0", "?0", `"macOS"`)
	f.Fuzz(func(t *testing.T, ua, mobile, platform string) {
		got := Parse(Hints{UA: ua, CHMobile: mobile, CHPlatform: platform})
		if !slices.Contains(families, got.Family) || !slices.Contains(oses, got.OS) || !slices.Contains(devices, got.Device) {
			t.Fatalf("Parse(%q, %q, %q) = %+v is outside the vocabularies", ua, mobile, platform, got)
		}
	})
}
