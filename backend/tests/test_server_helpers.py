"""Tests for TOS proxy path normalization and health metadata."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from lan_mac_finder.server import health_payload, route_parts  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
