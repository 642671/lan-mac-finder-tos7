"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "frontend", "app.js"),
  "utf8"
);
const context = {
  console,
  location: { pathname: "/" },
  navigator: {},
  window: {
    clearTimeout,
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined
    },
    setTimeout
  },
  document: {
    addEventListener: () => undefined,
    readyState: "loading"
  }
};

vm.createContext(context);
vm.runInContext(source, context, { filename: "frontend/app.js" });

test("incomplete focused input remains neutral while overlong input is invalid", () => {
  assert.equal(context.classifySuffixInput("A").status, "incomplete");
  assert.equal(context.classifySuffixInput("AA-").status, "incomplete");
  assert.equal(context.classifySuffixInput("12345").status, "too-long");
  assert.equal(context.classifySuffixInput("AA-BBB").status, "too-long");
});

test("continuous results survive only while the next cycle is still running", () => {
  const existing = [{
    interface: "enp1s0",
    scan_range: "192.0.2.0/24",
    ip: "192.0.2.88",
    mac: "02-42-AC-11-00-19",
    state: "LOCAL"
  }];

  context.state.continuous = true;
  assert.equal(
    context.shouldPreserveContinuousResults(true, [], existing),
    true
  );
  assert.equal(
    context.shouldPreserveContinuousResults(false, [], existing),
    false
  );
  assert.equal(
    context.shouldPreserveContinuousResults(true, existing, existing),
    false
  );

  context.state.continuous = false;
  assert.equal(
    context.shouldPreserveContinuousResults(true, [], existing),
    false
  );
});

test("network selection defaults to all and keeps an explicit subset", () => {
  const networks = [{
    interface: "enp1s0",
    scan_range: "192.0.2.0/24",
    network_id: "enp1s0|192.0.2.0/24"
  }, {
    interface: "enp2s0",
    scan_range: "198.51.100.0/24",
    network_id: "enp2s0|198.51.100.0/24"
  }];

  assert.equal(context.networkKey(networks[0]), "enp1s0|192.0.2.0/24");
  assert.equal(
    JSON.stringify(context.reconcileNetworkSelection(networks, [], false)),
    JSON.stringify([
      "enp1s0|192.0.2.0/24",
      "enp2s0|198.51.100.0/24"
    ])
  );
  assert.equal(
    JSON.stringify(context.reconcileNetworkSelection(
      networks,
      ["enp2s0|198.51.100.0/24", "missing|203.0.113.0/24"],
      true
    )),
    JSON.stringify(["enp2s0|198.51.100.0/24"])
  );
});

test("selected network ids ignore stale entries", () => {
  context.state.networks = [{
    interface: "enp1s0",
    scan_range: "192.0.2.0/24"
  }, {
    interface: "enp2s0",
    scan_range: "198.51.100.0/24"
  }];
  context.state.selectedNetworkIds = [
    "enp2s0|198.51.100.0/24",
    "missing|203.0.113.0/24"
  ];

  assert.equal(
    JSON.stringify(context.selectedNetworkIds()),
    JSON.stringify(["enp2s0|198.51.100.0/24"])
  );

  context.state.networks = [];
  context.state.selectedNetworkIds = [];
});

test("table filter matches multiple fields and MAC separator variants", () => {
  const items = [{
    interface: "enp1s0",
    scan_range: "192.0.2.0/24",
    ip: "192.0.2.9",
    mac: "02-42-AC-11-00-09",
    state: "REACHABLE"
  }, {
    interface: "enp1s0",
    scan_range: "192.0.2.0/24",
    ip: "192.0.2.100",
    mac: "02-42-AC-11-00-10",
    state: "LOCAL"
  }, {
    interface: "enp2s0",
    scan_range: "198.51.100.0/24",
    ip: "198.51.100.20",
    mac: "02-42-AC-11-00-20",
    state: "STALE"
  }];

  assert.deepEqual(
    context.filterTableRows(items, "enp1 192.0.2").map((item) => item.ip),
    ["192.0.2.9", "192.0.2.100"]
  );
  assert.deepEqual(
    context.filterTableRows(items, "00:10").map((item) => item.ip),
    ["192.0.2.100"]
  );
  assert.deepEqual(
    context.filterTableRows(items, "本机").map((item) => item.ip),
    ["192.0.2.100"]
  );
  assert.equal(context.filterTableRows(items, "   ").length, 3);

  context.state.tableQuery = "   ";
  assert.equal(context.tableQueryActive(), false);
  context.state.tableQuery = "";
});

test("table sorting uses numeric IPv4 order and preserves the source array", () => {
  const items = [
    { ip: "192.0.2.100" },
    { ip: "192.0.2.9" },
    { ip: "192.0.2.20" }
  ];

  assert.deepEqual(
    context.sortTableRows(items, "ip", "ascending").map((item) => item.ip),
    ["192.0.2.9", "192.0.2.20", "192.0.2.100"]
  );
  assert.deepEqual(
    context.sortTableRows(items, "ip", "descending").map((item) => item.ip),
    ["192.0.2.100", "192.0.2.20", "192.0.2.9"]
  );
  assert.deepEqual(items.map((item) => item.ip), [
    "192.0.2.100",
    "192.0.2.9",
    "192.0.2.20"
  ]);
  assert.deepEqual(
    context.sortTableRows(items, "unknown", "ascending").map((item) => item.ip),
    items.map((item) => item.ip)
  );
});

test("visible table rows combine filtering and sorting", () => {
  context.state.tableMode = "devices";
  context.state.devices = [{
    interface: "enp1s0",
    scan_range: "192.0.2.0/24",
    ip: "192.0.2.9",
    mac: "02-42-AC-11-00-09",
    state: "REACHABLE"
  }, {
    interface: "enp1s0",
    scan_range: "192.0.2.0/24",
    ip: "192.0.2.100",
    mac: "02-42-AC-11-00-10",
    state: "LOCAL"
  }, {
    interface: "enp2s0",
    scan_range: "198.51.100.0/24",
    ip: "198.51.100.20",
    mac: "02-42-AC-11-00-20",
    state: "STALE"
  }];
  context.state.tableQuery = "enp1";
  context.state.tableSortKey = "ip";
  context.state.tableSortDirection = "descending";

  assert.deepEqual(
    context.visibleTableRows().map((item) => item.ip),
    ["192.0.2.100", "192.0.2.9"]
  );

  context.state.devices = [];
  context.state.tableQuery = "";
  context.state.tableSortKey = "";
  context.state.tableSortDirection = "ascending";
});
