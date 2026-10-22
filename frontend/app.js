"use strict";

var APP_ID = "lan-mac-finder";
var MAC_SUFFIX_PATTERN = /^(?:[0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}|[0-9A-Fa-f]{4})$/;
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
var toastTimer = null;
var activeTooltipTarget = null;

var state = {
  networks: [],
  warnings: [],
  devices: [],
  results: [],
  tableSignature: "",
  tableMode: "devices",
  selectedMac: "",
  selectedKey: "",
  running: false,
  stopping: false,
  activeSuffix: "",
  scanStatus: "idle",
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

async function send(root, endpoint, payload) {
  var url = root + "/" + endpoint;
  var withBody = payload !== undefined && payload !== null;
  var response;
  try {
    response = await fetch(url, {
      method: withBody ? "POST" : "GET",
      credentials: "include",
      headers: platformHeaders(withBody),
      body: withBody ? JSON.stringify(payload) : undefined,
      cache: "no-store"
    });
  } catch (error) {
    throw apiFailure(
      "network",
      url,
      (error.name || "Error") + ": " + error.message
    );
  }

  var text = await response.text().catch(function () {
    return "";
  });
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

async function apiRequest(endpoint, payload) {
  if (!apiReady) {
    await refreshApiRoot();
  }
  try {
    return await send(API_ROOT, endpoint, payload);
  } catch (error) {
    if (error.kind === "gateway") {
      apiReady = false;
      await refreshApiRoot();
      return await send(API_ROOT, endpoint, payload);
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
    var item = document.createElement("div");
    item.className = "network-item";

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
  state.warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  setText(
    "networkSummary",
    state.networks.length
      ? state.networks.length + " 个活动物理网段"
      : "未发现可扫描网段"
  );
  renderNetworkList();
  renderWarnings();
  updateControls();
}

function validateInput(showError) {
  var input = byId("macSuffix");
  var shell = byId("inputShell");
  var error = byId("inputError");
  var value = input.value.trim();
  if (!value) {
    shell.classList.remove("is-invalid");
    error.hidden = true;
    return "";
  }
  var normalized = normalizeSuffix(value);
  if (!normalized) {
    if (showError) {
      error.textContent = "请输入 AA-BB、AA:BB 或 AABB 格式的 MAC 后四位。";
      error.hidden = false;
      shell.classList.add("is-invalid");
    } else {
      shell.classList.remove("is-invalid");
      error.hidden = true;
    }
    return "";
  }
  error.hidden = true;
  shell.classList.remove("is-invalid");
  return normalized;
}

function showInputError(message) {
  var error = byId("inputError");
  error.textContent = message || "请输入 AA-BB、AA:BB 或 AABB 格式的 MAC 后四位。";
  error.hidden = false;
  byId("inputShell").classList.add("is-invalid");
  byId("macSuffix").focus();
}

function updateControls() {
  var scanButton = byId("scanButton");
  var stopButton = byId("stopButton");
  var refreshButton = byId("refreshButton");
  var emptyRefreshButton = byId("emptyRefreshButton");
  var copyButton = byId("copyButton");
  var clearButton = byId("clearButton");
  var input = byId("macSuffix");

  scanButton.disabled = state.running || state.networks.length === 0;
  stopButton.disabled = !state.running || state.stopping;
  refreshButton.disabled = state.running;
  emptyRefreshButton.disabled = state.running;
  input.disabled = state.running;
  copyButton.disabled = !state.selectedMac;
  clearButton.disabled = state.tableMode !== "results" || state.results.length === 0;
  setText(
    "scanButtonText",
    state.running ? (state.stopping ? "停止中" : "扫描中") : "开始扫描"
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
  state.selectedKey = "";
  setText("selectionText", "未选择设备");
  byId("copyButton").disabled = true;
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
  state.selectedKey = row.getAttribute("data-key") || "";
  setText("selectionText", state.selectedMac ? "已选择 " + state.selectedMac : "未选择设备");
  var summary = document.querySelector(".selected-summary");
  if (summary) {
    summary.classList.toggle("has-selection", !!state.selectedMac);
  }
  byId("copyButton").disabled = !state.selectedMac;
}

function stateClass(value) {
  var normalized = String(value || "").toLowerCase();
  if (normalized === "reachable") {
    return "is-reachable";
  }
  if (normalized === "stale" || normalized === "delay" || normalized === "probe") {
    return "is-stale";
  }
  return "";
}

function visibleTableRows() {
  return state.tableMode === "results" ? state.results : state.devices;
}

function renderTable(items, mode, force) {
  var safeItems = Array.isArray(items) ? items : [];
  var signature = mode + ":" + JSON.stringify(safeItems);
  if (!force && signature === state.tableSignature) {
    return;
  }
  state.tableSignature = signature;
  state.tableMode = mode;
  if (mode === "results") {
    state.results = safeItems;
  } else {
    state.devices = safeItems;
  }
  resetSelection();

  var body = byId("resultsBody");
  while (body.firstChild) {
    body.removeChild(body.firstChild);
  }
  safeItems.forEach(function (result) {
    var row = document.createElement("tr");
    row.tabIndex = 0;
    row.setAttribute("role", "row");
    row.setAttribute("aria-selected", "false");
    row.setAttribute("data-mac", result.mac);
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
    ipCell.textContent = result.ip;
    var macCell = document.createElement("td");
    macCell.className = "mono-value";
    macCell.textContent = result.mac;
    var stateCell = document.createElement("td");
    var chip = document.createElement("span");
    chip.className = "state-chip " + stateClass(result.state);
    chip.textContent = result.state;
    stateCell.appendChild(chip);

    row.appendChild(interfaceCell);
    row.appendChild(rangeCell);
    row.appendChild(ipCell);
    row.appendChild(macCell);
    row.appendChild(stateCell);
    row.addEventListener("click", function () {
      selectRow(row);
    });
    row.addEventListener("dblclick", function () {
      selectRow(row);
      copySelectedMac();
    });
    row.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        selectRow(row);
        copySelectedMac();
      }
    });
    body.appendChild(row);
  });

  setText("tableHeading", mode === "results" ? "匹配结果" : "设备总表");
  setText("resultCount", safeItems.length);
  setHidden("tableWrap", safeItems.length === 0);
  setHidden("emptyState", safeItems.length > 0);
  setText(
    "emptyRefreshButton",
    mode === "results" ? "重新识别网段" : "刷新设备总表"
  );
  updateControls();
}

function renderResults(results, force) {
  renderTable(results, "results", force);
}

function renderDevices(devices, force) {
  renderTable(devices, "devices", force);
}

function renderEmptyForStatus(status) {
  if (state.tableMode === "devices") {
    setText("emptyTitle", "暂无设备记录");
    setText("emptyMessage", "当前邻居表中没有可显示的设备，刷新后再试。");
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
    setText("emptyMessage", "当前邻居表中没有符合该 MAC 后缀的记录。");
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

function renderScanStatus(data, notifyTerminal) {
  var wasRunning = state.running;
  state.running = !!data.running;
  state.stopping = !!data.stopping;
  state.scanStatus = data.status || "idle";
  state.activeSuffix = data.suffix || state.activeSuffix;
  state.totalHosts = Number(data.total_hosts) || 0;
  state.probedHosts = Number(data.probed_hosts) || 0;
  state.jobId = data.job_id || state.jobId;

  if (data.job_id || state.tableMode === "results") {
    renderResults(data.results || [], false);
  }
  updateControls();

  var percent = Number(data.progress_percent) || 0;
  if (state.running) {
    if (state.scanStatus === "discovering") {
      setProgress(0, true, "读取物理网卡与默认网关");
      setText("resultSummary", "正在识别当前物理局域网。");
      setScanState(
        "running",
        "正在识别网段",
        "读取 IPv4 地址、默认网关和安全的扫描范围。"
      );
    } else {
      setProgress(percent, false, "正在探测主机并读取邻居表");
      setText(
        "resultSummary",
        "正在匹配后缀 " + state.activeSuffix +
          "，已探测 " + state.probedHosts + " / " + state.totalHosts + " 台主机。"
      );
      setScanState(
        "running",
        "正在扫描 " + (data.current_interface || ""),
        (data.current_range || "准备扫描") +
          " · 已探测 " + state.probedHosts + " 台主机。"
      );
    }
  } else if (state.scanStatus === "completed") {
    setProgress(100, false, "扫描完成");
    setHidden("scanProgress", true);
    if (state.results.length) {
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
        "已扫描全部活动网段，未找到后缀 " + state.activeSuffix + "。"
      );
    }
  } else if (state.scanStatus === "stopped") {
    setHidden("scanProgress", true);
    setScanState(
      "idle",
      "扫描已停止",
      "已保留停止前找到的 " + state.results.length + " 条记录。"
    );
    setText("resultSummary", "扫描已停止，停止前的结果仍可选择和复制。");
  } else if (state.scanStatus === "error") {
    setHidden("scanProgress", true);
    setScanState("error", "扫描失败", data.error || "无法读取当前物理网段。");
    setText("resultSummary", data.error || "扫描未完成。");
  } else {
    setHidden("scanProgress", true);
    if (!state.networks.length) {
      setScanState("error", "没有可扫描网段", "请刷新物理网卡和默认网关。");
    } else {
      setScanState(
        "idle",
        "准备就绪",
        state.networks.length + " 个物理网段可用于扫描。"
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
    setText("scanFooterMeta", "等待网络扫描");
  }

  if (notifyTerminal && wasRunning && !state.running && state.jobId) {
    if (state.scanStatus === "completed") {
      toast(
        state.results.length
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
}

async function refreshNetworks() {
  if (state.running) {
    return;
  }
  byId("refreshButton").disabled = true;
  setText("networkSummary", "正在读取物理网卡");
  try {
    var data = await apiRequest("networks", null);
    setNetworks(data);
    if (state.tableMode === "devices") {
      await refreshDevices(false);
    }
    if (state.scanStatus === "idle") {
      setScanState(
        "idle",
        "准备就绪",
        state.networks.length
          ? state.networks.length + " 个物理网段可用于扫描。"
          : "没有找到带默认网关的物理网卡。"
      );
    }
  } catch (error) {
    state.networks = [];
    state.warnings = [describeError(error)];
    setText("networkSummary", "网段读取失败");
    renderNetworkList();
    renderWarnings();
    updateControls();
    setScanState("error", "网段读取失败", describeError(error));
    toast(describeError(error), true);
  } finally {
    byId("refreshButton").disabled = state.running;
  }
}

async function refreshDevices(showError) {
  try {
    var data = await apiRequest("devices", null);
    state.devices = Array.isArray(data.devices) ? data.devices : [];
    if (Array.isArray(data.warnings) && data.warnings.length) {
      state.warnings = Array.from(new Set(state.warnings.concat(data.warnings)));
      renderWarnings();
    }
    renderDevices(state.devices, true);
    setText(
      "resultSummary",
      state.devices.length
        ? "当前邻居表中共有 " + state.devices.length + " 台已知设备。"
        : "当前邻居表中暂无已知设备。"
    );
    setText("scanFooterMeta", "已知设备 " + state.devices.length + " 台");
    renderEmptyForStatus("idle");
    return true;
  } catch (error) {
    if (showError) {
      toast(describeError(error), true);
    }
    return false;
  }
}

function clearResultsForNewScan() {
  renderResults([], true);
  setText("resultSummary", "正在启动扫描。");
}

function scheduleScanPoll(delay) {
  if (pollTimer) {
    window.clearTimeout(pollTimer);
  }
  pollTimer = window.setTimeout(pollScanStatus, delay || 450);
}

async function pollScanStatus() {
  pollTimer = null;
  try {
    var data = await apiRequest("scan/status", null);
    renderScanStatus(data, true);
    if (data.running) {
      scheduleScanPoll(450);
    }
  } catch (error) {
    state.running = false;
    state.stopping = false;
    updateControls();
    setScanState("error", "状态读取失败", describeError(error));
    toast(describeError(error), true);
  }
}

async function startScan() {
  if (state.running) {
    return;
  }
  var suffix = validateInput(true);
  if (!suffix) {
    showInputError();
    return;
  }
  if (!state.networks.length) {
    toast("没有可扫描的物理网段，请刷新网络。", true);
    return;
  }

  state.running = true;
  state.stopping = false;
  state.activeSuffix = suffix;
  state.scanStatus = "discovering";
  clearResultsForNewScan();
  setProgress(0, true, "正在启动扫描");
  setScanState("running", "正在启动扫描", "准备读取当前物理网段。");
  updateControls();

  try {
    await apiRequest("scan/start", { suffix: suffix });
    scheduleScanPoll(350);
  } catch (error) {
    state.running = false;
    updateControls();
    setHidden("scanProgress", true);
    if (error.kind === "rejected") {
      showInputError(error.detail || "MAC 后缀格式不正确。");
    } else {
      setScanState("error", "扫描启动失败", describeError(error));
    }
    toast(describeError(error), true);
  }
}

async function stopScan() {
  if (!state.running || state.stopping) {
    return;
  }
  state.stopping = true;
  updateControls();
  setScanState("running", "正在停止扫描", "等待当前批次探测结束。");
  try {
    await apiRequest("scan/stop", {});
    scheduleScanPoll(250);
  } catch (error) {
    state.stopping = false;
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

async function clearResults() {
  if (state.running) {
    return;
  }
  state.scanStatus = "idle";
  state.activeSuffix = "";
  state.results = [];
  renderDevices(state.devices, true);
  setText(
    "resultSummary",
    state.devices.length
      ? "当前邻居表中共有 " + state.devices.length + " 台已知设备。"
      : "当前邻居表中暂无已知设备。"
  );
  setText("scanFooterMeta", "已知设备 " + state.devices.length + " 台");
  setScanState(
    "idle",
    "准备就绪",
    state.networks.length + " 个物理网段可用于扫描。"
  );
  await refreshNetworks();
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("lan-mac-finder-theme", theme);
  } catch (error) {
    return;
  }
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

async function checkBackend() {
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
    toast(describeError(error), true);
    return false;
  }
}

function bindEvents() {
  var input = byId("macSuffix");
  var shell = byId("inputShell");

  input.addEventListener("focus", function () {
    shell.classList.add("is-focused");
  });
  input.addEventListener("blur", function () {
    shell.classList.remove("is-focused");
  });
  input.addEventListener("input", function () {
    validateInput(true);
  });

  byId("scanForm").addEventListener("submit", function (event) {
    event.preventDefault();
    startScan();
  });
  byId("stopButton").addEventListener("click", stopScan);
  byId("refreshButton").addEventListener("click", refreshNetworks);
  byId("emptyRefreshButton").addEventListener("click", refreshNetworks);
  byId("copyButton").addEventListener("click", copySelectedMac);
  byId("clearButton").addEventListener("click", clearResults);
  byId("themeToggle").addEventListener("click", toggleTheme);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      hideTooltip();
      if (state.running) {
        event.preventDefault();
        stopScan();
      }
    }
  });
}

async function boot() {
  bindEvents();
  bindTooltips();
  updateControls();
  var online = await checkBackend();
  if (online) {
    await refreshNetworks();
    try {
      var status = await apiRequest("scan/status", null);
      renderScanStatus(status, false);
      if (status.running) {
        scheduleScanPoll(350);
      }
    } catch (error) {
      setScanState("error", "状态读取失败", describeError(error));
    }
  } else {
    state.networks = [];
    state.warnings = [describeError(new Error("backend unavailable"))];
    setText("networkSummary", "服务未连接");
    renderNetworkList();
    renderWarnings();
    updateControls();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
