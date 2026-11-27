//! Binary integration tests for the `libo11y` CLI.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn cli() -> Command {
    Command::new(env!("CARGO_BIN_EXE_libo11y"))
}

fn run_cli(args: &[&str]) -> Output {
    cli().args(args).output().expect("execute libo11y binary")
}

fn conformance_file(name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/appregistry")
        .join(name);
    path.exists().then_some(path)
}

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("libo11y-cli-it-{}-{id}", std::process::id()));
        fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }

    fn write(&self, name: &str, content: &str) -> String {
        let path = self.0.join(name);
        fs::write(&path, content).expect("write fixture");
        path.to_string_lossy().into_owned()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn valid_conformance_registry_exits_zero() {
    let Some(valid) = conformance_file("valid.yaml") else {
        return;
    };
    let valid_str = valid.to_string_lossy();
    let out = run_cli(&["registry", "check", &valid_str]);
    assert_eq!(out.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stdout.contains(": ok ("), "{stdout}");
    assert!(stderr.is_empty(), "{stderr}");
}

#[test]
fn invalid_conformance_registries_return_expected_exit_codes() {
    for violation_case in [
        "namespace-reserved.yaml",
        "namespace-reserved-state.yaml",
        "bad-name.yaml",
        "multi.yaml",
        "sensitivity-missing.yaml",
    ] {
        let Some(path) = conformance_file(violation_case) else {
            return;
        };
        let path_str = path.to_string_lossy();
        let out = run_cli(&["registry", "check", &path_str]);
        assert_eq!(
            out.status.code(),
            Some(1),
            "{violation_case}: stdout={}, stderr={}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(out.stderr.is_empty());
    }

    for parse_case in [
        "syntax.yaml",
        "empty.yaml",
        "duplicate-key.yaml",
        "second-document.yaml",
    ] {
        let Some(path) = conformance_file(parse_case) else {
            return;
        };
        let path_str = path.to_string_lossy();
        let out = run_cli(&["registry", "check", &path_str]);
        assert_eq!(
            out.status.code(),
            Some(2),
            "{parse_case}: stdout={}, stderr={}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(out.stdout.is_empty());
        assert!(!out.stderr.is_empty());
    }
}

#[test]
fn duplicate_namespace_and_missing_file_and_usage() {
    let dir = TempDir::new();
    let a = dir.write(
        "first.yaml",
        "schema: libo11y.app-registry/v1\nnamespace: acme\nattributes:\n  acme.req.id: {type: string, sensitivity: internal, cardinality: unbounded}\n",
    );
    let b = dir.write(
        "second.yaml",
        "schema: libo11y.app-registry/v1\nnamespace: acme\nattributes:\n  acme.user.id: {type: string, sensitivity: internal, cardinality: unbounded}\n",
    );
    let out = run_cli(&["registry", "check", &a, &b]);
    assert_eq!(out.status.code(), Some(1));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("libo11y_app_namespace_duplicate"),
        "{stdout}"
    );

    let missing = dir.0.join("missing.yaml");
    let missing_str = missing.to_string_lossy();
    let out = run_cli(&["registry", "check", &missing_str]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("no such file"));

    let out = run_cli(&["--help"]);
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("usage:"));

    let out = run_cli(&["unknown"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage:"));

    let out = run_cli(&["registry", "check"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage:"));
}
