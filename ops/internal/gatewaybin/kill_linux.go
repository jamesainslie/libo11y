package gatewaybin

import (
	"os/exec"
	"syscall"
)

// killWithParent asks Linux to kill the gateway when the process that
// started it dies, so a test binary that panics on its timeout cannot
// leave the gateway holding its ports.
func killWithParent(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
