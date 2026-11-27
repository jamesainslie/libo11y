module github.com/jamesainslie/libo11y/go/o11yrum

go 1.26.0

// The parent module resolves from this checkout when the go.work
// workspace is off. Downstream consumers ignore replace directives and
// resolve the version required above.
replace github.com/jamesainslie/libo11y/go => ../
