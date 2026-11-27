// Package uaparse classifies a user agent into three bounded vocabularies:
// browser family, operating system and device class. It is an ordered list
// of substring rules rather than a regex database, so it has no data to
// keep current and cannot emit a value outside the vocabularies. The rules
// are pinned by testdata/agents.txt.
package uaparse

import "strings"

// Hints is what a request says about its client.
type Hints struct {
	// UA is the User-Agent header.
	UA string
	// CHMobile is the Sec-CH-UA-Mobile client hint, "?1" or "?0".
	CHMobile string
	// CHPlatform is the Sec-CH-UA-Platform client hint, quoted.
	CHPlatform string
}

// Result is a classification. Every field holds one of the documented
// values.
type Result struct {
	// Family is chrome, edge, firefox, safari, opera, samsung or other, or
	// "" when the agent is not a browser.
	Family string
	// OS is Windows, macOS, iOS, Android, Linux or ChromeOS, or "" when
	// unknown.
	OS string
	// Device is desktop, mobile, tablet, tv, bot or unknown.
	Device string
}

var (
	botTokens = []string{
		"bot", "crawl", "spider", "slurp", "headlesschrome", "lighthouse",
		"pagespeed", "phantomjs", "prerender", "python-", "curl/", "wget/",
	}
	tvTokens = []string{
		"smart-tv", "smarttv", "web0s", "appletv", "googletv", "android tv",
		"crkey", "hbbtv", "bravia", "aftb", "afts", "aftm",
	}
	chPlatforms = map[string]string{
		"windows": "Windows", "macos": "macOS", "ios": "iOS", "android": "Android",
		"linux": "Linux", "chrome os": "ChromeOS", "chromium os": "ChromeOS",
	}
)

// Parse classifies h. The client hints, when present, win over the user
// agent string, which browsers increasingly freeze.
func Parse(h Hints) Result {
	ua := strings.ToLower(h.UA)
	r := Result{Family: family(ua), OS: osName(ua, h.CHPlatform)}
	r.Device = device(ua, r.OS, h.CHMobile)
	return r
}

func family(ua string) string {
	switch {
	case !strings.Contains(ua, "mozilla/"):
		return ""
	case strings.Contains(ua, "samsungbrowser/"):
		return "samsung"
	case containsAny(ua, []string{"opr/", "opera"}):
		return "opera"
	case containsAny(ua, []string{"edg/", "edga/", "edgios/", "edge/"}):
		return "edge"
	case containsAny(ua, []string{"firefox/", "fxios/"}):
		return "firefox"
	case containsAny(ua, []string{"crios/", "chrome/", "chromium/"}):
		return "chrome"
	case strings.Contains(ua, "safari/") && strings.Contains(ua, "version/"):
		return "safari"
	default:
		return "other"
	}
}

// osName reads the platform hint, else the user agent. Windows comes
// first because Windows Phone is gone, iOS before macOS because iPad and
// iPhone agents say "like Mac OS X", and ChromeOS is matched as a whole
// token because "microsoft" contains "cros".
func osName(ua, chPlatform string) string {
	if os, ok := chPlatforms[strings.ToLower(strings.Trim(chPlatform, `" `))]; ok {
		return os
	}
	switch {
	case strings.Contains(ua, "windows"):
		return "Windows"
	case containsAny(ua, []string{"iphone", "ipad", "ipod"}):
		return "iOS"
	case strings.Contains(ua, "android"):
		return "Android"
	case containsAny(ua, []string{"; cros ", "(cros "}):
		return "ChromeOS"
	case containsAny(ua, []string{"macintosh", "mac os x"}):
		return "macOS"
	case strings.Contains(ua, "linux"):
		return "Linux"
	}
	return ""
}

func device(ua, os, chMobile string) string {
	switch {
	case ua == "":
		return "unknown"
	// Cubot is a phone maker whose model names contain "bot".
	case containsAny(strings.ReplaceAll(ua, "cubot", ""), botTokens):
		return "bot"
	case containsAny(ua, tvTokens):
		return "tv"
	case chMobile == "?1":
		return "mobile"
	case strings.Contains(ua, "ipad") || strings.Contains(ua, "tablet") ||
		(strings.Contains(ua, "android") && !strings.Contains(ua, "mobile")):
		return "tablet"
	case containsAny(ua, []string{"mobi", "iphone", "ipod"}):
		return "mobile"
	case os == "Windows" || os == "macOS" || os == "Linux" || os == "ChromeOS":
		return "desktop"
	}
	return "unknown"
}

func containsAny(s string, tokens []string) bool {
	for _, t := range tokens {
		if strings.Contains(s, t) {
			return true
		}
	}
	return false
}
