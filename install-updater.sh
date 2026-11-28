#!/usr/bin/env bash
# =============================================================================
# PodSovereign: install (or repair) the one-click updater service
#
# Sets up upgrade-watch.sh as the systemd service `podsovereign-updater`, which is what the
# "Update now" button in Site settings talks to. Safe to run any number of times:
#   cd /opt/podsovereign && sudo ./install-updater.sh      (older installs: /opt/feedhost)
# =============================================================================
set -uo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT="/etc/systemd/system/podsovereign-updater.service"
log() { echo "[PodSovereign] $*"; }

if ! command -v systemctl >/dev/null 2>&1; then
  log "systemd isn't available. To enable one-click updates, keep ./upgrade-watch.sh running on the server (cron or tmux)."
  exit 0
fi

chmod +x "$INSTALL_DIR/update.sh" "$INSTALL_DIR/upgrade-watch.sh" "$INSTALL_DIR/install-updater.sh" 2>/dev/null || true

if systemctl is-active --quiet podsovereign-updater.service 2>/dev/null; then
  log "The one-click updater service is running."
  exit 0
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
  if ! sudo -n true 2>/dev/null && [ ! -t 0 ]; then
    log "The updater service isn't running, and this session can't use sudo. Run: sudo ./install-updater.sh"
    exit 0
  fi
fi

log "Installing the one-click updater service (podsovereign-updater)…"
$SUDO tee "$UNIT" >/dev/null <<UNITEOF
[Unit]
Description=PodSovereign one-click updater
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/env bash $INSTALL_DIR/upgrade-watch.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNITEOF
$SUDO systemctl daemon-reload
if $SUDO systemctl enable --now podsovereign-updater.service; then
  log "Done. The Update button in Site settings now works."
else
  log "Couldn't start the service. Check: sudo systemctl status podsovereign-updater"
fi
exit 0
