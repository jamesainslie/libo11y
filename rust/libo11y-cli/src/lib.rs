//! The `libo11y` command-line tool.
//!
//! `libo11y registry check FILE...` validates application attribute registries
//! against the libo11y policy rules, for use in a consumer's CI.
//!
//! Each file is checked on its own, as in the Go and TypeScript tools.
//!
//! Exit status: `0` when every file is valid, `1` when a file breaks a policy
//! rule, `2` on a usage, read, or parse error (the highest status wins).

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Write};
use std::path::Path;

use libo11y::appregistry::Registry;

/// Usage line printed on `--help` or usage errors.
pub const USAGE: &str = "usage: libo11y registry check FILE...";

/// Runs the CLI against UTF-8 `args`, writing output to `stdout` and errors to
/// `stderr`, and returns the process exit status (`0`, `1`, or `2`).
#[must_use]
pub fn run<I, S, Out, Err>(args: I, stdout: &mut Out, stderr: &mut Err) -> i32
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
    Out: Write,
    Err: Write,
{
    run_os(
        args.into_iter().map(|s| OsString::from(s.as_ref())),
        stdout,
        stderr,
    )
}

/// Runs the CLI against OS-native `args` (including non-UTF-8 paths on Unix),
/// writing output to `stdout` and errors to `stderr`, and returns the process
/// exit status (`0`, `1`, or `2`).
#[must_use]
pub fn run_os<I, S, Out, Err>(args: I, stdout: &mut Out, stderr: &mut Err) -> i32
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
    Out: Write,
    Err: Write,
{
    let args: Vec<OsString> = args
        .into_iter()
        .map(|s| s.as_ref().to_os_string())
        .collect();
    if args.len() == 1 && matches!(args[0].to_str(), Some("-h" | "--help" | "help")) {
        let _ = writeln!(stdout, "{USAGE}");
        return 0;
    }
    if args.len() < 3 || args[0] != OsStr::new("registry") || args[1] != OsStr::new("check") {
        let _ = writeln!(stderr, "{USAGE}");
        return 2;
    }

    args[2..]
        .iter()
        .map(|arg| check_file(Path::new(arg), stdout, stderr))
        .fold(0, i32::max)
}

/// Validates one registry file and returns its exit status (`0`, `1`, or `2`).
fn check_file<Out: Write, Err: Write>(path: &Path, stdout: &mut Out, stderr: &mut Err) -> i32 {
    let display = path.display();
    let raw = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) => {
            let _ = writeln!(stderr, "{}", format_read_error(path, &err));
            return 2;
        }
    };

    let reg = match Registry::parse(&raw) {
        Ok(reg) => reg,
        Err(err) => {
            let _ = writeln!(stderr, "{display}: {err}");
            return 2;
        }
    };

    let violations = reg.validate();
    if !violations.is_empty() {
        for violation in &violations {
            let _ = writeln!(stdout, "{display}: {violation}");
        }
        return 1;
    }

    let count = reg.attributes.len();
    let noun = if count == 1 {
        "attribute"
    } else {
        "attributes"
    };
    let _ = writeln!(
        stdout,
        "{display}: ok ({count} {noun} in namespace {})",
        reg.namespace
    );
    0
}

/// Formats an I/O read error to match Go's `os.ReadFile` message text.
fn format_read_error(path: &Path, err: &io::Error) -> String {
    let display = path.display();
    match err.kind() {
        io::ErrorKind::NotFound => format!("open {display}: no such file or directory"),
        io::ErrorKind::PermissionDenied => format!("open {display}: permission denied"),
        io::ErrorKind::IsADirectory => format!("read {display}: is a directory"),
        io::ErrorKind::NotADirectory => format!("open {display}: not a directory"),
        io::ErrorKind::InvalidInput => format!("open {display}: invalid argument"),
        _ => {
            let raw = err.to_string();
            let detail = raw
                .find(" (os error ")
                .map_or(raw.as_str(), |pos| &raw[..pos]);
            let mut chars = detail.chars();
            let normalized = match chars.next() {
                Some(first) if first.is_ascii_uppercase() => {
                    let mut out = String::with_capacity(detail.len());
                    out.push(first.to_ascii_lowercase());
                    out.push_str(chars.as_str());
                    out
                }
                _ => detail.to_owned(),
            };
            format!("open {display}: {normalized}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let id = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("libo11y-cli-unit-{}-{id}", std::process::id()));
            fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        fn write(&self, name: &str, body: &str) -> String {
            let path = self.0.join(name);
            fs::write(&path, body).expect("write fixture");
            path.to_string_lossy().into_owned()
        }

        fn path(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn run_str(args: &[&str]) -> (i32, String, String) {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = run(args, &mut stdout, &mut stderr);
        (
            code,
            String::from_utf8(stdout).expect("utf8 stdout"),
            String::from_utf8(stderr).expect("utf8 stderr"),
        )
    }

    #[test]
    fn valid_single_and_multiple_registries() {
        let dir = TempDir::new();
        let one = dir.write(
            "lor.yaml",
            "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.user.id: {type: string, sensitivity: internal, cardinality: unbounded}\n",
        );
        let two = dir.write(
            "shop.yaml",
            "schema: libo11y.app-registry/v1\nnamespace: shop\nattributes:\n  shop.order.id: {type: string, sensitivity: internal, cardinality: unbounded}\n  shop.order.tier: {type: string, sensitivity: public, cardinality: enum, values: [free, pro]}\n",
        );

        let (code, stdout, stderr) = run_str(&["registry", "check", &one]);
        assert_eq!(code, 0);
        assert!(
            stdout.contains("ok (1 attribute in namespace lor)"),
            "{stdout}"
        );
        assert!(stderr.is_empty(), "{stderr}");

        let (code, stdout, stderr) = run_str(&["registry", "check", &one, &two]);
        assert_eq!(code, 0);
        assert!(
            stdout.contains("ok (1 attribute in namespace lor)"),
            "{stdout}"
        );
        assert!(
            stdout.contains("ok (2 attributes in namespace shop)"),
            "{stdout}"
        );
        assert!(stderr.is_empty(), "{stderr}");
    }

    #[test]
    fn two_files_in_one_namespace_are_checked_independently() {
        let dir = TempDir::new();
        let first = dir.write(
            "a.yaml",
            "schema: libo11y.app-registry/v1\nnamespace: billing\nattributes:\n  billing.invoice.id: {type: string, sensitivity: internal, cardinality: unbounded}\n",
        );
        let second = dir.write(
            "b.yaml",
            "schema: libo11y.app-registry/v1\nnamespace: billing\nattributes:\n  billing.plan.id: {type: string, sensitivity: public, cardinality: bounded}\n",
        );

        let (code, stdout, stderr) = run_str(&["registry", "check", &first, &second]);
        assert_eq!(code, 0, "{stdout}");
        assert_eq!(
            stdout,
            format!(
                "{first}: ok (1 attribute in namespace billing)\n{second}: ok (1 attribute in namespace billing)\n"
            )
        );
        assert!(stderr.is_empty(), "{stderr}");
    }

    #[test]
    fn violations_unparsable_missing_and_worst_status_wins() {
        let dir = TempDir::new();
        let invalid = dir.write(
            "invalid.yaml",
            "schema: libo11y.app-registry/v1\nnamespace: http\nattributes:\n  http.thing: {type: string, sensitivity: public, cardinality: bounded}\n",
        );
        let broken = dir.write("broken.yaml", "schema: [\n");
        let missing = dir.path("nope.yaml");

        let (code, stdout, stderr) = run_str(&["registry", "check", &invalid]);
        assert_eq!(code, 1);
        assert!(
            stdout.contains("libo11y_app_namespace_reserved"),
            "{stdout}"
        );
        assert!(stderr.is_empty(), "{stderr}");

        let (code, stdout, stderr) = run_str(&["registry", "check", &broken]);
        assert_eq!(code, 2);
        assert!(stdout.is_empty(), "{stdout}");
        assert!(stderr.contains("parsing application registry"), "{stderr}");

        let (code, stdout, stderr) = run_str(&["registry", "check", &missing]);
        assert_eq!(code, 2);
        assert!(stdout.is_empty(), "{stdout}");
        assert!(stderr.contains("no such file"), "{stderr}");

        // Highest status wins across files.
        let (code, stdout, stderr) = run_str(&["registry", "check", &invalid, &broken]);
        assert_eq!(code, 2);
        assert!(
            stdout.contains("libo11y_app_namespace_reserved"),
            "{stdout}"
        );
        assert!(stderr.contains("parsing application registry"), "{stderr}");
    }

    #[test]
    fn usage_and_help_flags() {
        for flag in ["-h", "--help", "help"] {
            let (code, stdout, stderr) = run_str(&[flag]);
            assert_eq!(code, 0, "{flag}");
            assert!(stdout.contains("usage:"), "{stdout}");
            assert!(stderr.is_empty(), "{stderr}");
        }

        for bad in [
            &[][..],
            &["lint"][..],
            &["registry"][..],
            &["registry", "check"][..],
        ] {
            let (code, stdout, stderr) = run_str(bad);
            assert_eq!(code, 2, "{bad:?}");
            assert!(stdout.is_empty(), "{stdout}");
            assert!(stderr.contains("usage:"), "{stderr}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_os_arguments_and_paths_do_not_panic() {
        use std::os::unix::ffi::OsStrExt as _;

        let dir = TempDir::new();
        let valid_path = dir.0.join(OsStr::from_bytes(b"reg-\xff.yaml"));
        fs::write(
            &valid_path,
            "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.user.id: {type: string, sensitivity: internal, cardinality: unbounded}\n",
        )
        .expect("write non-utf8 file");

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = run_os(
            [
                OsStr::new("registry"),
                OsStr::new("check"),
                valid_path.as_os_str(),
            ],
            &mut stdout,
            &mut stderr,
        );
        assert_eq!(code, 0, "stderr: {}", String::from_utf8_lossy(&stderr));
        assert!(
            String::from_utf8_lossy(&stdout).contains("ok (1 attribute in namespace lor)"),
            "{}",
            String::from_utf8_lossy(&stdout)
        );
        assert!(stderr.is_empty());

        let missing = dir.0.join(OsStr::from_bytes(b"missing-\xfe.yaml"));
        stdout.clear();
        stderr.clear();
        let code = run_os(
            [
                OsStr::new("registry"),
                OsStr::new("check"),
                missing.as_os_str(),
            ],
            &mut stdout,
            &mut stderr,
        );
        assert_eq!(code, 2);
        assert!(stdout.is_empty());
        assert!(String::from_utf8_lossy(&stderr).contains("no such file or directory"));
    }

    #[test]
    fn format_read_error_normalizes_uncommon_os_errors() {
        let dir = TempDir::new();
        let file = dir.write("plain.yaml", "x");
        let not_a_dir = PathBuf::from(&file).join("child.yaml");
        let err = fs::read(&not_a_dir).expect_err("not a dir");
        let msg = format_read_error(&not_a_dir, &err);
        assert!(msg.starts_with("open "), "{msg}");
        assert!(!msg.contains("(os error"), "{msg}");

        let fallback = io::Error::other("Too many levels of symbolic links (os error 40)");
        assert_eq!(
            format_read_error(Path::new("loop.yaml"), &fallback),
            "open loop.yaml: too many levels of symbolic links"
        );
    }
}
