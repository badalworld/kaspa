# Kaspa Mining Console

A self-hosted control panel for **Kaspa CPU mining**. It runs the official
[`kaspad`](https://github.com/kaspanet/rusty-kaspa) node and
[`kaspa-miner`](https://github.com/kaspanet/cpuminer) (cpuminer) for you,
watches the hashrate, tracks the node's sync state, estimates earnings, and
generates the deployment files needed to run the whole thing on a VPS.

Built for exactly the setup this project was requested for: a small cloud
server (4 vCPU / 32 GB RAM / 700 GB disk) that you `git clone` and open in a
browser.

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser  ──HTTPS──▶  panel (Node.js, port 8080)                 │
│                          │                                       │
│                          ├── supervises ──▶ kaspad   (:16110 gRPC)│
│                          └── supervises ──▶ kaspa-miner          │
│                                              │                   │
│                                              └── submits blocks   │
└──────────────────────────────────────────────────────────────────┘
```

* No build step, **no npm dependencies** at runtime (Node.js 20+ only).
* Password protected, CSRF-resistant, rate limited; the panel never exposes
  `kaspad`'s RPC to the internet.
* Everything lives in `./data` (config, logs, binaries, chain data, keystore).

---

## 1. Quick start (5 minutes)

**Option A — Docker (recommended)**

```bash
git clone https://github.com/badalworld/kaspa kaspa-console
cd kaspa-console
cp .env.example .env
docker compose up -d --build
```

**Option B — native, with systemd**

```bash
git clone https://github.com/badalworld/kaspa kaspa-console
cd kaspa-console
sudo bash deploy/install.sh     # installs Node, a service user, systemd unit, firewall rules
```

**Option C — already have Node 20+**

```bash
npm start        # http://SERVER_IP:8080
```

On first launch the console prints a **setup token** (also stored in
`data/SETUP_TOKEN.txt`). Open `http://SERVER_IP:8080`, create the administrator
password, paste the token, and you are in.

Then, inside the panel:

1. **Setup → Kaspa payout address** — paste an address, or generate one in the
   **Wallet** tab.
2. **Setup → Binaries → Install kaspad / Install kaspa-miner** — downloads the
   official releases from GitHub into `data/bin` (~50 MB).
3. **Save & start mining.** The panel starts `kaspad`, waits for its gRPC port,
   then starts the miner and begins streaming hashrate.

> Until you install real binaries the panel runs its **simulator**, so the
> dashboard is never empty. Every simulated number is labelled `simulated` /
> `demo data` — it never pretends to be real mining.

---

## 2. What the dashboard gives you

| Page | What you get |
| --- | --- |
| **Overview** | Live hashrate (1 m / 5 m / 15 m), 24 h chart, expected block time, earnings estimate, host CPU/RAM/disk, network hashrate & price, event feed |
| **Setup** | Mining mode (solo / remote node / custom command), mainnet vs testnet, payout address with checksum validation, thread count, node options, binary installer, server plan vs recommendation, start-on-boot |
| **Node** | kaspad status, gRPC port state, peers, DAA score, sync state, chain-data size vs disk |
| **Wallet** | Payout address, on-chain balance, encrypted keystore (generate / import / reveal), guidance on official wallets |
| **Logs** | Live streaming tail of miner and node output, level colouring, download |
| **Deploy** | Dockerfile, docker-compose, systemd unit, nginx + certbot config, install script, `.zip` download — all generated from your current settings |
| **Settings** | Panel name/refresh rate, password change, session list, Slack/Discord webhook alerts, network overrides, storage backend, stop everything |

### The three mining modes

| Mode | What runs on this server | Use when |
| --- | --- | --- |
| **Solo — full node** | `kaspad` + `kaspa-miner` | You want the node to build block templates locally (default, self-sovereign) |
| **Remote node (gRPC)** | `kaspa-miner` only | You already run kaspad elsewhere (another VPS, a home node) |
| **Custom command** | anything you write | GPU miners (lolMiner, SRBMiner) or stratum pool clients; the panel supervises the process and parses its log |

`{{address}}`, `{{worker}}`, `{{threads}}`, `{{network}}`, `{{pool}}` and
`{{port}}` are expanded in custom commands.

---

## 3. Server requirements

| Component | Minimum | Recommended (mainnet node) |
| --- | --- | --- |
| CPU | 2 vCPU | **4 vCPU** (1 core left for the node + panel) |
| RAM | 4 GB | **8–16 GB** (32 GB is plenty; use `--ram-scale` to trim) |
| Disk | 40 GB | **120 GB** pruned / **600 GB+** archival |
| Network | 10 Mbit | 50 Mbit, port **16111/tcp** reachable for a healthy peer count |

The panel shows these as a live checklist in **Setup → Server plan**, comparing
detected hardware against the recommendation for your chosen mode.

### About CPU mining on Kaspa mainnet — read this

`kaspa-miner` is the *official* Kaspa CPU miner, maintained for testnets and
development. CPU mining on Kaspa mainnet has not been competitive since 2022:
the network runs at petahashes per second, and a 4-core server contributes
roughly 4 MH/s — around **10⁻¹⁰ %** of the network. The panel prints the exact
expectation (usually thousands of years per block) instead of hiding it.

Where CPU mining on this setup is genuinely useful:

* **Testnet** — validate the full pipeline (sync → templates → submits) for free.
* **Devnet / rehearsal** — test your infrastructure and monitoring.
* **A private pool** — with a stratum pool of your own, hashrate earns
  proportional shares rather than lottery tickets (use *Custom command* mode).
* **Mainnet for blocks** — requires ASIC hardware; the panel can still supervise
  it through *Custom command* mode.

::: warning
Running a Kaspa mainnet node and mining it with a CPU will not pay for the
server. The console tells you the truth on the Overview page rather than
inventing a number.
:::

---

## 4. Deployment

### Ports

| Port | Purpose | Exposure |
| --- | --- | --- |
| `8080` | Panel / dashboard | Public (behind HTTPS) |
| `16111` / `16211` | kaspad P2P (mainnet / testnet) | Public |
| `16110` / `16210` | kaspad gRPC (block templates) | `127.0.0.1` only |
| `18110` | kaspad wRPC JSON | `127.0.0.1` only |

Never expose `16110` publicly: it accepts block submissions and is only meant
for local miners.

### HTTPS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/kaspa-console
sudo ln -s /etc/nginx/sites-available/kaspa-console /etc/nginx/sites-enabled/
sudo certbot --nginx -d console.example.com
```

`deploy/nginx.conf` proxies only the panel; RPC and P2P are never proxied.
The panel is also safe inside an iframe (e.g. a preview pane) — it sends a CSP
`frame-ancestors` header, restricted to the same origin unless
`PANEL_FRAME_ANCESTORS` says otherwise.

### Aiven — what it can and cannot do

[Aiven](https://console.aiven.io) is a **managed data platform**: PostgreSQL,
Kafka, Redis, OpenSearch, Grafana and similar services. It gives you
connection strings, not a shell — you cannot run long-lived mining daemons
(`kaspad`, `kaspa-miner`) inside it, and it provides no CPU for hashing.

So the working split is:

| Piece | Where it runs |
| --- | --- |
| Node + miner + panel | your VPS (this repository) |
| Panel state (optional) | **Aiven for PostgreSQL** via `DATABASE_URL` |

Enable the Aiven database like this:

1. In the Aiven console create **PostgreSQL** (Hobbyist is enough).
2. Copy the *Service URI*:
   `postgres://avnadmin:PASSWORD@pg-xxxx.aivencloud.com:12345/defaultdb?sslmode=require`
3. Put it in `.env`:

```bash
DATABASE_URL="postgres://avnadmin:.../defaultdb?sslmode=require"
docker compose up -d --build
```

The panel creates its `panel_state` table automatically, writes the config
there, and keeps a local mirror so a database outage never stops mining. Without
`DATABASE_URL` the panel simply uses `data/config.json` — no external service
required.

> If you were looking for "deploy on Aiven", the honest answer is: Aiven hosts
> the *database* for this panel, not the miner. Any VPS (Hetzner, DigitalOcean,
> Contabo, Oracle Cloud…) with the specs above is the right host for mining.

---

## 5. Configuration

All settings are editable in the UI and stored in `data/config.json` (or in
PostgreSQL). Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PANEL_PORT` | `8080` | HTTP port |
| `PANEL_HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | State, logs, binaries, chain data |
| `BIN_DIR` | `$DATA_DIR/bin` | Where the binaries live (Docker uses `/opt/kaspa-bin`) |
| `PANEL_PASSWORD` | – | Seeds the password on first boot (skips the wizard) |
| `DATABASE_URL` | – | PostgreSQL (e.g. Aiven) for panel state |
| `TRUST_PROXY` | `1` | Honour `X-Forwarded-*` when behind nginx |
| `PANEL_FRAME_ANCESTORS` | `'self'` | CSP `frame-ancestors` override |

### Files in `data/`

| Path | Content |
| --- | --- |
| `config.json` | Panel + mining configuration, password hash (scrypt), sessions |
| `wallet.json` | Optional keystore, AES-256-GCM, key derived from the panel password |
| `logs/miner.log`, `logs/node.log` | Rotated process logs (8 MB) |
| `history.json` | 24 h hashrate history |
| `bin/kaspad`, `bin/kaspa-miner` | Downloaded binaries |
| `kaspad/` | Chain database |
| `SETUP_TOKEN.txt` | One-time first-run token (deleted after setup) |

**Backup:** copy `data/config.json` and `data/wallet.json`, plus your Kaspa
address. Chain data can be re-synced, and you should back up the address/private
key in an official wallet rather than in the panel.

---

## 6. Security model

* Passwords: scrypt (`N=2¹⁵`, `r=8`, `p=1`), per-password salt, constant-time compare.
* Sessions: 32-byte random tokens, stored hashed, `HttpOnly` + `SameSite=Strict` cookies, 7-day TTL, max 6 sessions, signed out on password change.
* All state-changing requests require same-origin `Origin` **and** an
  `x-panel-request: 1` header (CSRF defence). Cookies alone never authorise a write.
* Brute force: 5 failures → exponential lockout per IP (up to 15 min).
* First-run claim requires the setup token unless you connect from localhost.
* CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` headers.
* The keystore never leaves the server unencrypted; the private key is only
  returned after re-entering the panel password.
* Panel does **not** open firewall ports on its own; `deploy/install.sh` opens
  only SSH, the panel port and P2P.

Recommended hardening for a public server: put the panel behind HTTPS, keep
`16110` closed, use a strong password, and run it as a non-root service user
(the installer does this).

---

## 7. Development

```bash
npm start          # run the panel
npm run dev        # restart on file changes
npm test           # 29 tests: address codec, log parsers, HTTP API, deploy kit
```

Layout:

```
server/
  index.js      HTTP server, JSON API, routes, static files
  supervisor.js process lifecycle for kaspad / kaspa-miner / custom commands
  installer.js  downloads official GitHub release binaries
  parsers.js    log → hashrate / blocks / shares / sync state
  metrics.js    host sampling, hashrate history, network data, earnings maths
  store.js      JSON file or PostgreSQL persistence
  auth.js       scrypt passwords, sessions, setup token, throttling
  address.js    Kaspa address codec + secp256k1 (zero dependencies)
  wallet.js     encrypted keystore
  deploykit.js  Dockerfile / compose / systemd / nginx / install.sh generator
public/
  index.html, assets/app.js, assets/styles.css   single-page dashboard
test/           node:test suites
```

API surface (all JSON). Requests authenticate with the `HttpOnly` session
cookie, or with `Authorization: Bearer <token>` — the login response returns a
token, which the UI keeps in tab-scoped storage so the panel also works inside
embedded previews where third-party cookies are blocked.

```
GET  /api/health              public health probe
GET  /api/bootstrap           setup state + auth state
POST /api/login  /api/logout  /api/setup
GET  /api/status              everything the dashboard renders
GET  /api/config  PUT /api/config
GET  /api/logs?kind=miner|node&since=<id>
POST /api/miner/start|stop|restart, /api/node/start|stop
POST /api/install {target: node|miner}
GET  /api/wallet/balance, POST /api/wallet/generate|import|reveal|derive
GET  /api/deploy, /api/deploy/download, /api/deploy/zip
```

---

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `kaspad binary not found` | Setup → Install kaspad, or set an absolute path under *Custom miner path* / node path |
| Miner sits in `waiting-node` | The node has not opened its gRPC port yet. First mainnet sync can take 30–90 min; watch **Logs → Node** |
| `Kaspad is not synced` in the miner log | Normal until the node finishes syncing — the miner waits for valid templates |
| Node uses too much RAM | Lower `RAM scale` (e.g. `0.6`) in Setup, keep the node pruned (retention 0) |
| Disk filling up | Disable *Archival node*, set a retention period, or move the data directory to a bigger volume |
| Panel unreachable after reboot | `sudo systemctl status kaspa-console` (native) or `docker compose ps` (Docker) |
| Forgot the panel password | Stop the panel, delete the `auth` block in `data/config.json`, restart, and claim it again with the new setup token |
| `fetch failed` when installing binaries | The server cannot reach GitHub — install the binaries manually and set their paths |

Logs: `journalctl -u kaspa-console -f` (systemd) or `docker compose logs -f`
(Docker); process output is also in `data/logs/`.

---

## 9. Credits & license

* [rusty-kaspa](https://github.com/kaspanet/rusty-kaspa) — Kaspa full node (`kaspad`), MIT/Apache-2.0.
* [kaspanet/cpuminer](https://github.com/kaspanet/cpuminer) — official Kaspa CPU miner, MIT/Apache-2.0.
* Address encoding and secp256k1 handling in `server/address.js` follow the reference implementation and are verified against its test vectors.

This project: MIT. Mining Kaspa is subject to the network's own rules and your
provider's terms — check that your host allows sustained CPU load and P2P
traffic before you start.

---

## 10. FAQ

**Does this mine Kaspa with my 4 CPU / 32 GB / 700 GB server?**
Yes — it runs the official `kaspad` node and `kaspa-miner` with real CPU
hashing, and reports the true expected reward (see §3). Use testnet to validate
the pipeline; mainnet CPU hashrate is negligible.

**Can I deploy this on Aiven?**
Aiven hosts managed data services, not mining daemons. Run the panel on a VPS
and, if you want, point `DATABASE_URL` at an Aiven PostgreSQL instance (§4).

**Do I have to install the binaries myself?**
No. Setup → Binaries downloads the official GitHub releases into `data/bin`.
You can also point the panel at binaries you already have.

**Does it work without internet access to api.kaspa.org?**
Mining does. Only the earnings estimates fall back to built-in defaults, which
you can override in Settings → Network data.

**Where is my private key?**
Nowhere, unless you create or import a key in the Wallet tab. Then it is stored
in `data/wallet.json`, encrypted with AES-256-GCM using a key derived from your
panel password. Back it up, and prefer an address from an official wallet for
real funds.

**How do I update the node or the miner?**
Re-run the installer for that component in Setup → Binaries, then restart.
Config and chain data are preserved.
