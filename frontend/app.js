"use strict";

var APP_ID = "lan-mac-finder";
var MAC_SUFFIX_PATTERN = /^(?:[0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}|[0-9A-Fa-f]{4})$/;
var SEARCH_INTENT_KEY = "lanMacFinder.searchIntent.v1";
var NETWORK_SELECTION_KEY = "lanMacFinder.networkSelection.v1";
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
  scanStatus: "idle",
  continuous: false,
  noMatchRounds: 0,
  lastCountedJobId: "",
  searchExhausted: false,
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

function persistSearchIntent(displaySuffix, normalizedSuffix, results) {
  writeStoredJson(SEARCH_INTENT_KEY, {
    displaySuffix: displaySuffix,
    normalizedSuffix: normalizedSuffix,
    continuous: true,
    noMatchRounds: state.noMatchRounds,
    lastCountedJobId: state.lastCountedJobId,
    lastResults: Array.isArray(results) ? results.slice(0, 50) : []
  });
}

function persistCurrentFoundResults() {
  if (!state.continuous) {
    return;
  }
  persistSearchIntent(
    state.activeSuffix,
    state.normalizedSuffix,
    state.results
  );
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
  var displaySuffix = String(intent.displaySuffix || "").trim();
  var normalizedSuffix = normalizeSuffix(displaySuffix);
  if (!normalizedSuffix) {
    removeStoredValue(SEARCH_INTENT_KEY);
    return false;
  }
  byId("macSuffix").value = displaySuffix;
  var storedRounds = Math.max(
    0,
    Math.floor(Number(intent.noMatchRounds) || 0)
  );
  if (storedRounds >= MAX_NO_MATCH_ROUNDS) {
    removeStoredValue(SEARCH_INTENT_KEY);
    return false;
  }
  state.continuous = true;
  state.searchExhausted = false;
  state.noMatchRounds = storedRounds;
  state.lastCountedJobId = typeof intent.lastCountedJobId === "string"
    ? intent.lastCountedJobId
    : "";
  state.activeSuffix = displaySuffix;
  state.normalizedSuffix = normalizedSuffix;
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
    "服务恢复后将自动继续查找 MAC 后缀 " + displaySuffix + "。"
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

function continuousRoundLabel() {
  var current = Math.min(MAX_NO_MATCH_ROUNDS, state.noMatchRounds + 1);
  return "第 " + current + " / " + MAX_NO_MATCH_ROUNDS + " 轮";
}

function continuousExhaustedMessage() {
  return "已完成 " + MAX_NO_MATCH_ROUNDS + " 轮轮询查找，最终没有找到 MAC 后缀 " +
    state.activeSuffix + " 的设备。";
}

function registerContinuousRound(jobId, resultCount) {
  var key = String(jobId || "");
  if (!state.continuous || !key || key === state.lastCountedJobId) {
    return {
      changed: false,
      rounds: state.noMatchRounds,
      exhausted: false,
      found: false
    };
  }
  state.lastCountedJobId = key;
  if (Number(resultCount) > 0) {
    state.noMatchRounds = 0;
    return {
      changed: true,
      rounds: 0,
      exhausted: false,
      found: true
    };
  }
  state.noMatchRounds += 1;
  return {
    changed: true,
    rounds: state.noMatchRounds,
    exhausted: state.noMatchRounds >= MAX_NO_MATCH_ROUNDS,
    found: false
  };
}

function resetContinuousRoundTracking() {
  state.noMatchRounds = 0;
  state.lastCountedJobId = "";
  state.searchExhausted = false;
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

function validateInput(showError) {
  var input = byId("macSuffix");
  var result = classifySuffixInput(input.value);
  if (result.status === "empty") {
    setInputInvalidState(false);
    return "";
  }
  if (result.status === "valid") {
    setInputInvalidState(false);
    return result.normalized;
  }
  var inputIsFocused = document.activeElement === input;
  var shouldShowError = !!showError &&
    (result.status !== "incomplete" || !inputIsFocused);
  if (shouldShowError) {
    showInputError(inputErrorMessage(result.status));
    return "";
  }
  setInputInvalidState(false);
  return "";
}

function setInputInvalidState(invalid, message) {
  var shell = byId("inputShell");
  var error = byId("inputError");
  var input = byId("macSuffix");
  shell.classList.toggle("is-invalid", !!invalid);
  input.setAttribute("aria-invalid", invalid ? "true" : "false");
  if (invalid) {
    error.textContent = message || DEFAULT_INPUT_ERROR;
    error.hidden = false;
  } else {
    error.textContent = "";
    error.hidden = true;
  }
}

function showInputError(message) {
  setInputInvalidState(true, message || DEFAULT_INPUT_ERROR);
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
  var input = byId("macSuffix");
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
  refreshButton.disabled = state.running || state.inventoryScanning;
  emptyRefreshButton.disabled =
    (busy && !state.continuous) ||
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
  input.disabled = busy;
  inputClearButton.hidden = !input.value.trim();
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
    var stateCell = document.createElement("td");
    var chip = document.createElement("span");
    chip.className = "state-chip " + stateClass(result.state);
    chip.textContent = result.state === "LOCAL" ? "本机" : result.state;
    stateCell.appendChild(chip);

    row.appendChild(interfaceCell);
    row.appendChild(rangeCell);
    row.appendChild(ipCell);
    row.appendChild(macCell);
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
        "正在持续查找 MAC 后缀 " + state.activeSuffix +
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
        "本轮未发现 MAC 后缀 " + state.activeSuffix +
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
  state.normalizedSuffix = data.suffix || state.normalizedSuffix;
  if (!state.activeSuffix && data.suffix) {
    state.activeSuffix = data.suffix;
  }
  state.totalHosts = Number(data.total_hosts) || 0;
  state.probedHosts = Number(data.probed_hosts) || 0;
  state.jobId = data.job_id || "";

  var incomingResults = Array.isArray(data.results) ? data.results : [];
  var preserveFoundResults = shouldPreserveContinuousResults(
    state.running,
    incomingResults,
    state.results
  );
  var roundOutcome = null;
  if (state.continuous && !state.running && state.scanStatus === "completed") {
    roundOutcome = registerContinuousRound(data.job_id, incomingResults.length);
    if (roundOutcome.changed && state.continuous) {
      persistSearchIntent(
        state.activeSuffix,
        state.normalizedSuffix,
        incomingResults
      );
    }
    if (roundOutcome.exhausted) {
      state.continuous = false;
      state.searchExhausted = true;
      discardSearchIntent();
    }
  }
  if (data.job_id || state.tableMode === "results") {
    if (!preserveFoundResults) {
      renderResults(incomingResults, false);
    }
  }
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
          ? "正在刷新物理网段，完成后继续查找后缀 " + state.activeSuffix + "。"
          : "读取 IPv4 地址、默认网关和安全的扫描范围。"
      );
    } else {
      setProgress(percent, false, "正在探测主机并读取邻居表");
      setText(
        "resultSummary",
        (state.continuous
          ? "正在持续匹配后缀 " + state.activeSuffix +
            "（" + continuousRoundLabel() + "）"
          : "正在匹配后缀 " + state.activeSuffix) +
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
    if (state.searchExhausted) {
      setScanState(
        "idle",
        "轮询查找结束",
        continuousExhaustedMessage()
      );
      setText("resultSummary", continuousExhaustedMessage());
    } else if (state.continuous && state.results.length) {
      setScanState(
        "success",
        "已找到匹配设备",
        "后缀 " + state.activeSuffix + " 找到 " + state.results.length +
          " 条记录，下一轮搜索即将开始。"
      );
      setText(
        "resultSummary",
        "持续搜索已找到 " + state.results.length +
          " 台设备，下一轮会自动刷新。"
      );
    } else if (state.continuous) {
      setScanState(
        "success",
        "当前没有搜索到",
        "第 " + state.noMatchRounds + " / " + MAX_NO_MATCH_ROUNDS +
          " 轮未发现后缀 " + state.activeSuffix + "，将自动开始下一轮搜索。"
      );
      setText(
        "resultSummary",
        "当前没有搜索到后缀 " + state.activeSuffix +
          "，持续搜索仍在进行（" + continuousRoundLabel() + "）。"
      );
    } else if (state.results.length) {
      setScanState(
        "success",
        "扫描完成",
        "后缀 " + state.activeSuffix + " 找到 " + state.results.length + " 条匹配记录。"
      );
      setText(
        "resultSummary",
        "后缀 " + state.activeSuffix + " 匹配到 " + state.results.length + " 台设备。"
      );
    } else {
      setScanState(
        "success",
        "扫描完成",
        "扫描了 " + state.totalHosts + " 台主机，未发现后缀 " + state.activeSuffix + "。"
      );
      setText(
        "resultSummary",
        "已扫描所选网段，未找到后缀 " + state.activeSuffix + "。"
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
        state.searchExhausted
          ? continuousExhaustedMessage()
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
  if (state.running || state.inventoryScanning) {
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
    setNetworks(data);
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
    if (!isSilent) {
      state.networks = [];
    }
    state.warnings = [describeError(error)];
    setText(
      "networkSummary",
      isSilent ? "等待服务恢复" : "网段读取失败"
    );
    if (!isSilent) {
      renderNetworkList();
    }
    renderWarnings();
    updateControls();
    if (!isSilent) {
      setScanState("error", "网段读取失败", describeError(error));
      toast(describeError(error), true);
    }
    return false;
  } finally {
    byId("refreshButton").disabled =
      state.running || state.inventoryScanning;
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
  var networksReady = await refreshNetworks(true, false);
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
      "持续搜索已保留；服务恢复后会自动继续查找后缀 " + state.activeSuffix + "。",
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
  var displaySuffix = byId("macSuffix").value.trim();
  var suffix = validateInput(true);
  if (!suffix) {
    var draft = classifySuffixInput(byId("macSuffix").value);
    if (draft.status === "empty" && document.activeElement !== byId("macSuffix")) {
      showInputError();
    }
    return;
  }
  var networkIds = selectedNetworkIds();
  if (!state.networks.length) {
    state.continuous = true;
    state.activeSuffix = displaySuffix;
    state.normalizedSuffix = suffix;
    state.scanStatus = "waiting";
    persistSearchIntent(displaySuffix, suffix, state.results);
    updateControls();
    showContinuousWaiting(
      "等待可用网段",
      "当前没有可扫描的物理网段，将持续检查并在网段恢复后继续。"
    );
    scheduleContinuousRestart(nextServiceRetryDelay());
    return;
  }
  if (!networkIds.length) {
    state.continuous = false;
    state.running = false;
    state.scanStatus = "idle";
    discardSearchIntent();
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
  state.activeSuffix = displaySuffix;
  state.normalizedSuffix = suffix;
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
      "准备重新读取网段并查找后缀 " + displaySuffix + "。"
    );
  }
  persistSearchIntent(displaySuffix, suffix, state.results);
  updateControls();

  try {
    await apiRequest("scan/start", {
      suffix: suffix,
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
        "正在停止其他扫描任务，随后会继续搜索后缀 " + state.activeSuffix + "。"
      );
      scheduleContinuousRestart(CONTINUOUS_RESTART_DELAY_MS);
    } else if (error.kind === "rejected") {
      state.continuous = false;
      discardSearchIntent();
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
  state.continuous = false;
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
    updateControls();
    toast("持续搜索已停止。", false);
    return;
  }
  state.stopping = true;
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
  state.activeSuffix = "";
  state.normalizedSuffix = "";
  byId("macSuffix").value = "";
  validateInput(false);
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
  var shell = byId("inputShell");

  input.addEventListener("focus", function () {
    shell.classList.add("is-focused");
    validateInput(true);
  });
  input.addEventListener("blur", function () {
    shell.classList.remove("is-focused");
    if (input.value.trim()) {
      validateInput(true);
    }
  });
  input.addEventListener("input", function () {
    validateInput(true);
    byId("inputClearButton").hidden = !input.value.trim();
    if (
      !input.value.trim() &&
      state.tableMode === "results" &&
      !state.running &&
      !state.continuous
    ) {
      clearResults();
    }
    updateControls();
  });

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
  restoreNetworkSelection();
  updateControls();
  var online = await checkBackend(restored);
  if (online) {
    await refreshNetworks(restored, true);
    try {
      var status = await apiRequest("scan/status", null);
      if (
        state.continuous &&
        status.running &&
        status.suffix &&
        status.suffix !== state.normalizedSuffix
      ) {
        await apiRequest("scan/stop", {});
        showContinuousWaiting(
          "切换持续搜索",
          "正在停止旧任务，随后会继续搜索后缀 " + state.activeSuffix + "。"
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
    state.networks = [];
    state.warnings = [describeError(new Error("backend unavailable"))];
    setText("networkSummary", "服务未连接");
    renderNetworkList();
    renderWarnings();
    updateControls();
    if (state.continuous) {
      showContinuousWaiting(
        "等待 NAS 恢复",
        "持续搜索已保留；服务恢复后会自动继续查找后缀 " + state.activeSuffix + "。",
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
