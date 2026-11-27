module github.com/jamesainslie/libo11y/go/o11yrum

go 1.26.0

require gopkg.in/yaml.v3 v3.0.1

// The parent module resolves from this checkout when the go.work
// workspace is off. Downstream consumers ignore replace directives and
// resolve the version required above.
replace github.com/jamesainslie/libo11y/go => ../
