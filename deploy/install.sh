#!/usr/bin/env bash
# Kaspa Mining Console — one-shot installer for Ubuntu / Debian VPS
# Tested on: Ubuntu 22.04, 24.04, Debian 12
# Requirements: 4 vCPU / 8 GB RAM minimum (16 GB+ recommended for a mainnet node),
#               200 GB free disk (pruned node) or 600 GB+ (archival).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/kaspa-console}"
PORT="${PANEL_PORT:-8080}"
USER_NAME="${PANEL_USER:-kaspa}"
REPO_URL="${REPO_URL:-https://github.com/badalworld/kaspa}"

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root: sudo bash deploy/install.sh" >&2
  exit 1
fi

log "Installing base packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates unzip jq procps ufw rsync

log "Ensuring Node.js 22"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

log "Creating service user"
id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$USER_NAME"

log "Copying the console into $APP_DIR"
mkdir -p "$APP_DIR"
if [ -n "$REPO_URL" ]; then
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only
  else
    git clone --depth 1 "$REPO_URL" "$APP_DIR"
  fi
else
  # Running from inside a checkout: copy everything except local state
  SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [ "$SRC_DIR" != "$APP_DIR" ]; then
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --exclude data --exclude .git "$SRC_DIR"/ "$APP_DIR"/
    else
      cp -a "$SRC_DIR"/. "$APP_DIR"/ && rm -rf "$APP_DIR/data" "$APP_DIR/.git"
    fi
  fi
fi
mkdir -p "$APP_DIR/data/logs" "$APP_DIR/data/bin"
chown -R "$USER_NAME":"$USER_NAME" "$APP_DIR"

log "Installing systemd service"
sed -e "s|/opt/kaspa-console|$APP_DIR|g" -e "s|PANEL_PORT=8080|PANEL_PORT=$PORT|" \
  "$APP_DIR/deploy/kaspa-console.service" > /etc/systemd/system/kaspa-console.service
systemctl daemon-reload
systemctl enable kaspa-console
systemctl restart kaspa-console

if command -v ufw >/dev/null 2>&1; then
  log "Configuring firewall (SSH, panel, Kaspa P2P)"
  ufw allow 22/tcp || true
  ufw allow "$PORT"/tcp || true
  ufw allow 16111/tcp || true   # mainnet P2P
  ufw allow 16211/tcp || true   # testnet P2P
  yes | ufw enable || true
fi

sleep 2
SETUP_TOKEN="$(cat "$APP_DIR/data/SETUP_TOKEN.txt" 2>/dev/null || echo '(already configured)')"

cat <<EOF

\033[1;32mKaspa Mining Console is running\033[0m

  URL ............ http://$(hostname -I | awk '{print $1}'):$PORT
  Setup token .... $SETUP_TOKEN

Next steps:
  1. Open the URL, create the panel password and paste the setup token.
  2. Enter your Kaspa address (or generate one in the Wallet tab).
  3. Open Setup -> "Install binaries" (kaspad + kaspa-miner, ~50 MB).
  4. Press Start. The node then syncs; mining begins automatically once the
     node serves block templates.
  5. Point your domain at this server and run certbot for HTTPS:
        apt-get install -y certbot python3-certbot-nginx
        certbot --nginx -d your.domain.tld

Logs:   journalctl -u kaspa-console -f
Data:   $APP_DIR/data   (chain data, logs, wallet keystore)
EOF
