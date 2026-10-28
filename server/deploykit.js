'use strict';
/**
 * Generates a ready-to-use deployment kit from the current configuration:
 * docker compose stack, systemd unit, nginx reverse proxy and an install
 * script for a fresh Ubuntu/Debian VPS.
 */

function envFile(config) {
  const lines = [
    '# Kaspa Mining Console — environment',
    `PANEL_PORT=${process.env.PANEL_PORT || 8080}`,
    'DATA_DIR=./data',
    '# Optional: use an external PostgreSQL (for example an Aiven service)',
    '# DATABASE_URL=postgres://user:password@host:port/defaultdb?sslmode=require',
    '# Optional: seeds the panel password on first boot instead of the setup wizard',
    '# PANEL_PASSWORD=change-me',
    '# Binaries directory (the Docker image uses /opt/kaspa-bin)',
    '# BIN_DIR=./data/bin',
    '# Optional: trust X-Forwarded-* headers when running behind a reverse proxy',
    'TRUST_PROXY=1',
    '',
    '# ---- mining configuration is managed in the panel UI ----',
    `MINING_NETWORK=${config.mining.network}`,
    `MINING_ADDRESS=${config.mining.address || 'kaspa:...'}`,
    '',
  ];
  return lines.join('\n');
}

function dockerfile() {
  return `# Kaspa Mining Console — all-in-one image (panel + kaspad + kaspa-miner)
FROM node:22-bookworm-slim

RUN apt-get update \\
 && apt-get install -y --no-install-recommends ca-certificates curl unzip tini procps \\
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Panel sources (no npm dependencies required)
COPY package.json ./
COPY server ./server
COPY public ./public

# Official binaries
ARG MINER_VERSION=v0.2.7
ARG NODE_VERSION=v2.1.0
RUN set -eux; \\
    mkdir -p /opt/kaspa-bin; \\
    curl -fsSL -o /opt/kaspa-bin/kaspa-miner \\
      "https://github.com/kaspanet/cpuminer/releases/download/\${MINER_VERSION}/kaspa-miner-\${MINER_VERSION}-linux-gnu-amd64"; \\
    chmod +x /opt/kaspa-bin/kaspa-miner; \\
    curl -fsSL -o /tmp/kaspad.zip \\
      "https://github.com/kaspanet/rusty-kaspa/releases/download/\${NODE_VERSION}/rusty-kaspa-\${NODE_VERSION}-linux-amd64.zip"; \\
    unzip -o -q /tmp/kaspad.zip -d /tmp/kaspad; \\
    find /tmp/kaspad -name kaspad -type f -exec cp {} /opt/kaspa-bin/kaspad \\;; \\
    chmod +x /opt/kaspa-bin/kaspad; \\
    rm -rf /tmp/kaspad /tmp/kaspad.zip

ENV DATA_DIR=/app/data
ENV BIN_DIR=/opt/kaspa-bin
EXPOSE 8080 16111 16110

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \\
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PANEL_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
`;
}

function compose(config, port = 8080) {
  return `# Kaspa Mining Console — single-container stack
# Usage:  docker compose up -d --build
services:
  kaspa-console:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        MINER_VERSION: v0.2.7
        NODE_VERSION: v2.1.0
    image: kaspa-mining-console:latest
    container_name: kaspa-console
    restart: unless-stopped
    ports:
      - "${port}:8080"          # panel (put HTTPS in front of this)
      - "16111:16111"           # kaspad P2P (needed for a healthy peer count)
    volumes:
      - ./data:/app/data        # config, logs, wallet keystore and chain data
    environment:
      - DATA_DIR=/app/data
      - BIN_DIR=/opt/kaspa-bin
      - TRUST_PROXY=1
      # Both optional, read from .env when present
      - DATABASE_URL=\${DATABASE_URL:-}
      - PANEL_PASSWORD=\${PANEL_PASSWORD:-}
    stop_grace_period: 30s
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

# Mining settings (address, threads, solo vs remote node) live in the panel UI,
# or in ./data/config.json if you prefer to pre-seed them.
# Network: ${config.mining.network}
# Address: ${config.mining.address || '(not set yet)'}
`;
}

function systemdUnit(config) {
  const port = process.env.PANEL_PORT || 8080;
  return `[Unit]
Description=Kaspa Mining Console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${process.env.PANEL_USER || 'kaspa'}
Group=${process.env.PANEL_USER || 'kaspa'}
WorkingDirectory=/opt/kaspa-console
Environment=NODE_ENV=production
Environment=PANEL_PORT=${port}
Environment=DATA_DIR=/opt/kaspa-console/data
Environment=TRUST_PROXY=1
ExecStart=/usr/bin/node /opt/kaspa-console/server/index.js
Restart=always
RestartSec=5
# Allow kaspad to shut down cleanly (it needs time to flush RocksDB)
KillSignal=SIGINT
TimeoutStopSec=60
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target

# Network: ${config.mining.network}
# Mode: ${config.mining.mode}
`;
}

function nginxConfig(config) {
  return `# /etc/nginx/sites-available/kaspa-console
# Replace console.example.com with your domain, then:
#   sudo ln -s /etc/nginx/sites-available/kaspa-console /etc/nginx/sites-enabled/
#   sudo certbot --nginx -d console.example.com
server {
    listen 80;
    listen [::]:80;
    server_name console.example.com;

    # Mining dashboards stream numbers; keep compression on but disable buffering
    # for long polls.
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:${process.env.PANEL_PORT || 8080};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # Never expose the node RPC or the miner to the internet.
    location ~ ^/(api|assets)/ { proxy_pass http://127.0.0.1:${process.env.PANEL_PORT || 8080}; }
}
# Note: kaspad gRPC (16110) and P2P (16111) must NOT be proxied here.
# P2P is opened directly in the firewall; RPC stays bound to 127.0.0.1.
# network: ${config.mining.network}
`;
}

function installScript(config) {
  const port = process.env.PANEL_PORT || 8080;
  return `#!/usr/bin/env bash
# Kaspa Mining Console — one-shot installer for Ubuntu / Debian VPS
# Tested on: Ubuntu 22.04, 24.04, Debian 12
# Requirements: 4 vCPU / 8 GB RAM minimum (16 GB+ recommended for a mainnet node),
#               200 GB free disk (pruned node) or 600 GB+ (archival).
set -euo pipefail

APP_DIR="\${APP_DIR:-/opt/kaspa-console}"
PORT="\${PANEL_PORT:-${port}}"
USER_NAME="\${PANEL_USER:-kaspa}"
REPO_URL="\${REPO_URL:-${DEFAULT_REPO}}"

log() { printf '\\n\\033[1;35m==>\\033[0m %s\\n' "$*"; }

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
  SRC_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
  # Local state (config, logs, chain data) stays untouched
  mkdir -p "$APP_DIR/data"
  if [ "$SRC_DIR" != "$APP_DIR" ]; then
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --exclude data --exclude .git "$SRC_DIR"/ "$APP_DIR"/
    else
      cp -a "$SRC_DIR"/. "$APP_DIR"/ && rm -rf "$APP_DIR/.git"
    fi
  fi
fi
mkdir -p "$APP_DIR/data/logs" "$APP_DIR/data/bin"
chown -R "$USER_NAME":"$USER_NAME" "$APP_DIR"

log "Installing systemd service"
sed -e "s|/opt/kaspa-console|$APP_DIR|g" -e "s|PANEL_PORT=${port}|PANEL_PORT=$PORT|" \\
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

\\033[1;32mKaspa Mining Console is running\\033[0m

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
`;
}

function deployReadme(config) {
  const plan = recommendedPlan(config);
  return `# Deploying the Kaspa Mining Console

Generated ${new Date().toUTCString()} from your current panel configuration.

## Recommended server for this configuration

| Resource | Recommended | Notes |
| --- | --- | --- |
| vCPU | **${plan.vcpu}** | ${plan.solo ? 'one core stays free for the node and the panel' : 'miner only, the node runs elsewhere'} |
| RAM | **${plan.ramGb} GB** | more is fine; trim the node with \`--ram-scale\` |
| Disk | **${plan.diskGb} GB** | ${plan.solo ? (config.node.archival ? 'archival node keeps every block' : 'pruned node, grows with the DAG') : 'miner needs almost no disk'} |
| Bandwidth | 10 Mbit+ | open port 16111/tcp for mainnet P2P |
| Miner threads | **${plan.threads}** | leave one vCPU for the operating system |

| Setting | Value |
| --- | --- |
| Mode | ${config.mining.mode} |
| Network | ${config.mining.network} |
| Address | ${config.mining.address || 'not set'} |
| Threads | ${config.mining.threads || 'auto'} |
| Node data dir | ${config.node.dataDir || './data/kaspad'} |

## Option A — Docker (recommended)

\`\`\`bash
cp .env.example .env       # optional: adjust the port, add DATABASE_URL
docker compose up -d --build
docker compose logs -f
\`\`\`

The panel listens on \`http://SERVER_IP:${process.env.PANEL_PORT || 8080}\`.
State, chain data and the wallet keystore live in \`./data\`.

## Option B — Native systemd install

\`\`\`bash
sudo bash deploy/install.sh
\`\`\`

## Option C — Behind HTTPS (nginx + certbot)

\`\`\`bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/kaspa-console
sudo ln -s /etc/nginx/sites-available/kaspa-console /etc/nginx/sites-enabled/
sudo certbot --nginx -d your.domain.tld
\`\`\`

## Ports

| Port | Purpose | Exposure |
| --- | --- | --- |
| ${process.env.PANEL_PORT || 8080} | Dashboard | Public (put HTTPS in front) |
| 16111 | kaspad P2P mainnet | Public |
| 16211 | kaspad P2P testnet | Public |
| 16110 | kaspad gRPC (mining) | Localhost only |
| 18110 | kaspad wRPC JSON | Localhost only |

## Using Aiven

Aiven is a managed data platform: it runs databases, Kafka, Redis and similar
services. It does **not** provide a shell or allow long-running mining daemons,
so the miner and the node cannot run inside the Aiven console.

What you *can* do with Aiven is keep the console's state in a managed database:

1. Create an **Aiven for PostgreSQL** service (Hobbyist plan is enough).
2. Copy the *Service URI* (it looks like
   \`postgres://avnadmin:PASSWORD@pg-xxxx.aivencloud.com:12345/defaultdb?sslmode=require\`).
3. Start the panel with that URI in \`DATABASE_URL\`:

\`\`\`bash
DATABASE_URL="postgres://..." docker compose up -d --build
# or in .env:  DATABASE_URL=...
\`\`\`

The panel creates its \`panel_state\` table automatically and falls back to the
local file if the database is unreachable, so mining never stops because of a
database hiccup.

\`DATABASE_URL\` is optional — the default file storage in \`./data\` is already
durable and requires no extra service.
`;
}

const DEFAULT_REPO = process.env.REPO_URL || 'https://github.com/badalworld/kaspa';

/** Recommendation for the requested workload, expressed in generic units. */
function recommendedPlan(config, port) {
  const solo = config.mining.mode === 'solo';
  const threads = Number(config.mining.threads) || Math.max(1, (port ? 4 : 4) - 1);
  return {
    solo,
    vcpu: solo ? 4 : 2,
    ramGb: solo ? 8 : 2,
    diskGb: solo ? (config.node.archival ? 600 : 120) : 5,
    threads: solo ? Math.max(1, 4 - 1) : threads,
  };
}

function buildKit(config, { port } = {}) {
  const effectivePort = port || process.env.PANEL_PORT || 8080;
  return [
    { name: 'Dockerfile', content: dockerfile(), language: 'dockerfile' },
    { name: 'docker-compose.yml', content: compose(config, effectivePort), language: 'yaml' },
    { name: '.env.example', content: envFile(config), language: 'ini' },
    { name: 'deploy/install.sh', content: installScript(config), language: 'bash' },
    { name: 'deploy/kaspa-console.service', content: systemdUnit(config), language: 'ini' },
    { name: 'deploy/nginx.conf', content: nginxConfig(config), language: 'nginx' },
    { name: 'DEPLOY.md', content: deployReadme(config), language: 'markdown' },
  ];
}

module.exports = {
  buildKit,
  dockerfile,
  compose,
  envFile,
  systemdUnit,
  nginxConfig,
  installScript,
  deployReadme,
  recommendedPlan,
  DEFAULT_REPO,
};
