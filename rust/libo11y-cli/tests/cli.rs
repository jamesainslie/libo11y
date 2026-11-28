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

fn conformance_dir() -> Option<PathBuf> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = repo_root.join("conformance/appregistry");
    if dir.exists() {
        return Some(dir);
    }
    assert!(
        !(repo_root.join("Makefile").exists() && repo_root.join("docs/SPEC.md").exists()),
        "conformance directory {} is missing inside the repository",
        dir.display()
    );
    None
}

fn conformance_file(name: &str) -> Option<PathBuf> {
    conformance_dir().map(|dir| dir.join(name))
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
fn every_conformance_case_matches_its_want_file() {
    let Some(dir) = conformance_dir() else {
        return;
    };
    let mut cases: Vec<PathBuf> = fs::read_dir(&dir)
        .expect("read conformance/appregistry")
        .map(|entry| entry.expect("dir entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "yaml"))
        .collect();
    cases.sort();
    assert!(
        cases.len() >= 40,
        "expected full conformance suite, found only {} cases",
        cases.len()
    );

    let mut failures = Vec::new();
    for path in &cases {
        let want_raw =
            fs::read_to_string(path.with_extension("want")).expect("conformance case has .want");
        let want = want_raw.trim_end_matches('\n');
        let path_str = path.to_string_lossy();
        let out = run_cli(&["registry", "check", &path_str]);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);

        if let Some(rest) = want.strip_prefix("ok ") {
            let mut parts = rest.splitn(2, ' ');
            let count: usize = parts
                .next()
                .expect("ok count")
                .parse()
                .expect("numeric ok count");
            let namespace = parts.next().expect("ok namespace");
            let noun = if count == 1 {
                "attribute"
            } else {
                "attributes"
            };
            let expected = format!("{path_str}: ok ({count} {noun} in namespace {namespace})\n");
            if out.status.code() != Some(0) || stdout != expected || !stderr.is_empty() {
                failures.push(format!(
                    "{}: exit={:?} stdout={stdout:?} stderr={stderr:?} expected={expected:?}",
                    path.display(),
                    out.status.code()
                ));
            }
        } else if want.starts_with("parse: ") {
            let prefix = format!("{path_str}: ");
            if out.status.code() != Some(2)
                || !stdout.is_empty()
                || !stderr.starts_with(&prefix)
                || stderr.trim() == prefix.trim()
            {
                failures.push(format!(
                    "{}: exit={:?} stdout={stdout:?} stderr={stderr:?} want={want:?}",
                    path.display(),
                    out.status.code()
                ));
            }
        } else {
            use std::fmt::Write as _;
            let mut expected = String::new();
            for line in want.lines() {
                let _ = writeln!(expected, "{path_str}: {line}");
            }
            if out.status.code() != Some(1) || stdout != expected || !stderr.is_empty() {
                failures.push(format!(
                    "{}: exit={:?}\n got stdout:\n{stdout}\nwant stdout:\n{expected}\nstderr={stderr:?}",
                    path.display(),
                    out.status.code()
                ));
            }
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[cfg(unix)]
#[test]
fn non_utf8_cli_argument_exits_two_without_panicking() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt as _;

    let missing = OsStr::from_bytes(b"/nonexistent-libo11y-\xff.yaml");
    let out = cli()
        .arg("registry")
        .arg("check")
        .arg(missing)
        .output()
        .expect("execute libo11y binary");
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("no such file or directory"));
}

#[test]
fn same_namespace_in_two_files_and_missing_file_and_usage() {
    let dir = TempDir::new();
    let a = dir.write(
        "first.yaml",
        "schema: libo11y.app-registry/v1\nnamespace: acme\nattributes:\n  acme.req.id: {type: string, sensitivity: internal, cardinality: unbounded}\n",
    );
    let b = dir.write(
        "second.yaml",
        "schema: libo11y.app-registry/v1\nnamespace: acme\nattributes:\n  acme.user.id: {type: string, sensitivity: internal, cardinality: unbounded}\n",
    );
    // Each file is validated on its own, as in the Go CLI, so two valid
    // files that share a namespace both pass.
    let out = run_cli(&["registry", "check", &a, &b]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(0), "{stdout}");
    assert_eq!(
        stdout,
        format!(
            "{a}: ok (1 attribute in namespace acme)\n{b}: ok (1 attribute in namespace acme)\n"
        )
    );
    assert!(out.stderr.is_empty());

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
