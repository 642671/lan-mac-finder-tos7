"""Tests for TOS proxy path normalization and health metadata."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from lan_mac_finder.server import (  # noqa: E402
    ApiError,
    health_payload,
    parse_network_selection,
    route_parts,
    start_scan_result,
)


class FakeScanManager:
    def __init__(self) -> None:
        self.active_suffix = ""
        self.network_ids = []
        self.requested_network_ids = None

    def start(self, suffix: str, network_ids=None) -> bool:
        if self.active_suffix:
            return False
        self.active_suffix = suffix
        self.network_ids = list(network_ids or [])
        self.requested_network_ids = (
            None if network_ids is None else list(network_ids)
        )
        return True

    def matches_request(self, suffix: str, network_ids=None) -> bool:
        if self.active_suffix != suffix:
            return False
        requested = None if network_ids is None else set(network_ids)
        active = (
            None
            if self.requested_network_ids is None
            else set(self.requested_network_ids)
        )
        return requested == active

    def status(self) -> dict:
        return {
            "status": "scanning" if self.active_suffix else "idle",
            "running": bool(self.active_suffix),
            "job_id": "job-1" if self.active_suffix else "",
            "suffix": self.active_suffix,
            "selected_network_ids": list(self.network_ids),
        }


class RouteTests(unittest.TestCase):
    def test_proxy_prefixes_are_removed(self) -> None:
        expected = ["scan", "status"]
        self.assertEqual(route_parts("/scan/status"), expected)
        self.assertEqual(
            route_parts("/v2/proxy/lan-mac-finder/scan/status"),
            expected,
        )
        self.assertEqual(
            route_parts("/lan-mac-finder/api/scan/status"),
            expected,
        )

    def test_health_identifies_app(self) -> None:
        payload = health_payload()
        self.assertEqual(payload["app"], "lan-mac-finder")
        self.assertEqual(payload["status"], "ok")
        self.assertGreaterEqual(payload["max_hosts"], 1)

    def test_network_selection_is_optional_and_rejects_empty_values(self) -> None:
        self.assertIsNone(parse_network_selection({}))
        self.assertEqual(
            parse_network_selection(
                {"network_ids": ["enp1s0|192.0.2.0/24"]}
            ),
            ["enp1s0|192.0.2.0/24"],
        )
        with self.assertRaises(ApiError) as raised:
            parse_network_selection({"network_ids": []})
        self.assertEqual(raised.exception.status, 400)

    def test_start_scan_response_uses_actual_job(self) -> None:
        manager = FakeScanManager()
        status, first = start_scan_result(manager, "456A")
        self.assertEqual(status, 202)
        self.assertTrue(first["started"])
        self.assertEqual(first["job_id"], "job-1")
        self.assertEqual(first["suffix"], "456A")

        status, repeated = start_scan_result(manager, "456A")
        self.assertEqual(status, 200)
        self.assertFalse(repeated["started"])
        self.assertEqual(repeated["job_id"], "job-1")
        self.assertEqual(repeated["suffix"], "456A")

        with self.assertRaises(ApiError) as raised:
            start_scan_result(manager, "1234")
        self.assertEqual(raised.exception.status, 409)

    def test_start_scan_response_preserves_network_selection(self) -> None:
        manager = FakeScanManager()
        selected = ["enp1s0|192.0.2.0/24", "enp2s0|198.51.100.0/24"]
        status, payload = start_scan_result(manager, "456A", selected)
        self.assertEqual(status, 202)
        self.assertEqual(manager.network_ids, selected)
        self.assertEqual(payload["selected_network_ids"], selected)

    def test_start_scan_rejects_same_suffix_with_different_scope(self) -> None:
        manager = FakeScanManager()
        selected = ["enp1s0|192.0.2.0/24", "enp2s0|198.51.100.0/24"]
        start_scan_result(manager, "456A", selected)

        status, repeated = start_scan_result(
            manager,
            "456A",
            list(reversed(selected)),
        )
        self.assertEqual(status, 200)
        self.assertFalse(repeated["started"])

        with self.assertRaises(ApiError) as raised:
            start_scan_result(manager, "456A", [selected[0]])
        self.assertEqual(raised.exception.status, 409)


if __name__ == "__main__":
    unittest.main()
