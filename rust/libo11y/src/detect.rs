//! What libo11y's resource detectors find about the running process, in
//! the layers the Go library uses: the telemetry SDK, `host.name`, the
//! process runtime and `container.id`. Never the process ID, the command
//! line or `host.id`.

use opentelemetry::KeyValue;
use opentelemetry_sdk::resource::{ResourceDetector, TelemetryResourceDetector};

use libo11y_spec::attr;

/// The cgroup file the container ID is read from.
const CGROUP_PATH: &str = "/proc/self/cgroup";

/// The rustc version that compiled libo11y, recorded by build.rs.
const RUSTC_VERSION: &str = env!("LIBO11Y_RUSTC_VERSION");

/// The detected layers of the resource, lowest precedence first.
#[derive(Debug, Clone, Default)]
pub(crate) struct Detected {
    /// `telemetry.sdk.*`.
    pub(crate) telemetry_sdk: Vec<KeyValue>,
    pub(crate) host_name: Option<String>,
    pub(crate) runtime_version: String,
    pub(crate) container_id: Option<String>,
}

impl Detected {
    /// Detects the running process.
    pub(crate) fn from_system() -> Self {
        Self {
            telemetry_sdk: TelemetryResourceDetector
                .detect()
                .iter()
                .map(|(key, value)| KeyValue::new(key.clone(), value.clone()))
                .collect(),
            host_name: gethostname::gethostname().into_string().ok(),
            runtime_version: RUSTC_VERSION.to_owned(),
            container_id: std::fs::read_to_string(CGROUP_PATH)
                .ok()
                .and_then(|cgroup| container_id(&cgroup)),
        }
    }

    /// The detected attributes, lowest precedence first.
    pub(crate) fn attributes(&self) -> Vec<KeyValue> {
        let mut attrs = self.telemetry_sdk.clone();
        if let Some(host) = self.host_name.as_ref().filter(|h| !h.is_empty()) {
            attrs.push(KeyValue::new(attr::HOST_NAME, host.clone()));
        }
        attrs.push(KeyValue::new(attr::PROCESS_RUNTIME_NAME, "rustc"));
        if !self.runtime_version.is_empty() {
            attrs.push(KeyValue::new(
                attr::PROCESS_RUNTIME_VERSION,
                self.runtime_version.clone(),
            ));
        }
        if let Some(id) = &self.container_id {
            attrs.push(KeyValue::new(attr::CONTAINER_ID, id.clone()));
        }
        attrs
    }
}

/// Finds the container ID in a `/proc/self/cgroup` file as OpenTelemetry
/// Go's container detector does: the first line matching
/// `^.*/(?:.*[-:])?([0-9a-f]+)(?:\.|\s*$)`.
pub(crate) fn container_id(cgroup: &str) -> Option<String> {
    cgroup.lines().find_map(container_id_in_line)
}

/// Matches one line. The regex prefers the latest start for the hex run: a
/// position after a `-` or `:` past the first `/`, or after any `/`. The
/// run must be followed by `.` or by nothing but white space.
fn container_id_in_line(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let first_slash = bytes.iter().position(|&c| c == b'/')?;
    (first_slash + 1..=bytes.len()).rev().find_map(|start| {
        let eligible = match bytes[start - 1] {
            b'/' => true,
            b'-' | b':' => start - 1 > first_slash,
            _ => false,
        };
        if !eligible {
            return None;
        }
        let run = bytes[start..]
            .iter()
            .take_while(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
            .count();
        let rest = &bytes[start + run..];
        let ends = rest.first() == Some(&b'.')
            || rest
                .iter()
                .all(|c| matches!(c, b'\t' | b'\n' | 0x0c | b'\r' | b' '));
        (run > 0 && ends).then(|| line[start..start + run].to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_container_ids_as_go_does() {
        for (line, want) in [
            (
                "13:name=systemd:/podruntime/docker/kubepods/docker-dc579f8a8319c8cf7d38e1adf263bc08d23",
                Some("dc579f8a8319c8cf7d38e1adf263bc08d23"),
            ),
            (
                "11:devices:/kubepods.slice/crio-dc679f8a8319c8cf7d38e1adf263bc08d23.scope",
                Some("dc679f8a8319c8cf7d38e1adf263bc08d23"),
            ),
            (
                "1:name=systemd:/pod/d86d75589bf6cc254f3e2cc29debdf85dde404998aa128997a819ff991827356",
                Some("d86d75589bf6cc254f3e2cc29debdf85dde404998aa128997a819ff991827356"),
            ),
            (
                "0::/kubepods/burstable/podABC/cri-containerd:e857a4bf04e0a6b0d3b1b9f3d6e2c1a0f9e8d7c6b5a4938271605f4e3d2c1b0a",
                Some("e857a4bf04e0a6b0d3b1b9f3d6e2c1a0f9e8d7c6b5a4938271605f4e3d2c1b0a"),
            ),
            // Go takes any run of hex digits, however short.
            ("0::/docker/abc123", Some("abc123")),
            ("0::/user.slice/abc123 ", Some("abc123")),
            ("0::/", None),
            ("0::/init.scope", None),
            ("no slash here", None),
            ("0::/a-xyz", None),
            // The last match position wins: the hex run after the last
            // dash or colon, else after the last slash.
            ("0::/aa-bb-cc", Some("cc")),
            ("0::/x/aa-zz", None),
        ] {
            assert_eq!(container_id(line).as_deref(), want, "{line:?}");
        }
        assert_eq!(
            container_id("12:cpu:/\n0::/docker/beef\n0::/docker/cafe\n").as_deref(),
            Some("beef")
        );
    }

    #[test]
    fn detected_layers_never_carry_process_identity() {
        let detected = Detected::from_system();
        let keys: Vec<String> = detected
            .attributes()
            .iter()
            .map(|kv| kv.key.to_string())
            .collect();
        for key in [
            "telemetry.sdk.name",
            "telemetry.sdk.language",
            "telemetry.sdk.version",
        ] {
            assert!(keys.iter().any(|k| k == key), "{key} in {keys:?}");
        }
        assert!(keys.iter().any(|k| k == "process.runtime.name"));
        for forbidden in [
            "process.pid",
            "process.command_line",
            "process.command_args",
            "host.id",
        ] {
            assert!(
                !keys.iter().any(|k| k == forbidden),
                "{forbidden} in {keys:?}"
            );
        }
        assert!(!RUSTC_VERSION.is_empty());
    }
}
