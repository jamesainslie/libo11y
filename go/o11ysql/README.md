# o11ysql

o11ysql instruments `database/sql` with the database semantic conventions.
It wraps a `driver.Connector`, so it works with any driver. The usage guide
is in [the Go README](../README.md).

## Why libo11y owns this code

libo11y's rule is to wrap setup, never instrumentation. Each other package
configures an upstream OpenTelemetry instrumentation library rather than
writing its own. o11ysql is an accepted exception to that rule.

OpenTelemetry contrib has no `database/sql` instrumentation to wrap. The
common community library, `github.com/XSAM/otelsql` v0.44.0, cannot produce
the telemetry libo11y specifies:

- It sets `db.operation.name` on `db.client.operation.duration` to its own
  method names, such as `sql.conn.query`. That overrides the semantic
  conventions value, which names the SQL operation.
- It records `db.query.text` as the raw statement, with every literal
  value it carried. libo11y records the text only after removing every
  literal.
- It names its pool metrics `db.sql.connection.*`. The semantic
  conventions name them `db.client.connection.count` and
  `db.client.connection.max`.

So o11ysql is a small connector wrapper of libo11y's own. It adds no
third-party dependency beyond the OpenTelemetry modules the core already
requires.
