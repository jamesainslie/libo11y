"""Build-time VCS and timestamp metadata recorder and reader.

Run as ``python -m libo11y.buildinfo out.json`` at image build time to stamp
``vcs.ref.head.revision``, ``o11y.build.time`` and ``o11y.build.modified`` into
a JSON file that ``Options(build_info=...)`` reads at startup.
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast


@dataclass(frozen=True, slots=True)
class BuildInfo:
    """VCS and build metadata stamped at image build time."""

    revision: str = ""
    build_time: str = ""
    modified: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "vcs.ref.head.revision": self.revision,
            "o11y.build.time": self.build_time,
            "o11y.build.modified": self.modified,
        }


def _git_output(args: list[str], cwd: Path | None) -> str:
    try:
        res = subprocess.run(
            ["git", *args],
            cwd=str(cwd) if cwd is not None else None,
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if res.returncode != 0:
        return ""
    return res.stdout.strip()


def collect_build_info(repo_dir: Path | None = None) -> BuildInfo:
    """Collect current git revision, dirty status, and UTC build timestamp."""
    revision = _git_output(["rev-parse", "HEAD"], repo_dir)
    status = _git_output(["status", "--porcelain"], repo_dir)
    modified = bool(status)
    build_time = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return BuildInfo(revision=revision, build_time=build_time, modified=modified)


def write_build_info(path: str | Path, info: BuildInfo | None = None) -> BuildInfo:
    """Write BuildInfo as JSON to path and return it."""
    data = info if info is not None else collect_build_info()
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data.to_dict(), indent=2) + "\n", encoding="utf-8")
    return data


def read_build_info(path: str | Path) -> BuildInfo:
    """Read BuildInfo from a JSON file created by write_build_info."""
    raw: object = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("build info JSON must be an object")
    data = cast(dict[str, object], raw)
    rev = data.get("vcs.ref.head.revision", "")
    bt = data.get("o11y.build.time", "")
    mod = data.get("o11y.build.modified", False)
    return BuildInfo(
        revision=str(rev) if rev is not None else "",
        build_time=str(bt) if bt is not None else "",
        modified=bool(mod),
    )


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        sys.stderr.write("usage: python -m libo11y.buildinfo <output.json>\n")
        return 2
    write_build_info(args[0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
