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
		"valid":      {[]string{"registry", "check", valid}, 0, "ok (1 attributes in namespace lor)", ""},
		"violations": {[]string{"registry", "check", invalid}, 1, "libo11y_app_namespace_reserved", ""},
		"unparsable": {[]string{"registry", "check", broken}, 2, "", "parsing application registry"},
		"missing":    {[]string{"registry", "check", filepath.Join(t.TempDir(), "nope.yaml")}, 2, "", "no such file"},
		"worst wins": {[]string{"registry", "check", invalid, broken}, 2, "libo11y_app_namespace_reserved", "parsing"},
		"no files":   {[]string{"registry", "check"}, 2, "", "usage:"},
		"unknown":    {[]string{"lint"}, 2, "", "usage:"},
		"help":       {[]string{"-h"}, 0, "usage:", ""},
	} {
		t.Run(name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := run(tc.args, &stdout, &stderr)
			if code != tc.wantCode {
				t.Errorf("exit %d, want %d (stdout %q, stderr %q)", code, tc.wantCode, stdout.String(), stderr.String())
			}
			if !strings.Contains(stdout.String(), tc.wantStdout) {
				t.Errorf("stdout %q lacks %q", stdout.String(), tc.wantStdout)
			}
			if !strings.Contains(stderr.String(), tc.wantStderr) {
				t.Errorf("stderr %q lacks %q", stderr.String(), tc.wantStderr)
			}
		})
	}
}
