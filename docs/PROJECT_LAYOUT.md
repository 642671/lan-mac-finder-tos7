# Project Layout

```text
lan-mac-finder-tos7/
|- backend/
|  |- lan-mac-finder-service
|  |- lan_mac_finder/
|  |  |- core.py
|  |  |- server.py
|  |  `- __init__.py
|  `- tests/
|- frontend/
|  |- index.html
|  |- styles.css
|  `- app.js
|- images/icons/lan-mac-finder.svg
|- init.d/lanmacfinder-system.service
|- DEBIAN/
|  |- control
|  |- postinst
|  |- prerm
|  `- postrm
|- .github/workflows/build.yml
|- config.ini
|- lan-mac-finder.env
|- lan-mac-finder.lang
|- build.py
|- VERSION
|- CHANGELOG.md
`- README.md
```

## Ownership boundaries

- `backend/lan_mac_finder/core.py`: interface discovery, bounded probing,
  neighbor parsing, suffix matching, and scan state.
- `backend/lan_mac_finder/server.py`: TOS proxy routing, JSON API, Unix socket.
- `frontend/`: presentation and user interaction only.
- `DEBIAN/`: installation and removal lifecycle.
- `init.d/`: systemd unit copied into `/etc/systemd/system`.
- `build.py`: deterministic single-package Deb generation and verification.
