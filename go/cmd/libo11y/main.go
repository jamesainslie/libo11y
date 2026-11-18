// Command libo11y is the libo11y command-line tool. Its command
// `libo11y registry check FILE...` validates application attribute
// registries against the libo11y policy rules, for use in a consumer's CI.
//
// Exit status: 0 when every file is valid, 1 when a file breaks a policy
// rule, 2 on a usage, read, or parse error (the highest status wins).
package main

import (
	"fmt"
	"io"
	"os"

	"github.com/jamesainslie/libo11y/go/internal/appregistry"
)

const usage = "usage: libo11y registry check FILE..."

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// printf writes to a terminal stream; a failed write to stdout or stderr
// has nowhere to be reported, so its error is dropped on purpose.
func printf(w io.Writer, format string, args ...any) {
	_, _ = fmt.Fprintf(w, format, args...)
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help" || args[0] == "help") {
		printf(stdout, "%s\n", usage)
		return 0
	}
	if len(args) < 3 || args[0] != "registry" || args[1] != "check" {
		printf(stderr, "%s\n", usage)
		return 2
	}
	status := 0
	for _, path := range args[2:] {
		status = max(status, checkFile(path, stdout, stderr))
	}
	return status
}

// checkFile validates one registry file and returns its exit status.
func checkFile(path string, stdout, stderr io.Writer) int {
	raw, err := os.ReadFile(path)
	if err != nil {
		printf(stderr, "%v\n", err)
		return 2
	}
	reg, err := appregistry.Parse(raw)
	if err != nil {
		printf(stderr, "%s: %v\n", path, err)
		return 2
	}
	violations := reg.Validate()
	for _, v := range violations {
		printf(stdout, "%s: %s\n", path, v)
	}
	if len(violations) > 0 {
		return 1
	}
	printf(stdout, "%s: ok (%d attributes in namespace %s)\n", path, len(reg.Attributes), reg.Namespace)
	return 0
}
