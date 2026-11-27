//! The `libo11y` binary entry point.

use std::io;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut stdout = io::stdout().lock();
    let mut stderr = io::stderr().lock();
    let code = libo11y_cli::run(std::env::args().skip(1), &mut stdout, &mut stderr);
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
