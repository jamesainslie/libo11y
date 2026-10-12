// Command specgen generates the libo11y spec artifacts from the registry
// at spec/registry: the public go/spec package (typed keys, enums, event
// names, version constants), the go/internal/spectables validation tables,
// the docs/taxonomy markdown, and the OpenTelemetry schema file at
// spec/schemas/<version>. Run via `make spec-generate`. Every
// artifact is rendered in memory first and nothing is written unless all of
// them render.
//
// Both modes first validate the registry against the libo11y policy suite
// (naming, ownership, references, sensitivity, cardinality, enums, events,
// metrics, units) and exit non-zero on any violation, so an invalid
// registry never generates. With -check specgen stops after validating.
// Run via `make spec-check`.
package main

import (
	"bytes"
	"cmp"
	"errors"
	"flag"
	"fmt"
	"go/format"
	"io"
	"log"
	"maps"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type registryFile struct {
	Groups []group `yaml:"groups"`
}

// group and attr mirror the registry schema field for field. Registry files
// are decoded strictly (see decodeRegistry), so every key the registry uses
// must appear here, and a misspelled key is a load error.
type group struct {
	ID          string            `yaml:"id"`
	Type        string            `yaml:"type"`
	DisplayName string            `yaml:"display_name"`
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
	Examples         yaml.Node         `yaml:"examples"`
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
// The type mapping has passed decodeRegistry's strict validation, so the
// decode here cannot fail on a registry that loaded.
func (a attr) enumMembers() []enumMember {
	if a.Type.Kind != yaml.MappingNode {
		return nil
	}
	var spec enumTypeSpec
	if err := a.Type.Decode(&spec); err != nil {
		return nil
	}
	members := make([]enumMember, 0, len(spec.Members))
	for _, m := range spec.Members {
		members = append(members, enumMember{ID: m.ID, Value: m.Value, Brief: m.Brief})
	}
	return members
}

// enumTypeSpec is the mapping form of an attribute type: a closed enum.
type enumTypeSpec struct {
	Members []enumMemberSpec `yaml:"members"`
}

// enumMemberSpec lists every field an enum member may carry.
type enumMemberSpec struct {
	ID         string           `yaml:"id"`
	Value      string           `yaml:"value"`
	Brief      string           `yaml:"brief"`
	Note       string           `yaml:"note"`
	Stability  string           `yaml:"stability"`
	Deprecated *deprecationSpec `yaml:"deprecated"`
}

// deprecationSpec is the mapping form of a deprecated field.
type deprecationSpec struct {
	Reason    string `yaml:"reason"`
	RenamedTo string `yaml:"renamed_to"`
	Note      string `yaml:"note"`
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
	forbidden    []attr            // forbidden groups' keys: classified, never a tier or constant
	legacyKeys   map[string]string // pre-spec emitted key -> replacement key
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

	if err := run(*root, *check, os.Stderr); err != nil {
		log.Fatalf("specgen: %v", err)
	}
}

// run loads the registry at root and validates it against the policy suite,
// reporting every violation to stderr. Unless checkOnly, it then regenerates
// every artifact; an invalid registry never reaches the generator.
func run(root string, checkOnly bool, stderr io.Writer) error {
	m, err := load(root)
	if err != nil {
		return err
	}
	violations := checkGroups(m.groups, buildIndex(m.groups))
	for _, v := range violations {
		if _, err := fmt.Fprintln(stderr, v); err != nil {
			return err
		}
	}
	if len(violations) > 0 {
		return fmt.Errorf("%d policy violations", len(violations))
	}
	if checkOnly {
		return nil
	}
	return writeAll(root, m)
}

// bareSemver matches the last path segment of the manifest's schema_url:
// a MAJOR.MINOR.PATCH version with no prefix or file extension, which
// becomes the spec version and the schema file's name under spec/schemas.
var bareSemver = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

// errSchemaURL reports a manifest schema_url that cannot identify a spec
// version.
var errSchemaURL = errors.New("manifest schema_url must be an absolute http(s) URL ending in a bare semantic version")

// schemaVersion validates the manifest's schema URL and returns the spec
// version it names: its last path segment, a bare MAJOR.MINOR.PATCH.
func schemaVersion(schemaURL string) (string, error) {
	u, err := url.Parse(schemaURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", fmt.Errorf("%w: %q", errSchemaURL, schemaURL)
	}
	version := u.Path[strings.LastIndex(u.Path, "/")+1:]
	if !bareSemver.MatchString(version) {
		return "", fmt.Errorf("%w: %q", errSchemaURL, schemaURL)
	}
	return version, nil
}

func load(root string) (*model, error) {
	m := &model{
		tiers:       map[string][]attr{},
		legacyKeys:  map[string]string{},
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
	version, err := schemaVersion(m.schemaURL)
	if err != nil {
		return nil, err
	}
	m.specVersion = version
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
		file, err := decodeRegistry(raw)
		if err != nil {
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
	m.tierOrder = sortTiers(m.tierOrder)
	return m, nil
}

// decodeRegistry parses one registry file strictly: an unknown key (a
// misspelled requirement_level, say) is an error rather than a field the
// checks and the generator silently never see.
// The nested mappings (enum type specs, enum members, deprecation records)
// are decoded strictly too. An empty or comment-only file holds no groups;
// a second YAML document in one file is an error.
func decodeRegistry(raw []byte) (registryFile, error) {
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	var file registryFile
	if err := dec.Decode(&file); err != nil {
		if errors.Is(err, io.EOF) {
			return registryFile{}, nil
		}
		return registryFile{}, markUnknownField(err)
	}
	var extra yaml.Node
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("a registry file holds one YAML document, found a second")
		}
		return registryFile{}, err
	}
	if err := validateNested(file); err != nil {
		return registryFile{}, err
	}
	return file, nil
}

// validateNested strictly decodes the mappings the top-level decode keeps
// as raw nodes, so a misspelled member or deprecation key is a load error.
func validateNested(file registryFile) error {
	for _, g := range file.Groups {
		for _, a := range g.Attributes {
			if a.Type.Kind == yaml.MappingNode {
				var spec enumTypeSpec
				if err := decodeStrict(&a.Type, &spec); err != nil {
					return fmt.Errorf("attribute %s type: %w", a.name(), err)
				}
				if len(spec.Members) == 0 {
					return fmt.Errorf("attribute %s: enum type declares no members", a.name())
				}
			}
			if a.Deprecated.Kind == yaml.MappingNode {
				var spec deprecationSpec
				if err := decodeStrict(&a.Deprecated, &spec); err != nil {
					return fmt.Errorf("attribute %s deprecated: %w", a.name(), err)
				}
			}
		}
	}
	return nil
}

// decodeStrict decodes node into out, rejecting unknown fields. A
// yaml.Node has no strict decode, so the node is re-encoded and decoded
// again with KnownFields; line numbers in errors are relative to the node.
func decodeStrict(node *yaml.Node, out any) error {
	raw, err := yaml.Marshal(node)
	if err != nil {
		return err
	}
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(out); err != nil {
		return markUnknownField(err)
	}
	return nil
}

// markUnknownField prefixes an unknown-field decode error with its rule ID
// so it reads like the policy violations; other errors pass through.
func markUnknownField(err error) error {
	var typeErr *yaml.TypeError
	if errors.As(err, &typeErr) {
		for _, msg := range typeErr.Errors {
			if strings.Contains(msg, " not found in type ") {
				return fmt.Errorf("libo11y_registry_unknown_field: %w", err)
			}
		}
	}
	return err
}

// classify records g's attributes in the model's lookup tables and files
// the group under the artifact it feeds.
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
		if legacy, ok := a.Annotations["o11y.legacy_key"]; ok {
			if target := deprecatedTarget(a); target != "" {
				m.legacyKeys[legacy] = target
			}
		}
	}

	switch {
	case g.ID == "registry.o11y":
		m.minted = g.Attributes
	case isForbiddenGroup(g):
		m.forbidden = append(m.forbidden, g.Attributes...)
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

// render generates every artifact in memory and returns the repo-relative
// path (slash-separated) of each mapped to its final, formatted content. It
// fails on the first generator or formatting error, so a caller writes
// either every output or none.
func render(m *model) (map[string]string, error) {
	tables, err := genTables(m)
	if err != nil {
		return nil, err
	}
	schemaFile, err := genSchema(m)
	if err != nil {
		return nil, err
	}
	outputs := map[string]string{
		"docs/taxonomy/resource.md":     genDocs(m),
		"spec/schemas/" + m.specVersion: schemaFile,
	}
	goSources := []struct{ rel, src string }{
		{"go/spec/spec.go", genSpec(m)},
		{"go/internal/spectables/tables.go", tables},
	}
	for _, g := range goSources {
		formatted, err := format.Source([]byte(g.src))
		if err != nil {
			return nil, fmt.Errorf("formatting %s: %w", g.rel, err)
		}
		outputs[g.rel] = string(formatted)
	}
	return outputs, nil
}

var tierNumber = regexp.MustCompile(`^tier([0-9]+)$`)

// sortTiers returns tiers in presentation order: tierN names by N
// numerically (tier2 before tier10), then any other names alphabetically.
func sortTiers(tiers []string) []string {
	sorted := slices.Clone(tiers)
	slices.SortFunc(sorted, func(a, b string) int {
		na, aNumbered := tierIndex(a)
		nb, bNumbered := tierIndex(b)
		switch {
		case aNumbered && bNumbered:
			return cmp.Or(cmp.Compare(na, nb), strings.Compare(a, b))
		case aNumbered:
			return -1
		case bNumbered:
			return 1
		default:
			return strings.Compare(a, b)
		}
	})
	return sorted
}

// tierIndex parses the N of a tierN name.
func tierIndex(name string) (int, bool) {
	match := tierNumber.FindStringSubmatch(name)
	if match == nil {
		return 0, false
	}
	n, err := strconv.Atoi(match[1])
	return n, err == nil
}

// writeAll renders every artifact and, only once all of them rendered,
// writes them under root in a stable order.
func writeAll(root string, m *model) error {
	outputs, err := render(m)
	if err != nil {
		return err
	}
	for _, rel := range slices.Sorted(maps.Keys(outputs)) {
		content := outputs[rel]
		path := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return err
		}
	}
	return nil
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

// header writes the generated-file banner, the package clause, and the
// imports, given as unquoted paths. Imports are grouped goimports-style:
// standard library first (no dot in the first path element), a blank line,
// then everything else, each group sorted.
func header(b *strings.Builder, pkg string, m *model, imports ...string) {
	fmt.Fprintf(b, "// Code generated by specgen from spec/registry (spec %s). DO NOT EDIT.\n\n", m.specVersion)
	fmt.Fprintf(b, "package %s\n\n", pkg)
	if len(imports) == 0 {
		return
	}
	var std, other []string
	for _, imp := range imports {
		first, _, _ := strings.Cut(imp, "/")
		if strings.Contains(first, ".") {
			other = append(other, imp)
		} else {
			std = append(std, imp)
		}
	}
	slices.Sort(std)
	slices.Sort(other)
	b.WriteString("import (\n")
	for i, group := range [][]string{std, other} {
		if i > 0 && len(std) > 0 && len(group) > 0 {
			b.WriteString("\n")
		}
		for _, imp := range group {
			fmt.Fprintf(b, "\t%q\n", imp)
		}
	}
	b.WriteString(")\n\n")
}
