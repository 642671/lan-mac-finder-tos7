"""Unit tests for LAN discovery and MAC matching."""

from __future__ import annotations

import json
import sys
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from lan_mac_finder.core import (  # noqa: E402
    NetworkTarget,
    NeighborRecord,
    ScanCancelled,
    ScanManager,
    collect_neighbor_devices,
    discover_networks,
    is_virtual_interface,
    match_local_target,
    match_neighbor_records,
    network_target_key,
    network_target_payload,
    network_hosts,
    normalize_mac,
    normalize_mac_suffix,
    normalize_network_ids,
    parse_ipv4_network,
    parse_neighbor_items,
    probe_network_devices,
    select_network_targets,
)


class MacNormalizationTests(unittest.TestCase):
    def test_supported_suffix_formats(self) -> None:
        for value in ("45-6a", "45:6A", "456a", " 456A "):
            self.assertEqual(normalize_mac_suffix(value), "456A")

    def test_invalid_suffix_formats(self) -> None:
        for value in ("", "GG-12", "45-6", "45:6A:BC", "456A0", None):
            self.assertIsNone(normalize_mac_suffix(value))

    def test_mac_normalization(self) -> None:
        self.assertEqual(
            normalize_mac("02:42:ac:11:45:6a"),
            "02-42-AC-11-45-6A",
        )
        self.assertEqual(
            normalize_mac("02-42-AC-11-45-6A"),
            "02-42-AC-11-45-6A",
        )
        self.assertIsNone(normalize_mac("not-a-mac"))


class NetworkTests(unittest.TestCase):
    def test_network_host_limits(self) -> None:
        self.assertEqual(len(network_hosts(parse_ipv4_network("192.0.2.19", 24))), 254)
        self.assertEqual(len(network_hosts(parse_ipv4_network("198.51.100.9", 31))), 2)
        self.assertEqual(len(network_hosts(parse_ipv4_network("203.0.113.7", 32))), 1)

    def test_virtual_interface_filter(self) -> None:
        self.assertTrue(is_virtual_interface("docker0"))
        self.assertTrue(is_virtual_interface("tailscale0"))
        self.assertTrue(is_virtual_interface("veth123"))
        self.assertFalse(is_virtual_interface("enp1s0"))
        self.assertFalse(is_virtual_interface("bond0"))

    def test_discover_routed_physical_network(self) -> None:
        routes = [
            {
                "dst": "default",
                "gateway": "192.0.2.1",
                "dev": "enp1s0",
                "metric": 100,
            }
        ]
        addresses = [
            {
                "ifname": "enp1s0",
                "addr_info": [
                    {
                        "family": "inet",
                        "local": "192.0.2.25",
                        "prefixlen": 24,
                        "scope": "global",
                    }
                ],
            },
            {
                "ifname": "docker0",
                "addr_info": [
                    {
                        "family": "inet",
                        "local": "172.17.0.1",
                        "prefixlen": 16,
                        "scope": "global",
                    }
                ],
            },
        ]

        def runner(command):
            if "route" in command:
                return json.dumps(routes)
            if "addr" in command:
                return json.dumps(addresses)
            return json.dumps(
                [{"ifname": "enp1s0", "address": "02:42:ac:11:00:19"}]
            )

        targets, warnings = discover_networks(
            runner=runner,
            ip_command="/usr/bin/ip",
            max_hosts=1022,
        )
        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].interface, "enp1s0")
        self.assertEqual(targets[0].scan_range, "192.0.2.0/24")
        self.assertEqual(targets[0].gateway, "192.0.2.1")
        self.assertEqual(targets[0].local_mac, "02-42-AC-11-00-19")
        self.assertEqual(warnings, [])

    def test_discover_rejects_oversized_network(self) -> None:
        addresses = [
            {
                "ifname": "eth0",
                "addr_info": [
                    {
                        "family": "inet",
                        "local": "10.20.30.40",
                        "prefixlen": 16,
                        "scope": "global",
                    }
                ],
            }
        ]

        def runner(command):
            if "route" in command:
                return json.dumps(
                    [{"gateway": "10.20.0.1", "dev": "eth0", "metric": 10}]
                )
            if "addr" in command:
                return json.dumps(addresses)
            return json.dumps(
                [{"ifname": "eth0", "address": "02:42:ac:14:00:19"}]
            )

        targets, warnings = discover_networks(
            runner=runner,
            ip_command="/usr/bin/ip",
            max_hosts=1022,
        )
        self.assertEqual(targets, [])
        self.assertTrue(any("超过安全上限" in warning for warning in warnings))


class NeighborTests(unittest.TestCase):
    def test_neighbor_state_and_mac_filter(self) -> None:
        records = parse_neighbor_items(
            [
                {
                    "dst": "192.0.2.10",
                    "lladdr": "02:42:ac:11:45:6a",
                    "state": ["REACHABLE"],
                },
                {
                    "dst": "192.0.2.11",
                    "lladdr": "00:11:22:33:44:55",
                    "state": ["FAILED"],
                },
                {
                    "dst": "192.0.2.12",
                    "lladdr": "incomplete",
                    "state": "STALE",
                },
            ],
            "enp1s0",
        )
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].mac, "02-42-AC-11-45-6A")
        self.assertEqual(records[0].state, "REACHABLE")

    def test_match_by_suffix(self) -> None:
        records = [
            NeighborRecord("enp1s0", "192.0.2.10", "02-42-AC-11-45-6A", "REACHABLE"),
            NeighborRecord("enp1s0", "192.0.2.11", "4C-A6-4D-4A-00-12", "STALE"),
        ]
        matches = match_neighbor_records(records, "45:6a", "192.0.2.0/24")
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["ip"], "192.0.2.10")

    def test_collect_all_known_devices_for_network(self) -> None:
        target = NetworkTarget(
            interface="enp1s0",
            alias="enp1s0",
            local_ip="192.0.2.25",
            prefix_length=24,
            gateway="192.0.2.1",
            network="192.0.2.0",
            broadcast="192.0.2.255",
            scan_range="192.0.2.0/24",
            host_count=254,
            local_source="192.0.2.25",
            local_mac="02-42-AC-11-00-19",
        )
        records = [
            NeighborRecord(
                "enp1s0",
                "192.0.2.10",
                "02-42-AC-11-45-6A",
                "REACHABLE",
            ),
            NeighborRecord(
                "enp1s0",
                "198.51.100.20",
                "02-42-AC-22-45-6A",
                "STALE",
            ),
        ]
        devices, warnings = collect_neighbor_devices(
            [target],
            neighbors=lambda interface: records,
        )
        self.assertEqual(warnings, [])
        self.assertEqual(len(devices), 2)
        self.assertEqual(devices[0]["ip"], "192.0.2.10")
        self.assertEqual(devices[0]["scan_range"], "192.0.2.0/24")
        self.assertEqual(devices[1]["state"], "LOCAL")
        self.assertEqual(devices[1]["ip"], "192.0.2.25")

    def test_collect_deduplicates_shared_network_and_prefers_best_state(self) -> None:
        targets = []
        states = {
            "ovs_eth0": "STALE",
            "ovs_eth1": "REACHABLE",
            "ovs_eth2": "DELAY",
        }
        for interface, local_ip in (
            ("ovs_eth0", "192.0.2.25"),
            ("ovs_eth1", "192.0.2.26"),
            ("ovs_eth2", "192.0.2.27"),
        ):
            network = parse_ipv4_network(local_ip, 24)
            targets.append(
                NetworkTarget(
                    interface=interface,
                    alias=interface,
                    local_ip=local_ip,
                    prefix_length=network.prefixlen,
                    gateway="192.0.2.1",
                    network=str(network.network_address),
                    broadcast=str(network.broadcast_address),
                    scan_range=str(network),
                    host_count=len(network_hosts(network)),
                    local_source=local_ip,
                    local_mac="02-42-AC-11-00-19",
                )
            )

        def neighbors(interface):
            return [
                NeighborRecord(
                    interface,
                    "192.0.2.10",
                    "02-42-AC-11-45-6A",
                    states[interface],
                )
            ]

        devices, warnings = collect_neighbor_devices(targets, neighbors=neighbors)

        self.assertEqual(warnings, [])
        self.assertEqual(len(devices), 4)
        shared = next(device for device in devices if device["ip"] == "192.0.2.10")
        self.assertEqual(shared["interface"], "ovs_eth1")
        self.assertEqual(shared["state"], "REACHABLE")
        self.assertEqual(
            {device["ip"] for device in devices if device["state"] == "LOCAL"},
            {"192.0.2.25", "192.0.2.26", "192.0.2.27"},
        )

    def test_match_local_interface_mac(self) -> None:
        target = NetworkTarget(
            interface="eth0",
            alias="eth0",
            local_ip="192.0.2.25",
            prefix_length=24,
            gateway="192.0.2.1",
            network="192.0.2.0",
            broadcast="192.0.2.255",
            scan_range="192.0.2.0/24",
            host_count=254,
            local_source="192.0.2.25",
            local_mac="02-42-AC-11-D4-65",
        )
        matches = match_local_target(target, "d465")
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["state"], "LOCAL")
        self.assertEqual(matches[0]["mac"], "02-42-AC-11-D4-65")


class NetworkSelectionTests(unittest.TestCase):
    def _target(self, interface: str, local_ip: str) -> NetworkTarget:
        network = parse_ipv4_network(local_ip, 24)
        return NetworkTarget(
            interface=interface,
            alias=interface,
            local_ip=local_ip,
            prefix_length=network.prefixlen,
            gateway=str(network.network_address + 1),
            network=str(network.network_address),
            broadcast=str(network.broadcast_address),
            scan_range=str(network),
            host_count=len(network_hosts(network)),
            local_source=local_ip,
            local_mac="02-42-AC-11-00-19",
        )

    def test_network_payload_has_stable_identifier(self) -> None:
        target = self._target("enp1s0", "192.0.2.25")
        self.assertEqual(network_target_key(target), "enp1s0|192.0.2.0/24")
        self.assertEqual(
            network_target_payload(target)["network_id"],
            "enp1s0|192.0.2.0/24",
        )

    def test_selection_defaults_to_all_networks(self) -> None:
        targets = [
            self._target("enp1s0", "192.0.2.25"),
            self._target("enp2s0", "198.51.100.40"),
        ]
        selected, missing = select_network_targets(targets, None)
        self.assertEqual(selected, targets)
        self.assertEqual(missing, [])

    def test_selection_filters_targets_and_reports_missing(self) -> None:
        first = self._target("enp1s0", "192.0.2.25")
        second = self._target("enp2s0", "198.51.100.40")
        selected, missing = select_network_targets(
            [first, second],
            [network_target_key(second)],
        )
        self.assertEqual(selected, [second])
        self.assertEqual(missing, [])

        selected, missing = select_network_targets(
            [first, second],
            [network_target_key(second), "enp9s0|203.0.113.0/24"],
        )
        self.assertEqual(selected, [second])
        self.assertEqual(missing, ["enp9s0|203.0.113.0/24"])

    def test_network_ids_require_a_non_empty_string_array(self) -> None:
        self.assertIsNone(normalize_network_ids(None))
        self.assertEqual(normalize_network_ids(["a", "a", "b"]), ["a", "b"])
        for value in ([], "", "enp1s0|192.0.2.0/24", [1], ["  "]):
            with self.assertRaises(ValueError):
                normalize_network_ids(value)


class ScanManagerTests(unittest.TestCase):
    def _target(
        self,
        interface: str = "enp1s0",
        local_ip: str = "192.0.2.25",
        local_mac: str = "02-42-AC-11-00-19",
    ) -> NetworkTarget:
        network = parse_ipv4_network(local_ip, 24)
        return NetworkTarget(
            interface=interface,
            alias=interface,
            local_ip=local_ip,
            prefix_length=network.prefixlen,
            gateway=str(network.network_address + 1),
            network=str(network.network_address),
            broadcast=str(network.broadcast_address),
            scan_range=str(network),
            host_count=len(network_hosts(network)),
            local_source=local_ip,
            local_mac=local_mac,
        )

    def test_scan_manager_collects_matches(self) -> None:
        def discover():
            return [self._target()], []

        def sweep(target, cancel_event, progress):
            progress(254)
            return True

        def neighbors(interface):
            return [
                NeighborRecord(
                    interface,
                    "192.0.2.10",
                    "02-42-AC-11-45-6A",
                    "REACHABLE",
                )
            ]

        manager = ScanManager(discover=discover, neighbors=neighbors, sweep=sweep)
        self.assertTrue(manager.start("45-6A"))
        manager.wait(2)
        status = manager.status()
        self.assertEqual(status["status"], "completed")
        self.assertEqual(status["probed_hosts"], 254)
        self.assertEqual(status["results"][0]["mac"], "02-42-AC-11-45-6A")

    def test_scan_manager_defaults_to_all_networks(self) -> None:
        targets = [
            self._target("enp1s0", "192.0.2.25"),
            self._target("enp2s0", "198.51.100.40"),
        ]
        sweep_calls = []

        def sweep(target, cancel_event, progress):
            sweep_calls.append(target.scan_range)
            progress(target.host_count)
            return True

        manager = ScanManager(
            discover=lambda: (targets, []),
            neighbors=lambda interface: [],
            sweep=sweep,
        )
        self.assertTrue(manager.start("456A"))
        manager.wait(2)
        status = manager.status()
        self.assertEqual(status["status"], "completed")
        self.assertEqual(sweep_calls, ["192.0.2.0/24", "198.51.100.0/24"])
        self.assertEqual(status["total_hosts"], 508)
        self.assertEqual(len(status["selected_network_ids"]), 2)

    def test_scan_manager_sweeps_shared_network_once(self) -> None:
        targets = [
            self._target("ovs_eth0", "192.0.2.25", "02-42-AC-11-45-6A"),
            self._target("ovs_eth1", "192.0.2.26", "02-42-AC-11-45-6A"),
            self._target("ovs_eth2", "192.0.2.27", "02-42-AC-11-45-6A"),
        ]
        sweep_calls = []

        def sweep(target, cancel_event, progress):
            sweep_calls.append(target.interface)
            progress(target.host_count)
            return True

        def neighbors(interface):
            state = "REACHABLE" if interface == "ovs_eth1" else "STALE"
            return [
                NeighborRecord(
                    interface,
                    "192.0.2.10",
                    "02-42-AC-11-45-6A",
                    state,
                )
            ]

        manager = ScanManager(
            discover=lambda: (targets, []),
            neighbors=neighbors,
            sweep=sweep,
        )
        self.assertTrue(manager.start("456A"))
        manager.wait(2)
        status = manager.status()

        self.assertEqual(status["status"], "completed")
        self.assertEqual(sweep_calls, ["ovs_eth0"])
        self.assertEqual(status["total_hosts"], 254)
        self.assertEqual(status["probed_hosts"], 254)
        self.assertEqual(len(status["results"]), 4)
        shared = next(result for result in status["results"] if result["ip"] == "192.0.2.10")
        self.assertEqual(shared["state"], "REACHABLE")
        self.assertEqual(
            {result["ip"] for result in status["results"] if result["state"] == "LOCAL"},
            {"192.0.2.25", "192.0.2.26", "192.0.2.27"},
        )

    def test_scan_manager_only_scans_selected_network(self) -> None:
        first = self._target("enp1s0", "192.0.2.25")
        second = self._target("enp2s0", "198.51.100.40")
        selected = [network_target_key(second)]
        sweep_calls = []

        def sweep(target, cancel_event, progress):
            sweep_calls.append(target.scan_range)
            progress(target.host_count)
            return True

        manager = ScanManager(
            discover=lambda: ([first, second], []),
            neighbors=lambda interface: [],
            sweep=sweep,
        )
        self.assertTrue(manager.start("456A", selected))
        manager.wait(2)
        status = manager.status()
        self.assertEqual(status["status"], "completed")
        self.assertEqual(sweep_calls, ["198.51.100.0/24"])
        self.assertEqual(status["total_hosts"], 254)
        self.assertEqual(status["selected_network_ids"], selected)
        self.assertEqual(
            [network["network_id"] for network in status["networks"]],
            selected,
        )

    def test_scan_manager_rejects_empty_selection(self) -> None:
        manager = ScanManager(
            discover=lambda: ([self._target()], []),
            neighbors=lambda interface: [],
            sweep=lambda *args: True,
        )
        with self.assertRaises(ValueError):
            manager.start("456A", [])

    def test_scan_manager_reports_unavailable_selection_without_scanning(self) -> None:
        sweep_calls = []

        def sweep(target, cancel_event, progress):
            sweep_calls.append(target.scan_range)
            return True

        manager = ScanManager(
            discover=lambda: ([self._target()], []),
            neighbors=lambda interface: [],
            sweep=sweep,
        )
        self.assertTrue(manager.start("456A", ["enp9s0|203.0.113.0/24"]))
        manager.wait(2)
        status = manager.status()
        self.assertEqual(status["status"], "error")
        self.assertIn("所选网段当前不可用", status["error"])
        self.assertEqual(sweep_calls, [])

    def test_scan_manager_rejects_parallel_start_without_replacing_job(self) -> None:
        started = threading.Event()

        def sweep(target, cancel_event, progress):
            started.set()
            cancel_event.wait(1)
            return True

        manager = ScanManager(
            discover=lambda: ([self._target()], []),
            neighbors=lambda interface: [],
            sweep=sweep,
        )
        self.assertTrue(manager.start("45-6A"))
        self.assertTrue(started.wait(1))
        first_job_id = manager.status()["job_id"]
        self.assertFalse(manager.start("12-34"))
        active = manager.status()
        self.assertEqual(active["suffix"], "456A")
        self.assertEqual(active["job_id"], first_job_id)
        self.assertTrue(manager.stop())
        manager.wait(2)

    def test_scan_manager_matches_active_request_scope(self) -> None:
        targets = [
            self._target("enp1s0", "192.0.2.25"),
            self._target("enp2s0", "198.51.100.40"),
        ]
        selected = [network_target_key(target) for target in targets]
        started = threading.Event()

        def sweep(target, cancel_event, progress):
            started.set()
            cancel_event.wait(1)
            return True

        manager = ScanManager(
            discover=lambda: (targets, []),
            neighbors=lambda interface: [],
            sweep=sweep,
        )
        self.assertTrue(manager.start("456A", selected))
        self.assertTrue(started.wait(1))
        self.assertTrue(manager.matches_request("45:6a", list(reversed(selected))))
        self.assertFalse(manager.matches_request("456A", [selected[0]]))
        self.assertFalse(manager.matches_request("456A"))
        self.assertTrue(manager.stop())
        manager.wait(2)

    def test_scan_manager_stops(self) -> None:
        started = threading.Event()

        def discover():
            return [self._target()], []

        def sweep(target, cancel_event, progress):
            started.set()
            if cancel_event.wait(1):
                raise ScanCancelled("scan stopped")
            return True

        manager = ScanManager(
            discover=discover,
            neighbors=lambda interface: [],
            sweep=sweep,
        )
        self.assertTrue(manager.start("456A"))
        self.assertTrue(started.wait(1))
        self.assertTrue(manager.stop())
        manager.wait(2)
        self.assertEqual(manager.status()["status"], "stopped")

    def test_scan_manager_includes_local_interface_mac(self) -> None:
        target = self._target()
        target = NetworkTarget(
            **{
                **target.as_dict(),
                "local_mac": "02-42-AC-11-45-6A",
            }
        )

        def sweep(_target, _cancel_event, progress):
            progress(254)
            return True

        manager = ScanManager(
            discover=lambda: ([target], []),
            neighbors=lambda interface: [],
            sweep=sweep,
        )
        self.assertTrue(manager.start("45:6a"))
        manager.wait(2)
        status = manager.status()
        self.assertEqual(status["status"], "completed")
        self.assertEqual(len(status["results"]), 1)
        self.assertEqual(status["results"][0]["state"], "LOCAL")
        self.assertEqual(status["results"][0]["mac"], "02-42-AC-11-45-6A")

    def test_result_merge_keeps_identical_device_in_different_ranges(self) -> None:
        manager = ScanManager()
        manager._append_results(
            [
                {
                    "interface": "enp1s0",
                    "scan_range": "192.0.2.0/24",
                    "ip": "192.0.2.10",
                    "mac": "02-42-AC-11-45-6A",
                    "state": "REACHABLE",
                },
                {
                    "interface": "enp2s0",
                    "scan_range": "198.51.100.0/24",
                    "ip": "192.0.2.10",
                    "mac": "02-42-AC-11-45-6A",
                    "state": "REACHABLE",
                },
            ]
        )

        results = manager.status()["results"]
        self.assertEqual(len(results), 2)
        self.assertEqual(
            {result["scan_range"] for result in results},
            {"192.0.2.0/24", "198.51.100.0/24"},
        )

    def test_probe_network_devices_sweeps_shared_network_once(self) -> None:
        targets = [
            self._target("ovs_eth0", "192.0.2.25"),
            self._target("ovs_eth1", "192.0.2.26"),
            self._target("ovs_eth2", "192.0.2.27"),
        ]
        sweep_calls = []

        def sweep(target, cancel_event):
            sweep_calls.append(target.interface)
            return True

        def neighbors(interface):
            return [
                NeighborRecord(
                    interface,
                    "192.0.2.10",
                    "02-42-AC-11-45-6A",
                    "REACHABLE",
                )
            ]

        devices, warnings = probe_network_devices(
            targets,
            sweep=sweep,
            neighbors=neighbors,
        )

        self.assertEqual(warnings, [])
        self.assertEqual(sweep_calls, ["ovs_eth0"])
        self.assertEqual(len(devices), 4)
        self.assertEqual(
            {device["ip"] for device in devices if device["state"] == "LOCAL"},
            {"192.0.2.25", "192.0.2.26", "192.0.2.27"},
        )

    def test_probe_network_devices_returns_all_neighbors(self) -> None:
        target = self._target()
        sweep_calls = []

        def sweep(actual_target, cancel_event):
            self.assertIs(actual_target, target)
            self.assertFalse(cancel_event.is_set())
            sweep_calls.append(actual_target.interface)
            return True

        def neighbors(interface):
            return [
                NeighborRecord(
                    interface,
                    "192.0.2.10",
                    "02-42-AC-11-45-6A",
                    "REACHABLE",
                ),
                NeighborRecord(
                    interface,
                    "192.0.2.11",
                    "02-42-AC-11-12-34",
                    "STALE",
                ),
            ]

        devices, warnings = probe_network_devices(
            [target],
            sweep=sweep,
            neighbors=neighbors,
        )

        self.assertEqual(sweep_calls, ["enp1s0"])
        self.assertEqual(warnings, [])
        self.assertEqual(len(devices), 3)
        self.assertIn("LOCAL", {device["state"] for device in devices})
        self.assertEqual(
            {device["ip"] for device in devices},
            {"192.0.2.25", "192.0.2.10", "192.0.2.11"},
        )


if __name__ == "__main__":
    unittest.main()
