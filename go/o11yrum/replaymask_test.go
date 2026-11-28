package o11yrum

import (
	"strings"
	"testing"
	"time"
)

// The cases below mirror ts/packages/rum-replay/src/mask.test.ts,
// urls.test.ts and css.test.ts input for input, so the gateway and the
// collector agree beyond the shared vectors.

func TestMaskText(t *testing.T) {
	for in, want := range map[string]string{
		"Jane Doe\n42 Main St":                "**** ***\n** **** **",
		"\t \r\n\f\v":                         "\t \r\n\f\v",
		"":                                    "",
		"a\u00a0b\u0085c\ufeffd\u2028e\u3000": "**********",
		"\U0001f600x":                         "**",
		"a\ufffdb":                            "***",
		"e\u0301":                             "**",
		"\u00a0\u2028\u2029\u200b\u1680":      "*****",
	} {
		if got := maskText(in); got != want {
			t.Errorf("maskText(%q) = %q, want %q", in, got, want)
		}
	}
}

var testAllow = map[string]bool{"page": true}

func TestStripURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://shop.example/a/b?page=2&email=x%40y#top": "https://shop.example/a/b?page=2",
		"https://shop.example/a?email=x":                  "https://shop.example/a",
		"HTTP://shop.example/A?page=1&page=2":             "http://shop.example/A?page=1&page=2",
		"https://jane:hunter2@shop.example/a":             "https://shop.example/a",
		"//jane@cdn.example/a.png?page=1":                 "//cdn.example/a.png?page=1",
		"/img/a.png?token=s3cr3t":                         "/img/a.png",
		"b.css?page=1":                                    "b.css?page=1",
		"?email=j#x":                                      "",
		"/a?Page=1&pa%67e=2&page":                         "/a?page",
		"/a?page=1#?email=x":                              "/a?page=1",
		"#icon-cart":                                      "#icon-cart",
		"#access_token=abc&state=x":                       "",
		"/a#icon":                                         "/a",
		"data:image/png;base64,AAAA":                      "",
		"blob:https://x/1":                                "",
		"javascript:alert(1)":                             "",
		" JavaScript:x":                                   "",
		"java\tscript:alert(1)":                           "",
		"\u0001javascript:x":                              "",
		"jav\nascript:x":                                  "",
		"mailto:jane@x.test":                              "",
		"tel:+15551234567":                                "",
		"file:///home/jane/notes.txt":                     "",
		"about:blank":                                     "",
		"":                                                "",
		"   ":                                             "",
		"https://jane:hun/ter2@host.example/x":            "",
		"//jane:hun/ter2@cdn.example/a.png":               "",
		"https://jane:hun#ter2@host.example/x":            "",
		"https://host.example:8443/x?page=1":              "https://host.example:8443/x?page=1",
		"http://[::1]:8080/x":                             "http://[::1]:8080/x",
		"https:///x":                                      "https://x",
		"https://":                                        "",
		"https://jane@":                                   "",
		"https://shop.example/cart;jsessionid=A1B2C3?page=1": "https://shop.example/cart?page=1",
		"/a?page=1;token=SECRET":                             "/a?page=1",
		"/a?token=SECRET;page=2":                             "/a?page=2",
		"#eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5lIn0.sig":      "",
		"#" + strings.Repeat("a", 200):                       "",
		"#:r1:":                                              "#:r1:",
		// Beyond the TS unit tests: trimming and backslashes as a browser
		// reads them.
		"\x00 https://a.example/x?page=1 \x1f": "https://a.example/x?page=1",
		`https:\\a.example\x`:                  `https://a.example\x`,
		`\\a.example/x`:                        "//a.example/x",
		"/a?page&&page=;x":                     "/a?page&page=",
	} {
		if got := stripURL(in, testAllow); got != want {
			t.Errorf("stripURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStripURLEmptyNameOnAllowList(t *testing.T) {
	// An empty name on the list keeps empty pieces, as the TS split does.
	if got := stripURL("/a?&x=1", map[string]bool{"": true}); got != "/a?" {
		t.Fatalf("got %q", got)
	}
}

func TestStripSrcset(t *testing.T) {
	for in, want := range map[string]string{
		"/a.png?t=1 1x, /b.png?page=2 2x": "/a.png 1x, /b.png?page=2 2x",
		"/a.png 320w,/b.png   640w":       "/a.png 320w, /b.png 640w",
		"/a.png":                          "/a.png",
		"data:image/png;base64,SECRETPIXELS 1x, /b.png 2x": "/b.png 2x",
		"data:text/plain,Jane%20Doe":                       "",
		"/a.png jane@x.test 2x":                            "/a.png 2x",
		"/a.png 1.5x, /b.png?token=1 (secret) 2x":          "/a.png 1.5x, /b.png 2x",
		"/a.png,, /b.png 1e2x":                             "/a.png, /b.png 1e2x",
		" , ,":                                             "",
	} {
		if got := stripSrcset(in, testAllow); got != want {
			t.Errorf("stripSrcset(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStripCSSURLs(t *testing.T) {
	for in, want := range map[string]string{
		"background:url(/a.png?token=1&page=2)":                                                 `background:url("/a.png?page=2")`,
		"a{background-image:url( 'https://s3.example/u.png?X-Amz-Signature=abc' )}":             `a{background-image:url("https://s3.example/u.png")}`,
		`b{mask:URL("/m.svg#frag")}`:                                                            `b{mask:url("/m.svg")}`,
		"i{background:url(data:image/png;base64,SECRET)}":                                       `i{background:url("")}`,
		`@font-face{src:url("data:font/woff2;base64,AAAA") format("woff2")}`:                    `@font-face{src:url("") format("woff2")}`,
		`i{background:url("data\:image/png,SECRET")}`:                                           `i{background:url("")}`,
		`i{background:\75 rl(data:image/png,SECRET)}`:                                           `i{background:url("")}`,
		`i{background:u\72l(/a?token=SECRET)}`:                                                  `i{background:url("/a")}`,
		`i{background:url(/a\?token=SECRET)}`:                                                   `i{background:url("/a")}`,
		`@import "/theme.css?token=SECRET";`:                                                    `@import "/theme.css";`,
		"i{background-image:image-set('/a.png?token=SECRET' 1x, \"data:image/png,SECRET\" 2x)}": `i{background-image:image-set("/a.png" 1x, "" 2x)}`,
		"fill:url(#gradient)":                                                                   `fill:url("#gradient")`,
		"a{color:red/* https://x.example/?token=SECRET */}":                                     "a{color:red}",
		"a{background:url(/a?token=SECRET":                                                      `a{background:url("/a")`,
		`a{content:"data:x,SECRET`:                                                              `a{content:""`,
		"a{color:red/* SECRET":                                                                  "a{color:red",
		`@import "/my theme.css?token=SECRET";`:                                                 `@import "/my theme.css";`,
		`@import "/theme.css\9 ?token=SECRET";`:                                                 `@import "/theme.css";`,
		`i{background:image-set("/a b.png?token=SECRET" 1x)}`:                                   `i{background:image-set("/a b.png" 1x)}`,
		`i{background:image-set("a.png\a ?token=SECRET" 1x)}`:                                   `i{background:image-set("a.png" 1x)}`,
		"@import 'data:text/css,SECRET';":                                                       `@import "";`,
		"@IMPORT 'theme.css';":                                                                  `@IMPORT "theme.css";`,
		// Beyond the TS unit tests: JavaScript's notion of white space,
		// which differs from Go's, and ASCII-only case folding.
		"@import\u3000'x.css';":            "@import\u3000\"x.css\";",
		"a{content:'\ufeff/x?token=1'}":    "a{content:\"\ufeff/x\"}",
		"a{content:'\u0085/x'}":            "a{content:'\u0085/x'}",
		"a{content:'java\u017fcript:x y'}": "a{content:'java\u017fcript:x y'}",
		// A function named U+FFFD "url" is not a url() token. Outside a
		// declaration value its argument is kept; in one, a bare URL after
		// "(" is stripped as a bare URL.
		`a{\0 url(/x?token=1)}`:            `a{\0 url(/x?token=1)}`,
		`a{background:\0 url(/x?token=1)}`: `a{background:\0 url("/x")}`,
		// A string that is not a URL is kept exactly as written.
		"a{content:\"\x01\x7f\\\"\\\\\"}": "a{content:\"\x01\x7f\\\"\\\\\"}",
		// Control characters in a stripped URL are written back escaped.
		"a{background:url(\"/a\x01b?page=1\")}": `a{background:url("/a\1 b?page=1")}`,
	} {
		if got := stripCSSURLs(in, testAllow); got != want {
			t.Errorf("stripCSSURLs(%q) = %q, want %q", in, got, want)
		}
	}
	css := `a::before{content:"\201C Hello";font-family:"Helvetica Neue",sans-serif;color:#fff}.x>y{margin:0 auto}`
	if got := stripCSSURLs(css, testAllow); got != css {
		t.Errorf("plain CSS changed: %q", got)
	}
}

func TestStripCSSURLsBareValues(t *testing.T) {
	for in, want := range map[string]string{
		// The collector's css.test.ts cases.
		"--bg: https://cdn.example/a.png?token=SECRET1&page=2;color:red": `--bg: "https://cdn.example/a.png?page=2";color:red`,
		":root{--api:/v1/me?session=SECRET2}":                            `:root{--api:"/v1/me"}`,
		`a{--u:\68ttps://x.example/?t=SECRET3 }`:                         `a{--u:"https://x.example/" }`,
		"--list: //a.example/x?k=SECRET4, /b?k=SECRET5 !important":       `--list: "//a.example/x", "/b" !important`,
		"--img: data:image/png;base64,SECRET6":                           `--img: ""`,
		"--js:javascript:alert(SECRET7)":                                 `--js:"")`,
		"--f: var(--x, /a?k=SECRET8)":                                    `--f: var(--x, "/a")`,
		"@media (min-width:10px){a{--u:/x?t=SECRET}}":                    `@media (min-width:10px){a{--u:"/x"}}`,
		// Runs end at a comment, !important (any case, after white
		// space), a quote, ")" and white space. A comment also starts one.
		"--c:/*x*/https://a.example/?k=SECRET":  `--c:"https://a.example/"`,
		"--u: /x?t=1/*c*/;":                     `--u: "/x";`,
		"--u: /a?k=1!important":                 `--u: "/a"!important`,
		"--u: /a?k=1! IMPORTANT":                `--u: "/a"! IMPORTANT`,
		"--u:(/x?t=1)":                          `--u:("/x")`,
		"--u:/x?t=1\n":                          "--u:\"/x\"\n",
		"--u:/x?t=1'a'":                         `--u:"/x"'a'`,
		"--u:/x?t=1;--v:https://a.example/?t=2": `--u:"/x";--v:"https://a.example/"`,
		"x{} --u: /a?t=1":                       `x{} --u: "/a"`,
		"--u:a /x?t=1":                          `--u:a "/x"`,
		"a{--u:data:x;b,c}":                     `a{--u:""}`,
		"--u:\\/x?t=1":                          `--u:"/x"`,
		"--u:\\5c\\5c h.example/x?t=1":          `--u:"//h.example/x"`,
		"--u:url(/a?t=1)":                       `--u:url("/a")`,
		"--u:/a\\1 b?t=1&page=1":                `--u:"/a\1 b?page=1"`,
		"\u00e9:/x?t=1":                         "\u00e9:\"/x\"",
		"\U0001F600:/x?t=1":                     "\U0001F600" + `:"/x"`,
		"--u:FILE:/etc/passwd":                  `--u:""`,
		"--u:tel:+15550100":                     `--u:""`,
		"--u: /a?t=1, data:x,y;z ,/b?t=2":       `--u: "/a", "" ,"/b"`,
		"--u:'x' /a?t=1":                        `--u:'x' "/a"`,
		// A URL that strips to itself is kept exactly as written.
		`--u:\2f x`:      `--u:\2f x`,
		"--u: /a!x":      "--u: /a!x",
		"--u:/x?page=1":  "--u:/x?page=1",
		"--u:'/x'/y?t=1": `--u:"/x"/y?t=1`,
		// Not a value: a selector, a statement of more than one name, a
		// run that does not start at a boundary, a non-ASCII space.
		".tel:hover,data:hover{grid-row:1 / 3;font:12px/1.5 a;--p:/v1/me;--h:https://a.example/x}a::before{content:x}": ".tel:hover,data:hover{grid-row:1 / 3;font:12px/1.5 a;--p:/v1/me;--h:https://a.example/x}a::before{content:x}",
		"a b: /x?t=1":               "a b: /x?t=1",
		"--u:a/x?t=1":               "--u:a/x?t=1",
		"--u:\u00a0/x?t=1":          "--u:\u00a0/x?t=1",
		"--u:\u00e9/x?t=1":          "--u:\u00e9/x?t=1",
		"--u:x:/y?t=1":              "--u:x:/y?t=1",
		"a:b{/x?t=1}":               "a:b{/x?t=1}",
		"--u:\\":                    "--u:\\",
		"--u:\\\n/x?t=1":            "--u:\\\n\"/x\"",
		"--u:about:blank?t=1":       "--u:about:blank?t=1",
		"--u:https\\3a //a/?t=1 x":  `--u:"https://a/" x`,
		"--u:datA:x,y;z!important ": `--u:""!important `,
	} {
		if got := stripCSSURLs(in, testAllow); got != want {
			t.Errorf("stripCSSURLs(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestStripCSSURLsLongValuesAreCheap guards the two places where reading
// as the collector does would be quadratic on the gateway: a long run that
// is not a URL, read again from every boundary in it, and a long
// statement checked again at every ":" in it. The limit is loose, for the
// race detector on a loaded host; the quadratic cost took tens of seconds.
func TestStripCSSURLsLongValuesAreCheap(t *testing.T) {
	const n = 200000
	for name, css := range map[string]string{
		"boundaries in one run": "--u:" + strings.Repeat("a(", n),
		"colons in a statement": strings.Repeat("a", n) + "(" + strings.Repeat(":", n),
	} {
		start := time.Now()
		got := stripCSSURLs(css, testAllow)
		if d := time.Since(start); d > 2*time.Second {
			t.Errorf("%s: took %v", name, d)
		}
		if got != css {
			t.Errorf("%s: changed", name)
		}
	}
}

func TestStripContent(t *testing.T) {
	for in, want := range map[string]string{
		"https://shop.example/p/1?token=SECRET&page=2#SECRET": "https://shop.example/p/1?page=2",
		"//cdn.example/i.png?sig=SECRET":                      "//cdn.example/i.png",
		"/i.png?sig=SECRET":                                   "/i.png",
		`\\cdn.example/i.png?sig=SECRET`:                      "//cdn.example/i.png",
		" /i.png?sig=SECRET ":                                 "/i.png",
		"HTTPS://a.example/?t=1":                              "https://a.example/",
		"javascript:alert('SECRET')":                          "",
		"java\tscript:alert('SECRET')":                        "",
		" data:image/png;base64,SECRET":                       "",
		"mailto:jane@x.test":                                  "",
		"Tel:+15550100":                                       "",
		// A refresh keeps only its delay, whatever follows, and wins
		// over everything else.
		"5; url=https://x.example/?token=SECRET": "5",
		"0,https://x.example/?token=SECRET":      "0",
		"1.5 ;x":                                 "1.5",
		"1.;x":                                   "1.",
		"\t 12;x":                                "12",
		"5\u00a0\u2028\ufeff;x":                  "5",
		// Text is kept as written.
		"Shoes: 20% off? Ask us / today": "Shoes: 20% off? Ask us / today",
		"5 url=x":                        "5 url=x",
		".5;x":                           ".5;x",
		"\u0663;x":                       "\u0663;x",
		"about:blank?t=1":                "about:blank?t=1",
		"\u00a0/x?t=1":                   "\u00a0/x?t=1",
		"http+x:/y?t=1":                  "http+x:/y?t=1",
		"":                               "",
	} {
		if got := stripContent(in, testAllow); got != want {
			t.Errorf("stripContent(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAttributeListsMatchTheCollector(t *testing.T) {
	// The sizes of the lists in ts/packages/rum-replay/src/policy.ts; the
	// vectors check their contents.
	for name, tc := range map[string]struct {
		set  map[string]bool
		want int
	}{
		"masked": {maskedAttributes, 14},
		"url":    {urlAttributes, 5},
		"css":    {cssAttributes, 9},
		"kept":   {keptAttributes, 122},
	} {
		if len(tc.set) != tc.want {
			t.Errorf("%s attributes: %d, want %d", name, len(tc.set), tc.want)
		}
	}
	for _, k := range []string{"value", "checked", "selected", "onclick", "srcdoc", "rr_dataurl", "rr_src", "data-x", "contenteditable"} {
		if keptAttributes[k] || maskedAttributes[k] || urlAttributes[k] || cssAttributes[k] {
			t.Errorf("%s is on a list", k)
		}
	}
}
