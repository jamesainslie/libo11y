module github.com/jamesainslie/libo11y/go/o11ysql

go 1.26.0

require github.com/jamesainslie/libo11y/go v0.2.0

// Builds this checkout against the parent in the same checkout when the
// go.work workspace is off. Downstream consumers ignore replace directives
// and resolve the parent from its go/vX.Y.Z tag.
replace github.com/jamesainslie/libo11y/go => ../
