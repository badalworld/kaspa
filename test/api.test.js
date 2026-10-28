'use strict';
/**
 * Integration tests: boot the panel on an ephemeral port with a throwaway data
 * directory, then drive the real HTTP API end to end.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspa-console-test-'));
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let cookie = '';

const headers = (extra = {}) => ({
  'content-type': 'application/json',
  'x-panel-request': '1',
  ...(cookie ? { cookie } : {}),
  ...extra,
});

async function call(pathname, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return res;
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, res };
}

test.before(async () => {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PANEL_PORT: String(PORT), DATA_DIR, PANEL_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[panel] ${d}`));
  const deadline = Date.now() + 15000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('panel did not start in time');
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
});

test.after(async () => {
  child?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 600));
  child?.kill('SIGKILL');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('health check responds', async () => {
  const { status, data } = await call('/api/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

test('unauthenticated API access is rejected', async () => {
  const { status } = await call('/api/status');
  assert.equal(status, 401);
  const config = await call('/api/config');
  assert.equal(config.status, 401);
});

test('first run asks for setup and a local connection needs no token', async () => {
  const { data } = await call('/api/bootstrap');
  assert.equal(data.setupRequired, true);
  assert.equal(data.firstBoot, true);
  assert.equal(data.setupTokenRequired, false);
});

test('rejects weak passwords during setup', async () => {
  const { status, data } = await call('/api/setup', { method: 'POST', body: { password: 'short' } });
  assert.equal(status, 400);
  assert.match(data.error, /8 characters/);
});

test('setup creates the password, config and a session', async () => {
  const { status, data } = await call('/api/setup', {
    method: 'POST',
    body: { password: 'test-password-123', config: { mining: { network: 'testnet' }, panel: { name: 'Test Rig' } } },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(cookie.startsWith('kaspa_panel_session='));
  const bootstrap = await call('/api/bootstrap');
  assert.equal(bootstrap.data.authenticated, true);
});

test('status reports the simulated process state', async () => {
  const { status, data } = await call('/api/status');
  assert.equal(status, 200);
  assert.ok(data.miner);
  assert.ok(data.node);
  assert.ok(data.host.cores >= 1);
  assert.equal(typeof data.estimate.kasPerDay, 'number');
  assert.ok(data.resources.plan.checks.length === 3);
});

test('address validation endpoint accepts valid and rejects invalid input', async () => {
  const good = await call('/api/address/validate', {
    method: 'POST',
    body: { address: 'kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya' },
  });
  assert.equal(good.data.valid, true);
  assert.equal(good.data.network, 'testnet');

  const bad = await call('/api/address/validate', {
    method: 'POST',
    body: { address: 'kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplyb' },
  });
  assert.equal(bad.data.valid, false);
});

test('config validation refuses a mainnet address while set to testnet', async () => {
  const { status, data } = await call('/api/config', {
    method: 'PUT',
    body: { mining: { address: 'kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e' } },
  });
  assert.equal(status, 400);
  assert.match(data.error, /mainnet address/);
});

test('config accepts a testnet address and persists it', async () => {
  const address = 'kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya';
  const { status } = await call('/api/config', {
    method: 'PUT',
    body: { mining: { address, threads: 1 }, panel: { name: 'Dhaka Rig' } },
  });
  assert.equal(status, 200);
  const { data } = await call('/api/config');
  assert.equal(data.config.mining.address, address);
  assert.equal(data.config.mining.threads, 1);
  assert.equal(data.config.panel.name, 'Dhaka Rig');
  assert.equal(data.config.auth, undefined, 'password material must never be exposed');
});

test('miner start without binaries returns an actionable error', async () => {
  const { status, data } = await call('/api/miner/start', { method: 'POST', body: {} });
  assert.equal(status, 409);
  assert.equal(data.ok, false);
  assert.match(data.error, /binary|install/i);
});

test('demo mode starts, reports hashrate and can be stopped', async () => {
  const start = await call('/api/miner/start', { method: 'POST', body: { demo: true } });
  assert.equal(start.status, 200);
  assert.equal(start.data.demo, true);
  await new Promise((r) => setTimeout(r, 400));
  const running = await call('/api/status');
  assert.equal(running.data.miner.simulated, true);
  assert.match(running.data.miner.statusText, /simulated/);

  const stop = await call('/api/miner/stop', { method: 'POST' });
  assert.equal(stop.status, 200);
  const stopped = await call('/api/status');
  assert.equal(stopped.data.miner.status, 'stopped');
});

test('logs endpoint streams process output for both processes', async () => {
  const miner = await call('/api/logs?kind=miner&since=0');
  assert.equal(miner.status, 200);
  assert.ok(Array.isArray(miner.data.lines));
  const node = await call('/api/logs?kind=node&since=0');
  assert.equal(node.status, 200);
  assert.ok(node.data.lines.length > 0, 'demo node writes a start line');
});

test('deployment kit is generated from the live config', async () => {
  const { status, data } = await call('/api/deploy');
  assert.equal(status, 200);
  const names = data.files.map((f) => f.name);
  for (const expected of ['Dockerfile', 'docker-compose.yml', 'deploy/install.sh', 'deploy/nginx.conf', 'DEPLOY.md']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  const compose = data.files.find((f) => f.name === 'docker-compose.yml').content;
  assert.match(compose, /kaspa-console:/);
  const systemd = data.files.find((f) => f.name === 'deploy/kaspa-console.service').content;
  assert.match(systemd, /ExecStart=.*server\/index\.js/);
});

test('deployment kit downloads as a valid zip and single file', async () => {
  const zip = await call('/api/deploy/zip', { raw: true });
  assert.equal(zip.status, 200);
  const buffer = Buffer.from(await zip.arrayBuffer());
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  assert.ok(buffer.length > 2000);

  const file = await call('/api/deploy/download?file=Dockerfile', { raw: true });
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /Dockerfile/);
});

test('state-changing requests require the panel header', async () => {
  const res = await fetch(`${BASE}/api/miner/stop`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' } });
  assert.equal(res.status, 403);
});

test('password change invalidates the session and the new one works', async () => {
  const change = await call('/api/auth/password', {
    method: 'POST',
    body: { current: 'test-password-123', next: 'test-password-456' },
  });
  assert.equal(change.status, 200);
  const denied = await call('/api/status');
  assert.equal(denied.status, 401);

  cookie = '';
  const wrong = await call('/api/login', { method: 'POST', body: { password: 'test-password-123' } });
  assert.equal(wrong.status, 401);
  const ok = await call('/api/login', { method: 'POST', body: { password: 'test-password-456' } });
  assert.equal(ok.status, 200);
  const status = await call('/api/status');
  assert.equal(status.status, 200);
});

test('bearer tokens authenticate without cookies (embedded previews)', async () => {
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-panel-request': '1' },
    body: JSON.stringify({ password: 'test-password-456' }),
  });
  const data = await login.json();
  assert.ok(data.token && data.token.length > 20);

  const status = await fetch(`${BASE}/api/status`, { headers: { authorization: `Bearer ${data.token}` } });
  assert.equal(status.status, 200);

  const write = await fetch(`${BASE}/api/config`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${data.token}`, 'content-type': 'application/json', 'x-panel-request': '1' },
    body: JSON.stringify({ panel: { name: 'Bearer Rig' } }),
  });
  assert.equal(write.status, 200);

  const bogus = await fetch(`${BASE}/api/status`, { headers: { authorization: 'Bearer not-a-real-token' } });
  assert.equal(bogus.status, 401);
});

test('logout clears the session', async () => {
  const out = await call('/api/logout', { method: 'POST', body: {} });
  assert.equal(out.status, 200);
  cookie = '';
  const denied = await call('/api/status');
  assert.equal(denied.status, 401);
});
