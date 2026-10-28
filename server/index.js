'use strict';
/**
 * Kaspa Mining Console — HTTP server and JSON API.
 *
 * Zero runtime dependencies: only the Node.js standard library (Node >= 20).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { ROOT, DATA_DIR, LOG_DIR, BIN_DIR, readJson, formatHashrate, humanDuration, dirSizeBytes, isExecutable } = require('./util');
const { Store, CONFIG_FILE, mergeDeep, assignInPlace } = require('./store');
const auth = require('./auth');
const { Supervisor, portOpen } = require('./supervisor');
const { HostMetrics, History, NetworkService, estimate } = require('./metrics');
const { Installer } = require('./installer');
const { buildKit } = require('./deploykit');
const wallet = require('./wallet');
const { validateAddress, generateWallet, addressFromPrivateKey } = require('./address');

const VERSION = require('../package.json').version;
const PORT = Number(process.env.PANEL_PORT || 8080);
const HOST = process.env.PANEL_HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(ROOT, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/* --------------------------------------------------------------------- */
/* helpers                                                               */
/* --------------------------------------------------------------------- */

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '';
}

function isSecure(req) {
  if (req.socket.encrypted) return true;
  return TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function isLocalRequest(req) {
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(text);
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length, ...headers });
  res.end(body);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function securityHeaders(req, res) {
  const host = String(req.headers.host || '');
  const previewHost = /\.e2b\.app$/i.test(host) || /\.arena\./i.test(host);
  const ancestors = process.env.PANEL_FRAME_ANCESTORS || (previewHost ? '*' : "'self'");
  res.setHeader(
    'content-security-policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      `frame-ancestors ${ancestors}`,
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  );
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');
}

/* --------------------------------------------------------------------- */
/* boot                                                                  */
/* --------------------------------------------------------------------- */

const firstBoot = !fs.existsSync(CONFIG_FILE);

const store = new Store();
const hostMetrics = new HostMetrics();
const history = new History();
const networkService = new NetworkService({ store });
const installer = new Installer();

let lastNetwork = {
  online: false,
  demo: false,
  updatedAt: 0,
  hashrate: 0,
  price: 0,
  blockReward: 0,
  blockTimeSec: 0.1,
  difficulty: 0,
  height: 0,
};

const events = [];
function recordEvent(type, message, level = 'info') {
  const event = { id: crypto.randomUUID(), type, message, level, at: Date.now() };
  events.unshift(event);
  if (events.length > 80) events.pop();
  return event;
}

/** Give the simulator a short visible history so the chart is not a lone dot. */
function seedDemoHistory() {
  if (history.samples.length > 4) return;
  const rate = supervisor.state.miner.hashrate || 0;
  if (rate <= 0) return;
  const values = [];
  for (let i = 0; i < 30; i++) {
    const wobble = 0.82 + Math.random() * 0.36;
    values.push(Math.round(rate * wobble));
  }
  history.seed(values);
}

async function notifyWebhook(title, message) {
  const url = store.config.alerts?.webhookUrl;
  if (!url) return;
  try {
    let body;
    if (/discord(app)?\.com/i.test(url)) body = { content: `**${title}**\n${message}` };
    else if (/hooks\.slack\.com/i.test(url)) body = { text: `*${title}*\n${message}` };
    else body = { title, message, host: os.hostname(), at: new Date().toISOString() };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.error('[alerts] webhook failed:', err.message);
  }
}

const supervisor = new Supervisor({
  store,
  emit: (type, payload) => {
    if (type === 'hashrate') history.push(payload.value);
    if (type === 'block') {
      recordEvent('block', `Block found: ${payload.hash.slice(0, 20)}…`, 'success');
      if (store.config.alerts?.notifyOnBlock !== false) {
        notifyWebhook('Kaspa block found', `${payload.hash}\nHost: ${os.hostname()}`);
      }
    }
    if (type === 'state' && payload?.miner?.status === 'error' && store.config.alerts?.notifyOnCrash !== false) {
      const message = payload.miner.lastError || 'miner process stopped unexpectedly';
      if (!events.some((e) => e.type === 'crash' && Date.now() - e.at < 60000)) {
        recordEvent('crash', `Miner problem: ${message}`, 'error');
        notifyWebhook('Miner stopped', message);
      }
    }
  },
});

let nodeDirCache = { at: 0, bytes: 0 };

function nodeDataUsage() {
  const now = Date.now();
  if (now - nodeDirCache.at < 30000) return nodeDirCache.bytes;
  const dir = supervisor.nodeDataDir();
  const bytes = fs.existsSync(dir) ? dirSizeBytes(dir) : 0;
  nodeDirCache = { at: now, bytes };
  return bytes;
}

function currentHashrate() {
  const live = supervisor.state.miner.hashrate || 0;
  const recent = history.average(60);
  if (live > 0) return live;
  return recent;
}

function buildStatus() {
  const config = store.config;
  const miner = supervisor.state.miner;
  const node = supervisor.state.node;
  const h1 = history.average(60);
  const h5 = history.average(300);
  const h15 = history.average(900);
  const effective = currentHashrate();
  const myHash = h5 > 0 ? h5 : effective;
  const net = { ...lastNetwork };
  const isTestnet = config.mining.network === 'testnet';
  const est = estimate({ myHashrate: myHash, network: net, networkId: config.mining.network });
  const blocks24h = miner.blocks.filter((b) => Date.now() - b.at < 24 * 3600 * 1000).length;
  const lastBlock = miner.blocks[0] || null;
  const binaries = supervisor.binaries();
  const uptime = miner.startedAt && miner.status === 'running' ? Math.floor((Date.now() - miner.startedAt) / 1000) : 0;

  return {
    version: VERSION,
    serverTime: Date.now(),
    startedAt: hostMetrics.startedAt,
    setup: {
      required: !config.setupComplete,
      hasPassword: Boolean(config.auth?.password),
      demo: config.panel.demoMode || supervisor.isDemoRunning(),
    },
    backend: store.backend,
    panel: {
      name: config.panel.name,
      demoMode: config.panel.demoMode,
      refreshMs: config.panel.refreshMs,
    },
    mining: {
      mode: config.mining.mode,
      network: config.mining.network,
      address: config.mining.address,
      threads: config.mining.threads,
      autoStart: config.mining.autoStart,
      restartOnCrash: config.mining.restartOnCrash,
      poolUrl: config.mining.poolUrl,
      workerName: config.mining.workerName || os.hostname(),
      remoteHost: config.mining.remoteHost,
      remotePort: config.mining.remotePort,
    },
    miner: {
      ...miner,
      uptimeSec: uptime,
      uptimeText: humanDuration(uptime),
      statusText: miner.simulated ? 'simulated' : miner.status,
      hashrateText: formatHashrate(miner.hashrate).text,
      windows: {
        h1: { value: h1, text: formatHashrate(h1).text },
        h5: { value: h5, text: formatHashrate(h5).text },
        h15: { value: h15, text: formatHashrate(h15).text },
      },
      blocks24h,
      lastBlock,
      effectiveHashrate: myHash,
      effectiveText: formatHashrate(myHash).text,
    },
    node: {
      ...node,
      requiresNode: config.mining.mode === 'solo' && config.node.enabled !== false,
      dataDir: supervisor.nodeDataDir(),
      dataBytes: nodeDataUsage(),
      rpcPort: supervisor.rpcPort(),
      uptimeSec: node.startedAt && node.status === 'running' ? Math.floor((Date.now() - node.startedAt) / 1000) : 0,
    },
    host: hostMetrics.snapshot(),
    network: {
      ...net,
      testnet: isTestnet,
      hashrateText: formatHashrate(net.hashrate).text,
      mySharePct: net.hashrate > 0 ? (myHash / net.hashrate) * 100 : 0,
      stale: Date.now() - (net.updatedAt || 0) > 180000,
    },
    estimate: {
      ...est,
      kasPerDayText: isTestnet ? 'testnet (no value)' : formatKas(est.kasPerDay),
      usdPerDayText: isTestnet ? '—' : `$${formatUsd(est.usdPerDay)}`,
      bitcoinStyle:
        isTestnet
          ? null
          : est.expectedSecondsPerBlock
            ? humanDuration(est.expectedSecondsPerBlock)
            : 'never',
      blocksPerDayText: est.blocksPerDay >= 0.01 ? est.blocksPerDay.toFixed(3) : est.blocksPerDay.toExponential(2),
    },
    binaries,
    install: installer.state,
    history: history.series(120),
    events: events.slice(0, 25),
    resources: {
      nodeDirBytes: nodeDataUsage(),
      logsBytes: safeSize(LOG_DIR),
      cpuCores: os.cpus().length,
      plan: hardwarePlan(),
    },
  };
}

function safeSize(dir) {
  try {
    return dirSizeBytes(dir);
  } catch {
    return 0;
  }
}

function hardwarePlan() {
  const host = hostMetrics.snapshot();
  const cores = host.cores;
  const ramGb = host.memTotal / 1024 ** 3;
  const diskGb = host.diskFree / 1024 ** 3;
  const mode = store.config.mining.mode;
  const needsNode = mode === 'solo' && store.config.node.enabled !== false;
  const archival = Boolean(store.config.node?.archival);
  const recommended = {
    cores: needsNode ? 4 : 2,
    ramGb: needsNode ? 8 : 2,
    diskGb: needsNode ? (archival ? 600 : 120) : 5,
  };
  const checks = [
    { key: 'cores', label: 'CPU cores', value: cores, unit: 'vCPU', recommended: recommended.cores },
    { key: 'ram', label: 'Memory', value: Number(ramGb.toFixed(1)), unit: 'GB', recommended: recommended.ramGb },
    { key: 'disk', label: 'Free disk', value: Number(diskGb.toFixed(0)), unit: 'GB', recommended: recommended.diskGb },
  ].map((c) => ({ ...c, ok: c.value >= c.recommended }));
  return {
    checks,
    ok: checks.every((c) => c.ok),
    suggestedThreads: Math.max(1, cores - (needsNode ? 1 : 0)),
    mode,
    archival,
  };
}

function formatKas(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 KAS';
  if (value < 0.000001) return `${value.toExponential(2)} KAS`;
  if (value < 1) return `${value.toFixed(6)} KAS`;
  return `${value.toFixed(4)} KAS`;
}

function formatUsd(value) {
  if (!Number.isFinite(value) || value <= 0) return '0.00';
  if (value < 0.01) return value.toFixed(6);
  return value.toFixed(2);
}

/* --------------------------------------------------------------------- */
/* config patching                                                       */
/* --------------------------------------------------------------------- */

function bool(value) {
  return value === true || value === 'true' || value === 1;
}

function applyConfigPatch(patch, { requireAddress = false } = {}) {
  const config = store.config;
  const next = mergeDeep(config, {});
  const errors = [];
  const p = patch || {};

  if (p.panel) {
    if (typeof p.panel.name === 'string') next.panel.name = p.panel.name.slice(0, 60) || 'Kaspa Mining Console';
    if ('demoMode' in p.panel) next.panel.demoMode = bool(p.panel.demoMode);
    if (p.panel.refreshMs) next.panel.refreshMs = Math.min(30000, Math.max(1000, Number(p.panel.refreshMs) || 3000));
    if (typeof p.panel.publicUrl === 'string') next.panel.publicUrl = p.panel.publicUrl.slice(0, 200);
  }

  if (p.mining) {
    const m = p.mining;
    if (m.mode) {
      if (!['solo', 'remote', 'custom'].includes(m.mode)) errors.push('Unknown mining mode');
      else next.mining.mode = m.mode;
    }
    if (m.network) {
      if (!['mainnet', 'testnet'].includes(m.network)) errors.push('Unknown network');
      else next.mining.network = m.network;
    }
    if (typeof m.address === 'string') {
      const address = m.address.trim();
      if (!address) next.mining.address = '';
      else {
        const check = validateAddress(address);
        if (!check.valid) errors.push(`Invalid Kaspa address: ${check.error}`);
        else {
          const wanted = next.mining.network === 'testnet' ? 'testnet' : 'mainnet';
          if (check.network !== wanted) {
            errors.push(`Address is a ${check.network} address but the miner is set to ${next.mining.network}`);
          } else next.mining.address = address;
        }
      }
    }
    if (m.threads !== undefined) {
      const threads = Number(m.threads);
      const max = os.cpus().length * 4;
      if (!Number.isFinite(threads) || threads < 0 || threads > max) errors.push(`Threads must be between 0 and ${max}`);
      else next.mining.threads = Math.floor(threads);
    }
    if ('autoStart' in m) next.mining.autoStart = bool(m.autoStart);
    if ('restartOnCrash' in m) next.mining.restartOnCrash = bool(m.restartOnCrash);
    if (typeof m.minerPath === 'string') next.mining.minerPath = m.minerPath;
    if (typeof m.minerExtraArgs === 'string') next.mining.minerExtraArgs = m.minerExtraArgs.slice(0, 500);
    if (typeof m.remoteHost === 'string') next.mining.remoteHost = m.remoteHost.trim().slice(0, 120);
    if (m.remotePort !== undefined) {
      const port = Number(m.remotePort);
      if (!Number.isFinite(port) || port < 1 || port > 65535) errors.push('Remote port must be 1-65535');
      else next.mining.remotePort = Math.floor(port);
    }
    if (typeof m.customCommand === 'string') next.mining.customCommand = m.customCommand.slice(0, 2000);
    if (typeof m.customWorkDir === 'string') next.mining.customWorkDir = m.customWorkDir.slice(0, 300);
    if (typeof m.poolUrl === 'string') next.mining.poolUrl = m.poolUrl.slice(0, 200);
    if (typeof m.workerName === 'string') next.mining.workerName = m.workerName.replace(/[^\w.-]/g, '').slice(0, 40);
  }

  if (p.node) {
    const n = p.node;
    if ('enabled' in n) next.node.enabled = bool(n.enabled);
    if (typeof n.path === 'string') next.node.path = n.path;
    if (typeof n.dataDir === 'string') next.node.dataDir = n.dataDir.slice(0, 300);
    if ('utxoIndex' in n) next.node.utxoIndex = bool(n.utxoIndex);
    if ('archival' in n) next.node.archival = bool(n.archival);
    if (n.retentionDays !== undefined) {
      const days = Number(n.retentionDays);
      if (!Number.isFinite(days) || days < 0 || days > 3650) errors.push('Retention must be 0-3650 days');
      else next.node.retentionDays = days;
    }
    if (n.ramScale !== undefined) {
      const scale = Number(n.ramScale);
      if (!Number.isFinite(scale) || scale < 0.1 || scale > 10) errors.push('RAM scale must be 0.1-10');
      else next.node.ramScale = scale;
    }
    if ('exposeRpc' in n) next.node.exposeRpc = bool(n.exposeRpc);
    if ('exposeP2P' in n) next.node.exposeP2P = bool(n.exposeP2P);
    if ('disableUpnp' in n) next.node.disableUpnp = bool(n.disableUpnp);
    if (typeof n.extraArgs === 'string') next.node.extraArgs = n.extraArgs.slice(0, 500);
  }

  if (p.alerts) {
    const a = p.alerts;
    if (typeof a.webhookUrl === 'string') {
      const url = a.webhookUrl.trim();
      if (url && !/^https?:\/\//i.test(url)) errors.push('Webhook URL must start with http:// or https://');
      else next.alerts.webhookUrl = url.slice(0, 500);
    }
    if ('notifyOnBlock' in a) next.alerts.notifyOnBlock = bool(a.notifyOnBlock);
    if ('notifyOnCrash' in a) next.alerts.notifyOnCrash = bool(a.notifyOnCrash);
    if (a.lowHashratePct !== undefined) next.alerts.lowHashratePct = Math.max(0, Math.min(100, Number(a.lowHashratePct) || 0));
  }

  if (p.network) {
    const n = p.network;
    if (n.blockRewardOverride !== undefined) next.network.blockRewardOverride = Math.max(0, Number(n.blockRewardOverride) || 0);
    if (n.priceOverride !== undefined) next.network.priceOverride = Math.max(0, Number(n.priceOverride) || 0);
  }

  if (requireAddress && !next.mining.address && next.mining.mode !== 'custom') {
    errors.push('A Kaspa mining address is required');
  }

  if (errors.length) return { ok: false, error: errors.join(' · ') };
  assignInPlace(store.cache, next);
  return { ok: true };
}

/* --------------------------------------------------------------------- */
/* zip (store only — no compression library needed)                      */
/* --------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

/* --------------------------------------------------------------------- */
/* authentication middleware                                             */
/* --------------------------------------------------------------------- */

/**
 * Session resolution order:
 *   1. Authorization: Bearer <token>  — works inside third-party iframes and
 *      previews where cookies are blocked; the token lives in tab-scoped storage.
 *   2. HttpOnly session cookie.
 */
function sessionFromRequest(req) {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (bearer) {
    const session = auth.findSession(store.config, bearer[1].trim());
    if (session) {
      session.lastSeen = Date.now();
      return { session, token: bearer[1].trim(), via: 'bearer' };
    }
  }
  const cookies = auth.parseCookies(req);
  const token = cookies[auth.COOKIE_NAME];
  const session = auth.findSession(store.config, token);
  if (!session) return { session: null, token: null };
  session.lastSeen = Date.now();
  return { session, token, via: 'cookie' };
}

/** Cookies: cross-site (preview/iframe) requests need SameSite=None + Secure. */
function cookiePolicy(req) {
  const host = String(req.headers.host || '');
  const embedded = /\.e2b\.app$/i.test(host) || /(^|\.)arena\./i.test(host) || process.env.PANEL_COOKIE_SAMESITE === 'none';
  if (embedded) return { secure: true, sameSite: 'None' };
  return { secure: isSecure(req), sameSite: 'Lax' };
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = String(req.headers.host || '');
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------- */
/* routes                                                                */
/* --------------------------------------------------------------------- */

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const { session, token } = sessionFromRequest(req);
  const config = store.config;

  /* ---------------------------- public ---------------------------- */

  if (route === 'GET /api/health') {
    return sendJson(res, 200, { ok: true, version: VERSION, uptime: Math.floor(process.uptime()) });
  }

  if (route === 'GET /api/bootstrap') {
    return sendJson(res, 200, {
      version: VERSION,
      setupRequired: !config.setupComplete,
      hasPassword: Boolean(config.auth?.password),
      authenticated: Boolean(session),
      setupTokenRequired: !config.auth?.password && !isLocalRequest(req),
      setupTokenHint: !config.auth?.password && isLocalRequest(req) ? null : auth.getSetupToken(),
      localRequest: isLocalRequest(req),
      backend: store.backend,
      firstBoot,
    });
  }

  if (route === 'POST /api/login') {
    if (!originAllowed(req) || req.headers['x-panel-request'] !== '1') {
      return sendJson(res, 403, { ok: false, error: 'Rejected request origin' });
    }
    const throttle = auth.checkThrottle(clientIp(req));
    if (!throttle.allowed) {
      return sendJson(res, 429, { ok: false, error: `Too many attempts. Try again in ${throttle.retryAfterSec}s.` });
    }
    const body = await readBody(req);
    const passwordOk = await auth.verifyPassword(String(body.password || ''), config.auth.password, config.auth.salt);
    if (!passwordOk) {
      auth.registerFailure(clientIp(req));
      return sendJson(res, 401, { ok: false, error: 'Wrong password' });
    }
    auth.registerSuccess(clientIp(req));
    const newToken = auth.createSession(config, { ip: clientIp(req), ua: req.headers['user-agent'] });
    await store.save();
    res.setHeader('set-cookie', auth.sessionCookie(newToken, cookiePolicy(req)));
    return sendJson(res, 200, { ok: true, token: newToken });
  }

  if (route === 'POST /api/setup') {
    if (!originAllowed(req)) return sendJson(res, 403, { ok: false, error: 'Rejected request origin' });
    const body = await readBody(req);
    const hasPassword = Boolean(config.auth?.password);

    if (!hasPassword) {
      const password = String(body.password || '');
      const problem = auth.passwordProblem(password);
      if (problem) return sendJson(res, 400, { ok: false, error: problem });
      const tokenRequired = !isLocalRequest(req);
      if (tokenRequired && String(body.setupToken || '').trim().toUpperCase() !== auth.getSetupToken()) {
        return sendJson(res, 403, { ok: false, error: 'Invalid setup token (see data/SETUP_TOKEN.txt on the server)' });
      }
      const { hash, salt } = await auth.hashPassword(password);
      config.auth.password = hash;
      config.auth.salt = salt;
      config.auth.updatedAt = new Date().toISOString();
    } else if (!session) {
      return sendJson(res, 401, { ok: false, error: 'Log in to change the configuration' });
    }

    const patch = body.config || body;
    const result = applyConfigPatch(patch, { requireAddress: false });
    if (!result.ok) {
      if (!hasPassword) {
        config.auth.password = null;
        config.auth.salt = null;
      }
      await store.save();
      return sendJson(res, 400, { ok: false, error: result.error });
    }
    config.setupComplete = true;
    await store.save();
    auth.clearSetupToken();

    const newToken = auth.createSession(config, { ip: clientIp(req), ua: req.headers['user-agent'] });
    await store.save();
    res.setHeader('set-cookie', auth.sessionCookie(newToken, cookiePolicy(req)));
    return sendJson(res, 200, { ok: true, token: newToken, status: buildStatus() });
  }

  if (route === 'POST /api/address/validate') {
    const body = await readBody(req);
    const check = validateAddress(body.address);
    return sendJson(res, 200, check);
  }

  /* --------------------------- protected -------------------------- */

  if (url.pathname.startsWith('/api/') && !session) {
    return sendJson(res, 401, { ok: false, error: 'Not authenticated', login: true });
  }

  if (req.method !== 'GET' && req.headers['x-panel-request'] !== '1') {
    return sendJson(res, 403, { ok: false, error: 'Missing x-panel-request header' });
  }
  if (req.method !== 'GET' && !originAllowed(req)) {
    return sendJson(res, 403, { ok: false, error: 'Rejected request origin' });
  }

  if (route === 'POST /api/logout') {
    auth.destroySession(config, token);
    await store.save();
    res.setHeader('set-cookie', auth.clearCookie());
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'GET /api/status') {
    return sendJson(res, 200, buildStatus());
  }

  if (route === 'GET /api/logs') {
    const kind = url.searchParams.get('kind') === 'node' ? 'node' : 'miner';
    const since = Number(url.searchParams.get('since') || 0);
    const preset = url.searchParams.get('preset');
    // preset=recent -> newest page including history; otherwise incremental by id
    const lines =
      since > 0 && preset !== 'recent' ? supervisor.logs[kind].since(since, 400) : supervisor.logs[kind].tail(300);
    return sendJson(res, 200, {
      kind,
      lines,
      lastId: lines.length ? lines[lines.length - 1].id : since,
    });
  }

  if (route === 'GET /api/config') {
    const { auth: authConfig, ...rest } = config;
    return sendJson(res, 200, {
      config: rest,
      passwordSet: Boolean(authConfig?.password),
      sessions: (authConfig?.sessions || []).map((s) => ({ createdAt: s.createdAt, ip: s.ip, ua: s.ua })),
      wallet: wallet.walletSummary(),
      system: {
        cores: os.cpus().length,
        cpuModel: hostMetrics.cpuModel,
        memTotal: os.totalmem(),
        platform: `${os.type()} ${os.release()} ${os.arch()}`,
        hostname: os.hostname(),
        nodeVersion: process.version,
        dataDir: DATA_DIR,
        binDir: BIN_DIR,
      },
    });
  }

  if (route === 'PUT /api/config') {
    const body = await readBody(req);
    const result = applyConfigPatch(body, { requireAddress: Boolean(body.requireAddress) });
    if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
    if (store.config.mining.address && store.config.auth?.password) store.config.setupComplete = true;
    await store.save();
    if (body.panel && 'demoMode' in body.panel && !store.config.panel.demoMode && supervisor.isDemoRunning()) {
      await supervisor.stop();
    }
    return sendJson(res, 200, { ok: true, status: buildStatus() });
  }

  if (route === 'POST /api/auth/password') {
    const body = await readBody(req);
    const current = String(body.current || '');
    const next = String(body.next || '');
    const valid = await auth.verifyPassword(current, config.auth.password, config.auth.salt);
    if (!valid) return sendJson(res, 401, { ok: false, error: 'Current password is incorrect' });
    const problem = auth.passwordProblem(next);
    if (problem) return sendJson(res, 400, { ok: false, error: problem });
    try {
      wallet.reencryptWallet({ oldPassword: current, newPassword: next });
    } catch {
      /* no wallet stored, or it was created with another password */
    }
    const { hash, salt } = await auth.hashPassword(next);
    config.auth.password = hash;
    config.auth.salt = salt;
    config.auth.updatedAt = new Date().toISOString();
    config.auth.sessions = [];
    await store.save();
    res.setHeader('set-cookie', auth.clearCookie());
    return sendJson(res, 200, { ok: true });
  }

  /* ---------------------------- mining ---------------------------- */

  if (route === 'POST /api/miner/start') {
    const body = await readBody(req);
    // Never silently fall back to the simulator: only run it when explicitly asked.
    const demo = Boolean(body.demo);
    if (!demo) {
      const check = applyConfigPatch({}, { requireAddress: true });
      if (!check.ok) return sendJson(res, 400, { ok: false, error: check.error });
    }
    const result = await supervisor.start({ demo });
    if (!result.ok) return sendJson(res, 409, result);
    return sendJson(res, 200, { ok: true, demo: Boolean(result.demo), status: buildStatus() });
  }

  if (route === 'POST /api/miner/stop') {
    await supervisor.stop();
    return sendJson(res, 200, { ok: true, status: buildStatus() });
  }

  if (route === 'POST /api/miner/restart') {
    await supervisor.restart();
    return sendJson(res, 200, { ok: true, status: buildStatus() });
  }

  if (route === 'POST /api/node/start') {
    const result = await supervisor.startNode();
    return sendJson(res, result.ok ? 200 : 409, result);
  }

  if (route === 'POST /api/node/stop') {
    const result = await supervisor.stop({ keepNode: false });
    return sendJson(res, 200, result);
  }

  /* --------------------------- installer -------------------------- */

  if (route === 'GET /api/install') {
    return sendJson(res, 200, { ...installer.state, binaries: supervisor.binaries() });
  }

  if (route === 'POST /api/install') {
    const body = await readBody(req);
    const target = body.target === 'node' ? 'node' : 'miner';
    if (installer.state.running) return sendJson(res, 409, { ok: false, error: 'An install is already running' });
    installer.state = { running: false, target: null, step: '', percent: 0, message: '', error: null, done: false, sha256: null };
    const promise = target === 'node' ? installer.installNode() : installer.installMiner();
    promise.then((state) => {
      if (state.done) {
        if (state.target === 'node') store.config.node.path = state.path;
        else store.config.mining.minerPath = state.path;
        store.save();
        recordEvent('install', state.message, 'success');
      } else if (state.error) {
        recordEvent('install', `Install failed: ${state.error}`, 'error');
      }
    });
    return sendJson(res, 202, { ok: true, state: installer.state });
  }

  /* ---------------------------- wallet ---------------------------- */

  if (route === 'GET /api/wallet') {
    return sendJson(res, 200, { ...wallet.walletSummary(), address: wallet.walletSummary().address || config.mining.address });
  }

  if (route === 'POST /api/wallet/generate') {
    const body = await readBody(req);
    const network = body.network === 'testnet' ? 'testnet' : 'mainnet';
    const password = String(body.password || '');
    const valid = await auth.verifyPassword(password, config.auth.password, config.auth.salt);
    if (!valid) return sendJson(res, 401, { ok: false, error: 'Panel password required to store the key' });
    const created = wallet.createWallet({ network, password });
    config.mining.address = created.address;
    config.mining.network = network;
    await store.save();
    recordEvent('wallet', `New ${network} address generated`, 'success');
    return sendJson(res, 200, { ok: true, address: created.address, privateKey: created.privateKeyHex });
  }

  if (route === 'POST /api/wallet/import') {
    const body = await readBody(req);
    const password = String(body.password || '');
    const valid = await auth.verifyPassword(password, config.auth.password, config.auth.salt);
    if (!valid) return sendJson(res, 401, { ok: false, error: 'Panel password required to store the key' });
    try {
      const network = body.network === 'testnet' ? 'testnet' : 'mainnet';
      const imported = wallet.importWallet({ privateKeyHex: String(body.privateKey || ''), network, password });
      config.mining.address = imported.address;
      config.mining.network = network;
      await store.save();
      return sendJson(res, 200, { ok: true, address: imported.address });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (route === 'POST /api/wallet/reveal') {
    const body = await readBody(req);
    const valid = await auth.verifyPassword(String(body.password || ''), config.auth.password, config.auth.salt);
    if (!valid) return sendJson(res, 401, { ok: false, error: 'Panel password is incorrect' });
    try {
      return sendJson(res, 200, { ok: true, privateKey: wallet.revealPrivateKey(String(body.password)) });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (route === 'GET /api/wallet/balance') {
    const address = url.searchParams.get('address') || store.config.mining.address;
    const balance = await networkService.balance(address);
    return sendJson(res, 200, { ok: true, ...balance });
  }

  if (route === 'POST /api/wallet/derive') {
    const body = await readBody(req);
    try {
      const network = body.network === 'testnet' ? 'testnet' : 'mainnet';
      const derived = addressFromPrivateKey(String(body.privateKey || ''), network);
      return sendJson(res, 200, { ok: true, address: derived.address, publicKey: derived.publicKeyHex });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  /* --------------------------- deploy kit -------------------------- */

  if (route === 'GET /api/deploy') {
    const files = buildKit(store.config, { port: PORT });
    return sendJson(res, 200, { files, port: PORT, repo: require('./deploykit').DEFAULT_REPO });
  }

  if (route === 'GET /api/deploy/download') {
    const files = buildKit(store.config, { port: PORT });
    const name = url.searchParams.get('file');
    const file = files.find((f) => f.name === name);
    if (!file) return sendJson(res, 404, { ok: false, error: 'Unknown file' });
    const body = Buffer.from(file.content);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': body.length,
      'content-disposition': `attachment; filename="${path.basename(file.name)}"`,
    });
    return res.end(body);
  }

  if (route === 'GET /api/deploy/zip') {
    const files = buildKit(store.config, { port: PORT });
    const zip = buildZip(files);
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': zip.length,
      'content-disposition': 'attachment; filename="kaspa-console-deploy.zip"',
    });
    return res.end(zip);
  }

  /* --------------------------- misc ------------------------------- */

  if (route === 'POST /api/network/refresh') {
    lastNetwork = await networkService.stats({ demo: supervisor.isDemoRunning(), force: true });
    return sendJson(res, 200, { ok: true, network: lastNetwork });
  }

  if (route === 'GET /api/export/config') {
    const { auth: ignored, ...rest } = store.config;
    const body = Buffer.from(JSON.stringify(rest, null, 2));
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': body.length,
      'content-disposition': 'attachment; filename="kaspa-console-config.json"',
    });
    return res.end(body);
  }

  if (route === 'GET /api/logs/download') {
    const kind = url.searchParams.get('kind') === 'node' ? 'node' : 'miner';
    const file = path.join(LOG_DIR, `${kind}.log`);
    if (!fs.existsSync(file)) return sendText(res, 404, 'no log file yet');
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': body.length,
      'content-disposition': `attachment; filename="${kind}.log"`,
    });
    return res.end(body);
  }

  return sendJson(res, 404, { ok: false, error: `Unknown endpoint ${route}` });
}

/* --------------------------------------------------------------------- */
/* static files                                                          */
/* --------------------------------------------------------------------- */

function serveStatic(req, res, pathname) {
  const cleaned = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(cleaned).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'forbidden');
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback
      const index = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(index)) {
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(index));
      }
      return sendText(res, 404, 'not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=60',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* --------------------------------------------------------------------- */
/* server                                                                */
/* --------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  securityHeaders(req, res);
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendText(res, 400, 'bad request');
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      console.error('[api]', err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message || 'internal error' });
      else res.end();
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed');
  serveStatic(req, res, url.pathname);
});

/* --------------------------------------------------------------------- */
/* background loops                                                      */
/* --------------------------------------------------------------------- */

function startLoops() {
  setInterval(() => hostMetrics.sample(), 3000);
  setInterval(() => {
    const state = supervisor.state.miner;
    if (state.status === 'running' && Date.now() - (state.hashrateAt || 0) > 20000 && !state.simulated) {
      // No hashrate line for a while: treat the miner as degraded but keep the last value for a bit.
      history.push(0);
    } else if (state.status === 'running') {
      history.push(state.hashrate || 0);
    }
  }, 5000);

  const refreshNetwork = async () => {
    lastNetwork = await networkService.stats({ demo: supervisor.isDemoRunning() });
  };
  refreshNetwork();
  setInterval(refreshNetwork, 90000);

  setInterval(() => {
    // detect a node gRPC port state for the UI even when the miner is stopped
    if (store.config.mining.mode === 'solo' && supervisor.state.node.status === 'running' && !supervisor.state.node.simulated) {
      portOpen('127.0.0.1', supervisor.rpcPort(), 800).then((open) => {
        if (supervisor.state.node.listening !== open) supervisor.state.node.listening = open;
      });
    }
  }, 15000);
}

/* --------------------------------------------------------------------- */
/* bootstrap                                                             */
/* --------------------------------------------------------------------- */

(async () => {
  await store.init();
  if (firstBoot) {
    store.config.panel.demoMode = true;
  }
  process.env.PANEL_PASSWORD_HASHED = '1';

  if (process.env.PANEL_PASSWORD && !store.config.auth?.password) {
    const { hash, salt } = await auth.hashPassword(String(process.env.PANEL_PASSWORD));
    store.config.auth.password = hash;
    store.config.auth.salt = salt;
    store.config.auth.updatedAt = new Date().toISOString();
    await store.save();
  }

  if (Number(store.config.alerts?.lowHashratePct) > 0) {
    // placeholder for a future alerting rule; kept so old configs stay valid
  }

  const token = !store.config.auth?.password ? auth.getSetupToken() : null;

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
    console.log('');
    console.log('  Kaspa Mining Console ' + VERSION);
    console.log('  ────────────────────────────────────────────');
    console.log(`  panel      ${url}`);
    console.log(`  storage    ${store.backend === 'postgres' ? 'PostgreSQL' : 'local file'} (${DATA_DIR})`);
    console.log(`  setup      ${store.config.setupComplete ? 'complete' : 'required'}`);
    if (token) console.log(`  setup token ${token}   (also in data/SETUP_TOKEN.txt)`);
    console.log('');

    startLoops();

    const boot = async () => {
      const ready = supervisor.binaries().ready;
      const configured = Boolean(store.config.mining.address);
      if (store.config.mining.autoStart && configured) {
        const result = await supervisor.start({ demo: false });
        if (!result.ok) {
          recordEvent('error', result.error || 'auto-start failed', 'error');
        }
        return;
      }
      // A brand-new install shows live-looking data from the simulator, clearly flagged in the UI.
      if (store.config.panel.demoMode && !ready && !configured) {
        await supervisor.start({ demo: true });
        seedDemoHistory();
        recordEvent('demo', 'Simulator running — install the real binaries to mine for real', 'info');
      }
    };
    boot().catch((err) => console.error('[boot]', err));
  });
})();

async function shutdown(signal) {
  console.log(`\n[${signal}] shutting down...`);
  try {
    await supervisor.stop();
  } catch {
    /* ignore */
  }
  await store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
