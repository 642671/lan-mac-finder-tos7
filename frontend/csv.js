(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.LanMacCsv = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULT_COLUMNS = [
    { label: "网卡", value: "interface" },
    { label: "扫描范围", value: "scan_range" },
    { label: "IP 地址", value: "ip" },
    { label: "MAC 地址", value: "mac" },
    {
      label: "状态",
      value: function (item) {
        return item.state === "LOCAL" ? "本机" : item.state;
      }
    }
  ];

  function escapeCell(value) {
    var text = String(value === undefined || value === null ? "" : value);
    // Prevent spreadsheet formula execution when a captured interface or label
    // happens to begin with a formula marker.
    if (/^[=+@]/.test(text) || /^-(?!\d)/.test(text)) {
      text = "'" + text;
    }
    if (/[",\r\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function buildCsv(items, columns, options) {
    var rows = Array.isArray(items) ? items : [];
    var specs = Array.isArray(columns) && columns.length ? columns : DEFAULT_COLUMNS;
    var settings = options || {};
    var lines = [specs.map(function (column) {
      return escapeCell(column.label);
    }).join(",")];
    rows.forEach(function (item) {
      lines.push(specs.map(function (column) {
        var value = typeof column.value === "function"
          ? column.value(item)
          : item[column.value];
        return escapeCell(value);
      }).join(","));
    });
    var body = lines.join("\r\n");
    return settings.bom === false ? body : "\ufeff" + body;
  }

  function dateStamp(date) {
    var value = date instanceof Date ? date : new Date();
    function pad(number) {
      return String(number).padStart(2, "0");
    }
    return value.getFullYear() + pad(value.getMonth() + 1) + pad(value.getDate()) +
      "-" + pad(value.getHours()) + pad(value.getMinutes()) + pad(value.getSeconds());
  }

  return {
    DEFAULT_COLUMNS: DEFAULT_COLUMNS,
    csvCell: escapeCell,
    escapeCell: escapeCell,
    buildCsv: buildCsv,
    dateStamp: dateStamp
  };
});
