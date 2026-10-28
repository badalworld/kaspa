# Deploying the Kaspa Mining Console

Generated Wed, 28 Oct 2026 20:27:01 GMT from your current panel configuration.

| Setting | Value |
| --- | --- |
| Mode | solo |
| Network | mainnet |
| Address | not set |
| Threads | auto |
| Node data dir | ./data/kaspad |

## Option A — Docker (recommended)

```bash
cp .env.example .env       # optional: adjust the port, add DATABASE_URL
docker compose up -d --build
docker compose logs -f
```

The panel listens on `http://SERVER_IP:8080`.
State, chain data and the wallet keystore live in `./data`.

## Option B — Native systemd install

```bash
sudo bash deploy/install.sh
```

## Option C — Behind HTTPS (nginx + certbot)

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/kaspa-console
sudo ln -s /etc/nginx/sites-available/kaspa-console /etc/nginx/sites-enabled/
sudo certbot --nginx -d your.domain.tld
```

## Ports

| Port | Purpose | Exposure |
| --- | --- | --- |
| 8080 | Dashboard | Public (put HTTPS in front) |
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
   `postgres://avnadmin:PASSWORD@pg-xxxx.aivencloud.com:12345/defaultdb?sslmode=require`).
3. Start the panel with that URI in `DATABASE_URL`:

```bash
DATABASE_URL="postgres://..." docker compose up -d --build
# or in .env:  DATABASE_URL=...
```

The panel creates its `panel_state` table automatically and falls back to the
local file if the database is unreachable, so mining never stops because of a
database hiccup.

`DATABASE_URL` is optional — the default file storage in `./data` is already
durable and requires no extra service.
