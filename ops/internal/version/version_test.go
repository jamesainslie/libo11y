package version

import (
	"os"
	"regexp"
	"testing"
)

// Version must be plain semver, and the module must keep a changelog that
// a release lists it in.
func TestVersionIsSemver(t *testing.T) {
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(Version) {
		t.Fatalf("Version %q is not MAJOR.MINOR.PATCH", Version)
	}
	if _, err := os.Stat("../../CHANGELOG.md"); err != nil {
		t.Fatal(err)
	}
}
