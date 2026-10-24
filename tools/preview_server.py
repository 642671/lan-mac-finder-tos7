#!/usr/bin/env python3
"""Local WebUI preview with deterministic synthetic TOS API responses."""

from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
APP_ID = "lan-mac-finder"

NETWORKS = [
    {
        "interface": "enp1s0",
        "alias": "enp1s0",
        "local_ip": "192.0.2.25",
        "prefix_length": 24,
        "gateway": "192.0.2.1",
        "network": "192.0.2.0",
        "broadcast": "192.0.2.255",
        "scan_range": "192.0.2.0/24",
        "host_count": 254,
        "local_source": "192.0.2.25",
        "local_mac": "02-42-AC-11-00-19",
    },
    {
        "interface": "enp2s0",
        "alias": "enp2s0",
        "local_ip": "198.51.100.40",
        "prefix_length": 24,
        "gateway": "198.51.100.1",
        "network": "198.51.100.0",
        "broadcast": "198.51.100.255",
        "scan_range": "198.51.100.0/24",
        "host_count": 254,
        "local_source": "198.51.100.40",
        "local_mac": "02-42-AC-22-00-28",
    },
]

DEVICES = [
    {
        "interface": "enp1s0",
        "scan_range": "192.0.2.0/24",
        "ip": "192.0.2.1",
        "mac": "02-42-AC-11-00-01",
        "state": "REACHABLE",
    },
    {
        "interface": "enp1s0",
        "scan_range": "192.0.2.0/24",
        "ip": "192.0.2.25",
        "mac": "02-42-AC-11-00-19",
        "state": "LOCAL",
    },
    {
        "interface": "enp1s0",
        "scan_range": "192.0.2.0/24",
        "ip": "192.0.2.44",
        "mac": "02-42-AC-11-2C-00",
        "state": "STALE",
    },
    {
        "interface": "enp1s0",
        "scan_range": "192.0.2.0/24",
        "ip": "192.0.2.88",
        "mac": "02-42-AC-11-58-00",
        "state": "DELAY",
    },
    {
        "interface": "enp2s0",
        "scan_range": "198.51.100.0/24",
        "ip": "198.51.100.1",
        "mac": "02-42-AC-22-00-01",
        "state": "REACHABLE",
    },
    {
        "interface": "enp2s0",
        "scan_range": "198.51.100.0/24",
        "ip": "198.51.100.40",
        "mac": "02-42-AC-22-00-28",
        "state": "LOCAL",
    },
    {
        "interface": "enp2s0",
        "scan_range": "198.51.100.0/24",
        "ip": "198.51.100.126",
        "mac": "02-42-AC-22-7E-00",
        "state": "STALE",
    },
]


class PreviewState:
    def __init__(self, no_match: bool = False) -> None:
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.no_match = no_match
        self.job_sequence = 0
        self.data = self._idle()

    @staticmethod
    def _idle() -> dict:
        return {
            "status": "idle",
            "running": False,
            "stopping": False,
            "job_id": "",
            "suffix": "",
            "started_at": None,
            "finished_at": None,
            "networks": [],
            "warnings": ["预览模式会跳过虚拟网卡 docker0"],
            "total_hosts": 0,
            "probed_hosts": 0,
            "progress_percent": 0,
            "current_interface": "",
            "current_range": "",
            "results": [],
            "error": "",
        }

    def status(self) -> dict:
        with self.lock:
            return json.loads(json.dumps(self.data))

    def start(self, suffix: str) -> bool:
        with self.lock:
            if self.data["running"]:
                return False
            self.job_sequence += 1
            self.cancel = threading.Event()
            self.data = self._idle()
            self.data.update(
                {
                    "status": "discovering",
                    "running": True,
                    "suffix": suffix,
                    "job_id": f"preview-{self.job_sequence}",
                    "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                }
            )
        threading.Thread(
            target=self._run,
            args=(suffix, self.cancel),
            daemon=True,
            name="preview-scan",
        ).start()
        return True

    def stop(self) -> None:
        with self.lock:
            self.data["stopping"] = True
        self.cancel.set()

    def _run(self, suffix: str, cancel: threading.Event) -> None:
        time.sleep(0.35)
        if cancel.is_set():
            self._finish("stopped")
            return
        with self.lock:
            self.data.update(
                {
                    "status": "scanning",
                    "networks": NETWORKS,
                    "total_hosts": 508,
                    "current_interface": "enp1s0",
                    "current_range": "192.0.2.0/24",
                }
            )
        for completed in (64, 128, 192, 254, 318, 382, 446, 508):
            if cancel.is_set():
                self._finish("stopped")
                return
            time.sleep(0.12)
            with self.lock:
                self.data["probed_hosts"] = completed
                self.data["progress_percent"] = int(completed * 100 / 508)
                if completed > 254:
                    self.data["current_interface"] = "enp2s0"
                    self.data["current_range"] = "198.51.100.0/24"
        if not self.no_match:
            first_mac = f"02-42-AC-11-{suffix[:2]}-{suffix[2:]}"
            with self.lock:
                self.data["results"] = [
                    {
                        "interface": "enp1s0",
                        "scan_range": "192.0.2.0/24",
                        "ip": "192.0.2.88",
                        "mac": first_mac,
                        "state": "LOCAL",
                    },
                ]
        self._finish("completed")

    def _finish(self, status: str) -> None:
        with self.lock:
            self.data.update(
                {
                    "status": status,
                    "running": False,
                    "stopping": False,
                    "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "current_interface": "",
                    "current_range": "",
                }
            )
            if status == "completed":
                self.data["progress_percent"] = 100
                self.data["probed_hosts"] = 508


STATE = PreviewState()


def api_parts(path: str) -> list[str]:
    parts = [part for part in urlsplit(path).path.split("/") if part]
    while APP_ID in parts:
        index = parts.index(APP_ID)
        del parts[: index + 1]
    if parts and parts[0] == "api":
        parts = parts[1:]
    return parts


class PreviewHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, directory=str(FRONTEND), **kwargs)

    def log_message(self, format: str, *args) -> None:
        return

    def _json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:
        parts = api_parts(self.path)
        if parts == ["health"]:
            self._json(
                200,
                {
                    "ok": True,
                    "status": "ok",
                    "app": APP_ID,
                    "version": "1.0.007-preview",
                    "python": "preview",
                    "max_hosts": 1022,
                },
            )
            return
        if parts == ["networks"]:
            self._json(
                200,
                {
                    "ok": True,
                    "app": APP_ID,
                    "version": "1.0.007-preview",
                    "max_hosts": 1022,
                    "networks": NETWORKS,
                    "warnings": ["预览模式：docker0 已作为虚拟网卡跳过"],
                },
            )
            return
        if parts == ["devices"]:
            self._json(
                200,
                {
                    "ok": True,
                    "app": APP_ID,
                    "version": "1.0.007-preview",
                    "devices": DEVICES,
                    "warnings": [],
                },
            )
            return
        if parts == ["scan", "status"]:
            self._json(
                200,
                {
                    "ok": True,
                    "app": APP_ID,
                    "version": "1.0.007-preview",
                    **STATE.status(),
                },
            )
            return
        if self.path.startswith(("/v2/", "/lan-mac-finder/")):
            self._json(404, {"ok": False, "error": "not found"})
            return
        if urlsplit(self.path).path in {"", "/"}:
            source = (FRONTEND / "index.html").read_text(encoding="utf-8")
            raw = source.replace("__APP_VERSION__", "1.0.007-preview").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)
            return
        super().do_GET()

    def do_POST(self) -> None:
        parts = api_parts(self.path)
        body = self._read_body()
        if parts == ["devices", "scan"]:
            self._json(
                200,
                {
                    "ok": True,
                    "app": APP_ID,
                    "version": "1.0.007-preview",
                    "devices": DEVICES,
                    "warnings": [],
                },
            )
            return
        if parts == ["scan", "start"]:
            suffix = str(body.get("suffix") or "").upper()
            if len(suffix) != 4:
                self._json(400, {"ok": False, "error": "invalid suffix"})
                return
            started = STATE.start(suffix)
            actual = STATE.status()
            if not started and actual.get("suffix") != suffix:
                self._json(
                    409,
                    {
                        "ok": False,
                        "error": "another MAC suffix is already being scanned",
                    },
                )
                return
            self._json(
                202 if started else 200,
                {
                    "ok": True,
                    "app": APP_ID,
                    "started": started,
                    "running": actual.get("running"),
                    "status": actual.get("status"),
                    "job_id": actual.get("job_id", ""),
                    "suffix": actual.get("suffix", ""),
                },
            )
            return
        if parts == ["scan", "stop"]:
            STATE.stop()
            self._json(200, {"ok": True, "app": APP_ID, "stopping": True})
            return
        self._json(404, {"ok": False, "error": "not found"})


def main() -> int:
    global STATE
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4178)
    parser.add_argument(
        "--no-match",
        action="store_true",
        help="complete scans without returning a matching device",
    )
    args = parser.parse_args()
    STATE = PreviewState(no_match=args.no_match)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), PreviewHandler)
    print(f"Preview: http://127.0.0.1:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
