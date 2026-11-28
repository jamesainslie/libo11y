// Package pack defines the ops pack: its dashboards and rule files, and the
// artifacts the generator writes from them.
package pack

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/jamesainslie/libo11y/ops/internal/dash"
	"github.com/jamesainslie/libo11y/ops/internal/rules"
	"github.com/jamesainslie/libo11y/ops/internal/thresholds"
)

// Artifact is one generated file.
type Artifact struct {
	Path string // relative to ops/, slash-separated
	Data []byte
}

// UIDs are the UIDs of every dashboard the pack has, in the order Dashboards
// returns them. Dashboard links may name only these.
var UIDs = []string{
	"libo11y-rum-overview",
	"libo11y-rum-vitals",
	"libo11y-rum-errors",
	"libo11y-rum-session-explorer",
	"libo11y-rum-gateway",
}

// Dashboards returns the pack's dashboards, in the order the kustomization
// lists them.
func Dashboards(t thresholds.Thresholds) []dash.Dashboard {
	return []dash.Dashboard{overview(t), vitals(t), errorsDashboard(), explorer(), gatewayDashboard(t)}
}

// RuleFiles returns the pack's Prometheus rule files by path. version goes
// into the runbook links.
func RuleFiles(t thresholds.Thresholds, version string) map[string]rules.File {
	return map[string]rules.File{
		rumRulesPath:     rumRules(t, version),
		gatewayRulesPath: gatewayRules(t, version),
	}
}

// Build renders every artifact of the pack, sorted by path.
func Build(t thresholds.Thresholds, version string) ([]Artifact, error) {
	return build(Dashboards(t), RuleFiles(t, version))
}

func build(dashboards []dash.Dashboard, files map[string]rules.File) ([]Artifact, error) {
	var arts []Artifact
	seen := map[string]bool{}
	for _, d := range dashboards {
		if seen[d.UID] {
			return nil, fmt.Errorf("pack: two dashboards have uid %s", d.UID)
		}
		seen[d.UID] = true
		b, err := d.JSON()
		if err != nil {
			return nil, err
		}
		arts = append(arts, Artifact{Path: "dashboards/" + d.UID + ".json", Data: b})
	}
	var ordered []rules.File
	for _, p := range slices.Sorted(maps.Keys(files)) {
		if !slices.Contains(ruleFileOrder, p) {
			return nil, fmt.Errorf("pack: rule file %s has no place in the PrometheusRule", p)
		}
		b, err := files[p].YAML()
		if err != nil {
			return nil, fmt.Errorf("pack: %s: %w", p, err)
		}
		arts = append(arts, Artifact{Path: p, Data: b})
	}
	for _, p := range ruleFileOrder {
		if f, ok := files[p]; ok {
			ordered = append(ordered, f)
		}
	}
	if len(ordered) > 0 {
		b, err := rules.PrometheusRule("libo11y-rum", ordered...)
		if err != nil {
			return nil, fmt.Errorf("pack: %s: %w", prometheusRulePath, err)
		}
		arts = append(arts, Artifact{Path: prometheusRulePath, Data: b}, Artifact{Path: "kustomization.yaml", Data: kustomization(dashboards)})
	}
	slices.SortFunc(arts, func(a, b Artifact) int { return strings.Compare(a.Path, b.Path) })
	return arts, nil
}

// Owned reports whether p, relative to ops/, is a path the generator
// writes: anything under dashboards/ and kubernetes/, the rule files in
// alerts/ (not the hand-written promtool tests), and kustomization.yaml.
// Hidden files and editor backups, such as .DS_Store, .x.swp and x~, are
// never the generator's.
func Owned(p string) bool {
	dir, file := path.Split(p)
	if strings.HasPrefix(file, ".") || strings.HasSuffix(file, "~") {
		return false
	}
	switch {
	case p == "kustomization.yaml":
		return true
	case strings.HasPrefix(p, "dashboards/"), strings.HasPrefix(p, "kubernetes/"):
		return true
	case dir == "alerts/":
		return strings.HasSuffix(file, ".rules.yaml")
	}
	return false
}

// ownedRoots are the places Stale looks for files the generator no longer
// writes. Every path Owned accepts is under one of them.
var ownedRoots = []string{"dashboards", "kubernetes", "alerts", "kustomization.yaml"}

// Drift compares the artifacts with the files under root and lists every
// generated path that is missing or differs, and every file in a
// generated place that the generator does not write, sorted.
func Drift(root string, arts []Artifact) ([]string, error) {
	var out []string
	for _, a := range arts {
		got, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(a.Path)))
		switch {
		case errors.Is(err, fs.ErrNotExist):
			out = append(out, a.Path+" (missing)")
		case err != nil:
			return nil, err
		case !bytes.Equal(got, a.Data):
			out = append(out, a.Path+" (differs)")
		}
	}
	stale, err := Stale(root, arts)
	if err != nil {
		return nil, err
	}
	for _, s := range stale {
		out = append(out, s+" (not generated)")
	}
	slices.Sort(out)
	return out, nil
}

// Stale lists the files under root, relative and slash-separated, that are
// in a generated place but are not one of the artifacts, sorted.
func Stale(root string, arts []Artifact) ([]string, error) {
	want := map[string]bool{}
	for _, a := range arts {
		want[a.Path] = true
	}
	var out []string
	for _, r := range ownedRoots {
		err := filepath.WalkDir(filepath.Join(root, r), func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					return nil
				}
				return err
			}
			if d.IsDir() {
				return nil
			}
			rel, err := filepath.Rel(root, p)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			if Owned(rel) && !want[rel] {
				out = append(out, rel)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	slices.Sort(out)
	return out, nil
}
