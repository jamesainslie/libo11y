package o11y_test

import (
	"os"
	"regexp"
	"testing"

	"github.com/jamesainslie/libo11y/go/spec"
)

// The README quotes the schema URL and the current schema file. Both come
// from the generated spec package, so a spec release that forgets the
// README fails here.
func TestREADMENamesTheCurrentSpecVersion(t *testing.T) {
	t.Parallel()
	readme, err := os.ReadFile("README.md")
	if err != nil {
		t.Fatal(err)
	}
	quoted := regexp.MustCompile(`schemas\.o11y\.ing/libo11y/(\d+\.\d+\.\d+)|spec/schemas/(\d+\.\d+\.\d+)`)
	matches := quoted.FindAllSubmatch(readme, -1)
	if len(matches) < 2 {
		t.Fatalf("README quotes the spec version %d times, want the schema URL and the schema file", len(matches))
	}
	for _, m := range matches {
		if version := string(m[1]) + string(m[2]); version != spec.SpecVersion {
			t.Errorf("README says %s, want spec %s", m[0], spec.SpecVersion)
		}
	}
}
