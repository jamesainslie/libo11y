package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "o11y-registry.yaml")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRegistryCheck(t *testing.T) {
	valid := writeFile(t, "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.user.id: {type: string, sensitivity: internal, cardinality: unbounded}\n")
	invalid := writeFile(t, "schema: libo11y.app-registry/v1\nnamespace: http\nattributes:\n  http.thing: {type: string, sensitivity: public, cardinality: bounded}\n")
	broken := writeFile(t, "schema: [\n")

	for name, tc := range map[string]struct {
		args       []string
		wantCode   int
		wantStdout string
		wantStderr string
	}{
		"valid":      {[]string{"registry", "check", valid}, 0, "ok (1 attribute in namespace lor)", ""},
		"violations": {[]string{"registry", "check", invalid}, 1, "libo11y_app_namespace_reserved", ""},
		"unparsable": {[]string{"registry", "check", broken}, 2, "", "parsing application registry"},
		"missing":    {[]string{"registry", "check", filepath.Join(t.TempDir(), "nope.yaml")}, 2, "", "no such file"},
		"worst wins": {[]string{"registry", "check", invalid, broken}, 2, "libo11y_app_namespace_reserved", "parsing"},
		"no files":   {[]string{"registry", "check"}, 2, "", "usage:"},
		"unknown":    {[]string{"lint"}, 2, "", "usage:"},
		"help":       {[]string{"-h"}, 0, "usage:", ""},
		"long help":  {[]string{"--help"}, 0, "usage:", ""},
		"help word":  {[]string{"help"}, 0, "usage:", ""},
	} {
		t.Run(name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := run(tc.args, &stdout, &stderr)
			if code != tc.wantCode {
				t.Errorf("exit %d, want %d (stdout %q, stderr %q)", code, tc.wantCode, stdout.String(), stderr.String())
			}
			assertStream(t, "stdout", stdout.String(), tc.wantStdout)
			assertStream(t, "stderr", stderr.String(), tc.wantStderr)
		})
	}
}

// assertStream checks one output stream: an empty want means the stream
// must be empty, and any other want must appear in it.
func assertStream(t *testing.T, name, got, want string) {
	t.Helper()
	if want == "" {
		if got != "" {
			t.Errorf("%s = %q, want it empty", name, got)
		}
		return
	}
	if !strings.Contains(got, want) {
		t.Errorf("%s %q lacks %q", name, got, want)
	}
}
