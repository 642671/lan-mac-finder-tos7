"use strict";

var APP_ID = "lan-mac-finder";
var MAC_SUFFIX_PATTERN = /^(?:[0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}|[0-9A-Fa-f]{4})$/;
var SEARCH_INTENT_KEY = "lanMacFinder.searchIntent.v1";
var NETWORK_SELECTION_KEY = "lanMacFinder.networkSelection.v1";
var NETWORK_CACHE_KEY = "lanMacFinder.networkCache.v1";
var DEVICE_CACHE_KEY = "lanMacFinder.deviceCache.v1";
var DEVICE_CACHE_LIMIT = 1000;
var NETWORK_FRESHNESS_MS = 5000;
var SIDEBAR_WIDTH_KEY = "lanMacFinder.layout.sidebarWidth.v1";
var SCAN_PANE_HEIGHT_KEY = "lanMacFinder.layout.scanPaneHeight.v1";
var DEFAULT_SIDEBAR_WIDTH = 304;
var DEFAULT_SCAN_PANE_HEIGHT = 430;
var MIN_SIDEBAR_WIDTH = 280;
var MAX_SIDEBAR_WIDTH = 560;
var MIN_WORKSPACE_WIDTH = 560;
var MIN_SCAN_PANE_HEIGHT = 280;
var MIN_NETWORK_PANE_HEIGHT = 200;
var CONTINUOUS_RESTART_DELAY_MS = 1100;
var MAX_NO_MATCH_ROUNDS = 10;
var MAX_SUFFIX_INPUTS = 8;
var SERVICE_RETRY_DELAY_MS = 2200;
var REQUEST_TIMEOUT_MS = 12000;
var INVENTORY_REQUEST_TIMEOUT_MS = 45000;
var TABLE_SORT_KEYS = {
  interface: true,
  scan_range: true,
  ip: true,
  mac: true,
  state: true
};
var DEFAULT_INPUT_ERROR =
  "请输入 AA-BB、AA:BB 或 AABB 格式的 MAC 后四位。";
var API_CANDIDATES = (function buildCandidates() {
  var directory = location.pathname.slice(0, location.pathname.lastIndexOf("/") + 1);
  var values = [
    "/v2/proxy/" + APP_ID,
    "/v2/proxy/" + APP_ID + "/api",
    directory + "v2/proxy/" + APP_ID
  ];
  var unique = [];
  for (var index = 0; index < values.length; index += 1) {
    if (unique.indexOf(values[index]) < 0) {
      unique.push(values[index]);
    }
  }
  return unique;
}());

var API_ROOT = API_CANDIDATES[0];
var apiReady = false;
var pollTimer = null;
var continuousRestartTimer = null;
var toastTimer = null;
var activeTooltipTarget = null;

var state = {
  networks: [],
  selectedNetworkIds: [],
  networkSelectionTouched: false,
  networkCacheRestoredAt: 0,
  networkVerifiedAt: 0,
  networkVerifying: false,
  deviceCacheRestoredAt: 0,
  warnings: [],
  devices: [],
  results: [],
  tableSignature: "",
  tableMode: "devices",
  tableQuery: "",
  tableSortKey: "",
  tableSortDirection: "ascending",
  selectedMac: "",
  selectedIp: "",
  selectedKey: "",
  running: false,
  stopping: false,
  activeSuffix: "",
  normalizedSuffix: "",
  activeSuffixes: [],
  normalizedSuffixes: [],
  targets: [],
  scanStatus: "idle",
  continuous: false,
  noMatchRounds: 0,
  searchRound: 0,
  lastCountedJobId: "",
  searchExhausted: false,
  searchFinished: false,
  roundInterrupted: false,
  inventoryScanning: false,
  searchGeneration: 0,
  retryDelay: SERVICE_RETRY_DELAY_MS,
  lastRequestErrorKind: "",
  totalHosts: 0,
  probedHosts: 0,
  jobId: ""
};

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  var node = byId(id);
  if (node) {
    node.textContent = String(value);
  }
}

function setHidden(node, hidden) {
  if (typeof node === "string") {
    node = byId(node);
  }
  if (node) {
    node.hidden = !!hidden;
  }
}

function normalizeSuffix(value) {
  var text = String(value || "").trim();
  if (!MAC_SUFFIX_PATTERN.test(text)) {
    return "";
  }
  return text.replace(/[-:]/g, "").toUpperCase();
}

function readStoredJson(key) {
  try {
    var raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function writeStoredJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    return;
  }
}

function removeStoredValue(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    return;
  }
}

function networkKey(network) {
  if (network && typeof network.network_id === "string" && network.network_id) {
    return network.network_id;
  }
  var interfaceName = network && network.interface ? String(network.interface) : "";
  var scanRange = network && network.scan_range ? String(network.scan_range) : "";
  return interfaceName + "|" + scanRange;
}

function selectedNetworkIds() {
  var selected = {};
  state.selectedNetworkIds.forEach(function (id) {
    selected[id] = true;
  });
  return state.networks.map(networkKey).filter(function (id) {
    return !!selected[id];
  });
}

function networkSelectionLocked() {
  return state.running || state.inventoryScanning || state.stopping;
}

function reconcileNetworkSelection(networks, selectedIds, touched) {
  var safeNetworks = Array.isArray(networks) ? networks : [];
  if (!touched) {
    return safeNetworks.map(networkKey);
  }
  var available = {};
  safeNetworks.forEach(function (network) {
    available[networkKey(network)] = true;
  });
  var seen = {};
  var result = [];
  var requested = Array.isArray(selectedIds) ? selectedIds : [];
  requested.forEach(function (id) {
    if (typeof id === "string" && available[id] && !seen[id]) {
      seen[id] = true;
      result.push(id);
    }
  });
  return result;
}

function persistNetworkSelection() {
  writeStoredJson(NETWORK_SELECTION_KEY, {
    touched: true,
    selectedNetworkIds: state.selectedNetworkIds.slice()
  });
}

function restoreNetworkSelection() {
  var stored = readStoredJson(NETWORK_SELECTION_KEY);
  if (
    !stored ||
    stored.touched !== true ||
    !Array.isArray(stored.selectedNetworkIds)
  ) {
    return;
  }
  state.networkSelectionTouched = true;
  state.selectedNetworkIds = stored.selectedNetworkIds.filter(function (id) {
    return typeof id === "string" && !!id;
  });
}

function isUsableNetwork(network) {
  return !!network &&
    typeof network === "object" &&
    typeof network.interface === "string" &&
    !!network.interface &&
    typeof network.scan_range === "string" &&
    !!network.scan_range &&
    typeof network.local_ip === "string" &&
    !!network.local_ip;
}

function networkSignature(networks) {
  return (Array.isArray(networks) ? networks : [])
    .filter(isUsableNetwork)
    .map(function (network) {
      return [
        networkKey(network),
        network.interface,
        network.local_ip,
        network.prefix_length === undefined ? "" : String(network.prefix_length),
        network.gateway || "",
        network.scan_range
      ].join("|");
    })
    .sort()
    .join("\n");
}

function networkIdsSignature(ids) {
  return (Array.isArray(ids) ? ids : [])
    .filter(function (id) {
      return typeof id === "string" && !!id;
    })
    .slice()
    .sort()
    .join("|");
}

function isUsableDevice(device) {
  return !!device &&
    typeof device === "object" &&
    typeof device.interface === "string" &&
    typeof device.scan_range === "string" &&
    typeof device.ip === "string" &&
    typeof device.mac === "string" &&
    typeof device.state === "string";
}

function persistNetworkCache() {
  if (!state.networks.length) {
    removeStoredValue(NETWORK_CACHE_KEY);
    return;
  }
  writeStoredJson(NETWORK_CACHE_KEY, {
    savedAt: Date.now(),
    networks: state.networks,
    warnings: state.warnings
  });
}

function restoreNetworkCache() {
  var cache = readStoredJson(NETWORK_CACHE_KEY);
  if (!cache || !Array.isArray(cache.networks)) {
    return false;
  }
  var networks = cache.networks.filter(isUsableNetwork);
  if (!networks.length) {
    return false;
  }
  var warnings = Array.isArray(cache.warnings)
    ? cache.warnings.filter(function (item) {
      return typeof item === "string" && !!item;
    })
    : [];
  setNetworks({ networks: networks, warnings: warnings });
  state.networkCacheRestoredAt = Number(cache.savedAt) || 0;
  return true;
}

function persistDeviceCache(networkIds) {
  if (!state.devices.length) {
    removeStoredValue(DEVICE_CACHE_KEY);
    return;
  }
  writeStoredJson(DEVICE_CACHE_KEY, {
    savedAt: Date.now(),
    networkSignature: networkSignature(state.networks),
    networkIds: (Array.isArray(networkIds) ? networkIds : []).slice(),
    devices: state.devices.slice(0, DEVICE_CACHE_LIMIT)
  });
}

function restoreDeviceCache() {
  var cache = readStoredJson(DEVICE_CACHE_KEY);
  if (!cache || !Array.isArray(cache.devices)) {
    return false;
  }
  if (String(cache.networkSignature || "") !== networkSignature(state.networks)) {
    return false;
  }
  if (networkIdsSignature(cache.networkIds) !==
      networkIdsSignature(selectedNetworkIds())) {
    return false;
  }
  var devices = cache.devices.filter(isUsableDevice);
  if (!devices.length) {
    return false;
  }
  state.devices = devices;
  state.deviceCacheRestoredAt = Number(cache.savedAt) || 0;
  if (state.tableMode === "devices") {
    renderDevices(devices, true);
    var stamp = formatTime(state.deviceCacheRestoredAt);
    setText(
      "resultSummary",
      "已恢复上次探测到的 " + devices.length + " 台设备" +
        (stamp ? "（" + stamp + "）" : "") + "。"
    );
    setText("scanFooterMeta", "已缓存设备 " + devices.length + " 台");
  }
  return true;
}

function networkSelectionSummary() {
  if (!state.networks.length) {
    return "未发现可扫描网段";
  }
  var selectedCount = selectedNetworkIds().length;
  if (!selectedCount) {
    return "请至少选择一个活动网段";
  }
  return "已选择 " + selectedCount + " / " + state.networks.length + " 个活动网段";
}

function updateNetworkSummary() {
  setText("networkSummary", networkSelectionSummary());
}

function scheduleContinuousAfterSelectionChange() {
  if (
    state.continuous &&
    !state.running &&
    !state.stopping &&
    selectedNetworkIds().length
  ) {
    scheduleContinuousRestart(250);
  }
}

function setNetworkSelection(id, selected) {
  var networkId = String(id || "");
  if (!networkId || networkSelectionLocked()) {
    return;
  }
  var lookup = {};
  state.selectedNetworkIds.forEach(function (value) {
    lookup[value] = true;
  });
  if (selected) {
    lookup[networkId] = true;
  } else {
    delete lookup[networkId];
  }
  state.selectedNetworkIds = state.networks.map(networkKey).filter(function (value) {
    return !!lookup[value];
  });
  state.networkSelectionTouched = true;
  persistNetworkSelection();
  updateNetworkSummary();
  updateControls();
  scheduleContinuousAfterSelectionChange();
}

function selectAllNetworks() {
  if (networkSelectionLocked() || !state.networks.length) {
    return;
  }
  state.selectedNetworkIds = state.networks.map(networkKey);
  state.networkSelectionTouched = true;
  persistNetworkSelection();
  renderNetworkList();
  updateNetworkSummary();
  updateControls();
  scheduleContinuousAfterSelectionChange();
}

function clearContinuousRestart() {
  if (continuousRestartTimer) {
    window.clearTimeout(continuousRestartTimer);
    continuousRestartTimer = null;
  }
}

function nextServiceRetryDelay() {
  var delay = Math.max(
    SERVICE_RETRY_DELAY_MS,
    Number(state.retryDelay) || SERVICE_RETRY_DELAY_MS
  );
  state.retryDelay = Math.min(15000, Math.round(delay * 1.65));
  return delay;
}

function resetServiceRetryDelay() {
  state.retryDelay = SERVICE_RETRY_DELAY_MS;
}

function targetLabel(target) {
  if (!target) {
    return "";
  }
  return String(target.display || target.normalized || "");
}

function activeTargetLabel() {
  if (!state.targets.length) {
    return state.activeSuffix || state.normalizedSuffix || "";
  }
  var labels = state.targets.map(targetLabel);
  if (labels.length <= 3) {
    return labels.join("、");
  }
  return labels.slice(0, 3).join("、") + " 等 " + labels.length + " 个后缀";
}

function pendingTargetLabel() {
  var labels = state.targets.filter(function (target) {
    return target.status === "searching";
  }).map(targetLabel);
  if (!labels.length) {
    return activeTargetLabel();
  }
  if (labels.length <= 3) {
    return labels.join("、");
  }
  return labels.slice(0, 3).join("、") + " 等 " + labels.length + " 个后缀";
}

function targetResultLine(target) {
  var label = targetLabel(target);
  if (target.status === "found") {
    return label + " 找到 " + target.foundCount + " 台设备";
  }
  if (target.status === "not-found") {
    return label + " 已完成 " + MAX_NO_MATCH_ROUNDS + " 轮，未找到";
  }
  return label + " 未完成查找";
}

function buildTargets(entries) {
  return (Array.isArray(entries) ? entries : []).map(function (entry) {
    return {
      display: entry.display,
      normalized: entry.normalized,
      rounds: 0,
      foundCount: 0,
      status: "searching"
    };
  });
}

function syncActiveSuffixState() {
  state.activeSuffixes = state.targets.map(function (target) {
    return target.display;
  });
  state.normalizedSuffixes = state.targets.map(function (target) {
    return target.normalized;
  });
  state.activeSuffix = state.activeSuffixes.join("、");
  state.normalizedSuffix = state.normalizedSuffixes[0] || "";
}

function sameSuffixSet(values, expected) {
  function signature(list) {
    return (Array.isArray(list) ? list : []).map(function (value) {
      return normalizeSuffix(value) || String(value || "").toUpperCase();
    }).sort().join("|");
  }
  return signature(values) === signature(expected);
}

function resultMatchesTarget(item, target) {
  if (!item || !target || !target.normalized) {
    return false;
  }
  if (Array.isArray(item.matched_suffixes)) {
    for (var index = 0; index < item.matched_suffixes.length; index += 1) {
      var matched = normalizeSuffix(item.matched_suffixes[index]);
      if (matched === target.normalized) {
        return true;
      }
    }
    return false;
  }
  var mac = String(item.mac || "").replace(/[-:]/g, "").toUpperCase();
  return mac.slice(-target.normalized.length) === target.normalized;
}

function countTargetMatches(results, target) {
  var count = 0;
  (Array.isArray(results) ? results : []).forEach(function (item) {
    if (resultMatchesTarget(item, target)) {
      count += 1;
    }
  });
  return count;
}

function displaySuffixFor(value) {
  var normalized = normalizeSuffix(value) || String(value || "").toUpperCase();
  for (var index = 0; index < state.targets.length; index += 1) {
    if (state.targets[index].normalized === normalized) {
      return state.targets[index].display;
    }
  }
  return String(value || "");
}

function mergeResultItems(current, incoming) {
  var merged = [];
  var positions = {};
  function add(item) {
    if (!item || typeof item !== "object") {
      return;
    }
    var key = [item.interface, item.ip, item.mac].join("|");
    if (Object.prototype.hasOwnProperty.call(positions, key)) {
      var existing = merged[positions[key]];
      if (Array.isArray(item.matched_suffixes)) {
        var suffixes = Array.isArray(existing.matched_suffixes)
          ? existing.matched_suffixes.slice()
          : [];
        item.matched_suffixes.forEach(function (suffix) {
          if (suffixes.indexOf(suffix) < 0) {
            suffixes.push(suffix);
          }
        });
        existing.matched_suffixes = suffixes;
      }
      return;
    }
    positions[key] = merged.length;
    merged.push(item);
  }
  (Array.isArray(current) ? current : []).forEach(add);
  (Array.isArray(incoming) ? incoming : []).forEach(add);
  return merged;
}

function persistSearchIntent(results) {
  if (!state.targets.length) {
    return;
  }
  writeStoredJson(SEARCH_INTENT_KEY, {
    displaySuffixes: state.targets.map(function (target) {
      return target.display;
    }),
    normalizedSuffixes: state.targets.map(function (target) {
      return target.normalized;
    }),
    targets: state.targets.map(function (target) {
      return {
        display: target.display,
        normalized: target.normalized,
        rounds: target.rounds,
        foundCount: target.foundCount,
        status: target.status
      };
    }),
    continuous: true,
    noMatchRounds: state.noMatchRounds,
    searchRound: state.searchRound,
    lastCountedJobId: state.lastCountedJobId,
    lastResults: Array.isArray(results) ? results.slice(0, 50) : []
  });
}

function persistCurrentFoundResults() {
  if (!state.continuous) {
    return;
  }
  persistSearchIntent(state.results);
}

function discardSearchIntent() {
  clearContinuousRestart();
  removeStoredValue(SEARCH_INTENT_KEY);
}

function restoreSearchIntent() {
  var intent = readStoredJson(SEARCH_INTENT_KEY);
  if (!intent || intent.continuous !== true) {
    return false;
  }
  var displays = Array.isArray(intent.displaySuffixes)
    ? intent.displaySuffixes
    : (intent.displaySuffix ? [intent.displaySuffix] : []);
  var entries = [];
  var seen = {};
  displays.forEach(function (value) {
    var display = String(value || "").trim();
    var normalized = normalizeSuffix(display);
    if (!normalized || seen[normalized]) {
      return;
    }
    seen[normalized] = true;
    entries.push({ display: display, normalized: normalized });
  });
  if (!entries.length) {
    removeStoredValue(SEARCH_INTENT_KEY);
    return false;
  }
  var storedTargets = Array.isArray(intent.targets) ? intent.targets : [];
  var targets = entries.map(function (entry) {
    var stored = storedTargets.filter(function (item) {
      return item && item.normalized === entry.normalized;
    })[0];
    var status = stored && (stored.status === "found" || stored.status === "not-found")
      ? stored.status
      : "searching";
    var rounds = Math.max(0, Math.min(
      MAX_NO_MATCH_ROUNDS,
      Math.floor(Number(stored && stored.rounds) || 0)
    ));
    var foundCount = Math.max(
      0,
      Math.floor(Number(stored && stored.foundCount) || 0)
    );
    if (!stored && entries.length === 1) {
      rounds = Math.max(0, Math.floor(Number(intent.noMatchRounds) || 0));
    }
    if (status === "searching" && rounds >= MAX_NO_MATCH_ROUNDS) {
      status = "not-found";
    }
    return {
      display: entry.display,
      normalized: entry.normalized,
      rounds: rounds,
      foundCount: foundCount,
      status: status
    };
  });
  var hasPending = targets.some(function (target) {
    return target.status === "searching";
  });
  if (!hasPending) {
    removeStoredValue(SEARCH_INTENT_KEY);
    return false;
  }
  setSuffixInputs(entries.map(function (entry) {
    return entry.display;
  }));
  state.continuous = true;
  state.searchFinished = false;
  state.searchExhausted = false;
  state.roundInterrupted = false;
  state.searchRound = Math.max(0, Math.floor(Number(intent.searchRound) || 0));
  state.noMatchRounds = targets.reduce(function (maximum, target) {
    return Math.max(maximum, target.rounds);
  }, 0);
  state.lastCountedJobId = typeof intent.lastCountedJobId === "string"
    ? intent.lastCountedJobId
    : "";
  state.targets = targets;
  syncActiveSuffixState();
  state.scanStatus = "waiting";
  state.retryDelay = SERVICE_RETRY_DELAY_MS;
  var storedResults = Array.isArray(intent.lastResults)
    ? intent.lastResults.filter(function (item) {
      return item &&
        typeof item.interface === "string" &&
        typeof item.scan_range === "string" &&
        typeof item.ip === "string" &&
        typeof item.mac === "string" &&
        typeof item.state === "string";
    })
    : [];
  renderResults(storedResults, true);
  setScanState(
    "running",
    "恢复持续搜索",
    "服务恢复后将自动继续查找 " + activeTargetLabel() + "。"
  );
  return true;
}

function deviceWebUrl(ip) {
  var text = String(ip || "").trim();
  var parts = text.split(".");
  if (parts.length !== 4) {
    return "";
  }
  for (var index = 0; index < parts.length; index += 1) {
    if (!/^\d{1,3}$/.test(parts[index]) || Number(parts[index]) > 255) {
      return "";
    }
  }
  return "http://" + text + "/";
}

function targetRoundNumber(target) {
  var current = target.rounds + (state.running ? 1 : 0);
  return Math.max(1, Math.min(MAX_NO_MATCH_ROUNDS, current));
}

function continuousRoundLabel() {
  var completed = Math.max(0, state.searchRound);
  var current = state.running ? completed + 1 : Math.max(1, completed);
  return "第 " + Math.max(1, Math.min(MAX_NO_MATCH_ROUNDS, current)) +
    " / " + MAX_NO_MATCH_ROUNDS + " 轮";
}

function continuousExhaustedMessage() {
  if (state.targets.length > 1) {
    return "已完成 " + MAX_NO_MATCH_ROUNDS + " 轮轮询查找：" +
      state.targets.map(targetResultLine).join("；") + "。";
  }
  return "已完成 " + MAX_NO_MATCH_ROUNDS + " 轮轮询查找，最终没有找到 MAC 后缀 " +
    activeTargetLabel() + " 的设备。";
}

function searchFinishedMessage() {
  var only = state.targets.length === 1 ? state.targets[0] : null;
  if (only && only.status === "found") {
    return "查找完成，MAC 后缀 " + targetLabel(only) + " 找到 " +
      only.foundCount + " 台设备。";
  }
  if (only) {
    return continuousExhaustedMessage();
  }
  if (state.targets.length > 1) {
    return "查找完成：" + state.targets.map(targetResultLine).join("；") + "。";
  }
  return continuousExhaustedMessage();
}

function ensureLegacyTarget() {
  if (!state.targets.length) {
    var normalized = state.normalizedSuffix || normalizeSuffix(state.activeSuffix);
    var display = state.activeSuffix || normalized;
    if (!normalized) {
      return null;
    }
    state.targets = [{
      display: display,
      normalized: normalized,
      rounds: 0,
      foundCount: 0,
      status: "searching"
    }];
    syncActiveSuffixState();
  }
  return state.targets;
}

function registerContinuousRound(jobId, resultsOrCount) {
  var key = String(jobId || "");
  if (!state.continuous || !key || key === state.lastCountedJobId) {
    return {
      counted: false,
      changed: false,
      rounds: state.noMatchRounds,
      exhausted: false,
      found: false,
      allResolved: false
    };
  }
  var targets = ensureLegacyTarget();
  if (!targets) {
    return {
      counted: false,
      changed: false,
      rounds: state.noMatchRounds,
      exhausted: false,
      found: false,
      allResolved: false
    };
  }
  var results = Array.isArray(resultsOrCount) ? resultsOrCount : null;
  var countOnlyMatch = !results && Number(resultsOrCount) > 0;
  state.lastCountedJobId = key;
  state.searchRound += 1;
  var found = false;
  var changed = false;
  targets.forEach(function (target) {
    if (target.status !== "searching") {
      return;
    }
    var count = results
      ? countTargetMatches(results, target)
      : (countOnlyMatch ? 1 : 0);
    if (count > 0) {
      target.status = "found";
      target.foundCount = count;
      found = true;
      changed = true;
      return;
    }
    target.rounds += 1;
    if (target.rounds >= MAX_NO_MATCH_ROUNDS) {
      target.status = "not-found";
      target.foundCount = 0;
      changed = true;
    }
  });
  state.noMatchRounds = targets.reduce(function (maximum, target) {
    return Math.max(maximum, target.rounds);
  }, 0);
  var allResolved = targets.every(function (target) {
    return target.status !== "searching";
  });
  var exhausted = targets.some(function (target) {
    return target.status === "not-found";
  });
  return {
    counted: true,
    changed: changed,
    rounds: state.noMatchRounds,
    exhausted: exhausted,
    found: found,
    allResolved: allResolved
  };
}

function resetContinuousRoundTracking() {
  state.noMatchRounds = 0;
  state.searchRound = 0;
  state.lastCountedJobId = "";
  state.searchExhausted = false;
  state.searchFinished = false;
  state.roundInterrupted = false;
  state.targets.forEach(function (target) {
    target.rounds = 0;
    target.foundCount = 0;
    target.status = "searching";
  });
}

function targetStatusText(target) {
  if (target.status === "found") {
    return "找到 " + target.foundCount + " 台";
  }
  if (target.status === "not-found") {
    return "已查 " + MAX_NO_MATCH_ROUNDS + " 轮 · 未找到";
  }
  if (state.running) {
    return "查找中 · 第 " + targetRoundNumber(target) + " / " +
      MAX_NO_MATCH_ROUNDS + " 轮";
  }
  if (state.continuous) {
    return "已查 " + Math.min(MAX_NO_MATCH_ROUNDS, target.rounds) + " / " +
      MAX_NO_MATCH_ROUNDS + " 轮 · 等待下一轮";
  }
  if (state.roundInterrupted) {
    return "已停止 · 第 " + Math.min(
      MAX_NO_MATCH_ROUNDS,
      target.rounds + 1
    ) + " / " + MAX_NO_MATCH_ROUNDS + " 轮未完成";
  }
  if (target.rounds === 0) {
    return "已停止 · 未开始查找";
  }
  return "已停止 · 已查 " + Math.min(MAX_NO_MATCH_ROUNDS, target.rounds) +
    " / " + MAX_NO_MATCH_ROUNDS + " 轮";
}

function syncTargetCounts(results) {
  state.targets.forEach(function (target) {
    var count = countTargetMatches(results, target);
    if (count > 0) {
      target.foundCount = Math.max(target.foundCount, count);
    }
  });
}

function renderTargetSummary() {
  var panel = byId("targetSummary");
  var container = byId("targetChips");
  if (!panel || !container) {
    return;
  }
  var show = state.targets.length > 1 &&
    (state.continuous || state.searchFinished || state.tableMode === "results");
  panel.hidden = !show;
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
  if (!show) {
    return;
  }
  state.targets.forEach(function (target) {
    var chip = document.createElement("span");
    chip.className = "target-chip is-" + target.status;
    var dot = document.createElement("span");
    dot.className = "target-dot";
    dot.setAttribute("aria-hidden", "true");
    var value = document.createElement("strong");
    value.className = "target-value";
    value.textContent = targetLabel(target);
    var status = document.createElement("span");
    status.className = "target-state";
    status.textContent = targetStatusText(target);
    chip.appendChild(dot);
    chip.appendChild(value);
    chip.appendChild(status);
    container.appendChild(chip);
  });
}

function isIpLinkTarget(target) {
  return !!target &&
    typeof target.closest === "function" &&
    target.closest(".ip-link") !== null;
}

function getCookie(name) {
  var prefix = encodeURIComponent(name) + "=";
  var items = document.cookie.split(";");
  for (var index = 0; index < items.length; index += 1) {
    var item = items[index].trim();
    if (item.indexOf(prefix) === 0) {
      return item.slice(prefix.length);
    }
  }
  return "";
}

function platformHeaders(withJsonBody) {
  var headers = {};
  var csrf = getCookie("X-Csrf-Token");
  if (csrf) {
    headers["X-Csrf-Token"] = csrf;
  }
  if (withJsonBody) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function isLoginEnvelope(data) {
  return !!data && (
    data.is_login === false ||
    data.code_num === 117 ||
    data.msg === "please login"
  );
}

function apiFailure(kind, url, detail, status) {
  var labels = {
    network: "请求没有离开浏览器",
    session: "TOS 会话未生效",
    gateway: "平台代理没有转到本应用",
    offline: "应用服务返回了错误",
    rejected: "请求未被接受"
  };
  var error = new Error(labels[kind] + "：" + detail);
  error.kind = kind;
  error.url = url;
  error.detail = detail;
  error.status = status || 0;
  return error;
}

async function send(root, endpoint, payload, options) {
  var url = root + "/" + endpoint;
  var withBody = payload !== undefined && payload !== null;
  var timeoutMs = Math.max(
    1000,
    Number(options && options.timeoutMs) || REQUEST_TIMEOUT_MS
  );
  var response;
  var requestController = typeof AbortController === "function"
    ? new AbortController()
    : null;
  var requestTimeout = requestController
    ? window.setTimeout(function () {
      requestController.abort();
    }, timeoutMs)
    : null;
  try {
    response = await fetch(url, {
      method: withBody ? "POST" : "GET",
      credentials: "include",
      headers: platformHeaders(withBody),
      body: withBody ? JSON.stringify(payload) : undefined,
      signal: requestController ? requestController.signal : undefined,
      cache: "no-store"
    });
  } catch (error) {
    if (requestTimeout) {
      window.clearTimeout(requestTimeout);
    }
    throw apiFailure(
      "network",
      url,
      error.name === "AbortError"
        ? "请求超过 " + Math.round(timeoutMs / 1000) + " 秒未响应"
        : (error.name || "Error") + ": " + error.message
    );
  }

  var text = "";
  try {
    text = await response.text();
  } catch (error) {
    if (requestTimeout) {
      window.clearTimeout(requestTimeout);
    }
    if (error.name === "AbortError") {
      throw apiFailure(
        "network",
        url,
        "请求超过 " + Math.round(timeoutMs / 1000) + " 秒未响应"
      );
    }
  }
  if (requestTimeout) {
    window.clearTimeout(requestTimeout);
  }
  var data = null;
  try {
    data = JSON.parse(text);
  } catch (error) {
    data = null;
  }

  if (response.status === 401 || isLoginEnvelope(data)) {
    throw apiFailure(
      "session",
      url,
      "平台返回未登录响应（HTTP " + response.status + "）",
      response.status
    );
  }
  if (data === null) {
    throw apiFailure(
      "gateway",
      url,
      "HTTP " + response.status + " 且响应不是 JSON",
      response.status
    );
  }
  if (!response.ok) {
    throw apiFailure(
      response.status >= 500 ? "offline" : "rejected",
      url,
      data.error || ("HTTP " + response.status),
      response.status
    );
  }
  if (data.ok === false) {
    throw apiFailure(
      "rejected",
      url,
      data.error || "后端返回 ok:false",
      response.status
    );
  }
  return data;
}

async function refreshApiRoot() {
  var lastError = null;
  for (var index = 0; index < API_CANDIDATES.length; index += 1) {
    var root = API_CANDIDATES[index];
    try {
      var data = await send(root, "health", null);
      if (data.app !== APP_ID) {
        lastError = apiFailure(
          "gateway",
          root + "/health",
          "回包的 app 字段是 " + data.app
        );
        continue;
      }
      API_ROOT = root;
      apiReady = true;
      return data;
    } catch (error) {
      if (error.kind === "session" || error.kind === "network") {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError || apiFailure(
    "gateway",
    API_CANDIDATES[0] + "/health",
    "所有候选代理路径都不可用"
  );
}

async function apiRequest(endpoint, payload, options) {
  if (!apiReady) {
    await refreshApiRoot();
  }
  try {
    return await send(API_ROOT, endpoint, payload, options);
  } catch (error) {
    if (error.kind === "gateway") {
      apiReady = false;
      await refreshApiRoot();
      return await send(API_ROOT, endpoint, payload, options);
    }
    throw error;
  }
}

function setBackendState(kind, text) {
  var badge = byId("backendBadge");
  badge.className = "backend-badge " + (
    kind === "online"
      ? "is-online"
      : kind === "offline"
        ? "is-offline"
        : kind === "warning"
          ? "is-warning"
          : "is-checking"
  );
  setText("backendBadgeText", text);
}

function toast(message, isError) {
  var region = byId("toastRegion");
  region.textContent = "";
  var item = document.createElement("div");
  item.className = "toast" + (isError ? " is-error" : "");
  item.textContent = message;
  region.appendChild(item);
  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(function () {
    if (item.parentNode) {
      item.parentNode.removeChild(item);
    }
  }, isError ? 5200 : 2800);
}

function describeError(error) {
  if (!error) {
    return "未知错误";
  }
  if (error.kind === "session") {
    return "TOS 会话未生效，请从桌面重新打开应用。";
  }
  if (error.kind === "network") {
    return "浏览器未能连接平台代理，请检查当前 TOS 页面和网络连接。";
  }
  if (error.kind === "gateway") {
    return "平台代理没有返回本应用接口，请确认应用服务状态。";
  }
  if (error.kind === "offline") {
    return "应用后端返回错误，请稍后重试。";
  }
  return error.detail || error.message || "请求失败";
}

function iconSvg(children) {
  var namespace = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  children.forEach(function (definition) {
    var element = document.createElementNS(namespace, definition[0]);
    Object.keys(definition[1]).forEach(function (name) {
      element.setAttribute(name, definition[1][name]);
    });
    svg.appendChild(element);
  });
  return svg;
}

function renderNetworkList() {
  var list = byId("networkList");
  var selected = {};
  state.selectedNetworkIds.forEach(function (id) {
    selected[id] = true;
  });
  while (list.firstChild) {
    list.removeChild(list.firstChild);
  }
  if (!state.networks.length) {
    var empty = document.createElement("div");
    empty.className = "network-empty";
    empty.textContent = "没有可扫描的物理网段";
    list.appendChild(empty);
    return;
  }

  state.networks.forEach(function (network) {
    var networkId = networkKey(network);
    var isSelected = !!selected[networkId];
    var item = document.createElement("label");
    item.className = "network-item " + (isSelected ? "is-selected" : "is-unselected");

    var checkbox = document.createElement("input");
    checkbox.className = "network-checkbox";
    checkbox.type = "checkbox";
    checkbox.checked = isSelected;
    checkbox.disabled = networkSelectionLocked();
    checkbox.setAttribute(
      "aria-label",
      "扫描网段 " + network.scan_range + "（" + network.interface + "）"
    );
    checkbox.addEventListener("change", function () {
      item.classList.toggle("is-selected", checkbox.checked);
      item.classList.toggle("is-unselected", !checkbox.checked);
      setNetworkSelection(networkId, checkbox.checked);
    });

    var icon = document.createElement("div");
    icon.className = "network-item-icon";
    icon.appendChild(iconSvg([
      ["rect", { x: "3", y: "5", width: "18", height: "14", rx: "2" }],
      ["path", { d: "M7 9h2" }],
      ["path", { d: "M11 9h2" }],
      ["path", { d: "M15 9h2" }],
      ["path", { d: "M7 13h10" }]
    ]));

    var copy = document.createElement("div");
    copy.className = "network-item-copy";
    var name = document.createElement("div");
    name.className = "network-item-name";
    name.textContent = network.interface;
    var detail = document.createElement("div");
    detail.className = "network-item-detail";
    detail.textContent = network.local_ip + "/" + network.prefix_length +
      " · 网关 " + (network.gateway || "--");
    copy.appendChild(name);
    copy.appendChild(detail);

    var range = document.createElement("span");
    range.className = "network-range";
    range.textContent = network.scan_range;

    item.appendChild(checkbox);
    item.appendChild(icon);
    item.appendChild(copy);
    item.appendChild(range);
    list.appendChild(item);
  });
}

function renderWarnings() {
  var panel = byId("networkWarnings");
  while (panel.firstChild) {
    panel.removeChild(panel.firstChild);
  }
  if (!state.warnings.length) {
    panel.hidden = true;
    return;
  }
  state.warnings.forEach(function (warning) {
    var line = document.createElement("div");
    line.textContent = warning;
    panel.appendChild(line);
  });
  panel.hidden = false;
}

function setNetworks(payload) {
  state.networks = Array.isArray(payload.networks) ? payload.networks : [];
  state.selectedNetworkIds = reconcileNetworkSelection(
    state.networks,
    state.selectedNetworkIds,
    state.networkSelectionTouched
  );
  state.warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  updateNetworkSummary();
  renderNetworkList();
  renderWarnings();
  updateControls();
}

function classifySuffixInput(value) {
  var text = String(value || "").trim();
  if (!text) {
    return { status: "empty", normalized: "" };
  }
  if (text.length > 5) {
    return { status: "too-long", normalized: "" };
  }
  if (!/^[0-9A-Fa-f:-]+$/.test(text)) {
    return { status: "invalid-character", normalized: "" };
  }
  var separatorCount = (text.match(/[-:]/g) || []).length;
  if (separatorCount > 1) {
    return { status: "invalid-format", normalized: "" };
  }
  if (!separatorCount && text.length > 4) {
    return { status: "too-long", normalized: "" };
  }
  if (MAC_SUFFIX_PATTERN.test(text)) {
    return { status: "valid", normalized: normalizeSuffix(text) };
  }
  return { status: "incomplete", normalized: "" };
}

function inputErrorMessage(status) {
  if (status === "too-long") {
    return "无分隔符时最多输入 4 位；带 - 或 : 分隔符时最多输入 5 位。";
  }
  if (status === "invalid-character") {
    return "MAC 后四位只能包含 0-9、A-F，以及一个 - 或 : 分隔符。";
  }
  return DEFAULT_INPUT_ERROR;
}

function suffixRows() {
  var list = byId("suffixInputList");
  if (!list) {
    return [];
  }
  return Array.prototype.slice.call(
    list.querySelectorAll("[data-suffix-row]")
  );
}

function suffixInputs() {
  return suffixRows().map(function (row) {
    return row.querySelector("input");
  }).filter(Boolean);
}

function rowForInput(node) {
  if (!node || typeof node.closest !== "function") {
    return null;
  }
  return node.closest("[data-suffix-row]");
}

function anySuffixValue() {
  return suffixInputs().some(function (input) {
    return !!input.value.trim();
  });
}

function setRowInvalid(row, invalid, message) {
  if (!row) {
    return;
  }
  var shell = row.querySelector(".input-shell");
  var input = row.querySelector("input");
  if (shell) {
    shell.classList.toggle("is-invalid", !!invalid);
  }
  if (input) {
    input.setAttribute("aria-invalid", invalid ? "true" : "false");
  }
  if (invalid && message) {
    var error = byId("inputError");
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
  }
}

function clearSuffixRowFlags() {
  suffixRows().forEach(function (row) {
    setRowInvalid(row, false);
  });
}

function clearInputError() {
  clearSuffixRowFlags();
  var error = byId("inputError");
  if (error) {
    error.textContent = "";
    error.hidden = true;
  }
}

function showInputError(message, row) {
  var rows = suffixRows();
  var targetRow = row || rows[0] || null;
  clearSuffixRowFlags();
  setRowInvalid(targetRow, true, message || DEFAULT_INPUT_ERROR);
}

function setInputInvalidState(invalid, message) {
  if (!invalid) {
    clearInputError();
    return;
  }
  showInputError(message);
}

function collectSuffixEntries(showError) {
  var rows = suffixRows();
  if (!rows.length) {
    return null;
  }
  var entries = [];
  var seen = {};
  var problem = null;
  rows.forEach(function (row) {
    var input = row.querySelector("input");
    if (!input) {
      return;
    }
    var result = classifySuffixInput(input.value);
    if (result.status === "empty") {
      return;
    }
    if (result.status !== "valid") {
      var focused = document.activeElement === input;
      if (result.status === "incomplete" && focused && !showError) {
        return;
      }
      if (!problem) {
        problem = {
          row: row,
          message: inputErrorMessage(result.status)
        };
      }
      return;
    }
    if (seen[result.normalized]) {
      if (!problem) {
        problem = {
          row: row,
          message: "同一个 MAC 后缀不能重复输入。"
        };
      }
      return;
    }
    seen[result.normalized] = true;
    entries.push({
      display: input.value.trim(),
      normalized: result.normalized
    });
  });
  if (!showError) {
    return entries.length ? entries : null;
  }
  if (problem) {
    showInputError(problem.message, problem.row);
    return null;
  }
  if (!entries.length) {
    showInputError(DEFAULT_INPUT_ERROR, rows[0]);
    return null;
  }
  clearInputError();
  return entries;
}

function validateInput(showError) {
  var entries = collectSuffixEntries(showError);
  if (!entries || entries.length !== 1) {
    return "";
  }
  return entries[0].normalized;
}

function updateSuffixRowMetadata() {
  var rows = suffixRows();
  rows.forEach(function (row, index) {
    var input = row.querySelector("input");
    if (input) {
      input.setAttribute(
        "aria-label",
        index === 0 ? "MAC 后四位" : "MAC 后四位 " + (index + 1)
      );
    }
  });
}

function createSuffixRow(value) {
  var row = document.createElement("div");
  row.className = "suffix-input-row";
  row.setAttribute("data-suffix-row", "");
  var shell = document.createElement("div");
  shell.className = "input-shell";
  var firstShell = byId("inputShell");
  var firstIcon = firstShell ? firstShell.querySelector("svg") : null;
  if (firstIcon) {
    shell.appendChild(firstIcon.cloneNode(true));
  }
  var input = document.createElement("input");
  input.type = "text";
  input.className = "suffix-input";
  input.placeholder = "AA-BB / AA:BB / AABB";
  input.setAttribute("spellcheck", "false");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocapitalize", "none");
  input.setAttribute("aria-invalid", "false");
  input.setAttribute("aria-describedby", "inputError");
  input.setAttribute("data-suffix-input", "");
  input.value = String(value || "");
  shell.appendChild(input);
  var remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-suffix-button";
  remove.setAttribute("data-remove-suffix", "");
  remove.setAttribute("aria-label", "移除这个 MAC");
  remove.title = "移除这个 MAC";
  var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  var first = document.createElementNS("http://www.w3.org/2000/svg", "path");
  first.setAttribute("d", "M6 6 18 18");
  var second = document.createElementNS("http://www.w3.org/2000/svg", "path");
  second.setAttribute("d", "M18 6 6 18");
  icon.appendChild(first);
  icon.appendChild(second);
  remove.appendChild(icon);
  shell.appendChild(remove);
  row.appendChild(shell);
  return row;
}

function addSuffixRow(value, focus) {
  var list = byId("suffixInputList");
  if (!list || suffixRows().length >= MAX_SUFFIX_INPUTS) {
    return null;
  }
  var row = createSuffixRow(value);
  list.appendChild(row);
  updateSuffixRowMetadata();
  updateControls();
  if (focus) {
    var input = row.querySelector("input");
    if (input) {
      input.focus();
    }
  }
  return row;
}

function removeSuffixRow(row) {
  if (
    !row ||
    suffixRows().length <= 1 ||
    state.running ||
    state.continuous ||
    state.inventoryScanning
  ) {
    return;
  }
  row.parentNode.removeChild(row);
  clearInputError();
  updateSuffixRowMetadata();
  updateControls();
  var rows = suffixRows();
  var lastRow = rows[rows.length - 1];
  var input = lastRow ? lastRow.querySelector("input") : null;
  if (input) {
    input.focus();
  }
}

function setSuffixInputs(values) {
  var list = byId("suffixInputList");
  if (!list) {
    return;
  }
  var wanted = Array.isArray(values)
    ? values.slice(0, MAX_SUFFIX_INPUTS)
    : [];
  if (!wanted.length) {
    wanted = [""];
  }
  var rows = suffixRows();
  while (rows.length < wanted.length) {
    var row = createSuffixRow("");
    list.appendChild(row);
    rows.push(row);
  }
  while (rows.length > wanted.length) {
    var extra = rows.pop();
    list.removeChild(extra);
  }
  rows.forEach(function (rowNode, index) {
    var input = rowNode.querySelector("input");
    if (input) {
      input.value = wanted[index];
    }
  });
  updateSuffixRowMetadata();
  clearInputError();
  updateControls();
}

function updateControls() {
  var scanButton = byId("scanButton");
  var stopButton = byId("stopButton");
  var refreshButton = byId("refreshButton");
  var emptyRefreshButton = byId("emptyRefreshButton");
  var copyButton = byId("copyButton");
  var copyIpButton = byId("copyIpButton");
  var exportButton = byId("exportButton");
  var clearButton = byId("clearButton");
  var inputClearButton = byId("inputClearButton");
  var selectAllButton = byId("selectAllNetworksButton");
  var rows = suffixRows();
  var searchActive = state.running || state.continuous;
  var busy = searchActive || state.inventoryScanning;
  var selectedIds = selectedNetworkIds();
  var hasSelection = selectedIds.length > 0;
  var selectionLocked = networkSelectionLocked();
  var visibleRows = visibleTableRows();
  var filteredEmpty = tableQueryActive() &&
    rawTableRows().length > 0 &&
    visibleRows.length === 0;

  scanButton.disabled = busy || !hasSelection;
  stopButton.disabled = !searchActive || state.stopping;
  refreshButton.disabled =
    state.running || state.inventoryScanning || state.networkVerifying;
  emptyRefreshButton.disabled =
    (busy && !state.continuous) ||
    state.networkVerifying ||
    (state.tableMode === "devices" && state.networks.length > 0 && !hasSelection);
  if (selectAllButton) {
    selectAllButton.disabled = selectionLocked ||
      !state.networks.length ||
      selectedIds.length === state.networks.length;
  }
  var networkCheckboxes = document.querySelectorAll
    ? document.querySelectorAll("#networkList .network-checkbox")
    : [];
  for (var index = 0; index < networkCheckboxes.length; index += 1) {
    networkCheckboxes[index].disabled = selectionLocked;
  }
  var networkList = byId("networkList");
  if (networkList) {
    networkList.classList.toggle("is-locked", selectionLocked);
  }
  suffixInputs().forEach(function (field) {
    field.disabled = busy;
  });
  if (inputClearButton) {
    inputClearButton.hidden = !anySuffixValue();
  }
  var addButton = byId("addSuffixButton");
  if (addButton) {
    addButton.disabled = busy || rows.length >= MAX_SUFFIX_INPUTS;
  }
  var removeButtons = document.querySelectorAll("[data-remove-suffix]");
  for (var removeIndex = 0; removeIndex < removeButtons.length; removeIndex += 1) {
    removeButtons[removeIndex].disabled = busy;
  }
  setText(
    "suffixLimitHint",
    rows.length >= MAX_SUFFIX_INPUTS
      ? "已添加 " + MAX_SUFFIX_INPUTS + " 个，达到上限"
      : "最多同时搜索 " + MAX_SUFFIX_INPUTS + " 个"
  );
  copyButton.disabled = !state.selectedMac;
  copyIpButton.disabled = !state.selectedIp;
  exportButton.disabled = state.running || visibleRows.length === 0;
  clearButton.disabled = state.tableMode !== "results";
  setText(
    "scanButtonText",
    state.inventoryScanning
      ? "扫描设备中"
      : state.stopping
        ? "停止中"
        : state.running
          ? "持续扫描中"
          : state.continuous
            ? "持续搜索中"
            : "开始扫描"
  );
  setText(
    "emptyRefreshButton",
    state.continuous
      ? "停止持续搜索"
      : filteredEmpty
        ? "清除筛选"
        : state.tableMode === "results"
          ? "重新识别网段"
          : "刷新设备总表"
  );
}

function setScanState(kind, title, message) {
  var panel = byId("scanState");
  panel.className = "scan-state " + (
    kind === "running"
      ? "is-running"
      : kind === "success"
        ? "is-success"
        : kind === "error"
          ? "is-error"
          : "is-idle"
  );
  setText("scanStateTitle", title);
  setText("scanStateMessage", message);
}

function setProgress(percent, indeterminate, label) {
  var wrap = byId("scanProgress");
  var track = byId("progressTrack");
  var bar = byId("progressBar");
  if (!state.running && percent <= 0 && !indeterminate) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  track.classList.toggle("is-indeterminate", !!indeterminate);
  var safe = Math.max(0, Math.min(100, Number(percent) || 0));
  track.setAttribute("aria-valuenow", String(safe));
  bar.style.width = indeterminate ? "" : safe + "%";
  setText("progressValue", indeterminate ? "准备中" : safe + "%");
  setText("progressLabel", label || "正在扫描");
}

function resetSelection() {
  state.selectedMac = "";
  state.selectedIp = "";
  state.selectedKey = "";
  setText("selectionText", "未选择设备");
  byId("copyButton").disabled = true;
  byId("copyIpButton").disabled = true;
  var summary = document.querySelector(".selected-summary");
  if (summary) {
    summary.classList.remove("has-selection");
  }
}

function selectRow(row) {
  var rows = byId("resultsBody").querySelectorAll("tr");
  rows.forEach(function (item) {
    item.classList.toggle("is-selected", item === row);
    item.setAttribute("aria-selected", item === row ? "true" : "false");
  });
  state.selectedMac = row.getAttribute("data-mac") || "";
  state.selectedIp = row.getAttribute("data-ip") || "";
  state.selectedKey = row.getAttribute("data-key") || "";
  setText("selectionText", state.selectedMac ? "已选择 " + state.selectedMac : "未选择设备");
  var summary = document.querySelector(".selected-summary");
  if (summary) {
    summary.classList.toggle("has-selection", !!state.selectedMac);
  }
  byId("copyButton").disabled = !state.selectedMac;
  byId("copyIpButton").disabled = !state.selectedIp;
}

function stateClass(value) {
  var normalized = String(value || "").toLowerCase();
  if (normalized === "reachable") {
    return "is-reachable";
  }
  if (normalized === "stale" || normalized === "delay" || normalized === "probe") {
    return "is-stale";
  }
  if (normalized === "local") {
    return "is-local";
  }
  return "";
}

function rawTableRows() {
  return state.tableMode === "results" ? state.results : state.devices;
}

function normalizeTableQuery(value) {
  return String(value || "").trim().toLowerCase();
}

function tableQueryActive() {
  return !!normalizeTableQuery(state.tableQuery);
}

function tableRowSearchText(item) {
  var row = item || {};
  var stateValue = String(row.state || "");
  var localLabel = stateValue.toLowerCase() === "local" ? "本机 local" : "";
  return [
    row.interface,
    row.scan_range,
    row.ip,
    row.mac,
    stateValue,
    localLabel,
    (Array.isArray(row.matched_suffixes) ? row.matched_suffixes.join(" ") : ""),
    String(row.mac || "").replace(/[-:]/g, "")
  ].join(" ").toLowerCase();
}

function filterTableRows(items, query) {
  var safeItems = Array.isArray(items) ? items : [];
  var tokens = normalizeTableQuery(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    return safeItems.slice();
  }
  return safeItems.filter(function (item) {
    var text = tableRowSearchText(item);
    return tokens.every(function (token) {
      if (text.indexOf(token) >= 0) {
        return true;
      }
      var compact = token.replace(/[-:]/g, "");
      return compact !== token && text.indexOf(compact) >= 0;
    });
  });
}

function ipv4SortValue(value) {
  var parts = String(value || "").split(".");
  if (parts.length !== 4) {
    return null;
  }
  var total = 0;
  for (var index = 0; index < parts.length; index += 1) {
    if (!/^\d{1,3}$/.test(parts[index])) {
      return null;
    }
    var octet = Number(parts[index]);
    if (octet > 255) {
      return null;
    }
    total = total * 256 + octet;
  }
  return total;
}

function compareNaturalText(left, right) {
  var leftText = String(left === undefined || left === null ? "" : left)
    .toLowerCase();
  var rightText = String(right === undefined || right === null ? "" : right)
    .toLowerCase();
  if (leftText === rightText) {
    return 0;
  }
  var leftParts = leftText.match(/\d+|\D+/g) || [];
  var rightParts = rightText.match(/\d+|\D+/g) || [];
  var count = Math.max(leftParts.length, rightParts.length);
  for (var index = 0; index < count; index += 1) {
    var leftPart = leftParts[index] || "";
    var rightPart = rightParts[index] || "";
    if (leftPart === rightPart) {
      continue;
    }
    if (/^\d+$/.test(leftPart) && /^\d+$/.test(rightPart)) {
      var difference = Number(leftPart) - Number(rightPart);
      if (difference !== 0) {
        return difference < 0 ? -1 : 1;
      }
    }
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function compareScanRanges(left, right) {
  var leftParts = String(left || "").split("/");
  var rightParts = String(right || "").split("/");
  var leftAddress = ipv4SortValue(leftParts[0]);
  var rightAddress = ipv4SortValue(rightParts[0]);
  if (leftAddress !== null && rightAddress !== null) {
    if (leftAddress !== rightAddress) {
      return leftAddress < rightAddress ? -1 : 1;
    }
    var leftPrefix = Number(leftParts[1]);
    var rightPrefix = Number(rightParts[1]);
    if (!Number.isNaN(leftPrefix) && !Number.isNaN(rightPrefix)) {
      if (leftPrefix !== rightPrefix) {
        return leftPrefix < rightPrefix ? -1 : 1;
      }
    }
  } else if (leftAddress !== null) {
    return -1;
  } else if (rightAddress !== null) {
    return 1;
  }
  return compareNaturalText(left, right);
}

function compareTableItems(left, right, key) {
  var leftRow = left || {};
  var rightRow = right || {};
  if (key === "ip") {
    var leftIp = ipv4SortValue(leftRow.ip);
    var rightIp = ipv4SortValue(rightRow.ip);
    if (leftIp !== null && rightIp !== null) {
      if (leftIp !== rightIp) {
        return leftIp < rightIp ? -1 : 1;
      }
    } else if (leftIp !== null) {
      return -1;
    } else if (rightIp !== null) {
      return 1;
    }
    return compareNaturalText(leftRow.ip, rightRow.ip);
  }
  if (key === "scan_range") {
    return compareScanRanges(leftRow.scan_range, rightRow.scan_range);
  }
  if (key === "mac") {
    var leftMac = String(leftRow.mac || "").replace(/[-:]/g, "");
    var rightMac = String(rightRow.mac || "").replace(/[-:]/g, "");
    return compareNaturalText(leftMac, rightMac) ||
      compareNaturalText(leftRow.interface, rightRow.interface);
  }
  return compareNaturalText(leftRow[key], rightRow[key]);
}

function sortTableRows(items, key, direction) {
  var safeItems = Array.isArray(items) ? items.slice() : [];
  if (!key || !Object.prototype.hasOwnProperty.call(TABLE_SORT_KEYS, key)) {
    return safeItems;
  }
  var multiplier = direction === "descending" ? -1 : 1;
  return safeItems.map(function (item, index) {
    return { item: item, index: index };
  }).sort(function (left, right) {
    var compared = compareTableItems(left.item, right.item, key);
    if (compared === 0) {
      return left.index - right.index;
    }
    return compared * multiplier;
  }).map(function (entry) {
    return entry.item;
  });
}

function visibleTableRows() {
  return sortTableRows(
    filterTableRows(rawTableRows(), state.tableQuery),
    state.tableSortKey,
    state.tableSortDirection
  );
}

function updateTableFilterSummary(sourceCount, visibleCount) {
  if (!sourceCount) {
    setText("tableFilterSummary", "");
  } else if (tableQueryActive()) {
    setText(
      "tableFilterSummary",
      "筛选后 " + visibleCount + " / 共 " + sourceCount + " 台"
    );
  } else {
    setText("tableFilterSummary", "共 " + sourceCount + " 台设备");
  }
}

function updateTableFilterControls() {
  var input = byId("tableFilter");
  if (!input) {
    return;
  }
  if (input.value !== state.tableQuery) {
    input.value = state.tableQuery;
  }
  var clearButton = byId("tableFilterClear");
  if (clearButton) {
    clearButton.hidden = !input.value;
  }
}

function updateTableSortState() {
  var headers = document.querySelectorAll
    ? document.querySelectorAll(".results-table th[data-sort-key]")
    : [];
  for (var index = 0; index < headers.length; index += 1) {
    var header = headers[index];
    var active = header.getAttribute("data-sort-key") === state.tableSortKey;
    header.setAttribute(
      "aria-sort",
      active ? state.tableSortDirection : "none"
    );
    var button = header.querySelector(".sort-button");
    if (button && !button.getAttribute("aria-label")) {
      button.setAttribute("aria-label", "按" + button.textContent.trim() + "排序");
    }
  }
}

function setTableSort(key) {
  if (!Object.prototype.hasOwnProperty.call(TABLE_SORT_KEYS, key)) {
    return;
  }
  if (state.tableSortKey === key) {
    state.tableSortDirection = state.tableSortDirection === "ascending"
      ? "descending"
      : "ascending";
  } else {
    state.tableSortKey = key;
    state.tableSortDirection = "ascending";
  }
  paintTableRows(true);
}

function setTableQuery(value) {
  state.tableQuery = String(value || "");
  var input = byId("tableFilter");
  if (input && input.value !== state.tableQuery) {
    input.value = state.tableQuery;
  }
  paintTableRows(true);
}

function clearTableFilter(focusInput) {
  setTableQuery("");
  if (focusInput) {
    var input = byId("tableFilter");
    if (input) {
      input.focus();
    }
  }
}

function paintTableRows(preserveSelection) {
  var body = byId("resultsBody");
  var sourceRows = rawTableRows();
  var rows = visibleTableRows();
  var selectedKey = preserveSelection ? state.selectedKey : "";
  var table = document.querySelector(".results-table");
  if (table) {
    table.classList.toggle(
      "has-target-column",
      state.targets.length > 1 && state.tableMode === "results"
    );
  }
  while (body.firstChild) {
    body.removeChild(body.firstChild);
  }
  rows.forEach(function (result) {
    var row = document.createElement("tr");
    row.tabIndex = 0;
    row.setAttribute("role", "row");
    row.setAttribute("aria-selected", "false");
    row.setAttribute("data-mac", result.mac);
    row.setAttribute("data-ip", result.ip);
    row.setAttribute(
      "data-key",
      result.interface + "|" + result.ip + "|" + result.mac
    );

    var interfaceCell = document.createElement("td");
    interfaceCell.textContent = result.interface;
    var rangeCell = document.createElement("td");
    rangeCell.className = "mono-value";
    rangeCell.textContent = result.scan_range;
    var ipCell = document.createElement("td");
    ipCell.className = "mono-value";
    var ipUrl = deviceWebUrl(result.ip);
    if (ipUrl) {
      var ipLink = document.createElement("a");
      ipLink.className = "ip-link";
      ipLink.href = ipUrl;
      ipLink.target = "_blank";
      ipLink.rel = "noopener noreferrer";
      ipLink.textContent = result.ip;
      ipLink.title = "在新标签页打开 " + ipUrl;
      ipCell.appendChild(ipLink);
    } else {
      ipCell.textContent = result.ip;
    }
    var macCell = document.createElement("td");
    macCell.className = "mono-value";
    macCell.textContent = result.mac;
    var targetCell = document.createElement("td");
    targetCell.className = "target-column";
    var matchedSuffixes = Array.isArray(result.matched_suffixes)
      ? result.matched_suffixes
      : [];
    if (!matchedSuffixes.length && state.targets.length) {
      matchedSuffixes = state.targets.filter(function (target) {
        return resultMatchesTarget(result, target);
      }).map(function (target) {
        return target.normalized;
      });
    }
    matchedSuffixes.forEach(function (suffix) {
      var tag = document.createElement("span");
      tag.className = "target-tag";
      tag.textContent = displaySuffixFor(suffix);
      targetCell.appendChild(tag);
    });
    var stateCell = document.createElement("td");
    var chip = document.createElement("span");
    chip.className = "state-chip " + stateClass(result.state);
    chip.textContent = result.state === "LOCAL" ? "本机" : result.state;
    stateCell.appendChild(chip);

    row.appendChild(interfaceCell);
    row.appendChild(rangeCell);
    row.appendChild(ipCell);
    row.appendChild(macCell);
    row.appendChild(targetCell);
    row.appendChild(stateCell);
    row.addEventListener("click", function (event) {
      if (isIpLinkTarget(event.target)) {
        return;
      }
      selectRow(row);
    });
    row.addEventListener("dblclick", function (event) {
      if (isIpLinkTarget(event.target)) {
        return;
      }
      selectRow(row);
      copySelectedMac();
    });
    row.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" || isIpLinkTarget(event.target)) {
        return;
      }
      event.preventDefault();
      selectRow(row);
      copySelectedMac();
    });
    body.appendChild(row);
  });

  setText(
    "tableHeading",
    state.tableMode === "results" ? "匹配结果" : "设备总表"
  );
  setText("resultCount", rows.length);
  setHidden("tableToolbar", sourceRows.length === 0);
  setHidden("tableWrap", rows.length === 0);
  setHidden("emptyState", rows.length > 0);
  updateTableFilterSummary(sourceRows.length, rows.length);
  updateTableFilterControls();
  updateTableSortState();

  var restoredRow = null;
  if (selectedKey) {
    var rowNodes = body.querySelectorAll("tr");
    for (var index = 0; index < rowNodes.length; index += 1) {
      if (rowNodes[index].getAttribute("data-key") === selectedKey) {
        restoredRow = rowNodes[index];
        break;
      }
    }
  }
  if (restoredRow) {
    selectRow(restoredRow);
  } else {
    resetSelection();
  }
  if (!rows.length) {
    renderEmptyForStatus(state.running ? "running" : state.scanStatus);
  }
  renderTargetSummary();
  updateControls();
}

function renderTable(items, mode, force) {
  var safeItems = Array.isArray(items) ? items : [];
  var signature = mode + ":" + JSON.stringify(safeItems);
  if (!force && signature === state.tableSignature) {
    return;
  }
  var modeChanged = state.tableMode !== mode;
  state.tableSignature = signature;
  state.tableMode = mode;
  if (modeChanged) {
    state.tableQuery = "";
  }
  if (mode === "results") {
    state.results = safeItems;
    if (state.continuous && (safeItems.length || !state.running)) {
      persistCurrentFoundResults();
    }
  } else {
    state.devices = safeItems;
  }
  paintTableRows(false);
}

function renderResults(results, force) {
  renderTable(results, "results", force);
}

function renderDevices(devices, force) {
  renderTable(devices, "devices", force);
}

function renderEmptyForStatus(status) {
  var sourceRows = rawTableRows();
  if (tableQueryActive() && sourceRows.length) {
    setText("emptyTitle", "没有符合筛选条件的设备");
    setText(
      "emptyMessage",
      "请调整关键词，或清除筛选查看全部 " + sourceRows.length + " 台设备。"
    );
    return;
  }
  if (state.tableMode === "devices") {
    setText("emptyTitle", "暂无设备记录");
    setText("emptyMessage", "当前网段中没有探测到设备，刷新后再试。");
    return;
  }
  if (state.searchExhausted) {
    setText("emptyTitle", "轮询查找未找到");
    setText("emptyMessage", continuousExhaustedMessage());
    return;
  }
  if (state.continuous) {
    setText("emptyTitle", "当前没有搜索到");
    if (status === "running") {
      setText(
        "emptyMessage",
        "正在持续查找 " + pendingTargetLabel() +
          "，找到设备后会自动显示。"
      );
    } else if (status === "error" || status === "waiting") {
      setText(
        "emptyMessage",
        "当前服务暂不可用；恢复后会自动继续搜索，找到设备后会显示在这里。"
      );
    } else {
      setText(
        "emptyMessage",
        "本轮未发现 " + pendingTargetLabel() +
          "，将自动开始下一轮搜索。"
      );
    }
    return;
  }
  if (status === "running") {
    setText("emptyTitle", "正在扫描");
    setText("emptyMessage", "网段探测和邻居表读取正在后台进行。");
    return;
  }
  if (status === "stopped") {
    setText("emptyTitle", "扫描已停止");
    setText("emptyMessage", "已完成的探测结果保留在当前页面。");
    return;
  }
  if (status === "error") {
    setText("emptyTitle", "扫描未完成");
    setText("emptyMessage", "请检查网段、服务状态或稍后重试。");
    return;
  }
  if (status === "completed") {
    setText("emptyTitle", "未找到匹配设备");
    setText("emptyMessage", "当前网段中没有符合该 MAC 后缀的记录。");
    return;
  }
  setText("emptyTitle", "等待扫描");
  setText("emptyMessage", "匹配到的设备会显示在这里。");
}

function formatTime(value) {
  if (!value) {
    return "";
  }
  var parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function shouldPreserveContinuousResults(running, incomingResults, currentResults) {
  return state.continuous &&
    !!running &&
    incomingResults.length === 0 &&
    currentResults.length > 0;
}

function renderScanStatus(data, notifyTerminal) {
  var wasRunning = state.running;
  state.running = !!data.running;
  state.stopping = !!data.stopping;
  state.scanStatus = data.status || "idle";
  if (!state.targets.length) {
    var statusSuffixes = Array.isArray(data.suffixes) && data.suffixes.length
      ? data.suffixes
      : (data.suffix ? [data.suffix] : []);
    if (statusSuffixes.length) {
      state.targets = statusSuffixes.map(function (value) {
        var normalized = normalizeSuffix(value) ||
          String(value || "").toUpperCase();
        return {
          display: String(value || ""),
          normalized: normalized,
          rounds: 0,
          foundCount: 0,
          status: "searching"
        };
      });
      syncActiveSuffixState();
    }
  }
  state.totalHosts = Number(data.total_hosts) || 0;
  state.probedHosts = Number(data.probed_hosts) || 0;
  state.jobId = data.job_id || "";

  var incomingResults = Array.isArray(data.results) ? data.results : [];
  var displayResults = mergeResultItems(state.results, incomingResults);
  var roundOutcome = null;
  if (state.continuous && !state.running && state.scanStatus === "completed") {
    roundOutcome = registerContinuousRound(data.job_id, incomingResults);
    if (roundOutcome.counted && state.continuous) {
      persistSearchIntent(displayResults);
    }
    if (roundOutcome.allResolved) {
      state.continuous = false;
      state.searchFinished = true;
      state.searchExhausted = roundOutcome.exhausted;
      clearContinuousRestart();
      discardSearchIntent();
    }
  }
  if (data.job_id || state.tableMode === "results") {
    renderResults(displayResults, false);
  }
  syncTargetCounts(displayResults);
  renderTargetSummary();
  updateControls();

  var percent = Number(data.progress_percent) || 0;
  if (state.running) {
    if (state.scanStatus === "discovering") {
      setProgress(0, true, "读取物理网卡与默认网关");
      setText("resultSummary", "正在识别当前物理局域网。");
      setScanState(
        "running",
        state.continuous ? "持续搜索中" : "正在识别网段",
        state.continuous
          ? "正在刷新物理网段，完成后继续查找 " + activeTargetLabel() + "。"
          : "读取 IPv4 地址、默认网关和安全的扫描范围。"
      );
    } else {
      setProgress(percent, false, "正在探测主机并读取邻居表");
      setText(
        "resultSummary",
        (state.continuous
          ? "正在持续匹配 " + activeTargetLabel() +
            "（" + continuousRoundLabel() + "）"
          : "正在匹配 " + activeTargetLabel()) +
          "，已探测 " + state.probedHosts + " / " + state.totalHosts + " 台主机。"
      );
      setScanState(
        "running",
        (state.continuous ? "持续搜索中 · " : "正在扫描 ") +
          (data.current_interface || ""),
        (data.current_range || "准备扫描") +
          " · 已探测 " + state.probedHosts + " 台主机。"
      );
    }
  } else if (state.scanStatus === "completed") {
    setProgress(100, false, "扫描完成");
    setHidden("scanProgress", true);
    if (state.searchFinished) {
      setScanState(
        state.searchExhausted ? "idle" : "success",
        state.searchExhausted ? "轮询查找结束" : "查找完成",
        searchFinishedMessage()
      );
      setText("resultSummary", searchFinishedMessage());
    } else if (state.continuous && state.results.length) {
      setScanState(
        "success",
        "已找到匹配设备",
        activeTargetLabel() + " 找到 " + state.results.length +
          " 条记录，下一轮搜索即将开始。"
      );
      setText(
        "resultSummary",
        "持续搜索已找到 " + state.results.length +
          " 台设备，下一轮会自动刷新（" + continuousRoundLabel() + "）。"
      );
    } else if (state.continuous) {
      setScanState(
        "success",
        "当前没有搜索到",
        continuousRoundLabel() + "未发现 " + pendingTargetLabel() +
          "，将自动开始下一轮搜索。"
      );
      setText(
        "resultSummary",
        "当前没有搜索到 " + pendingTargetLabel() +
          "，持续搜索仍在进行（" + continuousRoundLabel() + "）。"
      );
    } else if (state.results.length) {
      setScanState(
        "success",
        "扫描完成",
        activeTargetLabel() + " 找到 " + state.results.length + " 条匹配记录。"
      );
      setText(
        "resultSummary",
        activeTargetLabel() + " 匹配到 " + state.results.length + " 台设备。"
      );
    } else {
      setScanState(
        "success",
        "扫描完成",
        "扫描了 " + state.totalHosts + " 台主机，未发现 " + activeTargetLabel() + "。"
      );
      setText(
        "resultSummary",
        "已扫描所选网段，未找到 " + activeTargetLabel() + "。"
      );
    }
  } else if (state.scanStatus === "stopped") {
    setHidden("scanProgress", true);
    if (state.continuous) {
      setScanState(
        "running",
        "持续搜索中",
        "上一轮任务已停止，将自动开始下一轮搜索。"
      );
      setText("resultSummary", "持续搜索正在自动恢复当前查询。");
    } else {
      setScanState(
        "idle",
        "扫描已停止",
        "已保留停止前找到的 " + state.results.length + " 条记录。"
      );
      setText("resultSummary", "扫描已停止，停止前的结果仍可选择和复制。");
    }
  } else if (state.scanStatus === "error") {
    setHidden("scanProgress", true);
    if (state.continuous) {
      setScanState(
        "running",
        "等待 NAS 恢复",
        "持续搜索已保留；服务恢复后会自动继续。"
      );
      setText("resultSummary", "持续搜索等待服务恢复，找到设备后会自动显示。");
    } else {
      setScanState("error", "扫描失败", data.error || "无法读取当前物理网段。");
      setText("resultSummary", data.error || "扫描未完成。");
    }
  } else {
    setHidden("scanProgress", true);
    if (state.continuous) {
      setScanState(
        "running",
        "等待继续搜索",
        "搜索任务已保留，将自动开始下一轮扫描。"
      );
      setText("resultSummary", "持续搜索正在准备下一轮扫描。");
    } else if (!state.networks.length) {
      setScanState("error", "没有可扫描网段", "请刷新物理网卡和默认网关。");
    } else if (!selectedNetworkIds().length) {
      setScanState(
        "idle",
        "请选择网段",
        "至少选择一个活动网段后即可开始扫描。"
      );
    } else {
      setScanState(
        "idle",
        "准备就绪",
        networkSelectionSummary() + "。"
      );
    }
    if (state.tableMode === "results" && !state.results.length) {
      setText("resultSummary", "输入 MAC 后四位开始定位设备。");
    }
  }

  renderEmptyForStatus(state.running ? "running" : state.scanStatus);
  var visibleRows = visibleTableRows();
  setText("resultCount", visibleRows.length);
  setHidden("tableWrap", visibleRows.length === 0);
  setHidden("emptyState", visibleRows.length > 0);

  if (data.started_at || data.finished_at) {
    setText(
      "lastScanTime",
      "扫描 " + formatTime(data.started_at || data.finished_at)
    );
  }
  if (state.totalHosts) {
    setText(
      "scanFooterMeta",
      state.running
        ? "已探测 " + state.probedHosts + " / " + state.totalHosts
        : "共探测 " + state.totalHosts + " 台主机"
    );
  } else if (state.tableMode === "results") {
    setText(
      "scanFooterMeta",
      state.continuous ? "持续搜索运行中" : "等待网络扫描"
    );
  }

  if (notifyTerminal && !state.continuous && wasRunning && !state.running && state.jobId) {
    if (state.scanStatus === "completed") {
      toast(
        state.searchFinished
          ? searchFinishedMessage()
          : state.results.length
            ? "扫描完成，找到 " + state.results.length + " 条匹配记录。"
            : "扫描完成，未找到匹配设备。",
        false
      );
    } else if (state.scanStatus === "stopped") {
      toast("扫描已停止。", false);
    } else if (state.scanStatus === "error") {
      toast(data.error || "扫描失败。", true);
    }
  }

  if (
    state.continuous &&
    !state.running &&
    !state.stopping
  ) {
    scheduleContinuousRestart(CONTINUOUS_RESTART_DELAY_MS);
  }
}

async function refreshNetworks(silent, refreshDeviceList) {
  if (state.running || state.inventoryScanning || state.networkVerifying) {
    return false;
  }
  var isSilent = !!silent;
  var shouldRefreshDevices = refreshDeviceList !== false;
  byId("refreshButton").disabled = true;
  setText(
    "networkSummary",
    isSilent ? "正在恢复活动网段" : "正在读取物理网卡"
  );
  try {
    var data = await apiRequest("networks", null);
    state.lastRequestErrorKind = "";
    resetServiceRetryDelay();
    state.networkVerifiedAt = Date.now();
    setNetworks(data);
    persistNetworkCache();
    if (shouldRefreshDevices && state.tableMode === "devices") {
      await refreshDevices(false);
    }
    if (state.scanStatus === "idle") {
      setScanState(
        "idle",
        "准备就绪",
        state.networks.length
          ? networkSelectionSummary() + "。"
          : "没有找到带默认网关的物理网卡。"
      );
    }
    return true;
  } catch (error) {
    state.lastRequestErrorKind = error.kind || "";
    state.networkVerifiedAt = 0;
    var message = describeError(error);
    state.warnings = state.networks.length
      ? Array.from(new Set(state.warnings.concat([message])))
      : [message];
    setText(
      "networkSummary",
      state.networks.length
        ? "网段刷新失败 · 使用上次结果"
        : "网段读取失败"
    );
    if (!state.networks.length) {
      renderNetworkList();
      if (!isSilent) {
        setScanState("error", "网段读取失败", message);
      }
    }
    renderWarnings();
    updateControls();
    if (!isSilent) {
      toast(message, true);
    }
    return false;
  } finally {
    byId("refreshButton").disabled =
      state.running || state.inventoryScanning || state.networkVerifying;
  }
}

async function verifyCachedNetworks() {
  if (state.networkVerifying) {
    return { ok: false, changed: false, added: [], removed: [] };
  }
  state.networkVerifying = true;
  updateControls();
  var beforeNetworks = state.networks.slice();
  var beforeSignature = networkSignature(beforeNetworks);
  var beforeKeys = {};
  beforeNetworks.forEach(function (network) {
    beforeKeys[networkKey(network)] = true;
  });
  try {
    var data = await apiRequest("networks", null);
    state.lastRequestErrorKind = "";
    resetServiceRetryDelay();
    state.networkVerifiedAt = Date.now();
    var freshNetworks = Array.isArray(data.networks)
      ? data.networks.filter(isUsableNetwork)
      : [];
    var freshKeys = {};
    freshNetworks.forEach(function (network) {
      freshKeys[networkKey(network)] = true;
    });
    var added = Object.keys(freshKeys).filter(function (key) {
      return !beforeKeys[key];
    });
    var removed = Object.keys(beforeKeys).filter(function (key) {
      return !freshKeys[key];
    });
    var changed = networkSignature(freshNetworks) !== beforeSignature;
    setNetworks({
      networks: freshNetworks,
      warnings: Array.isArray(data.warnings) ? data.warnings : []
    });
    persistNetworkCache();
    if (changed) {
      var parts = [];
      if (added.length) {
        parts.push("新增 " + added.length + " 个网段");
      }
      if (removed.length) {
        parts.push("移除 " + removed.length + " 个失效网段");
      }
      setText("networkSummary", "网段已更新 · " + networkSelectionSummary());
      if (parts.length) {
        toast(parts.join("，") + "。", false);
      }
    } else {
      setText("networkSummary", "网段未变化 · " + networkSelectionSummary());
    }
    if (state.scanStatus === "idle") {
      setScanState(
        "idle",
        "准备就绪",
        state.networks.length
          ? networkSelectionSummary() + "。"
          : "没有找到带默认网关的物理网卡。"
      );
    }
    return { ok: true, changed: changed, added: added, removed: removed };
  } catch (error) {
    state.lastRequestErrorKind = error.kind || "";
    state.networkVerifiedAt = 0;
    setText("networkSummary", "服务已连接 · 使用上次网段");
    if (state.tableMode === "devices" && !state.deviceCacheRestoredAt) {
      setText(
        "resultSummary",
        "网段校验失败，显示上次保存的网段；可手动刷新设备总表。"
      );
    }
    return { ok: false, changed: false, added: [], removed: [] };
  } finally {
    state.networkVerifying = false;
    updateControls();
  }
}

async function refreshDevices(showError) {
  if (state.inventoryScanning) {
    return false;
  }
  if (!state.networks.length) {
    setText("resultSummary", "当前没有可扫描的物理网段。");
    if (showError) {
      toast("当前没有可扫描的物理网段。", true);
    }
    return false;
  }
  var networkIds = selectedNetworkIds();
  if (!networkIds.length) {
    setText("resultSummary", "请至少选择一个活动网段后刷新设备总表。");
    if (showError) {
      toast("请至少选择一个活动网段。", true);
    }
    return false;
  }
  state.inventoryScanning = true;
  updateControls();
  setText("resultSummary", "正在主动探测当前网段内的设备。");
  try {
    var data = await apiRequest(
      "devices/scan",
      { network_ids: networkIds },
      { timeoutMs: INVENTORY_REQUEST_TIMEOUT_MS }
    );
    state.devices = Array.isArray(data.devices) ? data.devices : [];
    persistDeviceCache(networkIds);
    if (Array.isArray(data.warnings) && data.warnings.length) {
      state.warnings = Array.from(new Set(state.warnings.concat(data.warnings)));
      renderWarnings();
    }
    renderDevices(state.devices, true);
    setText(
      "resultSummary",
      state.devices.length
        ? "当前网段共探测到 " + state.devices.length + " 台设备。"
        : "当前网段中暂未探测到设备。"
    );
    setText("scanFooterMeta", "已探测设备 " + state.devices.length + " 台");
    renderEmptyForStatus("idle");
    return true;
  } catch (error) {
    state.warnings = Array.from(
      new Set(state.warnings.concat([describeError(error)]))
    );
    renderWarnings();
    setText("resultSummary", "设备总表探测失败，请检查网络或服务状态。");
    if (showError) {
      toast(describeError(error), true);
    }
    return false;
  } finally {
    state.inventoryScanning = false;
    updateControls();
  }
}

function clearResultsForNewScan() {
  renderResults([], true);
  setText("resultSummary", "正在启动扫描。");
}

function scheduleContinuousRestart(delay) {
  clearContinuousRestart();
  if (!state.continuous || state.running || state.stopping) {
    return;
  }
  continuousRestartTimer = window.setTimeout(
    resumeContinuousSearch,
    delay || CONTINUOUS_RESTART_DELAY_MS
  );
}

function showContinuousWaiting(title, message, error) {
  state.running = false;
  state.stopping = false;
  state.scanStatus = "waiting";
  setHidden("scanProgress", true);
  updateControls();
  setScanState("running", title, message);
  setText("resultSummary", message);
  renderTargetSummary();
  if (error) {
    setBackendState("offline", "等待服务恢复");
  }
  renderEmptyForStatus("waiting");
  var visibleRows = visibleTableRows();
  setText("resultCount", visibleRows.length);
  setHidden("tableWrap", visibleRows.length === 0);
  setHidden("emptyState", visibleRows.length > 0);
}

async function resumeContinuousSearch() {
  continuousRestartTimer = null;
  if (!state.continuous || state.running || state.stopping) {
    return;
  }
  var generation = state.searchGeneration;
  setScanState(
    "running",
    "持续搜索中",
    "正在确认活动网段并准备下一轮搜索。"
  );
  var networkCheckFresh =
    state.networkVerifiedAt > 0 &&
    Date.now() - state.networkVerifiedAt <= NETWORK_FRESHNESS_MS;
  var networksReady = true;
  if (!state.networkVerifying && !networkCheckFresh) {
    networksReady = await refreshNetworks(true, false);
  }
  if (
    generation !== state.searchGeneration ||
    !state.continuous ||
    state.stopping
  ) {
    return;
  }
  if (!networksReady) {
    if (state.lastRequestErrorKind === "session") {
      setBackendState("warning", "需要重新登录");
      showContinuousWaiting(
        "需要重新登录",
        "持续搜索已保留。重新打开应用并恢复 TOS 会话后会自动继续。"
      );
      return;
    }
    showContinuousWaiting(
      "等待 NAS 恢复",
      "持续搜索已保留；服务恢复后会自动继续查找 " + activeTargetLabel() + "。",
      true
    );
    scheduleContinuousRestart(nextServiceRetryDelay());
    return;
  }
  if (!state.networks.length) {
    showContinuousWaiting(
      "等待可用网段",
      "当前没有可扫描的物理网段，将持续检查并在网段恢复后继续搜索。"
    );
    scheduleContinuousRestart(nextServiceRetryDelay());
    return;
  }
  if (!selectedNetworkIds().length) {
    showContinuousWaiting(
      "等待选择网段",
      "持续搜索已保留；请至少勾选一个活动网段，选择后会自动继续。"
    );
    return;
  }
  setBackendState("online", "服务在线");
  await startScan({ continuousCycle: true });
}

function scheduleScanPoll(delay, generation) {
  if (pollTimer) {
    window.clearTimeout(pollTimer);
  }
  var expectedGeneration = typeof generation === "number"
    ? generation
    : state.searchGeneration;
  pollTimer = window.setTimeout(function () {
    pollScanStatus(expectedGeneration);
  }, delay || 450);
}

async function pollScanStatus(generation) {
  pollTimer = null;
  var expectedGeneration = typeof generation === "number"
    ? generation
    : state.searchGeneration;
  try {
    var data = await apiRequest("scan/status", null);
    if (expectedGeneration !== state.searchGeneration) {
      return;
    }
    state.lastRequestErrorKind = "";
    renderScanStatus(data, true);
    if (data.running) {
      scheduleScanPoll(450, expectedGeneration);
    }
  } catch (error) {
    if (expectedGeneration !== state.searchGeneration) {
      return;
    }
    state.lastRequestErrorKind = error.kind || "";
    if (state.continuous) {
      if (error.kind === "session") {
        setBackendState("warning", "需要重新登录");
        showContinuousWaiting(
          "需要重新登录",
          "持续搜索已保留。重新打开应用并恢复 TOS 会话后会自动继续。"
        );
        return;
      }
      showContinuousWaiting(
        "等待 NAS 恢复",
        "与 NAS 的连接暂时中断；服务恢复后会自动继续搜索，已有结果会保留。",
        error
      );
      scheduleContinuousRestart(nextServiceRetryDelay());
    } else {
      state.running = false;
      state.stopping = false;
      updateControls();
      setScanState("error", "状态读取失败", describeError(error));
      toast(describeError(error), true);
    }
  }
}

async function startScan(options) {
  var startOptions = options || {};
  if (state.running || state.inventoryScanning) {
    return;
  }
  if (!startOptions.continuousCycle) {
    state.searchGeneration += 1;
    resetServiceRetryDelay();
    resetContinuousRoundTracking();
  }
  var generation = state.searchGeneration;
  var entries = collectSuffixEntries(true);
  if (!entries) {
    var firstInput = byId("macSuffix");
    if (firstInput && document.activeElement !== firstInput) {
      firstInput.focus();
    }
    return;
  }
  var normalizedSuffixes = entries.map(function (entry) {
    return entry.normalized;
  });
  if (
    !startOptions.continuousCycle ||
    !state.targets.length ||
    !sameSuffixSet(normalizedSuffixes, state.normalizedSuffixes)
  ) {
    state.targets = buildTargets(entries);
  } else {
    state.targets.forEach(function (target, index) {
      if (entries[index]) {
        target.display = entries[index].display;
      }
    });
  }
  syncActiveSuffixState();
  var networkIds = selectedNetworkIds();
  if (!state.networks.length) {
    state.continuous = true;
    state.searchFinished = false;
    state.scanStatus = "waiting";
    persistSearchIntent(state.results);
    renderTargetSummary();
    updateControls();
    showContinuousWaiting(
      "等待可用网段",
      "当前没有可扫描的物理网段，将持续检查并在网段恢复后继续查找 " +
        activeTargetLabel() + "。"
    );
    scheduleContinuousRestart(nextServiceRetryDelay());
    return;
  }
  if (!networkIds.length) {
    state.continuous = false;
    state.running = false;
    state.searchFinished = false;
    state.scanStatus = "idle";
    discardSearchIntent();
    renderTargetSummary();
    setScanState(
      "error",
      "未选择网段",
      "请至少勾选一个活动网段后再开始扫描。"
    );
    setText("resultSummary", "尚未选择扫描范围。");
    updateControls();
    toast("请至少选择一个活动网段。", true);
    return;
  }

  state.continuous = true;
  state.running = true;
  state.stopping = false;
  state.searchFinished = false;
  state.scanStatus = "discovering";
  clearContinuousRestart();
  if (!startOptions.continuousCycle) {
    clearResultsForNewScan();
    setProgress(0, true, "正在启动扫描");
    setScanState("running", "正在启动扫描", "准备读取当前物理网段。");
  } else {
    setProgress(0, true, "正在继续持续搜索");
    setScanState(
      "running",
      "持续搜索中",
      "准备重新读取网段并查找 " + activeTargetLabel() + "。"
    );
  }
  persistSearchIntent(state.results);
  renderTargetSummary();
  updateControls();

  try {
    await apiRequest("scan/start", {
      suffixes: normalizedSuffixes,
      network_ids: networkIds
    });
    if (generation !== state.searchGeneration) {
      return;
    }
    state.lastRequestErrorKind = "";
    resetServiceRetryDelay();
    setBackendState("online", "服务在线");
    scheduleScanPoll(350, generation);
  } catch (error) {
    if (generation !== state.searchGeneration) {
      return;
    }
    state.lastRequestErrorKind = error.kind || "";
    state.running = false;
    updateControls();
    setHidden("scanProgress", true);
    if (error.kind === "rejected" && error.status === 409) {
      apiRequest("scan/stop", {}).catch(function () {
        return;
      });
      showContinuousWaiting(
        "切换持续搜索",
        "正在停止其他扫描任务，随后会继续搜索 " + activeTargetLabel() + "。"
      );
      scheduleContinuousRestart(CONTINUOUS_RESTART_DELAY_MS);
    } else if (error.kind === "rejected") {
      state.continuous = false;
      state.targets = [];
      syncActiveSuffixState();
      discardSearchIntent();
      renderTargetSummary();
      showInputError(error.detail || "MAC 后缀格式不正确。");
      updateControls();
      toast(error.detail || "MAC 后缀格式不正确。", true);
    } else if (error.kind === "session") {
      setBackendState("warning", "需要重新登录");
      showContinuousWaiting(
        "需要重新登录",
        "持续搜索已保留。重新打开应用并恢复 TOS 会话后会自动继续。"
      );
    } else {
      showContinuousWaiting(
        "等待 NAS 恢复",
        "扫描启动时连接中断；服务恢复后会自动继续搜索，已有结果会保留。",
        error
      );
      scheduleContinuousRestart(nextServiceRetryDelay());
    }
  }
}

async function stopScan() {
  if ((!state.running && !state.continuous) || state.stopping) {
    return;
  }
  state.searchGeneration += 1;
  var generation = state.searchGeneration;
  state.roundInterrupted = state.running;
  state.continuous = false;
  state.searchFinished = false;
  discardSearchIntent();
  if (!state.running) {
    state.stopping = false;
    state.scanStatus = "stopped";
    setHidden("scanProgress", true);
    setScanState(
      "idle",
      "持续搜索已停止",
      "已保留停止前找到的 " + state.results.length + " 条记录。"
    );
    setText("resultSummary", "持续搜索已停止，已有结果仍可选择和复制。");
    renderEmptyForStatus("stopped");
    renderTargetSummary();
    updateControls();
    toast("持续搜索已停止。", false);
    return;
  }
  state.stopping = true;
  renderTargetSummary();
  updateControls();
  setScanState("running", "正在停止扫描", "等待当前批次探测结束。");
  try {
    await apiRequest("scan/stop", {});
    scheduleScanPoll(250, generation);
  } catch (error) {
    state.running = false;
    state.stopping = false;
    state.scanStatus = "stopped";
    setHidden("scanProgress", true);
    setScanState("idle", "扫描已停止", "无法确认后端状态，但不会自动重新开始搜索。");
    setText("resultSummary", "搜索已停止，已有结果仍可选择和复制。");
    renderEmptyForStatus("stopped");
    renderTargetSummary();
    updateControls();
    toast(describeError(error), true);
  }
}

async function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  var area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "readonly");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  var succeeded = document.execCommand("copy");
  document.body.removeChild(area);
  if (!succeeded) {
    throw new Error("clipboard copy was rejected");
  }
}

async function copySelectedMac() {
  if (!state.selectedMac) {
    toast("请先选择一条匹配结果。", true);
    return;
  }
  try {
    await writeClipboard(state.selectedMac);
    toast("已复制 " + state.selectedMac, false);
  } catch (error) {
    toast("复制失败，请重试。", true);
  }
}

async function copySelectedIp() {
  if (!state.selectedIp) {
    toast("请先选择一条匹配结果。", true);
    return;
  }
  try {
    await writeClipboard(state.selectedIp);
    toast("已复制 " + state.selectedIp, false);
  } catch (error) {
    toast("复制失败，请重试。", true);
  }
}

function exportVisibleCsv() {
  var csv = window.LanMacCsv;
  var rows = visibleTableRows();
  if (!csv || !rows.length) {
    toast("当前没有可导出的设备记录。", true);
    return;
  }
  var content = csv.buildCsv(rows);
  var blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var link = document.createElement("a");
  link.href = url;
  link.download = "LanMacFinder-" + csv.dateStamp(new Date()) + ".csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  toast("已导出 " + rows.length + " 条记录", false);
}

async function clearResults() {
  var wasRunning = state.running;
  state.searchGeneration += 1;
  state.continuous = false;
  resetContinuousRoundTracking();
  discardSearchIntent();
  state.running = false;
  state.stopping = false;
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (wasRunning) {
    apiRequest("scan/stop", {}).catch(function () {
      return;
    });
  }
  state.scanStatus = "idle";
  state.targets = [];
  state.searchFinished = false;
  syncActiveSuffixState();
  setSuffixInputs([""]);
  renderTargetSummary();
  state.results = [];
  renderDevices(state.devices, true);
  setText(
    "resultSummary",
    state.devices.length
      ? "当前网段共探测到 " + state.devices.length + " 台设备。"
      : "当前网段中暂未探测到设备。"
  );
  setText("scanFooterMeta", "已探测设备 " + state.devices.length + " 台");
  setScanState(
    "idle",
    "准备就绪",
    state.networks.length + " 个物理网段可用于扫描。"
  );
  updateControls();
  await refreshNetworks();
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  var toggle = byId("themeToggle");
  var isDark = theme === "dark";
  toggle.setAttribute("aria-pressed", isDark ? "true" : "false");
  toggle.setAttribute("aria-label", isDark ? "切换为浅色主题" : "切换为深色主题");
  toggle.setAttribute(
    "data-tooltip",
    isDark ? "切换为浅色主题" : "切换为深色主题"
  );
}

function toggleTheme() {
  var current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
  hideTooltip();
}

function showTooltip(target) {
  var text = target && target.getAttribute("data-tooltip");
  if (!text || target.disabled) {
    return;
  }
  activeTooltipTarget = target;
  var tooltip = byId("glassTooltip");
  setText("glassTooltipText", text);
  tooltip.hidden = false;
  positionTooltip(target);
}

function positionTooltip(target) {
  var tooltip = byId("glassTooltip");
  var rect = target.getBoundingClientRect();
  var tooltipRect = tooltip.getBoundingClientRect();
  var center = rect.left + rect.width / 2;
  var half = tooltipRect.width / 2;
  center = Math.max(half + 8, Math.min(window.innerWidth - half - 8, center));
  var top = rect.top - tooltipRect.height - 9;
  var placement = "top";
  if (top < 8) {
    top = rect.bottom + 9;
    placement = "bottom";
  }
  tooltip.setAttribute("data-placement", placement);
  tooltip.style.left = center + "px";
  tooltip.style.top = top + "px";
}

function hideTooltip() {
  activeTooltipTarget = null;
  setHidden("glassTooltip", true);
}

function bindTooltips() {
  var targets = document.querySelectorAll("[data-tooltip]");
  targets.forEach(function (target) {
    target.addEventListener("mouseenter", function () {
      showTooltip(target);
    });
    target.addEventListener("mouseleave", hideTooltip);
    target.addEventListener("focus", function () {
      showTooltip(target);
    });
    target.addEventListener("blur", hideTooltip);
  });
  document.addEventListener("scroll", hideTooltip, true);
  window.addEventListener("resize", hideTooltip);
}

function sidebarWidthBounds() {
  var shell = byId("sidebarResizer").parentElement;
  var splitterWidth = byId("sidebarResizer").offsetWidth || 10;
  var maximum = Math.min(
    MAX_SIDEBAR_WIDTH,
    shell.clientWidth - splitterWidth - MIN_WORKSPACE_WIDTH
  );
  maximum = Math.max(MIN_SIDEBAR_WIDTH, maximum);
  return { min: MIN_SIDEBAR_WIDTH, max: maximum };
}

function applySidebarWidth(value, persist) {
  var handle = byId("sidebarResizer");
  var bounds = sidebarWidthBounds();
  var width = Math.round(
    Math.max(bounds.min, Math.min(bounds.max, Number(value) || bounds.min))
  );
  document.documentElement.style.setProperty("--sidebar-width", width + "px");
  handle.setAttribute("aria-valuemin", String(bounds.min));
  handle.setAttribute("aria-valuemax", String(bounds.max));
  handle.setAttribute("aria-valuenow", String(width));
  if (persist) {
    writeStoredJson(SIDEBAR_WIDTH_KEY, width);
  }
  return width;
}

function scanPaneHeightBounds() {
  var sidebar = document.querySelector(".sidebar");
  var footer = document.querySelector(".sidebar-footer");
  var splitter = byId("networkResizer");
  var available = sidebar.clientHeight -
    footer.offsetHeight -
    splitter.offsetHeight;
  var maximum = Math.max(
    MIN_SCAN_PANE_HEIGHT,
    Math.min(560, available - MIN_NETWORK_PANE_HEIGHT)
  );
  return { min: MIN_SCAN_PANE_HEIGHT, max: maximum };
}

function applyScanPaneHeight(value, persist) {
  var handle = byId("networkResizer");
  var bounds = scanPaneHeightBounds();
  var height = Math.round(
    Math.max(bounds.min, Math.min(bounds.max, Number(value) || bounds.min))
  );
  document.documentElement.style.setProperty("--scan-pane-height", height + "px");
  handle.setAttribute("aria-valuemin", String(bounds.min));
  handle.setAttribute("aria-valuemax", String(bounds.max));
  handle.setAttribute("aria-valuenow", String(height));
  if (persist) {
    writeStoredJson(SCAN_PANE_HEIGHT_KEY, height);
  }
  return height;
}

function bindPanelResizer(handle, orientation) {
  var dragState = null;
  var isColumn = orientation === "vertical";

  function pointerPosition(event) {
    return isColumn ? event.clientX : event.clientY;
  }

  function currentSize() {
    return isColumn
      ? document.querySelector(".sidebar").getBoundingClientRect().width
      : document.querySelector(".scan-control").getBoundingClientRect().height;
  }

  function applySize(value, persist) {
    if (isColumn) {
      return applySidebarWidth(value, persist);
    }
    return applyScanPaneHeight(value, persist);
  }

  handle.addEventListener("pointerdown", function (event) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragState = {
      pointerId: event.pointerId,
      startPosition: pointerPosition(event),
      startSize: currentSize()
    };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-active");
    document.body.classList.add(
      isColumn ? "is-resizing-column" : "is-resizing-row"
    );
    hideTooltip();
  });

  handle.addEventListener("pointermove", function (event) {
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }
    applySize(
      dragState.startSize + pointerPosition(event) - dragState.startPosition,
      false
    );
  });

  function finishDrag(event, cancelled) {
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }
    var finalSize = cancelled
      ? currentSize()
      : dragState.startSize +
        pointerPosition(event) -
        dragState.startPosition;
    applySize(finalSize, true);
    dragState = null;
    handle.classList.remove("is-active");
    document.body.classList.remove("is-resizing-column", "is-resizing-row");
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  }

  handle.addEventListener("pointerup", finishDrag);
  handle.addEventListener("pointercancel", function (event) {
    finishDrag(event, true);
  });
  handle.addEventListener("dblclick", function () {
    applySize(
      isColumn ? DEFAULT_SIDEBAR_WIDTH : DEFAULT_SCAN_PANE_HEIGHT,
      true
    );
  });
  handle.addEventListener("keydown", function (event) {
    var size = currentSize();
    var bounds = isColumn ? sidebarWidthBounds() : scanPaneHeightBounds();
    var step = event.shiftKey ? 32 : 12;
    var next = size;
    if (
      (isColumn && event.key === "ArrowLeft") ||
      (!isColumn && event.key === "ArrowUp")
    ) {
      next = size - step;
    } else if (
      (isColumn && event.key === "ArrowRight") ||
      (!isColumn && event.key === "ArrowDown")
    ) {
      next = size + step;
    } else if (event.key === "Home") {
      next = bounds.min;
    } else if (event.key === "End") {
      next = bounds.max;
    } else {
      return;
    }
    event.preventDefault();
    applySize(next, true);
  });
}

function initializePanelLayout() {
  var storedSidebarWidth = readStoredJson(SIDEBAR_WIDTH_KEY);
  var storedScanPaneHeight = readStoredJson(SCAN_PANE_HEIGHT_KEY);
  bindPanelResizer(byId("sidebarResizer"), "vertical");
  bindPanelResizer(byId("networkResizer"), "horizontal");
  applySidebarWidth(storedSidebarWidth || DEFAULT_SIDEBAR_WIDTH, false);
  applyScanPaneHeight(storedScanPaneHeight || DEFAULT_SCAN_PANE_HEIGHT, false);
  window.addEventListener("resize", function () {
    var sidebarHandle = byId("sidebarResizer");
    var scanHandle = byId("networkResizer");
    applySidebarWidth(Number(sidebarHandle.getAttribute("aria-valuenow")), false);
    applyScanPaneHeight(Number(scanHandle.getAttribute("aria-valuenow")), false);
  });
}

async function checkBackend(quiet) {
  setBackendState("checking", "正在连接服务");
  try {
    var data = await refreshApiRoot();
    setBackendState("online", "服务在线");
    setText(
      "backendVersion",
      "服务 v" + (data.version || "--") + " · Python " + (data.python || "--")
    );
    return true;
  } catch (error) {
    setBackendState("offline", "服务不可用");
    setText("backendVersion", "服务未连接");
    if (!quiet) {
      toast(describeError(error), true);
    }
    return false;
  }
}

function bindEvents() {
  var input = byId("macSuffix");
  var suffixList = byId("suffixInputList");

  if (suffixList) {
    suffixList.addEventListener("focusin", function (event) {
      var row = rowForInput(event.target);
      if (!row) {
        return;
      }
      var shell = row.querySelector(".input-shell");
      if (shell) {
        shell.classList.add("is-focused");
      }
      updateControls();
    });
    suffixList.addEventListener("focusout", function (event) {
      var row = rowForInput(event.target);
      if (!row) {
        return;
      }
      var shell = row.querySelector(".input-shell");
      if (shell) {
        shell.classList.remove("is-focused");
      }
      if (event.target.value.trim()) {
        collectSuffixEntries(true);
      }
      updateControls();
    });
    suffixList.addEventListener("input", function (event) {
      var field = event.target;
      var row = rowForInput(field);
      if (!row) {
        return;
      }
      var result = classifySuffixInput(field.value);
      if (
        result.status === "too-long" ||
        result.status === "invalid-character" ||
        result.status === "invalid-format"
      ) {
        showInputError(inputErrorMessage(result.status), row);
      } else {
        setRowInvalid(row, false);
        var stillInvalid = suffixRows().some(function (rowNode) {
          var shell = rowNode.querySelector(".input-shell");
          return !!shell && shell.classList.contains("is-invalid");
        });
        if (!stillInvalid) {
          clearInputError();
        }
      }
      if (
        !anySuffixValue() &&
        state.tableMode === "results" &&
        !state.running &&
        !state.continuous
      ) {
        clearResults();
      }
      updateControls();
    });
    suffixList.addEventListener("click", function (event) {
      var removeButton = event.target && event.target.closest
        ? event.target.closest("[data-remove-suffix]")
        : null;
      if (removeButton) {
        removeSuffixRow(removeButton.closest("[data-suffix-row]"));
      }
    });
  }

  var addSuffixButton = byId("addSuffixButton");
  if (addSuffixButton) {
    addSuffixButton.addEventListener("click", function () {
      if (!addSuffixRow("", true)) {
        toast("最多同时搜索 " + MAX_SUFFIX_INPUTS + " 个 MAC。", true);
      }
    });
  }

  var tableFilter = byId("tableFilter");
  if (tableFilter) {
    tableFilter.addEventListener("input", function () {
      setTableQuery(tableFilter.value);
    });
    tableFilter.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") {
        return;
      }
      event.stopPropagation();
      if (tableQueryActive()) {
        clearTableFilter(false);
      } else {
        tableFilter.blur();
      }
    });
  }
  var tableFilterClear = byId("tableFilterClear");
  if (tableFilterClear) {
    tableFilterClear.addEventListener("click", function () {
      clearTableFilter(true);
    });
  }
  var sortButtons = document.querySelectorAll(".sort-button");
  sortButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      setTableSort(button.getAttribute("data-sort-key"));
    });
  });

  byId("scanForm").addEventListener("submit", function (event) {
    event.preventDefault();
    startScan();
  });
  byId("stopButton").addEventListener("click", stopScan);
  byId("refreshButton").addEventListener("click", function () {
    refreshNetworks();
  });
  byId("selectAllNetworksButton").addEventListener("click", selectAllNetworks);
  byId("emptyRefreshButton").addEventListener("click", function () {
    if (state.continuous) {
      stopScan();
    } else if (tableQueryActive() && rawTableRows().length) {
      clearTableFilter(true);
    } else {
      refreshNetworks();
    }
  });
  byId("copyButton").addEventListener("click", copySelectedMac);
  byId("copyIpButton").addEventListener("click", copySelectedIp);
  byId("exportButton").addEventListener("click", exportVisibleCsv);
  byId("clearButton").addEventListener("click", clearResults);
  byId("inputClearButton").addEventListener("click", function () {
    clearResults().then(function () {
      input.focus();
    });
  });
  byId("themeToggle").addEventListener("click", toggleTheme);

  document.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "e") {
      event.preventDefault();
      exportVisibleCsv();
      return;
    }
    if (event.key === "Escape") {
      hideTooltip();
      var currentFilter = byId("tableFilter");
      if (currentFilter && document.activeElement === currentFilter) {
        event.preventDefault();
        if (tableQueryActive()) {
          clearTableFilter(false);
        } else {
          currentFilter.blur();
        }
        return;
      }
      if (state.running || state.continuous) {
        event.preventDefault();
        stopScan();
      }
    }
  });
  document.addEventListener("visibilitychange", function () {
    if (
      document.visibilityState === "visible" &&
      state.continuous &&
      !state.running &&
      !state.stopping &&
      !continuousRestartTimer
    ) {
      scheduleContinuousRestart(250);
    }
  });
  window.addEventListener("online", function () {
    if (state.continuous && !state.running && !state.stopping) {
      scheduleContinuousRestart(250);
    }
  });
}

async function boot() {
  applyTheme(document.documentElement.getAttribute("data-theme") || "light");
  initializePanelLayout();
  bindEvents();
  bindTooltips();
  var restored = restoreSearchIntent();
  var cachedNetworks = restoreNetworkCache();
  restoreNetworkSelection();
  var cachedDevices = false;
  if (cachedNetworks) {
    cachedDevices = restoreDeviceCache();
    updateNetworkSummary();
    renderNetworkList();
    setText(
      "networkSummary",
      "已恢复上次网段" +
        (state.networkCacheRestoredAt
          ? "（" + formatTime(state.networkCacheRestoredAt) + "）"
          : "")
    );
    if (!restored && !cachedDevices) {
      setText("resultSummary", "已恢复上次网段，正在后台快速校验。");
    }
  }
  updateControls();
  if (cachedNetworks) {
    if (!restored) {
      setScanState(
        "idle",
        "准备就绪",
        state.networks.length
          ? networkSelectionSummary() + "。"
          : "没有找到带默认网关的物理网卡。"
      );
    }
    renderWarnings();
  }
  var online = await checkBackend(restored);
  if (online) {
    if (cachedNetworks) {
      var verification = await verifyCachedNetworks();
      if (
        state.tableMode === "devices" &&
        (!cachedDevices || (verification.ok && verification.changed))
      ) {
        await refreshDevices(false);
      }
    } else {
      await refreshNetworks(restored, true);
    }
    try {
      var status = await apiRequest("scan/status", null);
      var statusSuffixes = Array.isArray(status.suffixes) && status.suffixes.length
        ? status.suffixes
        : (status.suffix ? [status.suffix] : []);
      if (
        state.continuous &&
        status.running &&
        statusSuffixes.length &&
        !sameSuffixSet(statusSuffixes, state.normalizedSuffixes)
      ) {
        await apiRequest("scan/stop", {});
        showContinuousWaiting(
          "切换持续搜索",
          "正在停止旧任务，随后会继续搜索 " + activeTargetLabel() + "。"
        );
        scheduleContinuousRestart(CONTINUOUS_RESTART_DELAY_MS);
        return;
      }
      renderScanStatus(status, false);
      if (status.running) {
        scheduleScanPoll(350, state.searchGeneration);
      } else if (state.continuous) {
        scheduleContinuousRestart(CONTINUOUS_RESTART_DELAY_MS);
      }
    } catch (error) {
      state.lastRequestErrorKind = error.kind || "";
      if (state.continuous) {
        if (error.kind === "session") {
          showContinuousWaiting(
            "需要重新登录",
            "持续搜索已保留。重新打开应用并恢复 TOS 会话后会自动继续。"
          );
        } else {
          showContinuousWaiting(
            "等待 NAS 恢复",
            "服务恢复后会自动继续搜索，已有结果会保留。",
            error
          );
          scheduleContinuousRestart(nextServiceRetryDelay());
        }
      } else {
        setScanState("error", "状态读取失败", describeError(error));
      }
    }
  } else {
    if (!cachedNetworks) {
      state.networks = [];
      state.warnings = [describeError(new Error("backend unavailable"))];
      setText("networkSummary", "服务未连接");
      renderNetworkList();
      renderWarnings();
      updateControls();
    } else {
      setText("networkSummary", "服务未连接 · 使用上次网段");
      if (state.tableMode === "devices" && !cachedDevices) {
        setText("resultSummary", "服务未连接，当前显示上次保存的网段。");
      }
    }
    if (state.continuous) {
      showContinuousWaiting(
        "等待 NAS 恢复",
        "持续搜索已保留；服务恢复后会自动继续查找 " + activeTargetLabel() + "。",
        true
      );
      scheduleContinuousRestart(nextServiceRetryDelay());
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
