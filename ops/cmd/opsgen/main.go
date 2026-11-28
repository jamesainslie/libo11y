// Command opsgen generates the libo11y RUM ops pack: the Grafana dashboards,
// the Prometheus rule files and the kustomization. Operators can run it with
// their own thresholds:
//
//	go run github.com/jamesainslie/libo11y/ops/cmd/opsgen@<version> -thresholds my.yaml -out out/
//
// It also removes generated files the pack no longer produces. With -check
// it writes nothing and exits 1 when the files under -out differ from what
// it would generate.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/jamesainslie/libo11y/ops/internal/pack"
	"github.com/jamesainslie/libo11y/ops/internal/thresholds"
	"github.com/jamesainslie/libo11y/ops/internal/version"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr, pack.Build))
}

// buildFunc renders the pack's artifacts.
type buildFunc func(thresholds.Thresholds, string) ([]pack.Artifact, error)

// run is the command, minus process concerns. It returns the exit code: 0
// on success, 1 on a failure or drift, 2 on a usage error.
func run(args []string, stdout, stderr io.Writer, build buildFunc) int {
	fs := flag.NewFlagSet("opsgen", flag.ContinueOnError)
	fs.SetOutput(stderr)
	out := fs.String("out", ".", "directory to write the pack into")
	thresholdsPath := fs.String("thresholds", "", "thresholds file (default: the pack's thresholds.yaml)")
	ver := fs.String("version", version.Version, "pack version written into runbook links")
	check := fs.Bool("check", false, "compare with the files under -out instead of writing them")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	fail := func(err error) int {
		_, _ = fmt.Fprintln(stderr, "opsgen:", err)
		return 1
	}
	t := thresholds.Default()
	if *thresholdsPath != "" {
		var err error
		if t, err = thresholds.Load(*thresholdsPath); err != nil {
			return fail(err)
		}
	}
	arts, err := build(t, *ver)
	if err != nil {
		return fail(err)
	}
	if *check {
		drift, err := pack.Drift(*out, arts)
		if err != nil {
			return fail(err)
		}
		for _, d := range drift {
			_, _ = fmt.Fprintln(stderr, "opsgen: out of date:", d)
		}
		if len(drift) > 0 {
			return 1
		}
		return 0
	}
	stale, err := pack.Stale(*out, arts)
	if err != nil {
		return fail(err)
	}
	for _, s := range stale {
		if err := os.Remove(filepath.Join(*out, filepath.FromSlash(s))); err != nil {
			return fail(err)
		}
		_, _ = fmt.Fprintln(stdout, "opsgen: removed", s)
	}
	for _, a := range arts {
		if err := writeAtomic(filepath.Join(*out, filepath.FromSlash(a.Path)), a.Data); err != nil {
			return fail(err)
		}
	}
	_, _ = fmt.Fprintf(stdout, "opsgen: wrote %d files to %s\n", len(arts), *out)
	return 0
}

// writeAtomic writes data to a temporary file beside path and renames it
// into place, so a reader never sees a partly written file.
func writeAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
