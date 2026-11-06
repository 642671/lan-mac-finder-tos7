# LAN MAC Finder for TOS 7

`lan-mac-finder` is a TOS 7 iframe Deb application for finding devices in the
NAS's current physical LAN by the last four characters of their MAC address.

Current version: `1.0.017`.

## Features

- Detect physical IPv4 interfaces that have a default gateway.
- Exclude common virtual interfaces such as Docker, veth, VM, Tailscale, TUN,
  TAP, WireGuard, and ZeroTier.
- Calculate the real network and broadcast address from each interface prefix.
- Discover every routed physical IPv4 network. All networks are selected by
  default, and the active-network list can scan one or several selected ranges.
- Keep the selected network scope across WebUI reloads and continuous-search
  cycles, and apply it to both MAC matching and device inventory scans.
- Reject oversized scan ranges with a configurable safety limit.
- Probe hosts in the background, never blocking the WebUI.
- Prime the kernel neighbor table with empty UDP datagrams and use ICMP ping
  when the local `ping` command is available.
- Read `REACHABLE`, `STALE`, `DELAY`, and `PROBE` neighbor records.
- Match `AA-BB`, `AA:BB`, and `AABB` suffixes case-insensitively.
- Start with one MAC input and add up to 8 search targets one at a time with
  “添加一个 MAC”, pinned to the same row as the MAC suffix label; duplicate
  suffixes are rejected, each added row's remove control sits inside its input,
  and all rows keep a stable width as rows are added or removed.
- Search every entered suffix in the same sweep and annotate rows with the
  matched targets. The match table gains a target column when more than one
  suffix is searched, and a per-target summary shows how many devices each
  target found.
- Track polling per target: a found suffix stops counting while suffixes that
  are still missing continue their own 10-round budget. The search stops as
  soon as every suffix is found or has exhausted its rounds, and the final
  message lists which suffixes were found and which were not found.
- Preserve the exact casing typed in the input while comparing the normalized suffix.
- Keep incomplete input neutral while the field is focused, while rejecting
  overlong fragments immediately and exposing the error state to assistive
  technology.
- Show the complete accepted-format hint directly inside the empty input.
- Actively probe every scannable host in the selected networks on startup and
  refresh, then show the discovered inventory as the device overview before
  searching.
- Collapse devices found through multiple interfaces on the same scanned
  network and probe each unique network only once, avoiding duplicate rows and
  repeated full-network sweeps.
- Include each physical interface's own MAC as a `LOCAL` device.
- Clear the search field to return immediately to the unfiltered device overview.
- Filter the visible device overview or match table by IP, MAC, interface,
  scan range, or state. Space-separated terms must all match, and MAC fragments
  accept either `-` or `:` separators.
- Sort every table column in ascending or descending order, with numeric IPv4
  and network ordering instead of plain string ordering.
- Keep a submitted non-empty suffix searching automatically. A cycle refreshes
  physical networks, retains the latest match while the next scan is running,
  shows the no-match state when a completed scan returns no devices, retries
  after temporary NAS or API loss, and resumes after the WebUI reloads.
- Limit automatic polling to 10 rounds per target. Targets that have already
  matched stop consuming rounds, missing targets each keep their own 10-round
  budget, and polling stops once every target is resolved. A finished search
  clearly reports which suffixes were found and which were ultimately not
  found, instead of staying at the first round forever.
- Open a device's IP address in a new browser tab by clicking it in either the
  device overview or the match table, without interfering with row selection,
  double-click MAC copy, or keyboard row actions.
- Resize the navigation and scan/network boundaries with the mouse, touch, or
  keyboard while preserving minimum content sizes.
- Copy either the selected device's IP or MAC address.
- Export the currently visible, filtered and sorted device or match table to
  UTF-8 CSV for Excel with `Ctrl+E`.
- Follow the TOS `themeMode` on startup and provide a directly clickable
  application theme toggle.
- Version-bump the packaged icon mtime so TOS navigation cache-busts updated
  application artwork.
- Stop an active scan, refresh interfaces, select a result, and copy its MAC.
- Liquid-glass light/dark themes, custom tooltips, and TOS-safe window layout.

## Screenshot

The screenshots use RFC 5737 example addresses and synthetic MAC values; they
do not contain data from a real NAS or customer network.

![LAN MAC Finder light theme](docs/screenshots/light.png)

![LAN MAC Finder dark theme](docs/screenshots/dark.png)

## Design references

The table workflow was reviewed against public network scanners:

- [arp-scan](https://github.com/royhills/arp-scan) for full-inventory output
  and scan clarity.
- [network_scanner](https://github.com/parvez/network_scanner) for
  multi-network device-list workflows.
- [python-network-scanner](https://github.com/devmarcstorm/python-network-scanner)
  for device table filtering and selection patterns.
- [TOS app package tools](https://github.com/terramaster-tos/tos-app-pkg-tools)
  for the current TOS 7 packaging contract.

These projects are interaction references only. No GPL code or OUI database
from `arp-scan` is included, and the app does not add `nmap` or another runtime
dependency.

## How it works

The app has no Windows dependency. The TOS package runs a Python 3 standard
library service as the non-root `lan-mac-finder` user and exposes an HTTP API
over `/var/api/lan-mac-finder.sock`.

Main endpoints:

```text
GET  /health
GET  /networks
GET  /devices
POST /devices/scan
POST /scan/start
GET  /scan/status
POST /scan/stop
```

`POST /scan/start` and `POST /devices/scan` accept an optional `network_ids`
array. Each value is the `network_id` returned by `GET /networks`, for example
`enp1s0|192.0.2.0/24`:

```json
{
  "suffix": "456A",
  "network_ids": ["enp1s0|192.0.2.0/24", "enp2s0|198.51.100.0/24"]
}
```

Omitting `network_ids` preserves the original behavior and scans every
discovered network. An explicit empty array is rejected, and unavailable
selected networks never fall back to scanning unselected ranges.

The WebUI uses the TOS proxy prefix:

```text
/v2/proxy/lan-mac-finder/
```

## Runtime paths

```text
/usr/local/lan-mac-finder/
/usr/local/lan-mac-finder/data/
/usr/local/lan-mac-finder/logs/
/var/api/lan-mac-finder.sock
```

The application only reads routing, interface, and neighbor data. It never
changes NAS or remote-device network settings.

## Development

Requirements:

- Python 3.10 or newer
- TOS 7 NAS for package and real-network validation
- Node.js 20 or newer for frontend state tests
- Playwright only for optional local visual checks

Run the unit tests:

```powershell
py -3 -m unittest discover -s backend/tests -v
node --check frontend/csv.js
node --check frontend/app.js
node --test tests/frontend_csv.test.js tests/frontend_search_state.test.js
```

Compile-check the backend:

```powershell
py -3 -m compileall -q backend
```

Run the deterministic local WebUI preview:

```powershell
py -3 tools/preview_server.py --port 4178
```

Then open `http://127.0.0.1:4178/`. The preview server is development tooling
only and is not included in the Deb package.

Build both package architectures:

```powershell
py -3 build.py --platform x86_64
py -3 build.py --platform aarch64
```

Generated packages and SHA256 files are written to `dist/`.

## TOS installation

For a test NAS:

```bash
sudo dpkg -i lan-mac-finder_1.0.017_x86_64.deb
systemctl status lanmacfinder-system.service
curl --unix-socket /var/api/lan-mac-finder.sock http://localhost/health
```

For normal distribution, upload the matching Deb from the GitHub Release to
the TerraMaster developer platform or install it through App Center.

## Safety and compatibility

- Windows PowerShell 5.1 is supported by the original standalone WPF tool, not
  by this TOS package. The TOS version is a separate Linux/iframe application.
- `config.ini` uses strict JSON contents despite its extension.
- `/var/api` is shared and sticky on TOS. This package does not change its owner
  or permissions.
- `webui.bz2` is re-extracted during every package configure.
- The systemd unit uses the application user's real primary group instead of a
  nonexistent same-named group.
- `PrivateTmp=true` is not used because `/var/api` may point into `/tmp/api`.
- The app only sees devices in the same broadcast domain that the NAS can reach
  at layer 2. Cross-router and cross-VLAN devices normally appear only as the
  gateway MAC.

## Release

Repository: `https://github.com/642671/lan-mac-finder-tos7`

Before a versioned release, update:

- `VERSION`
- `config.ini`
- `DEBIAN/control`
- `backend/lan_mac_finder/__init__.py`
- `CHANGELOG.md`
- `README.md`
- `lan-mac-finder.lang`

Then run tests, build both architectures, commit, tag, and push:

```powershell
git add -A
git commit -m "release: v1.0.017"
git push origin main
git tag -a v1.0.017 -m "LAN MAC Finder v1.0.017"
git push origin v1.0.017
```
