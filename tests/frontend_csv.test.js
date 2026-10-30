"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const csv = require("../frontend/csv.js");

test("default CSV columns include a UTF-8 BOM and device fields", () => {
  const text = csv.buildCsv([{
    interface: "eth0",
    scan_range: "192.0.2.0/24",
    ip: "192.0.2.10",
    mac: "02-42-AC-11-00-10",
    state: "LOCAL"
  }]);
  assert.ok(text.startsWith("\ufeff"));
  assert.match(text, /网卡,扫描范围,IP 地址,MAC 地址,状态/);
  assert.match(text, /eth0,192\.0\.2\.0\/24,192\.0\.2\.10,02-42-AC-11-00-10,本机$/);
});

test("CSV escaping handles quotes, commas, newlines, and formulas", () => {
  assert.equal(csv.escapeCell("a,b"), '"a,b"');
  assert.equal(csv.escapeCell('a"b'), '"a""b"');
  assert.equal(csv.escapeCell("a\nb"), '"a\nb"');
  assert.equal(csv.escapeCell("=cmd"), "'=cmd");
  assert.equal(csv.escapeCell("-12.5"), "-12.5");
});

test("dateStamp is deterministic in local time", () => {
  assert.equal(csv.dateStamp(new Date(2026, 9, 30, 9, 7, 5)), "20261030-090705");
});
