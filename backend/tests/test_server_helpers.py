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
    route_parts,
    start_scan_result,
)


class FakeScanManager:
    def __init__(self) -> None:
        self.active_suffix = ""

    def start(self, suffix: str) -> bool:
        if self.active_suffix:
            return False
        self.active_suffix = suffix
        return True

    def status(self) -> dict:
        return {
            "status": "scanning" if self.active_suffix else "idle",
            "running": bool(self.active_suffix),
            "job_id": "job-1" if self.active_suffix else "",
            "suffix": self.active_suffix,
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


if __name__ == "__main__":
    unittest.main()
