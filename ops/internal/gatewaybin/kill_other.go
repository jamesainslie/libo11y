//go:build !linux

package gatewaybin

import "os/exec"

// killWithParent does nothing outside Linux, which has no parent death
// signal; the process budget still bounds the gateway's life.
func killWithParent(*exec.Cmd) {}
