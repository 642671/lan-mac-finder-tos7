"""Network discovery, neighbor parsing, and background scan state."""

from __future__ import annotations

import concurrent.futures
import ipaddress
import json
import math
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Callable, Iterable, Sequence

APP_ID = "lan-mac-finder"
DEFAULT_MAX_HOSTS = 1022
DEFAULT_CONCURRENCY = 64
ALLOWED_NEIGHBOR_STATES = {"REACHABLE", "STALE", "DELAY", "PROBE"}
MAC_SUFFIX_PATTERN = re.compile(
    r"^(?:[0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}|[0-9A-Fa-f]{4})$"
)
VIRTUAL_INTERFACE_PREFIXES = (
    "docker",
    "veth",
    "virbr",
    "vmnet",
    "tailscale",
    "tun",
    "tap",
    "wg",
    "zt",
    "cni",
    "flannel",
    "podman",
    "lxc",
    "kube",
    "dummy",
    "lo",
)


class CommandError(RuntimeError):
    """Raised when a required local network command fails."""


class ScanCancelled(RuntimeError):
    """Internal cancellation signal."""


@dataclass(frozen=True)
class NetworkTarget:
    interface: str
    alias: str
    local_ip: str
    prefix_length: int
    gateway: str
    network: str
    broadcast: str
    scan_range: str
    host_count: int
    local_source: str

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class NeighborRecord:
    interface: str
    ip: str
    mac: str
    state: str


def normalize_mac_suffix(value: str) -> str | None:
    text = str(value or "").strip()
    if MAC_SUFFIX_PATTERN.fullmatch(text) is None:
        return None
    return re.sub(r"[-:]", "", text).upper()


def normalize_mac(value: str) -> str | None:
    text = str(value or "").strip().replace("-", "").replace(":", "")
    if re.fullmatch(r"[0-9A-Fa-f]{12}", text) is None:
        return None
    upper = text.upper()
    return "-".join(upper[index : index + 2] for index in range(0, 12, 2))


def parse_ipv4_network(address: str, prefix_length: int) -> ipaddress.IPv4Network:
    try:
        network = ipaddress.ip_network(
            f"{address}/{int(prefix_length)}",
            strict=False,
        )
    except (ipaddress.AddressValueError, ipaddress.NetmaskValueError, ValueError) as exc:
        raise CommandError(f"invalid IPv4 network {address}/{prefix_length}: {exc}") from exc
    if not isinstance(network, ipaddress.IPv4Network):
        raise CommandError(f"not an IPv4 network: {address}/{prefix_length}")
    return network


def network_hosts(network: ipaddress.IPv4Network) -> list[ipaddress.IPv4Address]:
    if network.prefixlen <= 30:
        return list(network.hosts())
    if network.prefixlen == 31:
        return list(network)
    return [network.network_address]


def is_virtual_interface(name: str) -> bool:
    lowered = str(name or "").strip().lower()
    if not lowered:
        return True
    return any(
        lowered == prefix or lowered.startswith(prefix)
        for prefix in VIRTUAL_INTERFACE_PREFIXES
    )


def run_command(command: Sequence[str], timeout: float = 8.0) -> str:
    try:
        result = subprocess.run(
            list(command),
            capture_output=True,
            check=False,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CommandError(f"{' '.join(command)} failed: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise CommandError(
            f"{' '.join(command)} exited {result.returncode}: {detail or 'no output'}"
        )
    return result.stdout


def resolve_ip_command(ip_command: str | None = None) -> str:
    if ip_command:
        return ip_command
    for candidate in ("ip", "/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"):
        resolved = shutil.which(candidate) if os.path.sep not in candidate else candidate
        if resolved and os.path.isfile(resolved):
            return resolved
    raise CommandError("the iproute2 'ip' command is not available")


def _json_items(raw: str, label: str) -> list[dict]:
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError as exc:
        raise CommandError(f"{label} returned invalid JSON: {exc}") from exc
    if isinstance(value, dict):
        return [value]
    if not isinstance(value, list):
        raise CommandError(f"{label} returned an unexpected JSON value")
    return [item for item in value if isinstance(item, dict)]


def discover_networks(
    *,
    runner: Callable[[Sequence[str]], str] = run_command,
    ip_command: str | None = None,
    max_hosts: int | None = None,
) -> tuple[list[NetworkTarget], list[str]]:
    """Discover routed physical IPv4 networks without scanning them yet."""

    command = resolve_ip_command(ip_command)
    configured_max = (
        int(os.environ.get("SCAN_MAX_HOSTS", DEFAULT_MAX_HOSTS))
        if max_hosts is None
        else int(max_hosts)
    )
    limit = max(1, configured_max)
    routes = _json_items(
        runner([command, "-j", "-4", "route", "show", "default"]),
        "ip route",
    )
    addresses = _json_items(
        runner([command, "-j", "-4", "addr", "show"]),
        "ip addr",
    )

    by_interface: dict[str, list[dict]] = {}
    for entry in addresses:
        name = str(entry.get("ifname") or "")
        inet_items = [
            item
            for item in (entry.get("addr_info") or [])
            if isinstance(item, dict)
            and item.get("family") == "inet"
            and item.get("local")
            and item.get("prefixlen") is not None
        ]
        if name and inet_items:
            by_interface[name] = inet_items

    warnings: list[str] = []
    skipped_virtual: set[str] = set()
    targets: list[NetworkTarget] = []
    seen: set[tuple[str, str]] = set()
    sorted_routes = sorted(
        routes,
        key=lambda item: int(item.get("metric") or 0),
    )
    for route in sorted_routes:
        interface = str(route.get("dev") or "")
        gateway = str(route.get("gateway") or "")
        if not interface:
            continue
        if is_virtual_interface(interface):
            if interface not in skipped_virtual:
                warnings.append(f"已跳过虚拟网卡 {interface}")
                skipped_virtual.add(interface)
            continue
        interface_addresses = by_interface.get(interface, [])
        if not interface_addresses:
            warnings.append(f"{interface} 没有可用的 IPv4 地址")
            continue
        for address in interface_addresses:
            local_ip = str(address.get("local") or "")
            if local_ip.startswith("169.254."):
                continue
            try:
                network = parse_ipv4_network(local_ip, int(address["prefixlen"]))
            except (CommandError, KeyError, TypeError, ValueError) as exc:
                warnings.append(str(exc))
                continue
            key = (interface, str(network))
            if key in seen:
                continue
            hosts = network_hosts(network)
            if len(hosts) > limit:
                warnings.append(
                    f"{interface} 的 {network} 包含 {len(hosts)} 台主机，"
                    f"超过安全上限 {limit}，已跳过"
                )
                continue
            seen.add(key)
            target = NetworkTarget(
                interface=interface,
                alias=interface,
                local_ip=local_ip,
                prefix_length=network.prefixlen,
                gateway=gateway,
                network=str(network.network_address),
                broadcast=str(network.broadcast_address),
                scan_range=str(network),
                host_count=len(hosts),
                local_source=str(address.get("local") or ""),
            )
            targets.append(target)

    targets.sort(key=lambda target: (target.interface, target.scan_range))
    if not targets and not warnings:
        warnings.append("未找到同时具有 IPv4 地址和默认网关的物理网卡")
    return targets, warnings


def parse_neighbor_items(
    items: Iterable[dict],
    interface: str,
) -> list[NeighborRecord]:
    records: list[NeighborRecord] = []
    seen: set[tuple[str, str]] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        raw_state = item.get("state")
        state_values = raw_state if isinstance(raw_state, list) else [raw_state]
        normalized_states = [
            str(value).upper()
            for value in state_values
            if value is not None and str(value).strip()
        ]
        state = next(
            (
                value
                for value in normalized_states
                if value in ALLOWED_NEIGHBOR_STATES
            ),
            "",
        )
        if not state:
            continue
        ip_value = str(item.get("dst") or "")
        try:
            address = ipaddress.ip_address(ip_value)
        except ValueError:
            continue
        if not isinstance(address, ipaddress.IPv4Address):
            continue
        mac = normalize_mac(str(item.get("lladdr") or ""))
        if mac is None:
            continue
        key = (str(address), mac)
        if key in seen:
            continue
        seen.add(key)
        records.append(
            NeighborRecord(
                interface=interface,
                ip=str(address),
                mac=mac,
                state=state,
            )
        )
    return records


def read_neighbors(
    interface: str,
    *,
    runner: Callable[[Sequence[str]], str] = run_command,
    ip_command: str | None = None,
) -> list[NeighborRecord]:
    command = resolve_ip_command(ip_command)
    output = runner(
        [command, "-j", "-4", "neigh", "show", "dev", interface],
    )
    return parse_neighbor_items(_json_items(output, "ip neigh"), interface)


def _safe_int(value: str | None, default: int) -> int:
    try:
        return int(str(value or "").strip())
    except ValueError:
        return default


def resolve_ping_command() -> str | None:
    for candidate in ("ping", "/usr/bin/ping", "/bin/ping", "/sbin/ping"):
        resolved = shutil.which(candidate) if os.path.sep not in candidate else candidate
        if resolved and os.path.isfile(resolved):
            return resolved
    return None


def prime_neighbor_cache(
    source_ip: str,
    hosts: Iterable[ipaddress.IPv4Address],
) -> None:
    """Send empty UDP datagrams so the kernel resolves local ARP entries."""

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.bind((source_ip, 0))
        for host in hosts:
            try:
                sock.sendto(b"", (str(host), 9))
            except OSError:
                continue
    finally:
        sock.close()


def _ping_host(
    ping_command: str,
    interface: str,
    address: ipaddress.IPv4Address,
    timeout_ms: int,
) -> bool:
    wait_seconds = max(1, int(math.ceil(timeout_ms / 1000)))
    command = [
        ping_command,
        "-n",
        "-c",
        "1",
        "-W",
        str(wait_seconds),
        "-I",
        interface,
        str(address),
    ]
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=wait_seconds + 1.25,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def scan_hosts(
    target: NetworkTarget,
    cancel_event: threading.Event,
    progress: Callable[[int], None] | None = None,
    *,
    timeout_ms: int | None = None,
    concurrency: int | None = None,
    ping_command: str | None = None,
    primer: Callable[[str, Iterable[ipaddress.IPv4Address]], None] = prime_neighbor_cache,
) -> bool:
    """Probe every host in a bounded network. Return whether ping was available."""

    network = parse_ipv4_network(target.local_ip, target.prefix_length)
    hosts = network_hosts(network)
    configured_timeout = (
        _safe_int(os.environ.get("SCAN_PING_TIMEOUT_MS"), 1000)
        if timeout_ms is None
        else int(timeout_ms)
    )
    batch_size = max(
        1,
        min(
            128,
            _safe_int(os.environ.get("SCAN_CONCURRENCY"), DEFAULT_CONCURRENCY)
            if concurrency is None
            else int(concurrency),
        ),
    )
    ping_path = resolve_ping_command() if ping_command is None else ping_command
    completed = 0
    for start in range(0, len(hosts), batch_size):
        if cancel_event.is_set():
            raise ScanCancelled("scan stopped")
        batch = hosts[start : start + batch_size]
        try:
            primer(target.local_source, batch)
        except OSError:
            pass
        if ping_path:
            with concurrent.futures.ThreadPoolExecutor(
                max_workers=len(batch),
                thread_name_prefix="lan-ping",
            ) as executor:
                futures = [
                    executor.submit(
                        _ping_host,
                        ping_path,
                        target.interface,
                        address,
                        configured_timeout,
                    )
                    for address in batch
                ]
                for future in concurrent.futures.as_completed(futures):
                    if cancel_event.is_set():
                        for pending in futures:
                            pending.cancel()
                        raise ScanCancelled("scan stopped")
                    try:
                        future.result()
                    except Exception:
                        pass
        completed += len(batch)
        if progress:
            progress(completed)
    time.sleep(0.15)
    return bool(ping_path)


def match_neighbor_records(
    records: Iterable[NeighborRecord],
    suffix: str,
    scan_range: str,
) -> list[dict]:
    normalized = normalize_mac_suffix(suffix)
    if normalized is None:
        raise ValueError("invalid MAC suffix")
    matches: list[dict] = []
    for record in records:
        compact = record.mac.replace("-", "")
        if not compact.endswith(normalized):
            continue
        matches.append(
            {
                "interface": record.interface,
                "scan_range": scan_range,
                "ip": record.ip,
                "mac": record.mac,
                "state": record.state,
            }
        )
    return matches


def _sort_results(results: Iterable[dict]) -> list[dict]:
    def key(item: dict) -> tuple:
        try:
            ip_value = int(ipaddress.ip_address(item.get("ip", "")))
        except ValueError:
            ip_value = 0
        return (item.get("interface", ""), ip_value, item.get("mac", ""))

    return sorted(results, key=key)


class ScanManager:
    """Run one scan at a time and expose polling-friendly state."""

    def __init__(
        self,
        *,
        discover: Callable[..., tuple[list[NetworkTarget], list[str]]] = discover_networks,
        neighbors: Callable[[str], list[NeighborRecord]] = read_neighbors,
        sweep: Callable[..., bool] = scan_hosts,
    ) -> None:
        self._discover = discover
        self._neighbors = neighbors
        self._sweep = sweep
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._cancel = threading.Event()
        self._state = self._idle_state()

    @staticmethod
    def _idle_state() -> dict:
        return {
            "status": "idle",
            "running": False,
            "stopping": False,
            "job_id": "",
            "suffix": "",
            "started_at": None,
            "finished_at": None,
            "networks": [],
            "warnings": [],
            "total_hosts": 0,
            "probed_hosts": 0,
            "progress_percent": 0,
            "current_interface": "",
            "current_range": "",
            "results": [],
            "error": "",
        }

    def status(self) -> dict:
        with self._lock:
            snapshot = dict(self._state)
            snapshot["networks"] = [dict(item) for item in self._state["networks"]]
            snapshot["warnings"] = list(self._state["warnings"])
            snapshot["results"] = [dict(item) for item in self._state["results"]]
            return snapshot

    def start(self, suffix: str) -> bool:
        normalized = normalize_mac_suffix(suffix)
        if normalized is None:
            raise ValueError("MAC suffix must be AA-BB, AA:BB, or AABB")
        with self._lock:
            if self._state["running"]:
                return False
            self._cancel = threading.Event()
            self._state = self._idle_state()
            self._state.update(
                {
                    "status": "discovering",
                    "running": True,
                    "job_id": uuid.uuid4().hex,
                    "suffix": normalized,
                    "started_at": datetime.now().isoformat(timespec="seconds"),
                }
            )
            self._thread = threading.Thread(
                target=self._run,
                args=(self._state["job_id"], normalized, self._cancel),
                name="lan-mac-scan",
                daemon=True,
            )
            self._thread.start()
        return True

    def stop(self) -> bool:
        with self._lock:
            if not self._state["running"]:
                return False
            self._state["stopping"] = True
            self._cancel.set()
            return True

    def wait(self, timeout: float | None = None) -> None:
        with self._lock:
            thread = self._thread
        if thread is not None:
            thread.join(timeout)

    def _update(self, **values) -> None:
        with self._lock:
            self._state.update(values)

    def _append_results(self, values: Iterable[dict]) -> None:
        with self._lock:
            combined = list(self._state["results"]) + list(values)
            unique: dict[tuple[str, str, str], dict] = {}
            for item in combined:
                unique[(item["interface"], item["ip"], item["mac"])] = item
            self._state["results"] = _sort_results(unique.values())

    def _run(
        self,
        job_id: str,
        suffix: str,
        cancel_event: threading.Event,
    ) -> None:
        try:
            targets, warnings = self._discover()
            if cancel_event.is_set():
                raise ScanCancelled("scan stopped")
            if not targets:
                message = warnings[0] if warnings else "no scannable physical networks"
                self._update(
                    status="error",
                    running=False,
                    finished_at=datetime.now().isoformat(timespec="seconds"),
                    warnings=warnings,
                    error=message,
                )
                return

            total = sum(target.host_count for target in targets)
            self._update(
                status="scanning",
                networks=[target.as_dict() for target in targets],
                warnings=warnings,
                total_hosts=total,
            )
            probed_before = 0
            for target in targets:
                if cancel_event.is_set():
                    raise ScanCancelled("scan stopped")
                self._update(
                    current_interface=target.interface,
                    current_range=target.scan_range,
                )

                def on_progress(completed: int, offset: int = probed_before) -> None:
                    done = min(total, offset + completed)
                    percent = 0 if total <= 0 else int(done * 100 / total)
                    self._update(
                        probed_hosts=done,
                        progress_percent=percent,
                    )

                self._sweep(
                    target,
                    cancel_event,
                    on_progress,
                )
                records = self._neighbors(target.interface)
                self._append_results(
                    match_neighbor_records(records, suffix, target.scan_range)
                )
                probed_before += target.host_count

            if cancel_event.is_set():
                raise ScanCancelled("scan stopped")
            self._update(
                status="completed",
                running=False,
                stopping=False,
                probed_hosts=total,
                progress_percent=100,
                current_interface="",
                current_range="",
                finished_at=datetime.now().isoformat(timespec="seconds"),
            )
        except ScanCancelled:
            self._update(
                status="stopped",
                running=False,
                stopping=False,
                current_interface="",
                current_range="",
                finished_at=datetime.now().isoformat(timespec="seconds"),
            )
        except Exception as exc:
            self._update(
                status="error",
                running=False,
                stopping=False,
                current_interface="",
                current_range="",
                error=str(exc),
                finished_at=datetime.now().isoformat(timespec="seconds"),
            )
        finally:
            with self._lock:
                if self._state["job_id"] == job_id:
                    self._state["running"] = False


def max_configured_hosts() -> int:
    return max(1, _safe_int(os.environ.get("SCAN_MAX_HOSTS"), DEFAULT_MAX_HOSTS))
