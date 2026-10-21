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
    discover_networks,
    is_virtual_interface,
    match_neighbor_records,
    network_hosts,
    normalize_mac,
    normalize_mac_suffix,
    parse_ipv4_network,
    parse_neighbor_items,
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
            return json.dumps(addresses)

        targets, warnings = discover_networks(
            runner=runner,
            ip_command="/usr/bin/ip",
            max_hosts=1022,
        )
        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].interface, "enp1s0")
        self.assertEqual(targets[0].scan_range, "192.0.2.0/24")
        self.assertEqual(targets[0].gateway, "192.0.2.1")
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
            return json.dumps(addresses)

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


class ScanManagerTests(unittest.TestCase):
    def _target(self) -> NetworkTarget:
        return NetworkTarget(
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


if __name__ == "__main__":
    unittest.main()
