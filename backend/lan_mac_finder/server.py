"""HTTP-over-Unix-socket server for the TOS LAN MAC Finder WebUI."""

from __future__ import annotations

import json
import os
import signal
import socketserver
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from typing import Any, Mapping
from urllib.parse import parse_qs, unquote, urlsplit

from . import __version__
from .core import (
    APP_ID,
    ScanManager,
    collect_neighbor_devices,
    discover_networks,
    max_configured_hosts,
    normalize_mac_suffix,
)

SOCKET_DIR = "/var/api"
SOCKET_PATH = os.path.join(SOCKET_DIR, f"{APP_ID}.sock")
MAX_BODY_BYTES = 8 * 1024


def log(level: str, message: str) -> None:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] [{level}] [{APP_ID}] {message}", flush=True)


def route_parts(path: str) -> list[str]:
    raw = str(path or "").split("?", 1)[0].split("#", 1)[0]
    parts = [unquote(part) for part in raw.split("/") if part]
    while APP_ID in parts:
        index = parts.index(APP_ID)
        del parts[: index + 1]
    if parts and parts[0] == "api":
        parts = parts[1:]
    return parts


def health_payload() -> dict:
    return {
        "ok": True,
        "status": "ok",
        "app": APP_ID,
        "version": __version__,
        "python": sys.version.split()[0],
        "max_hosts": max_configured_hosts(),
    }


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class LanMacFinderHandler(BaseHTTPRequestHandler):
    server_version = f"{APP_ID}/{__version__}"
    timeout = 30

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _origin(self) -> str:
        return self.headers.get("Origin") or "null"

    def _manager(self) -> ScanManager:
        manager = getattr(self.server, "scan_manager", None)
        if manager is None:
            raise ApiError(503, "scan manager is unavailable")
        return manager

    def _send_json(
        self,
        status: int,
        payload: Mapping[str, Any],
        *,
        head_only: bool = False,
    ) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", self._origin())
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Vary", "Origin")
        self.end_headers()
        if not head_only:
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                return

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self._origin())
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header(
            "Access-Control-Allow-Methods",
            "GET, HEAD, POST, OPTIONS",
        )
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-Csrf-Token, Cookie",
        )
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_HEAD(self) -> None:
        self._dispatch("HEAD")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def _read_json_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ApiError(400, "invalid Content-Length") from exc
        if length < 0 or length > MAX_BODY_BYTES:
            raise ApiError(413, "request body is too large")
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"invalid JSON body: {exc}") from exc
        if not isinstance(value, dict):
            raise ApiError(400, "JSON body must be an object")
        return value

    def _dispatch(self, method: str) -> None:
        head_only = method == "HEAD"
        try:
            parts = route_parts(self.path)
            if not parts or parts == ["info"]:
                self._send_json(
                    200,
                    {
                        **health_payload(),
                        "capabilities": [
                            "health",
                            "networks",
                            "devices",
                            "scan/start",
                            "scan/status",
                            "scan/stop",
                        ],
                    },
                    head_only=head_only,
                )
                return
            if parts == ["health"]:
                if method not in {"GET", "HEAD"}:
                    raise ApiError(405, "method not allowed")
                self._send_json(200, health_payload(), head_only=head_only)
                return
            if parts == ["networks"]:
                if method not in {"GET", "HEAD"}:
                    raise ApiError(405, "method not allowed")
                targets, warnings = discover_networks()
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "app": APP_ID,
                        "version": __version__,
                        "max_hosts": max_configured_hosts(),
                        "networks": [target.as_dict() for target in targets],
                        "warnings": warnings,
                    },
                    head_only=head_only,
                )
                return
            if parts == ["devices"]:
                if method not in {"GET", "HEAD"}:
                    raise ApiError(405, "method not allowed")
                targets, warnings = discover_networks()
                devices, neighbor_warnings = collect_neighbor_devices(targets)
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "app": APP_ID,
                        "version": __version__,
                        "devices": devices,
                        "warnings": warnings + neighbor_warnings,
                    },
                    head_only=head_only,
                )
                return
            if parts == ["scan", "status"]:
                if method not in {"GET", "HEAD"}:
                    raise ApiError(405, "method not allowed")
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "app": APP_ID,
                        "version": __version__,
                        **self._manager().status(),
                    },
                    head_only=head_only,
                )
                return
            if parts == ["scan", "start"]:
                if method != "POST":
                    raise ApiError(405, "method not allowed")
                body = self._read_json_body()
                suffix = normalize_mac_suffix(str(body.get("suffix") or ""))
                if suffix is None:
                    raise ApiError(
                        400,
                        "MAC suffix must use AA-BB, AA:BB, or AABB format",
                    )
                started = self._manager().start(suffix)
                self._send_json(
                    202 if started else 200,
                    {
                        "ok": True,
                        "app": APP_ID,
                        "started": started,
                        "running": True,
                        "suffix": suffix,
                        "message": "scan started" if started else "scan already running",
                    },
                )
                return
            if parts == ["scan", "stop"]:
                if method != "POST":
                    raise ApiError(405, "method not allowed")
                self._read_json_body()
                stopping = self._manager().stop()
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "app": APP_ID,
                        "stopping": stopping,
                        "message": "stopping" if stopping else "scan is not running",
                    },
                )
                return
            raise ApiError(404, "not found")
        except ApiError as exc:
            self._send_json(
                exc.status,
                {"ok": False, "app": APP_ID, "error": str(exc)},
                head_only=head_only,
            )
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            log("ERROR", f"Unhandled request failure for {self.path}: {exc}")
            self._send_json(
                500,
                {"ok": False, "app": APP_ID, "error": "internal server error"},
                head_only=head_only,
            )


if hasattr(socketserver, "UnixStreamServer"):
    class ThreadingUnixHTTPServer(
        socketserver.ThreadingMixIn,
        socketserver.UnixStreamServer,
    ):
        daemon_threads = True
        block_on_close = False
        allow_reuse_address = True
        request_queue_size = 128
else:
    # Windows cannot bind an AF_UNIX HTTP server, but importing the module must
    # still work so pure route tests and local tooling remain cross-platform.
    class ThreadingUnixHTTPServer(
        socketserver.ThreadingMixIn,
        socketserver.TCPServer,
    ):
        daemon_threads = True
        block_on_close = False
        allow_reuse_address = True
        request_queue_size = 128


def prepare_socket(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.lexists(path):
        try:
            os.unlink(path)
        except OSError as exc:
            raise RuntimeError(
                f"{path} exists but cannot be removed: {exc}. "
                "The shared /var/api directory is sticky; a foreign-owned "
                "socket must be removed by its owner or root."
            ) from exc


def serve(socket_path: str = SOCKET_PATH) -> int:
    prepare_socket(socket_path)
    manager = ScanManager()
    server = ThreadingUnixHTTPServer(socket_path, LanMacFinderHandler)
    server.scan_manager = manager
    os.chmod(socket_path, 0o660)
    stop_once = threading.Event()

    def request_stop(signum: int, frame: Any) -> None:
        del signum, frame
        if stop_once.is_set():
            return
        stop_once.set()
        threading.Thread(target=server.shutdown, name="http-shutdown", daemon=True).start()

    for signal_name in ("SIGTERM", "SIGINT"):
        if hasattr(signal, signal_name):
            signal.signal(getattr(signal, signal_name), request_stop)

    log(
        "INFO",
        f"version={__version__} socket={socket_path} python={sys.version.split()[0]}",
    )
    try:
        server.serve_forever(poll_interval=0.4)
    finally:
        manager.stop()
        manager.wait(2.0)
        server.server_close()
        try:
            if os.path.lexists(socket_path):
                os.unlink(socket_path)
        except OSError:
            pass
        log("INFO", "service stopped")
    return 0


def main() -> int:
    configured_socket = str(os.environ.get("APP_SOCKET_PATH") or SOCKET_PATH)
    try:
        return serve(configured_socket)
    except Exception as exc:
        log("ERROR", str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
