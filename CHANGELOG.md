# Changelog

## 1.0.011 - 2026-11-04

### 修复

- 同一广播域由多块物理或 OVS 网卡重复暴露时，设备总表和匹配结果现在按“扫描网段、IP、MAC”合并为一条；合并时优先保留 `LOCAL`、`REACHABLE`、`DELAY`、`PROBE`、`STALE` 中状态更强的一条，并继续保留各接口自身不同的 `LOCAL` 地址。
- 对相同扫描网段只执行一次主机探测，进度和总主机数按实际唯一网段计算，避免多个接口重复扫完整网段导致耗时和结果成倍增加。
- 同步全部 14 种语言的应用商店发布说明到当前版本，并增加发布说明版本契约测试，避免升级后仍展示旧版本说明。

### 验证

- 增加同网段多接口去重、状态优先级、单次探测和不同网段隔离的回归测试。
- 通过完整后端单元测试与前端 Node.js 测试。

## 1.0.010 - 2026-11-03

### 新增

- 设备总表和 MAC 匹配结果新增即时筛选，可按 IP、MAC、网卡、扫描网段或状态
  检索；多个关键词以空格分隔时要求全部命中，MAC 查询兼容 `-` 和 `:` 分隔符。
- 表头支持按网卡、扫描范围、IP、MAC 和状态升序或降序排序；IP 与扫描网段按
  数值顺序排序，而不是按字符串顺序排序。
- 表格工具栏显示筛选后的设备数与总数；筛选无结果时提供明确空状态和“清除筛选”
  入口。
- CSV 导出改为导出当前筛选和排序后的可见记录，与界面上看到的内容保持一致。

### 修复

- 筛选或排序时保留仍可见的选中设备；筛选后不可见的选中项会安全清除，避免
  继续复制旧记录。
- 表格工具栏和空状态纳入现有 TOS 明暗主题、窄窗口与键盘操作布局。
- 发布说明版本号同步到当前版本，修正 `1.0.009` 发布时仍显示 `1.0.008` 的问题。

## 1.0.009 - 2026-11-03

### 新增

- 多网段环境默认全选所有活动物理网段，并可在“活动网段”列表中只勾选一个或
  多个网段执行扫描。
- 网段选择同时作用于 MAC 后缀扫描和设备总表探测，并会随页面刷新和持续搜索
  自动恢复。
- `/scan/start` 与 `/devices/scan` 新增可选 `network_ids` 参数；未传时保持
  旧版全网段行为，空选择会被拒绝，失效网段不会回退为全网段扫描。

### 修复

- 修复多网段环境下无法限定扫描范围、后台可能同时探测不需要网段的问题。
- 在扫描运行期间锁定网段选择，避免界面选择与后台任务范围不一致。
- 同名 MAC 后缀正在扫描但请求范围不同时返回 409，避免误报为已加入当前任务。

## 1.0.008 - 2026-10-30

- Add CSV export for the current device overview or MAC match table, with a
  stable column order, UTF-8 BOM for Excel, `Ctrl+E`, and disabled state when
  there is nothing to export.
- Escape commas, quotes, and line breaks and neutralize spreadsheet formula
  injection without altering numeric values.
- Share the CSV implementation with the Windows build and add Node.js unit
  tests for default columns, escaping, formulas, and filenames.
- Follow the explicit result-count and export workflow common to LAN scanners
  such as Angry IP Scanner while keeping all data on the NAS.


## 1.0.007 - 2026-10-24

- Actively probe every scannable host when loading or refreshing the device
  overview instead of showing only the NAS's partially populated neighbor
  cache.
- Return the complete probed device inventory through a dedicated endpoint,
  including the NAS's own physical interface.
- Serialize inventory scans with suffix searches and disable conflicting
  controls while the inventory scan is running.
- Use a longer timeout for full-network inventory scans while retaining the
  shorter timeout used by interactive search requests.

## 1.0.006 - 2026-10-24

- Keep incomplete MAC input neutral while the field is focused, while still
  rejecting more than four digits or more than five characters with a
  separator immediately.
- Move the complete `AA-BB / AA:BB / AABB` format guidance into the input
  placeholder and expose validation state through `aria-invalid`.
- Make both application boundaries draggable by mouse, touch, and keyboard,
  with minimum sidebar, workspace, scan-panel, and network-panel sizes.
- Turn a submitted non-empty suffix into a persistent continuous search that
  refreshes networks, keeps the latest match while the next cycle runs, shows
  the no-match state when a completed cycle returns no devices, retries after
  NAS or API interruptions, and resumes after a WebUI reload.
- Add request timeouts, backoff for recoverable service failures, and explicit
  stop, clear, login-required, and scan-conflict handling.

## 1.0.005 - 2026-10-22

- Give the packaged SVG icon a version-derived modification time so TOS
  navigation cache-busts the URL instead of showing an older icon.
- Strengthen the liquid-glass visual system with richer background gradients,
  lower-opacity blurred surfaces, specular borders, and translucent controls.
- Keep the improved glass treatment readable in both TOS light and dark themes.

## 1.0.004 - 2026-10-22

- Move the theme control out of the TOS host title-bar hit area so clicking it
  always toggles the application theme.
- Initialize the application theme from the TOS `themeMode` value so the host
  window controls and application colors use the same light or dark baseline.
- Add a Copy IP action for the selected device row.
- Reserve space for the bottom-right resize handle so device counts no longer
  overlap it.
- Make the application icon fill its SVG viewBox so navigation and App Center
  render it at the same visual size as system icons.

## 1.0.003 - 2026-10-22

- Reserve a wider host-control safe area in the title bar so TOS minimize,
  maximize, and close controls no longer overlap application actions.
- Make the bottom resize-safe corner transparent and remove the footer's
  right-side spacing so status data sits against the workspace edge.
- Clearing the MAC input or pressing the search-reset action now immediately
  restores the unfiltered device overview.
- Preserve the user's original suffix casing in scan status messages while
  continuing to normalize only the matching value.
- Include each physical interface's own MAC in the device overview and scan
  results with a distinct `LOCAL` state, fixing searches for the NAS's own MAC.

## 1.0.002 - 2026-10-22

- Preserve the exact case typed by the user while keeping MAC suffix matching
  case-insensitive.
- Show the current neighbor table as the default device overview on the right;
  after a search, show only matching devices and provide a back-to-overview
  action.
- Remove the outer content gaps and card-like margins so the sidebar, workspace,
  results table, and footer sit flush against the host edges.
- Replace the navigation icon with a simpler magnifier/network glyph and remove
  the small plus badge that became unreadable at navigation-bar size.

## 1.0.001 - 2026-10-21

- First TOS 7 release.
- Discover routed physical IPv4 interfaces and construct bounded scan ranges.
- Run host probing in a background scan job without blocking the WebUI.
- Read Linux neighbor records and match the normalized last four MAC characters.
- Add stop, refresh, result selection, double-click copy, and keyboard copy.
- Add a liquid-glass WebUI with custom tooltips, light/dark themes, responsive
  sizing, and a TOS-compatible resize-safe corner.
- Ship deterministic x86_64 and aarch64 Deb packages, checksums, tests, and
  GitHub Actions packaging.
