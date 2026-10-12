// Command specgen generates the libo11y spec artifacts from the registry
// at spec/registry: the public go/spec package (typed keys, enums, event
// names, version constants), the go/internal/spectables validation tables,
// and the docs/taxonomy markdown. Run via `make spec-generate`.
//
// With -check it instead validates the registry against the libo11y policy
// suite (naming, ownership, sensitivity, cardinality, events, units) and
// exits non-zero on any violation. Run via `make spec-check`.
package main

import (
	"flag"
	"fmt"
	"go/format"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

type registryFile struct {
	Groups []group `yaml:"groups"`
}

type group struct {
	ID          string            `yaml:"id"`
	Type        string            `yaml:"type"`
	Name        string            `yaml:"name"`
	MetricName  string            `yaml:"metric_name"`
	Instrument  string            `yaml:"instrument"`
	Unit        string            `yaml:"unit"`
	Brief       string            `yaml:"brief"`
	Stability   string            `yaml:"stability"`
	Annotations map[string]string `yaml:"annotations"`
	Attributes  []attr            `yaml:"attributes"`
}

type attr struct {
	ID               string            `yaml:"id"`
	Ref              string            `yaml:"ref"`
	Type             yaml.Node         `yaml:"type"`
	Stability        string            `yaml:"stability"`
	Brief            string            `yaml:"brief"`
	RequirementLevel yaml.Node         `yaml:"requirement_level"`
	Annotations      map[string]string `yaml:"annotations"`
	Deprecated       yaml.Node         `yaml:"deprecated"`
}

// name returns the attribute's full name whether defined or referenced.
func (a attr) name() string {
	if a.ID != "" {
		return a.ID
	}
	return a.Ref
}

// requirement flattens requirement_level to one of required,
// conditionally_required, recommended, opt_in.
func (a attr) requirement() string {
	switch a.RequirementLevel.Kind {
	case yaml.ScalarNode:
		return a.RequirementLevel.Value
	case yaml.MappingNode:
		if len(a.RequirementLevel.Content) > 0 {
			return a.RequirementLevel.Content[0].Value
		}
	}
	return "recommended"
}

// enumMembers extracts enum member values when the type is a member map.
func (a attr) enumMembers() []enumMember {
	if a.Type.Kind != yaml.MappingNode {
		return nil
	}
	var typeSpec struct {
		Members []struct {
			ID    string `yaml:"id"`
			Value string `yaml:"value"`
			Brief string `yaml:"brief"`
		} `yaml:"members"`
	}
	if err := a.Type.Decode(&typeSpec); err != nil {
		return nil
	}
	members := make([]enumMember, 0, len(typeSpec.Members))
	for _, m := range typeSpec.Members {
		members = append(members, enumMember{ID: m.ID, Value: m.Value, Brief: m.Brief})
	}
	return members
}

// scalarType returns the scalar type name for defined attributes
// ("string", "boolean", "double", "int", "template[string]", or "enum").
func (a attr) scalarType() string {
	if a.Type.Kind == yaml.ScalarNode {
		return a.Type.Value
	}
	if len(a.enumMembers()) > 0 {
		return "enum"
	}
	return "string"
}

type enumMember struct {
	ID    string
	Value string
	Brief string
}

type model struct {
	schemaURL      string
	specVersion    string
	semconvVersion string

	groups       []group           // every group in the registry, for checks
	minted       []attr            // defined in attributes/o11y.yaml
	tiers        map[string][]attr // tier id -> refs, in file order
	tierOrder    []string
	events       []group
	metrics      []group
	spans        []group
	metricLabels []attr

	classByName map[string]string // attribute -> sensitivity class
	cardByName  map[string]string // attribute -> cardinality class
	typeByName  map[string]string // defined attribute -> scalar type
}

func main() {
	root := flag.String("root", "..", "repository root")
	check := flag.Bool("check", false, "validate the registry against the policy suite instead of generating")
	flag.Parse()

	m, err := load(*root)
	if err != nil {
		log.Fatalf("specgen: %v", err)
	}
	if *check {
		violations := checkGroups(m.groups, buildIndex(m.groups))
		for _, v := range violations {
			fmt.Fprintln(os.Stderr, v)
		}
		if len(violations) > 0 {
			os.Exit(1)
		}
		return
	}
	if err := writeAll(*root, m); err != nil {
		log.Fatalf("specgen: %v", err)
	}
}

func load(root string) (*model, error) {
	m := &model{
		tiers:       map[string][]attr{},
		classByName: map[string]string{},
		cardByName:  map[string]string{},
		typeByName:  map[string]string{},
	}

	manifest, err := os.ReadFile(filepath.Join(root, "spec", "registry", "manifest.yaml"))
	if err != nil {
		return nil, fmt.Errorf("reading manifest: %w", err)
	}
	var manifestDoc struct {
		SchemaURL      string `yaml:"schema_url"`
		SemconvVersion string `yaml:"semconv_version"`
	}
	if err := yaml.Unmarshal(manifest, &manifestDoc); err != nil {
		return nil, fmt.Errorf("parsing manifest: %w", err)
	}
	m.schemaURL = manifestDoc.SchemaURL
	m.specVersion = m.schemaURL[strings.LastIndex(m.schemaURL, "/")+1:]
	m.semconvVersion = manifestDoc.SemconvVersion

	registryDir := filepath.Join(root, "spec", "registry")
	err = filepath.WalkDir(registryDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(path, ".yaml") || strings.HasSuffix(path, "manifest.yaml") {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var file registryFile
		if err := yaml.Unmarshal(raw, &file); err != nil {
			return fmt.Errorf("parsing %s: %w", path, err)
		}
		for _, g := range file.Groups {
			m.groups = append(m.groups, g)
			m.classify(g)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(m.tierOrder)
	return m, nil
}

func (m *model) classify(g group) {
	for _, a := range g.Attributes {
		if a.ID != "" {
			m.typeByName[a.ID] = a.scalarType()
		}
		if class, ok := a.Annotations["o11y.sensitivity"]; ok {
			if _, seen := m.classByName[a.name()]; !seen {
				m.classByName[a.name()] = class
			}
		}
		if card, ok := a.Annotations["o11y.cardinality"]; ok {
			if _, seen := m.cardByName[a.name()]; !seen {
				m.cardByName[a.name()] = card
			}
		}
	}

	switch {
	case g.ID == "registry.o11y":
		m.minted = g.Attributes
	case strings.HasPrefix(g.ID, "libo11y.resource."):
		tier := strings.TrimPrefix(g.ID, "libo11y.resource.")
		m.tiers[tier] = g.Attributes
		m.tierOrder = append(m.tierOrder, tier)
	case g.Type == "event":
		m.events = append(m.events, g)
	case g.Type == "metric":
		m.metrics = append(m.metrics, g)
	case strings.HasPrefix(g.ID, "libo11y.span."):
		m.spans = append(m.spans, g)
	case g.ID == "libo11y.metrics.resource_labels":
		m.metricLabels = g.Attributes
	}
}

func writeAll(root string, m *model) error {
	if err := writeGo(filepath.Join(root, "go", "spec", "spec.go"), genSpec(m)); err != nil {
		return err
	}
	if err := writeGo(filepath.Join(root, "go", "internal", "spectables", "tables.go"), genTables(m)); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(root, "docs", "taxonomy"), 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, "docs", "taxonomy", "resource.md"), []byte(genDocs(m)), 0o644)
}

func writeGo(path, src string) error {
	formatted, err := format.Source([]byte(src))
	if err != nil {
		return fmt.Errorf("formatting %s: %w", path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, formatted, 0o644)
}

var initialisms = map[string]string{
	"id": "ID", "sdk": "SDK", "k8s": "K8S", "http": "HTTP", "url": "URL",
	"vcs": "VCS", "os": "OS", "faas": "FaaS", "uid": "UID", "ip": "IP",
	"mac": "MAC", "pid": "PID", "pii": "PII",
}

// goName converts a dotted attribute name to an exported Go identifier,
// dropping an o11y. prefix.
func goName(attrName string) string {
	attrName = strings.TrimPrefix(attrName, "o11y.")
	var b strings.Builder
	for _, segment := range strings.FieldsFunc(attrName, func(r rune) bool { return r == '.' || r == '_' }) {
		if special, ok := initialisms[segment]; ok {
			b.WriteString(special)
			continue
		}
		b.WriteString(strings.ToUpper(segment[:1]) + segment[1:])
	}
	return b.String()
}

func header(b *strings.Builder, pkg string, m *model, imports ...string) {
	fmt.Fprintf(b, "// Code generated by specgen from spec/registry (spec %s). DO NOT EDIT.\n\n", m.specVersion)
	fmt.Fprintf(b, "package %s\n\n", pkg)
	if len(imports) > 0 {
		b.WriteString("import (\n")
		for _, imp := range imports {
			fmt.Fprintf(b, "\t%s\n", imp)
		}
		b.WriteString(")\n\n")
	}
}
