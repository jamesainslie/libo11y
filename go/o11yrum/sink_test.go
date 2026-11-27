package o11yrum

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestExportJoinsSinkErrors(t *testing.T) {
	ok := &recordingSink{}
	failing := &namedFailingSink{name: "collector"}
	err := exportAll(context.Background(), []Sink{failing, ok}, Batch{Service: "shop-web", Signal: SignalLogs})
	if err == nil || !strings.Contains(err.Error(), "sink collector") || !errors.Is(err, errSinkTest) {
		t.Fatalf("err = %v", err)
	}
	if ok.count() != 1 {
		t.Fatal("a failing sink stopped the others")
	}
	if err := exportAll(context.Background(), []Sink{ok}, Batch{}); err != nil {
		t.Fatalf("err = %v", err)
	}
}

var errSinkTest = errors.New("refused")

type namedFailingSink struct{ name string }

func (s *namedFailingSink) Name() string { return s.name }

func (s *namedFailingSink) Export(context.Context, Batch) error { return errSinkTest }
