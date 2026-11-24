package o11y

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"go.opentelemetry.io/otel/attribute"
)

// updateVectors rewrites the committed vectors instead of checking them:
// go test -run TestVectors -update-vectors .
var updateVectors = flag.Bool("update-vectors", false, "rewrite conformance/vectors from this implementation")

// vectorsDir holds the values every libo11y implementation must reproduce
// exactly. See conformance/README.md.
const vectorsDir = "../conformance/vectors"

// checkVector compares the JSON rendering of v with the committed file
// name, or rewrites the file under -update-vectors.
func checkVector(t *testing.T, name string, v any) {
	t.Helper()
	if _, err := os.Stat("../go.work"); err != nil {
		t.Skip("conformance vectors live beside the go module; skipped outside the repository")
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(vectorsDir, name)
	if *updateVectors {
		if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test -run TestVectors -update-vectors . to create it)", err)
	}
	if !bytes.Equal(buf.Bytes(), want) {
		t.Errorf("%s is stale or this implementation changed its output; diff it against:\n%s", path, buf.String())
	}
}

// piiCase is one PII hash vector. Value is the input as JSON; Kind says
// how the implementation must read it.
type piiCase struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Value     any    `json:"value"`
	Canonical string `json:"canonical"`
	Token     string `json:"token"`
}

// deepMap nests depth maps, the innermost holding a string leaf.
func deepMap(depth int) any {
	var v any = "leaf"
	for range depth {
		v = map[string]any{"n": v}
	}
	return v
}

func TestVectorsPIIHash(t *testing.T) {
	key := make([]byte, minPIIHashKeyLen)
	for i := range key {
		key[i] = byte(i)
	}
	p := &sensitivityPolicy{pii: PIIHash, key: key}

	attrCases := []struct {
		name, kind string
		attr       attribute.Value
	}{
		{"email", "string", attribute.StringValue("alice@example.com")},
		{"empty string", "string", attribute.StringValue("")},
		{"non-ascii string", "string", attribute.StringValue("café 日本 🎉")},
		{"html in a scalar stays raw", "string", attribute.StringValue("<a href='x'>&amp;</a>")},
		{"zero", "int", attribute.Int64Value(0)},
		{"negative int", "int", attribute.Int64Value(-42)},
		{"largest safe int", "int", attribute.Int64Value(9007199254740991)},
		{"tenth", "float", attribute.Float64Value(0.1)},
		{"small negative float", "float", attribute.Float64Value(-2.5e-7)},
		{"float below the exponent threshold", "float", attribute.Float64Value(1e-5)},
		{"float with a fraction", "float", attribute.Float64Value(123456.789)},
		{"float past six digits", "float", attribute.Float64Value(1234567.5)},
		{"float past the safe range", "float", attribute.Float64Value(1e21)},
		{"largest float", "float", attribute.Float64Value(1.7976931348623157e308)},
		{"true", "bool", attribute.BoolValue(true)},
		{"false", "bool", attribute.BoolValue(false)},
		{"string array", "string_array", attribute.StringSliceValue([]string{"10.0.0.1", "10.0.0.2"})},
		{"html-escaped array members", "string_array", attribute.StringSliceValue([]string{"<a&b>", "\u2028\u2029"})},
		{"control characters in an array", "string_array", attribute.StringSliceValue([]string{"\b\f\u0001\t\n\"\\"})},
		{"empty array", "string_array", attribute.StringSliceValue([]string{})},
		{"int array", "int_array", attribute.Int64SliceValue([]int64{1, 2, 3})},
		{"float array", "float_array", attribute.Float64SliceValue([]float64{0.5, 1e-7})},
		{"bool array", "bool_array", attribute.BoolSliceValue([]bool{true, false})},
	}
	cases := make([]piiCase, 0, len(attrCases)+6)
	for _, c := range attrCases {
		canonical := canonicalAttr(c.attr)
		cases = append(cases, piiCase{c.name, c.kind, c.attr.AsInterface(), canonical, p.token(canonical)})
	}

	// Composite payloads, as a log record carries them. The bytes case
	// gives its input as standard base64; every other value is its input.
	bytesInput := []byte{0, 1, 2, 3, 255}
	cases = append(cases, piiCase{"bytes", "bytes", base64.StdEncoding.EncodeToString(bytesInput), canonicalAny(bytesInput), p.token(canonicalAny(bytesInput))})
	wide := make([]any, 2100)
	for i := range wide {
		wide[i] = "x"
	}
	anyCases := []struct {
		name  string
		input any
	}{
		{"map with unsorted keys", map[string]any{"b": "2", "a": "x"}},
		// Go sorts keys by UTF-8 bytes. JSON.stringify puts integer-like
		// keys first, and a UTF-16 sort puts U+1F600 before U+FF61.
		{"map keys in utf-8 byte order", map[string]any{"10": "a", "2": "b", "a": "c", "\uff61": "d", "😀": "e"}},
		{"nested map with an array", map[string]any{"z": map[string]any{"y": []any{int64(1), "<"}}, "a": true}},
		{"map nested past the depth limit", deepMap(20)},
		{"array past the walk budget", map[string]any{"a": wide}},
	}
	for _, c := range anyCases {
		canonical := canonicalAny(c.input)
		cases = append(cases, piiCase{c.name, "map", c.input, canonical, p.token(canonical)})
	}

	checkVector(t, "pii-hash.json", struct {
		KeyHex string    `json:"key_hex"`
		Cases  []piiCase `json:"cases"`
	}{"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", cases})
}

func TestVectorsInstanceID(t *testing.T) {
	type idCase struct {
		Name      string `json:"name"`
		PodUID    string `json:"k8s_pod_uid"`
		PodName   string `json:"k8s_pod_name"`
		Namespace string `json:"k8s_namespace_name"`
		Want      string `json:"want"`
	}
	cases := []idCase{
		{Name: "pod uid", PodUID: "0f0c5e8e-3b8a-4c1e-9d3a-2f6b7a1c9e42"},
		{Name: "pod uid wins over the name", PodUID: "0f0c5e8e-3b8a-4c1e-9d3a-2f6b7a1c9e42", PodName: "lor-portal-0", Namespace: "lor-portal"},
		{Name: "namespace and pod name", PodName: "lor-site-7d9f8-abcde", Namespace: "lor-site"},
		{Name: "pod name without a namespace", PodName: "lor-site-7d9f8-abcde"},
	}
	for i := range cases {
		cases[i].Want = instanceIDFor(cases[i].PodUID, cases[i].PodName, cases[i].Namespace)
	}
	checkVector(t, "instance-id.json", cases)
}

func TestVectorsEndpointSanitize(t *testing.T) {
	type endpointCase struct {
		In   string `json:"in"`
		Want string `json:"want"`
	}
	inputs := []string{
		"https://user:tok3n@collector.example:4318/v1?api_key=k3y#frag",
		"http://collector.example:4318",
		"collector.example:4317",
		"user:pw@collector.example:4317",
		"https://collector.example/?",
		"https://[::1]:4318/v1",
		"://bad",
		"http://%zz",
		"https://AbC/x+y@collector.example:4318",
		"AbC/x+y@collector.example:4317",
		"https://user:/s3cr3t@collector.example",
		"https://user:12?ab@collector.example:4318",
		"https://u:p@x/y@collector.example",
		"https://u:p@ss?word@collector.example:4318",
		"https://u:S3cr3t@abc?x@collector.example:4318/v1",
		"u:p@ss?word@collector.example:4317",
		// Go's url.URL.String keeps what a WHATWG URL parser would
		// normalize: host case, default ports, dot segments, IDNA.
		"https://Collector.Example:443/a/../b",
		"https://bücher.example/v1",
		"https://collector.example/a b",
		"HTTPS://collector.example",
		"https://tok@collector.example",
		"",
	}
	cases := make([]endpointCase, len(inputs))
	for i, in := range inputs {
		cases[i] = endpointCase{in, sanitizeEndpoint(in)}
	}
	checkVector(t, "endpoint-sanitize.json", cases)
}
