"""Static package-contract checks mirroring the TOS review gate."""

from __future__ import annotations

import configparser
import json
import re
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class PackageContractTests(unittest.TestCase):
    def test_versions_match(self) -> None:
        version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
        config = json.loads((ROOT / "config.ini").read_text(encoding="utf-8"))
        control = (ROOT / "DEBIAN" / "control").read_text(encoding="utf-8")
        backend = (ROOT / "backend" / "lan_mac_finder" / "__init__.py").read_text(
            encoding="utf-8"
        )
        self.assertEqual(config["version"], version)
        self.assertIn(f"Version: {version}", control)
        self.assertIn(f'__version__ = "{version}"', backend)

    def test_service_contract(self) -> None:
        unit = (ROOT / "init.d" / "lanmacfinder-system.service").read_text(
            encoding="utf-8"
        )
        self.assertIn("User=lan-mac-finder", unit)
        self.assertIn("ProtectSystem=strict", unit)
        self.assertNotIn("Group=lan-mac-finder", unit)
        self.assertNotIn("PrivateTmp=true", unit)
        self.assertIn(
            "ExecStart=/usr/bin/python3 "
            "/usr/local/lan-mac-finder/bin/lan-mac-finder-service",
            unit,
        )

    def test_language_contract(self) -> None:
        wanted = {
            "zh-cn",
            "zh-hk",
            "en-us",
            "fr-fr",
            "de-de",
            "it-it",
            "es-es",
            "hu-hu",
            "ja-jp",
            "ko-kr",
            "pl-pl",
            "ru-ru",
            "tr-tr",
            "pt-pt",
        }
        parser = configparser.ConfigParser(interpolation=None)
        parser.optionxform = str
        raw = (ROOT / "lan-mac-finder.lang").read_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        self.assertNotIn(b"\r\n", raw)
        parser.read_string(raw.decode("utf-8"))
        self.assertEqual(set(parser.sections()), wanted)

    def test_lifecycle_safety_contract(self) -> None:
        for name in ("postinst", "prerm", "postrm"):
            path = ROOT / "DEBIAN" / name
            raw = path.read_bytes()
            self.assertTrue(raw.startswith(b"#!/bin/sh\n"), name)
            self.assertNotIn(b"\r\n", raw, name)
        postinst = (ROOT / "DEBIAN" / "postinst").read_text(encoding="utf-8")
        postrm = (ROOT / "DEBIAN" / "postrm").read_text(encoding="utf-8")
        self.assertNotIn("chmod 0770 /var/api", postinst)
        self.assertNotIn("apt install", postinst)
        self.assertIn('rm -rf "${APP_DIR}"', postrm)

    def test_icon_contract(self) -> None:
        config = json.loads((ROOT / "config.ini").read_text(encoding="utf-8"))
        icon = ROOT / config["icon"].lstrip("/")
        self.assertTrue(icon.is_file())
        self.assertLessEqual(icon.stat().st_size, 50 * 1024)
        root = ET.fromstring(icon.read_bytes())
        self.assertIn("viewBox", root.attrib)
        self.assertIsNone(re.search(r"<script\b", icon.read_text(encoding="utf-8"), re.I))
        full_bleed = next(
            element for element in root if element.tag.rsplit("}", 1)[-1] == "rect"
        )
        self.assertIn(full_bleed.attrib.get("x", "0"), {"0"})
        self.assertIn(full_bleed.attrib.get("y", "0"), {"0"})
        self.assertEqual(full_bleed.attrib.get("width"), "64")
        self.assertEqual(full_bleed.attrib.get("height"), "64")

    def test_ui_contract(self) -> None:
        html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "frontend" / "app.js").read_text(encoding="utf-8")
        self.assertIn('id="themeToggle"', html)
        self.assertIn('id="copyIpButton"', html)
        self.assertIn('placeholder="AA-BB / AA:BB / AABB"', html)
        self.assertIn('aria-invalid="false"', html)
        self.assertNotIn('maxlength="5"', html)
        self.assertNotIn('id="inputHint"', html)
        self.assertIn('id="sidebarResizer"', html)
        self.assertIn('id="networkResizer"', html)
        self.assertIn('role="separator"', html)
        self.assertIn("window.parent.localStorage.getItem(\"themeMode\")", html)
        self.assertIn("lanMacFinder.searchIntent.v1", script)
        self.assertIn("resumeContinuousSearch", script)
        self.assertIn("REQUEST_TIMEOUT_MS", script)
        self.assertIn("setInputInvalidState", script)
        self.assertIn("var MIN_WORKSPACE_WIDTH = 560", script)
        self.assertIn("var MIN_NETWORK_PANE_HEIGHT = 200", script)
        self.assertIn("当前没有搜索到", script)
        titlebar = html.split('class="titlebar-actions"', 1)[1].split("</header>", 1)[0]
        self.assertNotIn('id="themeToggle"', titlebar)


if __name__ == "__main__":
    unittest.main()
