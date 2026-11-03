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
APP_VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
PREVIEW_VERSION = APP_VERSION + "-preview"

NETWORKS = [
    {
        "interface": "enp1s0",
        "network_id": "enp1s0|192.0.2.0/24",
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
        "network_id": "enp2s0|198.51.100.0/24",
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


def network_key(network: dict) -> str:
    return str(
        network.get("network_id")
        or f"{network.get('interface', '')}|{network.get('scan_range', '')}"
    )


def normalize_selected_ids(value: object) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not value:
        raise ValueError("至少选择一个网段")
    selected: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ValueError("网段选择格式不正确")
        text = item.strip()
        if text not in selected:
            selected.append(text)
    return selected


def select_preview_networks(
    network_ids: list[str] | None,
) -> tuple[list[dict], list[str]]:
    if network_ids is None:
        return list(NETWORKS), []
    wanted = set(network_ids)
    selected = [network for network in NETWORKS if network_key(network) in wanted]
    available = {network_key(network) for network in NETWORKS}
    missing = [network_id for network_id in network_ids if network_id not in available]
    return selected, missing


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
            "selected_network_ids": [],
            "requested_network_ids": None,
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

    def start(
        self,
        suffix: str,
        networks: list[dict],
        requested_network_ids: list[str] | None = None,
    ) -> bool:
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
                    "selected_network_ids": [network_key(network) for network in networks],
                    "requested_network_ids": (
                        None
                        if requested_network_ids is None
                        else list(requested_network_ids)
                    ),
                    "job_id": f"preview-{self.job_sequence}",
                    "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                }
            )
        threading.Thread(
            target=self._run,
            args=(suffix, self.cancel, networks),
            daemon=True,
            name="preview-scan",
        ).start()
        return True

    def matches_request(
        self,
        suffix: str,
        network_ids: list[str] | None = None,
    ) -> bool:
        with self.lock:
            if self.data["suffix"] != suffix:
                return False
            active = self.data.get("requested_network_ids")
            if active is None or network_ids is None:
                return active is None and network_ids is None
            return set(active) == set(network_ids)

    def stop(self) -> None:
        with self.lock:
            self.data["stopping"] = True
        self.cancel.set()

    def _run(
        self,
        suffix: str,
        cancel: threading.Event,
        networks: list[dict],
    ) -> None:
        time.sleep(0.35)
        if cancel.is_set():
            self._finish("stopped")
            return
        if not networks:
            with self.lock:
                self.data["error"] = "????????"
            self._finish("error")
            return
        total = sum(max(0, int(network.get("host_count") or 0)) for network in networks)
        first = networks[0]
        with self.lock:
            self.data.update(
                {
                    "status": "scanning",
                    "networks": networks,
                    "selected_network_ids": [network_key(network) for network in networks],
                    "total_hosts": total,
                    "current_interface": first["interface"],
                    "current_range": first["scan_range"],
                }
            )
        probed_before = 0
        for network in networks:
            host_count = max(0, int(network.get("host_count") or 0))
            for step in range(1, 5):
                if cancel.is_set():
                    self._finish("stopped")
                    return
                time.sleep(0.12)
                completed = probed_before + (host_count * step // 4)
                with self.lock:
                    self.data["probed_hosts"] = completed
                    self.data["progress_percent"] = (
                        100 if total <= 0 else int(completed * 100 / total)
                    )
                    self.data["current_interface"] = network["interface"]
                    self.data["current_range"] = network["scan_range"]
            probed_before += host_count
        if not self.no_match:
            network = networks[0]
            local_mac = str(network.get("local_mac") or "02-42-AC-11-00-19")
            first_mac = "-".join(
                local_mac.split("-")[:4] + [suffix[:2], suffix[2:]]
            )
            with self.lock:
                self.data["results"] = [
                    {
                        "interface": network["interface"],
                        "scan_range": network["scan_range"],
                        "ip": network["local_ip"],
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
                self.data["probed_hosts"] = int(self.data.get("total_hosts") or 0)


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
                    "version": PREVIEW_VERSION,
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
                    "version": PREVIEW_VERSION,
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
                    "version": PREVIEW_VERSION,
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
                    "version": PREVIEW_VERSION,
                    **STATE.status(),
                },
            )
            return
        if self.path.startswith(("/v2/", "/lan-mac-finder/")):
            self._json(404, {"ok": False, "error": "not found"})
            return
        if urlsplit(self.path).path in {"", "/"}:
            source = (FRONTEND / "index.html").read_text(encoding="utf-8")
            raw = source.replace("__APP_VERSION__", PREVIEW_VERSION).encode("utf-8")
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
            try:
                network_ids = normalize_selected_ids(body.get("network_ids"))
            except ValueError as exc:
                self._json(400, {"ok": False, "error": str(exc)})
                return
            networks, missing = select_preview_networks(network_ids)
            if network_ids is not None and not networks:
                self._json(
                    409,
                    {"ok": False, "error": "所选网段当前不可用，请刷新网段后重试"},
                )
                return
            selected_keys = {network_key(network) for network in networks}
            devices = [
                device
                for device in DEVICES
                if f"{device['interface']}|{device['scan_range']}" in selected_keys
            ]
            warnings = (
                ["所选网段当前不可用：" + "、".join(missing)] if missing else []
            )
            self._json(
                200,
                {
                    "ok": True,
                    "app": APP_ID,
                    "version": PREVIEW_VERSION,
                    "devices": devices,
                    "warnings": warnings,
                },
            )
            return
        if parts == ["scan", "start"]:
            suffix = str(body.get("suffix") or "").upper()
            if len(suffix) != 4:
                self._json(400, {"ok": False, "error": "invalid suffix"})
                return
            try:
                network_ids = normalize_selected_ids(body.get("network_ids"))
            except ValueError as exc:
                self._json(400, {"ok": False, "error": str(exc)})
                return
            networks, missing = select_preview_networks(network_ids)
            if network_ids is not None and not networks:
                self._json(
                    409,
                    {"ok": False, "error": "所选网段当前不可用，请刷新网段后重试"},
                )
                return
            started = STATE.start(suffix, networks, network_ids)
            actual = STATE.status()
            if not started and not STATE.matches_request(suffix, network_ids):
                self._json(
                    409,
                    {
                        "ok": False,
                        "error": "another scan is already running with a different scope",
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
                    "selected_network_ids": actual.get("selected_network_ids", []),
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
