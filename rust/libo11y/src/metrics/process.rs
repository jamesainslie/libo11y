//! Process runtime metrics registered on the SDK's own meter provider.
//!
//! Emits the standard `process.*` observable instruments on Linux via safe
//! reads of `/proc/self/{stat,status,fd,auxv}` (zero `unsafe` code). On
//! non-Linux platforms this is a safe no-op stub.

use opentelemetry::metrics::MeterProvider;
#[cfg(target_os = "linux")]
use opentelemetry::metrics::{ObservableCounter, ObservableUpDownCounter};

/// Holds the registered process runtime observable instruments so they stay
/// alive for the lifetime of the [`Sdk`](crate::Sdk).
#[derive(Debug, Default)]
pub(crate) struct ProcessMetrics {
    #[cfg(target_os = "linux")]
    _handles: Option<LinuxHandles>,
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct LinuxHandles {
    _cpu_time: ObservableCounter<f64>,
    _memory_usage: ObservableUpDownCounter<i64>,
    _memory_virtual: ObservableUpDownCounter<i64>,
    _thread_count: ObservableUpDownCounter<i64>,
    _fd_count: ObservableUpDownCounter<i64>,
}

/// Registers the process runtime metrics on `provider` (never the global
/// provider).
pub(crate) fn register<P: MeterProvider + ?Sized>(provider: &P) -> ProcessMetrics {
    #[cfg(target_os = "linux")]
    {
        register_linux(provider)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = provider;
        ProcessMetrics::default()
    }
}

#[cfg(target_os = "linux")]
fn register_linux<P: MeterProvider + ?Sized>(provider: &P) -> ProcessMetrics {
    use opentelemetry::KeyValue;

    let meter = provider.meter_with_scope(crate::violations::scope());

    let cpu_time = meter
        .f64_observable_counter("process.cpu.time")
        .with_unit("s")
        .with_description("Total CPU seconds broken down by different states.")
        .with_callback(|observer| {
            if let Some((user, system)) = linux::cpu_time_seconds() {
                observer.observe(user, &[KeyValue::new("cpu.mode", "user")]);
                observer.observe(system, &[KeyValue::new("cpu.mode", "system")]);
            }
        })
        .build();

    let memory_usage = meter
        .i64_observable_up_down_counter("process.memory.usage")
        .with_unit("By")
        .with_description("The amount of physical memory in use.")
        .with_callback(|observer| {
            if let Some(rss) = linux::memory_rss_bytes() {
                observer.observe(rss, &[]);
            }
        })
        .build();

    let memory_virtual = meter
        .i64_observable_up_down_counter("process.memory.virtual")
        .with_unit("By")
        .with_description("The amount of committed virtual memory.")
        .with_callback(|observer| {
            if let Some(vsize) = linux::memory_virtual_bytes() {
                observer.observe(vsize, &[]);
            }
        })
        .build();

    let thread_count = meter
        .i64_observable_up_down_counter("process.thread.count")
        .with_unit("{thread}")
        .with_description("Process threads count.")
        .with_callback(|observer| {
            if let Some(threads) = linux::thread_count() {
                observer.observe(threads, &[]);
            }
        })
        .build();

    let fd_count = meter
        .i64_observable_up_down_counter("process.unix.file_descriptor.count")
        .with_unit("{file_descriptor}")
        .with_description("Number of file descriptors in use by the process.")
        .with_callback(|observer| {
            if let Some(fds) = linux::fd_count() {
                observer.observe(fds, &[]);
            }
        })
        .build();

    ProcessMetrics {
        _handles: Some(LinuxHandles {
            _cpu_time: cpu_time,
            _memory_usage: memory_usage,
            _memory_virtual: memory_virtual,
            _thread_count: thread_count,
            _fd_count: fd_count,
        }),
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::fs;
    use std::sync::OnceLock;

    /// Auxiliary vector tag for `USER_HZ` (`AT_CLKTCK`).
    const AT_CLKTCK: usize = 17;
    /// Auxiliary vector tag for system page size (`AT_PAGESZ`).
    const AT_PAGESZ: usize = 6;
    /// Default Linux `USER_HZ` fallback when `/proc/self/auxv` is unavailable.
    const DEFAULT_CLK_TCK: f64 = 100.0;
    /// Default page size fallback when `/proc/self/auxv` is unavailable.
    const DEFAULT_PAGE_SIZE: u64 = 4096;

    static CLK_TCK: OnceLock<f64> = OnceLock::new();
    static PAGE_SIZE: OnceLock<u64> = OnceLock::new();

    /// Reads an entry from `/proc/self/auxv` safely without `unsafe` or libc.
    fn auxv_value(tag: usize) -> Option<usize> {
        let bytes = fs::read("/proc/self/auxv").ok()?;
        parse_auxv(&bytes, tag)
    }

    pub(super) fn parse_auxv(bytes: &[u8], target_tag: usize) -> Option<usize> {
        let word = size_of::<usize>();
        let pair = word * 2;
        for chunk in bytes.chunks_exact(pair) {
            let tag = usize::from_ne_bytes(chunk[..word].try_into().ok()?);
            let val = usize::from_ne_bytes(chunk[word..].try_into().ok()?);
            if tag == 0 {
                break;
            }
            if tag == target_tag && val > 0 {
                return Some(val);
            }
        }
        None
    }

    #[allow(
        clippy::cast_precision_loss,
        reason = "clock ticks per second is small (typically 100)"
    )]
    fn clk_tck() -> f64 {
        *CLK_TCK.get_or_init(|| auxv_value(AT_CLKTCK).map_or(DEFAULT_CLK_TCK, |ticks| ticks as f64))
    }

    fn page_size() -> u64 {
        *PAGE_SIZE.get_or_init(|| {
            auxv_value(AT_PAGESZ)
                .and_then(|v| u64::try_from(v).ok())
                .unwrap_or(DEFAULT_PAGE_SIZE)
        })
    }

    /// Parses `(utime_ticks, stime_ticks, vsize_bytes, rss_pages)` from
    /// `/proc/self/stat`.
    pub(super) fn parse_proc_stat(contents: &str) -> Option<(u64, u64, u64, u64)> {
        // Field 2 is `(comm)`, which may contain spaces and parentheses; find
        // the last `)` before splitting remaining fields starting at field 3.
        let after_comm = contents.rsplit_once(')')?.1;
        let mut fields = after_comm.split_whitespace();
        // After `)`: index 0 is field 3 (state).
        // field 14 (utime) => index 11
        // field 15 (stime) => index 12
        // field 23 (vsize) => index 20
        // field 24 (rss)   => index 21
        let utime = fields.nth(11)?.parse::<u64>().ok()?;
        let stime = fields.next()?.parse::<u64>().ok()?;
        let vsize = fields.nth(7)?.parse::<u64>().ok()?;
        let rss = fields.next()?.parse::<u64>().ok()?;
        Some((utime, stime, vsize, rss))
    }

    /// Parses a named integer field from `/proc/self/status`, returning bytes
    /// if the unit is `kB`.
    pub(super) fn parse_status_field(contents: &str, key: &str) -> Option<i64> {
        for line in contents.lines() {
            let Some(rest) = line.strip_prefix(key) else {
                continue;
            };
            let mut parts = rest.split_whitespace();
            let value = parts.next()?.parse::<i64>().ok()?;
            return match parts.next() {
                Some("kB") => value.checked_mul(1024),
                _ => Some(value),
            };
        }
        None
    }

    #[allow(
        clippy::cast_precision_loss,
        reason = "CPU ticks converted to f64 seconds per OTel semconv"
    )]
    pub(super) fn cpu_time_seconds() -> Option<(f64, f64)> {
        let stat = fs::read_to_string("/proc/self/stat").ok()?;
        let (utime, stime, _, _) = parse_proc_stat(&stat)?;
        let hz = clk_tck();
        Some((utime as f64 / hz, stime as f64 / hz))
    }

    pub(super) fn memory_rss_bytes() -> Option<i64> {
        if let Ok(status) = fs::read_to_string("/proc/self/status")
            && let Some(rss) = parse_status_field(&status, "VmRSS:")
        {
            return Some(rss);
        }
        let stat = fs::read_to_string("/proc/self/stat").ok()?;
        let (_, _, _, rss_pages) = parse_proc_stat(&stat)?;
        i64::try_from(rss_pages.saturating_mul(page_size())).ok()
    }

    pub(super) fn memory_virtual_bytes() -> Option<i64> {
        if let Ok(status) = fs::read_to_string("/proc/self/status")
            && let Some(vsize) = parse_status_field(&status, "VmSize:")
        {
            return Some(vsize);
        }
        let stat = fs::read_to_string("/proc/self/stat").ok()?;
        let (_, _, vsize, _) = parse_proc_stat(&stat)?;
        i64::try_from(vsize).ok()
    }

    pub(super) fn thread_count() -> Option<i64> {
        let status = fs::read_to_string("/proc/self/status").ok()?;
        parse_status_field(&status, "Threads:")
    }

    pub(super) fn fd_count() -> Option<i64> {
        let count = fs::read_dir("/proc/self/fd").ok()?.count();
        // Exclude the directory descriptor opened by read_dir itself.
        i64::try_from(count.saturating_sub(1)).ok()
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::linux;

    #[test]
    fn parses_proc_stat_with_parens_in_comm() {
        let sample =
            "1234 (my (weird) proc) R 1 2 3 4 5 6 7 8 9 10 42 15 0 0 20 0 4 0 99 1048576 256 0";
        let (utime, stime, vsize, rss) = linux::parse_proc_stat(sample).expect("parsed");
        assert_eq!(utime, 42);
        assert_eq!(stime, 15);
        assert_eq!(vsize, 1_048_576);
        assert_eq!(rss, 256);
    }

    #[test]
    fn parses_proc_status_fields() {
        let sample = "Name:\ttest\nVmSize:\t    6896 kB\nVmRSS:\t    2176 kB\nThreads:\t3\n";
        assert_eq!(
            linux::parse_status_field(sample, "VmSize:"),
            Some(6896 * 1024)
        );
        assert_eq!(
            linux::parse_status_field(sample, "VmRSS:"),
            Some(2176 * 1024)
        );
        assert_eq!(linux::parse_status_field(sample, "Threads:"), Some(3));
    }

    #[test]
    fn parses_auxv_entries() {
        let mut buf = Vec::new();
        for (tag, val) in [(6usize, 4096usize), (17usize, 100usize), (0usize, 0usize)] {
            buf.extend_from_slice(&tag.to_ne_bytes());
            buf.extend_from_slice(&val.to_ne_bytes());
        }
        assert_eq!(linux::parse_auxv(&buf, 6), Some(4096));
        assert_eq!(linux::parse_auxv(&buf, 17), Some(100));
        assert_eq!(linux::parse_auxv(&buf, 99), None);
    }

    #[test]
    fn live_linux_readers_return_sensible_values() {
        let (user, system) = linux::cpu_time_seconds().expect("cpu time");
        assert!(user >= 0.0);
        assert!(system >= 0.0);
        assert!(linux::memory_rss_bytes().expect("rss") > 0);
        assert!(linux::memory_virtual_bytes().expect("vsize") > 0);
        assert!(linux::thread_count().expect("threads") >= 1);
        assert!(linux::fd_count().expect("fds") >= 1);
    }
}
