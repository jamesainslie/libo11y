"""A loopback OTLP/HTTP collector for tests: it records every request it receives."""

from __future__ import annotations

import http.server
import threading
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class Received:
    """One request the collector received. Header names are lower case."""

    path: str
    headers: dict[str, str]
    body: bytes


@dataclass(slots=True)
class Collector:
    """A running loopback collector."""

    url: str
    status: int = 200
    requests: list[Received] = field(default_factory=list[Received])
    arrived: threading.Condition = field(default_factory=threading.Condition)

    def paths(self) -> list[str]:
        with self.arrived:
            return [r.path for r in self.requests]

    def wait_for(self, count: int, timeout: float = 5.0) -> list[Received]:
        """Wait until count requests have arrived and return all of them."""
        with self.arrived:
            self.arrived.wait_for(lambda: len(self.requests) >= count, timeout=timeout)
            return list(self.requests)


@contextmanager
def otlp_collector(status: int = 200) -> Generator[Collector]:
    """Serve OTLP/HTTP on a loopback port, answering every POST with status."""
    collector = Collector(url="", status=status)

    class _Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            del format, args

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            headers = {name.lower(): value for name, value in self.headers.items()}
            with collector.arrived:
                collector.requests.append(Received(self.path, headers, body))
                collector.arrived.notify_all()
            self.send_response(collector.status)
            self.send_header("Content-Type", "application/x-protobuf")
            self.send_header("Content-Length", "0")
            self.end_headers()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.daemon_threads = True
    collector.url = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, name="otlp-loopback", daemon=True)
    thread.start()
    try:
        yield collector
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)
