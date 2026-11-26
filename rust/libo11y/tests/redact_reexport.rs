//! The derive reached through `libo11y::redact` names that path, so a user
//! who depends only on `libo11y` can derive `Redact`.

use libo11y::redact::{Redact, Secret};

#[derive(Redact)]
struct Login {
    user: String,
    #[o11y(secret)]
    password: String,
    token: Secret<String>,
}

#[test]
fn derive_through_core_renders_the_protected_form() {
    let login = Login {
        user: "ada".to_owned(),
        password: "hunter2".to_owned(),
        token: Secret::new("t0k3n".to_owned()),
    };
    let text = login.to_string();
    assert_eq!(text, "{user:ada password:REDACTED token:REDACTED}");
    assert!(!format!("{login:?}").contains("hunter2"));
    assert_eq!(login.password, "hunter2", "the value itself is kept");
}
