//! Records the rustc version that compiles libo11y, which the resource
//! reports as `process.runtime.version`.

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=RUSTC");
    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_owned());
    // `rustc -V` prints "rustc 1.95.0 (59807616e 2026-04-14)".
    let version = Command::new(rustc)
        .arg("-V")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|out| out.split_whitespace().nth(1).map(str::to_owned))
        .unwrap_or_default();
    println!("cargo:rustc-env=LIBO11Y_RUSTC_VERSION={version}");
}
