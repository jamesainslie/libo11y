//! Deadlines for flush, shutdown and export calls.
//!
//! A deadline is a point on the monotonic `awake` clock. Every call that
//! can wait takes one, so a caller's shutdown budget bounds every retry
//! and every network wait below it.

const std = @import("std");
const Io = std.Io;

/// A point in time on `Io.Clock.awake` after which a call gives up.
pub const Deadline = Io.Clock.Timestamp;

/// The clock every deadline uses.
pub const clock: Io.Clock = .awake;

/// Returns the deadline `duration` from now.
pub fn after(io: Io, duration: Io.Duration) Deadline {
    return Deadline.fromNow(io, .{ .raw = duration, .clock = clock });
}

/// Returns the earlier of two deadlines.
pub fn earliest(a: Deadline, b: Deadline) Deadline {
    return if (a.compare(.lte, b)) a else b;
}

/// Reports whether `deadline` has passed.
pub fn expired(io: Io, deadline: Deadline) bool {
    return remaining(io, deadline).nanoseconds <= 0;
}

/// Returns the time left until `deadline`, which is negative once it has
/// passed.
pub fn remaining(io: Io, deadline: Deadline) Io.Duration {
    return deadline.durationFromNow(io).raw;
}

/// Returns `deadline` as an `Io.Timeout` for the waiting calls of `std.Io`.
pub fn timeout(deadline: Deadline) Io.Timeout {
    return .{ .deadline = deadline };
}

test "after, earliest, expired and remaining agree" {
    const io = std.testing.io;
    const soon = after(io, .fromMilliseconds(50));
    const later = after(io, .fromSeconds(60));
    try std.testing.expectEqual(soon, earliest(soon, later));
    try std.testing.expectEqual(soon, earliest(later, soon));
    try std.testing.expect(!expired(io, later));
    try std.testing.expect(remaining(io, later).nanoseconds > 0);
    const past = after(io, .fromMilliseconds(-1));
    try std.testing.expect(expired(io, past));
}
