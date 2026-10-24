# Changelog

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
