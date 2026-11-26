//! Private database telemetry and SQL text sanitization module shared by
//! `o11ypg` and `o11ysqlite`.

pub const sqltext = @import("sqltext.zig");
pub const telemetry = @import("telemetry.zig");

test {
    _ = sqltext;
    _ = telemetry;
}
