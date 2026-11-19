package main

import (
	"testing"

	"github.com/jamesainslie/libo11y/go/internal/appregistry"
)

// TestReservedNamespacesMatchSemconvPin pins the application registry's
// reserved namespaces to the semconv release the spec registry pins, so a
// semconv bump cannot land without a review of the reserved list. It lives
// here, not in appregistry, because appregistry is in the core library's
// import graph and its tests run in consumers' modules, where spec/ is
// absent.
func TestReservedNamespacesMatchSemconvPin(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	if m.semconvVersion != appregistry.ReservedSemconvVersion {
		t.Errorf("manifest pins semconv %s but appregistry's reserved namespaces reflect %s: review them for the new semconv release, then update ReservedSemconvVersion",
			m.semconvVersion, appregistry.ReservedSemconvVersion)
	}
}
