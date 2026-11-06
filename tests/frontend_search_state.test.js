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

test("device web links are limited to valid IPv4 addresses", () => {
  assert.equal(context.deviceWebUrl("192.0.2.19"), "http://192.0.2.19/");
  assert.equal(context.deviceWebUrl(" 198.51.100.1 "), "http://198.51.100.1/");
  assert.equal(context.deviceWebUrl("192.0.2.256"), "");
  assert.equal(context.deviceWebUrl("192.0.2"), "");
  assert.equal(context.deviceWebUrl("http://192.0.2.1/"), "");
  assert.equal(context.deviceWebUrl(""), "");
});

function resetContinuousState(entries) {
  context.state.continuous = true;
  context.state.running = false;
  context.state.targets = context.buildTargets(entries);
  context.syncActiveSuffixState();
  context.state.noMatchRounds = 0;
  context.state.searchRound = 0;
  context.state.searchFinished = false;
  context.state.searchExhausted = false;
  context.state.lastCountedJobId = "";
}

function matchedDevice(suffix, ip) {
  return {
    interface: "enp1s0",
    scan_range: "192.0.2.0/24",
    ip: ip,
    mac: "02-42-AC-11-" + suffix.slice(0, 2) + "-" + suffix.slice(2),
    state: "REACHABLE",
    matched_suffixes: [suffix]
  };
}

test("continuous search stops after ten no-match rounds and reports not found", () => {
  resetContinuousState([{ display: "AB-CD", normalized: "ABCD" }]);

  for (let round = 1; round <= 10; round += 1) {
    const outcome = context.registerContinuousRound("job-" + round, []);
    assert.equal(outcome.counted, true);
    assert.equal(outcome.rounds, round);
    assert.equal(outcome.exhausted, round === 10);
    assert.equal(outcome.allResolved, round === 10);
    assert.equal(outcome.changed, round === 10);
  }
  assert.equal(context.state.searchRound, 10);
  assert.equal(context.state.targets[0].status, "not-found");
  assert.equal(context.continuousRoundLabel(), "第 10 / 10 轮");
  assert.equal(context.continuousExhaustedMessage().includes("10 轮"), true);
  assert.equal(context.continuousExhaustedMessage().includes("AB-CD"), true);

  resetContinuousState([{ display: "AB-CD", normalized: "ABCD" }]);
  context.state.targets[0].status = "not-found";
  context.state.targets[0].rounds = 10;
  context.state.running = true;
  assert.equal(context.targetStatusText(context.state.targets[0]), "已查 10 轮 · 未找到");
});

test("a completed job id is counted only once", () => {
  resetContinuousState([{ display: "ABCD", normalized: "ABCD" }]);

  let outcome = context.registerContinuousRound("job-a", []);
  assert.equal(outcome.counted, true);
  assert.equal(outcome.rounds, 1);

  outcome = context.registerContinuousRound("job-a", []);
  assert.equal(outcome.counted, false);
  assert.equal(outcome.changed, false);
  assert.equal(context.state.searchRound, 1);
  assert.equal(context.state.targets[0].rounds, 1);
});

test("a found target resolves while other targets keep polling", () => {
  resetContinuousState([
    { display: "AB-CD", normalized: "ABCD" },
    { display: "EF-01", normalized: "EF01" }
  ]);

  let outcome = context.registerContinuousRound(
    "job-1",
    [matchedDevice("ABCD", "192.0.2.10")]
  );
  assert.equal(outcome.found, true);
  assert.equal(outcome.allResolved, false);
  assert.equal(outcome.exhausted, false);
  assert.equal(context.state.targets[0].status, "found");
  assert.equal(context.state.targets[0].foundCount, 1);
  assert.equal(context.state.targets[1].status, "searching");
  assert.equal(context.state.targets[1].rounds, 1);

  for (let round = 2; round <= 9; round += 1) {
    outcome = context.registerContinuousRound("job-" + round, []);
    assert.equal(outcome.allResolved, false);
    assert.equal(outcome.exhausted, false);
  }
  assert.equal(context.state.targets[0].status, "found");
  assert.equal(context.state.targets[0].foundCount, 1);

  outcome = context.registerContinuousRound("job-10", []);
  assert.equal(outcome.allResolved, true);
  assert.equal(outcome.exhausted, true);
  assert.equal(context.state.targets[1].status, "not-found");

  const message = context.searchFinishedMessage();
  assert.equal(message.includes("AB-CD 找到 1 台设备"), true);
  assert.equal(message.includes("EF-01 已完成 10 轮，未找到"), true);
});

test("all targets found ends the search without waiting for ten rounds", () => {
  resetContinuousState([
    { display: "AB-CD", normalized: "ABCD" },
    { display: "EF-01", normalized: "EF01" }
  ]);

  const outcome = context.registerContinuousRound("job-1", [
    matchedDevice("ABCD", "192.0.2.10"),
    matchedDevice("EF01", "192.0.2.11")
  ]);
  assert.equal(outcome.found, true);
  assert.equal(outcome.allResolved, true);
  assert.equal(outcome.exhausted, false);
  assert.equal(context.state.targets[0].status, "found");
  assert.equal(context.state.targets[1].status, "found");
  assert.equal(context.searchFinishedMessage().includes("查找完成"), true);
});

test("round results merge per device and keep every matched suffix", () => {
  const first = matchedDevice("ABCD", "192.0.2.10");
  const second = matchedDevice("EF01", "192.0.2.11");
  const merged = context.mergeResultItems([first], [first, second]);
  assert.equal(merged.length, 2);
  assert.equal(
    JSON.stringify(merged.map((item) => item.ip)),
    JSON.stringify(["192.0.2.10", "192.0.2.11"])
  );

  const shared = {
    interface: "enp1s0",
    scan_range: "192.0.2.0/24",
    ip: "192.0.2.12",
    mac: "02-42-AC-11-AB-CD",
    state: "REACHABLE",
    matched_suffixes: ["ABCD"]
  };
  const mergedShared = context.mergeResultItems(
    [shared],
    [Object.assign({}, shared, { matched_suffixes: ["CD"] })]
  );
  assert.equal(mergedShared.length, 1);
  assert.equal(
    JSON.stringify(mergedShared[0].matched_suffixes),
    JSON.stringify(["ABCD", "CD"])
  );
});

test("matched suffixes prefer backend annotation and fall back to the MAC", () => {
  const target = { display: "AB-CD", normalized: "ABCD", status: "searching" };
  assert.equal(
    context.resultMatchesTarget(
      { mac: "02-42-AC-11-AB-CD", matched_suffixes: ["ABCD"] },
      target
    ),
    true
  );
  assert.equal(
    context.resultMatchesTarget(
      { mac: "02-42-AC-11-AB-CD", matched_suffixes: ["EF01"] },
      target
    ),
    false
  );
  assert.equal(
    context.resultMatchesTarget({ mac: "02-42-AC-11-AB-CD" }, target),
    true
  );
  assert.equal(
    context.resultMatchesTarget({ mac: "02-42-AC-11-EF-01" }, target),
    false
  );
});

test("network and device cache signatures detect real changes", () => {
  const first = {
    interface: "enp1s0",
    network_id: "enp1s0|192.0.2.0/24",
    scan_range: "192.0.2.0/24",
    local_ip: "192.0.2.25",
    prefix_length: 24,
    gateway: "192.0.2.1"
  };
  const second = {
    interface: "enp2s0",
    network_id: "enp2s0|198.51.100.0/24",
    scan_range: "198.51.100.0/24",
    local_ip: "198.51.100.40",
    prefix_length: 24,
    gateway: "198.51.100.1"
  };

  assert.equal(context.isUsableNetwork(first), true);
  assert.equal(
    context.isUsableNetwork({ interface: "enp1s0", scan_range: "192.0.2.0/24" }),
    false
  );
  assert.equal(
    context.networkSignature([first, second]),
    context.networkSignature([second, first])
  );
  assert.equal(
    context.networkSignature([first, { interface: "broken" }]),
    context.networkSignature([first])
  );
  assert.notEqual(
    context.networkSignature([first]),
    context.networkSignature([Object.assign({}, first, {
      local_ip: "192.0.2.99"
    })])
  );
  assert.equal(
    context.networkIdsSignature(["enp2s0|198.51.100.0/24", "enp1s0|192.0.2.0/24"]),
    context.networkIdsSignature(["enp1s0|192.0.2.0/24", "enp2s0|198.51.100.0/24"])
  );
  assert.notEqual(
    context.networkIdsSignature(["enp1s0|192.0.2.0/24"]),
    context.networkIdsSignature([
      "enp1s0|192.0.2.0/24",
      "enp2s0|198.51.100.0/24"
    ])
  );
  assert.equal(context.isUsableDevice({
    interface: "enp1s0",
    scan_range: "192.0.2.0/24",
    ip: "192.0.2.9",
    mac: "02-42-AC-11-00-09",
    state: "REACHABLE"
  }), true);
  assert.equal(context.isUsableDevice({ interface: "enp1s0" }), false);
});

test("stopped targets distinguish an unfinished round from a round not started", () => {
  const saved = {
    continuous: context.state.continuous,
    running: context.state.running,
    roundInterrupted: context.state.roundInterrupted
  };
  const target = {
    display: "AB-CD",
    normalized: "ABCD",
    rounds: 0,
    foundCount: 0,
    status: "searching"
  };

  context.state.continuous = false;
  context.state.running = false;
  context.state.roundInterrupted = true;
  assert.equal(
    context.targetStatusText(target),
    "已停止 · 第 1 / 10 轮未完成"
  );

  context.state.roundInterrupted = false;
  assert.equal(context.targetStatusText(target), "已停止 · 未开始查找");

  target.rounds = 3;
  assert.equal(context.targetStatusText(target), "已停止 · 已查 3 / 10 轮");

  context.state.continuous = saved.continuous;
  context.state.running = saved.running;
  context.state.roundInterrupted = saved.roundInterrupted;
});
