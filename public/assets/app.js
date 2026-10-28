/* Kaspa Mining Console — front-end (vanilla ES modules, no dependencies) */

const state = {
  bootstrap: null,
  status: null,
  config: null,
  system: null,
  tab: 'overview',
  pollTimer: null,
  logCursor: { miner: 0, node: 0 },
  logLines: { miner: [], node: [] },
  loop: null,
  installPoll: null,
  wallet: null,
  balance: null,
  deploy: null,
};

/* ------------------------------- helpers ------------------------------ */

const TOKEN_KEY = 'kaspa_console_token';

/** Session token fallback for contexts where cookies are blocked (embedded previews). */
const authToken = {
  get() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  },
  set(value) {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
  },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const cssId = (value) => String(value).replace(/\./g, '_');

function fmtNum(value, digits = 0) {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtBytes(bytes, digits = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function duration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

function shortHash(hash) {
  if (!hash) return '—';
  return `${hash.slice(0, 12)}…${hash.slice(-10)}`;
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json', 'x-panel-request': '1' };
  const token = authToken.get();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: `Unexpected response (HTTP ${res.status})` };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(message, type = 'info', ttl = 4200) {
  const root = $('#toasts');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  root.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 220);
  }, ttl);
}

function openModal({ title, sub = '', body = '', actions = [], wide = false, onMount }) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" style="${wide ? 'width:min(760px,100%)' : ''}" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3>
      ${sub ? `<p class="modal-sub">${sub}</p>` : ''}
      <div class="modal-body">${body}</div>
      <div class="modal-actions">
        ${actions
          .map(
            (a, i) =>
              `<button class="btn ${a.className || 'btn-ghost'}" data-modal-action="${i}" ${a.disabled ? 'disabled' : ''}>${esc(a.label)}</button>`,
          )
          .join('')}
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeModal();
  });
  $$('[data-modal-action]', backdrop).forEach((btn) => {
    const action = actions[Number(btn.dataset.modalAction)];
    btn.addEventListener('click', async () => {
      if (action.keepOpen) {
        await action.onClick?.($('.modal-body', backdrop), btn);
        return;
      }
      const result = await action.onClick?.($('.modal-body', backdrop), btn);
      if (result !== false) closeModal();
    });
  });
  onMount?.($('.modal-body', backdrop), backdrop);
  return backdrop;
}

function closeModal() {
  $$('.modal-backdrop').forEach((n) => n.remove());
}

function promptPassword({ title = 'Confirm with password', sub = 'Your panel password is required for this action.' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };
    openModal({
      title,
      sub,
      body: `<div class="field"><label for="pw-prompt">Panel password</label>
        <input class="input" id="pw-prompt" type="password" autocomplete="current-password" placeholder="••••••••" /></div>`,
      actions: [
        { label: 'Cancel', className: 'btn-ghost', onClick: () => finish(null) },
        {
          label: 'Confirm',
          className: 'btn-primary',
          onClick: (bodyEl) => {
            const value = $('#pw-prompt', bodyEl).value;
            finish(value || null);
          },
        },
      ],
      onMount: (bodyEl) => {
        const input = $('#pw-prompt', bodyEl);
        input.focus();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            finish(input.value || null);
          }
        });
      },
    });
  });
}

function copyText(text) {
  const done = () => toast('Copied to clipboard', 'success', 2000);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallback());
  } else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch {
      toast('Copy failed — select the text manually', 'error');
    }
    ta.remove();
  }
}

/* --------------------------------- boot -------------------------------- */

async function boot() {
  try {
    state.bootstrap = await api('/api/bootstrap');
  } catch (err) {
    $('#boot').innerHTML = `<div class="boot-inner"><p class="red">Cannot reach the console API</p><p class="small muted">${esc(err.message)}</p></div>`;
    return;
  }
  $('#boot').hidden = true;

  if (!state.bootstrap.authenticated) {
    renderAuth();
    return;
  }
  await enterApp();
}

async function enterApp() {
  $('#shell').hidden = false;
  $('#version').textContent = `v${state.bootstrap.version}`;
  try {
    const data = await api('/api/config');
    state.config = data.config;
    state.system = data.system;
    state.wallet = data.wallet;
  } catch (err) {
    if (err.status === 401) {
      renderAuth();
      return;
    }
    toast(err.message, 'error');
  }
  buildNav();
  setTab('overview');
  await refreshStatus();
  startPolling();
}

function startPolling() {
  stopPolling();
  const delay = Math.max(1500, state.status?.panel?.refreshMs || 3000);
  state.pollTimer = setInterval(async () => {
    if (document.hidden) return;
    await refreshStatus();
  }, delay);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    state.status = status;
    setConn(true);
    document.title = `${status.miner.simulated ? '● demo' : status.miner.status === 'running' ? '● ' + status.miner.hashrateText : '○'} · Kaspa Console`;
    updateTopbar();
    updateBanners();
    if (state.tab === 'overview') updateOverview();
    if (state.tab === 'node') updateNodeView();
  } catch (err) {
    setConn(false);
    if (err.status === 401) {
      stopPolling();
      authToken.set('');
      renderAuth();
    }
  }
}

function setConn(ok) {
  const conn = $('#conn');
  conn.classList.toggle('off', !ok);
  conn.title = ok ? 'connected' : 'connection lost';
}

/* ------------------------------- auth UI ------------------------------- */

function renderAuth() {
  stopPolling();
  $('#shell').hidden = true;
  $('#boot').hidden = true;
  const b = state.bootstrap || {};
  const root = document.createElement('div');
  root.className = 'auth-screen';
  root.id = 'auth-root';
  $('#auth-root')?.remove();

  if (b.hasPassword) {
    root.innerHTML = `
      <div class="card auth-card">
        <div class="auth-brand">
          <svg viewBox="0 0 32 32" width="30" height="30"><path d="M16 2 4 9v14l12 7 12-7V9L16 2Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M11 21V11l10 10V11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <div><strong>KASPA</strong><small>mining console</small></div>
        </div>
        <h2 style="font-size:18px;margin-bottom:6px">Sign in</h2>
        <p class="muted small" style="margin-bottom:18px">This panel controls real mining software on this server.</p>
        <form id="login-form" class="stack">
          <div class="field">
            <label for="login-password">Panel password</label>
            <input class="input" id="login-password" type="password" autocomplete="current-password" placeholder="••••••••••" autofocus />
          </div>
          <button class="btn btn-primary btn-block" type="submit" id="login-submit">Unlock console</button>
          <p class="form-note" id="login-error" style="min-height:16px"></p>
        </form>
        <div class="auth-foot">Forgot it? Reset from the server: <span class="mono">data/config.json</span> → <span class="mono">auth</span></div>
      </div>`;
    document.body.appendChild(root);
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#login-submit');
      const errorEl = $('#login-error');
      btn.disabled = true;
      errorEl.textContent = '';
      try {
        const session = await api('/api/login', { method: 'POST', body: { password: $('#login-password').value } });
        if (session.token) authToken.set(session.token);
        state.bootstrap = await api('/api/bootstrap');
        root.remove();
        await enterApp();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.className = 'form-note red';
      } finally {
        btn.disabled = false;
      }
    });
    return;
  }

  // First run: claim the panel
  root.innerHTML = `
    <div class="card auth-card" style="width:min(520px,100%)">
      <div class="auth-brand">
        <svg viewBox="0 0 32 32" width="30" height="30"><path d="M16 2 4 9v14l12 7 12-7V9L16 2Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M11 21V11l10 10V11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <div><strong>KASPA</strong><small>mining console</small></div>
      </div>
      <h2 style="font-size:18px;margin-bottom:6px">Claim this console</h2>
      <p class="muted small" style="margin-bottom:18px">
        Create the administrator password. Mining settings, wallet tools and process control are unlocked after this step.
      </p>
      <form id="claim-form" class="stack">
        <div class="field">
          <label for="claim-password">New panel password</label>
          <input class="input" id="claim-password" type="password" minlength="8" autocomplete="new-password" placeholder="at least 8 characters" />
        </div>
        <div class="field">
          <label for="claim-password2">Repeat password</label>
          <input class="input" id="claim-password2" type="password" minlength="8" autocomplete="new-password" />
        </div>
        ${
          b.setupTokenRequired
            ? `<div class="field">
                 <label for="claim-token">Setup token</label>
                 <input class="input mono" id="claim-token" placeholder="e.g. 7F3KQ2M9XZ" autocapitalize="characters" />
                 <span class="hint">Printed by the installer and stored in <span class="mono">data/SETUP_TOKEN.txt</span> on the server (also in the server console log).</span>
               </div>`
            : `<p class="form-note">You are connecting from the server itself, so no setup token is required.</p>`
        }
        <div class="field">
          <label for="claim-address">Kaspa mining address <span class="muted tiny">(optional — you can add it later)</span></label>
          <input class="input mono" id="claim-address" placeholder="kaspa:..." spellcheck="false" />
          <span class="hint" id="claim-address-hint">Payout address for mined blocks. Generate one in the Wallet tab if you do not have a wallet yet.</span>
        </div>
        <button class="btn btn-primary btn-block" type="submit" id="claim-submit">Create password & continue</button>
        <p class="form-note" id="claim-error" style="min-height:16px"></p>
      </form>
    </div>`;
  document.body.appendChild(root);

  $('#claim-address').addEventListener('input', async (e) => {
    const value = e.target.value.trim();
    const input = e.target;
    const hint = $('#claim-address-hint');
    if (!value) {
      input.classList.remove('valid', 'invalid');
      hint.textContent = 'Payout address for mined blocks.';
      return;
    }
    try {
      const check = await api('/api/address/validate', { method: 'POST', body: { address: value } });
      input.classList.toggle('valid', check.valid);
      input.classList.toggle('invalid', !check.valid);
      hint.textContent = check.valid ? `Valid ${check.network} ${check.versionName} address` : check.error;
      hint.className = `hint ${check.valid ? 'green' : 'red'}`;
    } catch {
      /* ignore */
    }
  });

  $('#claim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = $('#claim-error');
    const password = $('#claim-password').value;
    if (password !== $('#claim-password2').value) {
      errorEl.textContent = 'Passwords do not match';
      return;
    }
    errorEl.textContent = '';
    const btn = $('#claim-submit');
    btn.disabled = true;
    try {
      const address = $('#claim-address').value.trim();
      const config = {};
      if (address) config.mining = { address };
      const session = await api('/api/setup', {
        method: 'POST',
        body: { password, setupToken: $('#claim-token')?.value || '', config },
      });
      if (session.token) authToken.set(session.token);
      root.remove();
      state.bootstrap = await api('/api/bootstrap');
      state.bootstrap.firstBoot = false;
      toast('Console configured', 'success');
      await enterApp();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.className = 'form-note red';
    } finally {
      btn.disabled = false;
    }
  });
}

/* -------------------------------- shell -------------------------------- */

const NAV = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'setup', label: 'Setup', icon: 'sliders' },
  { id: 'node', label: 'Node', icon: 'server' },
  { id: 'wallet', label: 'Wallet', icon: 'key' },
  { id: 'logs', label: 'Logs', icon: 'terminal' },
  { id: 'deploy', label: 'Deploy', icon: 'ship' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  server: '<rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6 6.5h.01M6 17.5h.01"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 9-9M17 4l3 3M14 7l3 3"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  ship: '<path d="M3 17c2 1 4 1 6 0s4-1 6 0 4 1 6 0M5 13l7-9 7 9M12 4v9"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  zap: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  coins: '<circle cx="8" cy="8" r="5"/><path d="M18.1 5.6a5 5 0 1 1-6.5 6.5M7 17.5v3M11 17.5v3"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  box: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m3 7 9 5 9-5M12 12v10"/>',
};

function icon(name, size = 17) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function buildNav() {
  const nav = $('#nav');
  nav.innerHTML = NAV.map(
    (item) => `<button class="nav-item" data-tab="${item.id}" type="button">${icon(item.icon)}<span class="label">${item.label}</span></button>`,
  ).join('');
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) setTab(btn.dataset.tab);
  });
}

const PAGE_META = {
  overview: ['Overview', 'Live status of your Kaspa miner'],
  setup: ['Setup', 'Mining requirements, binaries and runtime options'],
  node: ['Node', 'kaspad health, sync state and disk usage'],
  wallet: ['Wallet', 'Mining address, balance and key tools'],
  logs: ['Logs', 'Streaming output from the node and the miner'],
  deploy: ['Deploy', 'Generated docker, systemd and nginx artifacts'],
  settings: ['Settings', 'Security, alerts and panel preferences'],
};

function setTab(tab) {
  if (state.loop) {
    clearInterval(state.loop);
    state.loop = null;
  }
  state.tab = tab;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const [title, sub] = PAGE_META[tab] || ['', ''];
  $('#page-title').textContent = title;
  $('#page-sub').textContent = sub;
  const view = $('#view');
  view.innerHTML = '';
  view.className = 'view';
  const render = VIEWS[tab];
  if (render) render(view);
  updateTopbar();
}

function updateTopbar() {
  const s = state.status;
  if (!s) return;
  const startBtn = $('#btn-start');
  const stopBtn = $('#btn-stop');
  const restartBtn = $('#btn-restart');
  const running = s.miner.status === 'running' || s.miner.status === 'waiting-node';
  startBtn.classList.toggle('hidden', running);
  stopBtn.classList.toggle('hidden', !running);
  restartBtn.classList.toggle('hidden', !running);
  $('#net-badge').textContent = s.mining.network === 'testnet' ? 'testnet' : 'mainnet';
  $('#net-badge').classList.toggle('testnet', s.mining.network === 'testnet');
}

function updateBanners() {
  const slot = $('#banner-slot');
  const s = state.status;
  const banners = [];

  if (s.setup.required) {
    banners.push(`<div class="callout info">
      <span class="ico">→</span>
      <div><strong>Finish the setup.</strong> Add your Kaspa address, pick the resource plan and install the binaries, then start mining.
      <div class="row mt-8"><button class="btn btn-sm btn-primary" data-action="goto-setup">Open setup</button></div></div>
    </div>`);
  }
  if (s.miner.simulated) {
    banners.push(`<div class="callout demo">
      <span class="ico">◆</span>
      <div><strong>Demo data.</strong> The numbers below come from the built-in simulator, not from the network.
      Install the real binaries and press <em>Start mining</em> to mine for real.
      <div class="row mt-8"><button class="btn btn-sm" data-action="goto-setup">Install binaries</button>
      <button class="btn btn-sm btn-ghost" data-action="stop-demo">Stop demo</button></div></div>
    </div>`);
  }
  if (!s.setup.required && !s.miner.simulated && s.miner.status !== 'running') {
    const binaries = s.binaries;
    if (!binaries.ready) {
      banners.push(`<div class="callout warn">
        <span class="ico">!</span>
        <div><strong>Binaries missing.</strong> ${!binaries.node ? 'kaspad ' : ''}${!binaries.miner ? 'kaspa-miner' : ''}
        not found. Install them from the Setup tab, or point the panel at binaries you already have.</div>
      </div>`);
    }
  }
  if (!s.network.online && !s.miner.simulated) {
    banners.push(`<div class="callout warn">
      <span class="ico">!</span>
      <div><strong>Network data offline.</strong> Could not reach <span class="mono">api.kaspa.org</span> — earnings estimates use fallback values. Mining itself is unaffected.</div>
    </div>`);
  }
  slot.innerHTML = banners.join('');
}

/* ------------------------------- overview ------------------------------ */

const CHART = { canvas: null, ctx: null };

function metricCard(label, valueId, subId, iconName) {
  return `<div class="card stat">
    <div class="stat-label">${icon(iconName, 13)} ${label}</div>
    <div class="stat-value" id="${valueId}">—</div>
    <div class="stat-sub" id="${subId}">—</div>
  </div>`;
}

function mountOverview(view) {
  view.innerHTML = `
    <div class="grid hero">
      <div class="card hero-card">
        <div class="hero-top">
          <div>
            <div class="row" style="gap:8px">
              <span class="pill stopped" id="ov-status">stopped</span>
              <span class="pill demo hidden" id="ov-demo">demo data</span>
              <span class="badge" id="ov-mode">solo · mainnet</span>
            </div>
            <div class="hashrate-live mt-8">
              <span class="stat-value lg" id="ov-hashrate">0 H/s</span>
            </div>
            <div class="stat-sub" id="ov-hashrate-sub">No hashrate yet</div>
          </div>
          <div style="text-align:right">
            <div class="stat-label" style="justify-content:flex-end">expected block</div>
            <div class="stat-value sm" id="ov-ttb">—</div>
            <div class="stat-sub" id="ov-share">—</div>
          </div>
        </div>
        <div class="chart-wrap">
          <canvas id="chart" width="800" height="132"></canvas>
        </div>
        <div class="row between">
          <div class="chart-legend"><span>1m <b id="ov-h1">0</b></span><span>5m <b id="ov-h5">0</b></span><span>15m <b id="ov-h15">0</b></span></div>
          <div class="chart-legend"><span id="ov-chart-range">last 24h</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon('coins', 14)} Expected earnings</div>
            <div class="card-sub">Solo-mining probability at current hashrate</div>
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">Per day</div>
          <div class="stat-value sm" id="ov-kas-day">—</div>
          <div class="stat-sub" id="ov-usd-day">—</div>
        </div>
        <div class="mini-row mt-14"><span class="k">Per month</span><span class="v" id="ov-kas-month">—</span></div>
        <div class="mini-row"><span class="k">Blocks / day</span><span class="v" id="ov-blocks-day">—</span></div>
        <div class="mini-row"><span class="k">Block reward</span><span class="v" id="ov-reward">—</span></div>
        <div class="mini-row"><span class="k">KAS price</span><span class="v" id="ov-price">—</span></div>
        <div class="mini-row"><span class="k">Your network share</span><span class="v" id="ov-netshare">—</span></div>
      </div>
    </div>

    <div class="grid c4">
      ${metricCard('Node', 'ov-node', 'ov-node-sub', 'server')}
      ${metricCard('Threads', 'ov-threads', 'ov-threads-sub', 'cpu')}
      ${metricCard('Blocks found (24h)', 'ov-blocks', 'ov-blocks-sub', 'box')}
      ${metricCard('Uptime', 'ov-uptime', 'ov-uptime-sub', 'clock')}
    </div>

    <div class="grid c2">
      <div class="card">
        <div class="card-head">
          <div class="card-title">${icon('cpu', 14)} Host resources</div>
          <div class="card-sub" id="ov-host-name">—</div>
        </div>
        <div class="stack">
          <div class="meter">
            <div class="meter-head"><span>CPU</span><span id="ov-cpu-val">—</span></div>
            <div class="bar"><i id="ov-cpu-bar" style="width:0%"></i></div>
          </div>
          <div class="meter">
            <div class="meter-head"><span>Memory</span><span id="ov-mem-val">—</span></div>
            <div class="bar"><i id="ov-mem-bar" style="width:0%"></i></div>
          </div>
          <div class="meter">
            <div class="meter-head"><span>Disk</span><span id="ov-disk-val">—</span></div>
            <div class="bar"><i id="ov-disk-bar" style="width:0%"></i></div>
          </div>
        </div>
        <div class="mini-row mt-14"><span class="k">Load average</span><span class="v" id="ov-load">—</span></div>
        <div class="mini-row"><span class="k">Chain data</span><span class="v" id="ov-chain">—</span></div>
        <div class="mini-row"><span class="k">Panel uptime</span><span class="v" id="ov-panel-uptime">—</span></div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">${icon('activity', 14)} Kaspa network</div>
          <button class="btn btn-sm btn-ghost" data-action="refresh-network" type="button">Refresh</button>
        </div>
        <div class="mini-row"><span class="k">Network hashrate</span><span class="v" id="ov-net-hash">—</span></div>
        <div class="mini-row"><span class="k">Difficulty</span><span class="v" id="ov-net-diff">—</span></div>
        <div class="mini-row"><span class="k">DAG height</span><span class="v" id="ov-net-height">—</span></div>
        <div class="mini-row"><span class="k">Price</span><span class="v" id="ov-net-price">—</span></div>
        <div class="mini-row"><span class="k">Data source</span><span class="v" id="ov-net-source">—</span></div>
      </div>
    </div>

    <div class="grid c2">
      <div class="card" id="ov-reality"></div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">${icon('zap', 14)} Recent events</div>
        </div>
        <div class="events" id="ov-events"></div>
      </div>
    </div>`;

  CHART.canvas = $('#chart', view);
  CHART.ctx = CHART.canvas?.getContext('2d');
  drawChart([]);
}

function updateOverview() {
  const s = state.status;
  if (!s || state.tab !== 'overview') return;

  $('#ov-status').textContent = s.miner.simulated ? 'simulated' : s.miner.status;
  $('#ov-status').className = `pill ${
    s.miner.simulated ? 'demo' : s.miner.status === 'running' ? 'running' : s.miner.status === 'waiting-node' ? 'waiting' : s.miner.status === 'error' ? 'error' : 'stopped'
  }`;
  $('#ov-demo').classList.toggle('hidden', !s.miner.simulated);
  $('#ov-mode').textContent = `${s.mining.mode} · ${s.mining.network}`;
  $('#ov-hashrate').textContent = s.miner.simulated ? s.miner.hashrateText : s.miner.hashrate > 0 ? s.miner.hashrateText : s.miner.effectiveText;
  $('#ov-hashrate-sub').textContent =
    s.miner.status === 'running'
      ? `${s.miner.uptimeText} uptime · ${s.miner.threads || s.mining.threads || 'auto'} threads`
      : s.miner.status === 'waiting-node'
        ? 'Waiting for the node gRPC port…'
        : s.miner.status === 'error'
          ? s.miner.lastError || 'Miner stopped with an error'
          : 'Miner is stopped';

  $('#ov-ttb').textContent = s.network.testnet ? '—' : s.estimate.bitcoinStyle ? s.estimate.bitcoinStyle : '—';
  $('#ov-share').textContent = s.network.testnet
    ? 'testnet rewards have no monetary value'
    : `${s.network.mySharePct ? s.network.mySharePct.toExponential(2) : '0'}% of network`;
  $('#ov-h1').textContent = s.miner.windows.h1.text;
  $('#ov-h5').textContent = s.miner.windows.h5.text;
  $('#ov-h15').textContent = s.miner.windows.h15.text;

  $('#ov-kas-day').textContent = s.network.testnet ? 'testnet' : s.estimate.kasPerDayText;
  $('#ov-usd-day').textContent = s.network.testnet ? 'no market value' : `${s.estimate.usdPerDayText} per day (est.)`;
  $('#ov-kas-month').textContent = s.network.testnet ? '—' : s.estimate.kasPerMonth < 0.01 ? '≈ 0' : `${s.estimate.kasPerMonth.toFixed(2)} KAS`;
  $('#ov-blocks-day').textContent = s.estimate.blocksPerDayText;
  $('#ov-reward').textContent = `${s.estimate.reward.toFixed(3)} KAS`;
  $('#ov-price').textContent = s.network.price ? `$${s.network.price.toFixed(4)}` : '—';
  $('#ov-netshare').textContent = `${(s.network.mySharePct || 0).toExponential(2)}%`;

  $('#ov-node').textContent = s.node.requiresNode ? (s.node.simulated ? 'simulated' : s.node.status) : 'external';
  $('#ov-node').className = `stat-value ${
    !s.node.requiresNode ? '' : s.node.status === 'running' ? 'green' : s.node.status === 'error' ? 'red' : ''
  }`;
  $('#ov-node-sub').textContent = s.node.requiresNode
    ? s.node.listening
      ? `gRPC :${s.node.rpcPort} open${s.node.peers ? ` · ${s.node.peers} peers` : ''}`
      : `gRPC :${s.node.rpcPort} not reachable yet`
    : `${s.mining.remoteHost || 'remote'}:${s.mining.remotePort}`;

  $('#ov-threads').textContent = s.miner.threads || s.mining.threads || 'auto';
  $('#ov-threads-sub').textContent = `${s.host.cores} vCPU available`;

  $('#ov-blocks').textContent = fmtNum(s.miner.blocks24h);
  $('#ov-blocks-sub').textContent = s.miner.lastBlock ? `last ${timeAgo(s.miner.lastBlock.at)}` : 'none yet';

  $('#ov-uptime').textContent = s.miner.uptimeSec ? duration(s.miner.uptimeSec) : '—';
  $('#ov-uptime-sub').textContent = s.miner.restarts ? `${s.miner.restarts} restarts` : 'no restarts';

  $('#ov-host-name').textContent = `${s.host.hostname} · ${s.host.cpuModel}`;
  setBar('ov-cpu-bar', 'ov-cpu-val', s.host.cpuPct, `${s.host.cpuPct.toFixed(0)}% · load ${s.host.loadAvg[0].toFixed(2)}`);
  setBar('ov-mem-bar', 'ov-mem-val', s.host.memPct, `${fmtBytes(s.host.memUsed)} / ${fmtBytes(s.host.memTotal)}`);
  setBar('ov-disk-bar', 'ov-disk-val', s.host.diskPct, `${fmtBytes(s.host.diskUsed)} / ${fmtBytes(s.host.diskTotal)}`);
  $('#ov-load').textContent = s.host.loadAvg.map((v) => v.toFixed(2)).join(' · ');
  $('#ov-chain').textContent = fmtBytes(s.node.dataBytes);
  $('#ov-panel-uptime').textContent = duration(s.host.uptimeSec);

  $('#ov-net-hash').textContent = s.network.hashrateText;
  $('#ov-net-diff').textContent = s.network.difficulty ? s.network.difficulty.toExponential(3) : '—';
  $('#ov-net-height').textContent = s.network.height ? fmtNum(s.network.height) : '—';
  $('#ov-net-price').textContent = s.network.price ? `$${s.network.price.toFixed(4)}` : '—';
  $('#ov-net-source').textContent = s.network.demo ? 'simulated' : s.network.online ? 'api.kaspa.org' : `offline${s.network.stale ? ' (stale)' : ''}`;

  drawChart(s.history || []);

  const reality = renderRealityCheck(s);
  const realityEl = $('#ov-reality');
  if (realityEl.dataset.key !== reality.key) {
    realityEl.dataset.key = reality.key;
    realityEl.innerHTML = reality.html;
  }

  const events = $('#ov-events');
  events.innerHTML = s.events.length
    ? s.events
        .map(
          (e) => `<div class="event ${e.level}"><span class="dot"></span><span class="msg">${esc(e.message)}</span><span class="when">${timeAgo(e.at)}</span></div>`,
        )
        .join('')
    : '<div class="log-empty">Nothing yet. Events such as blocks found, crashes and installs appear here.</div>';
}

function setBar(barId, valId, pct, text) {
  const bar = $(`#${barId}`);
  if (!bar) return;
  const clamped = Math.max(0, Math.min(100, pct || 0));
  bar.style.width = `${clamped}%`;
  bar.parentElement.classList.toggle('warn', clamped >= 75 && clamped < 90);
  bar.parentElement.classList.toggle('crit', clamped >= 90);
  $(`#${valId}`).textContent = text;
}

function renderRealityCheck(s) {
  const cpuMining = s.mining.mode !== 'custom';
  const key = `${s.mining.network}-${s.mining.mode}-${Math.round((s.network.mySharePct || 0) * 1e12)}`;
  if (s.mining.network === 'testnet') {
    return {
      key: `${key}-t`,
      html: `<div class="card-head"><div class="card-title">${icon('zap', 14)} Reality check</div></div>
        <p class="small muted">You are mining <strong class="amber">testnet</strong>. This is the right place to test the whole pipeline —
        sync, templates, block submission — with zero cost. Testnet KAS has no market value.</p>
        <div class="mini-row mt-14"><span class="k">Network blocks / day</span><span class="v">864,000</span></div>
        <div class="mini-row"><span class="k">Mining with</span><span class="v">${esc(s.mining.mode)}</span></div>`,
    };
  }
  if (!cpuMining) {
    return {
      key: `${key}-c`,
      html: `<div class="card-head"><div class="card-title">${icon('zap', 14)} Custom miner</div></div>
      <p class="small muted">A custom command is running. Earnings and hashrate come from the miner's own log output, so keep
      <span class="mono">accepted</span>/<span class="mono">rejected</span> lines enabled if you want share counters.</p>`,
    };
  }
  const years = s.estimate.expectedSecondsPerBlock ? s.estimate.expectedSecondsPerBlock / 31557600 : null;
  return {
    key,
    html: `<div class="callout warn" style="border:0;background:transparent;padding:0">
      <span class="ico">!</span>
      <div><strong>CPU solo mining on mainnet is a lottery ticket.</strong>
      <p class="small muted mt-8">A ${s.host.cores}-vCPU server hashes roughly ${esc(s.miner.effectiveText) || 'a few MH/s'}.
      Against the current network hashrate (${esc(s.network.hashrateText)}) your share is
      ${(s.network.mySharePct || 0).toExponential(2)}%, so one block is expected every
      <strong class="amber">${years ? (years > 1000 ? Math.round(years).toLocaleString('en-US') + ' years' : years.toFixed(1) + ' years') : 'never'}</strong>.
      That is fine if you are learning, supporting the network, or testing — but a CPU will not pay for this server.</p>
      <p class="small muted mt-8">For real income on mainnet you need ASICs. Keep this pipeline on testnet, or point
      <span class="mono">Remote node</span> mode at a node you already run.</p></div></div>`,
  };
}

function drawChart(series) {
  const canvas = CHART.canvas;
  if (!canvas || !CHART.ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = CHART.ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  if (!series.length) {
    ctx.strokeStyle = '#1e2634';
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(0, h - 20);
    ctx.lineTo(w, h - 20);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#5c6980';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Hashrate history appears here once mining starts', w / 2, h / 2);
    return;
  }

  const max = Math.max(...series.map((p) => p.h), 1);
  const maxT = series[series.length - 1].t;
  // Fill the chart with the data we actually have (min 10 minutes) instead of
  // drawing a needle at the left edge right after startup.
  const minT = Math.min(series[0].t, maxT - 10 * 60 * 1000);
  const span = Math.max(60 * 1000, maxT - minT);
  const padX = 2;
  const padTop = 12;
  const padBottom = 14;

  const x = (t) => padX + ((t - minT) / span) * (w - padX * 2);
  const y = (v) => h - padBottom - (v / (max * 1.15)) * (h - padTop - padBottom);

  // grid
  ctx.strokeStyle = 'rgba(30, 38, 52, 0.85)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const gy = padTop + ((h - padTop - padBottom) / 3) * i;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
  }

  const grad = ctx.createLinearGradient(0, padTop, 0, h);
  grad.addColorStop(0, 'rgba(94, 234, 212, 0.32)');
  grad.addColorStop(1, 'rgba(94, 234, 212, 0)');

  ctx.beginPath();
  ctx.moveTo(x(series[0].t), y(series[0].h));
  for (const point of series) ctx.lineTo(x(point.t), y(point.h));
  ctx.lineTo(x(series[series.length - 1].t), h - padBottom);
  ctx.lineTo(x(series[0].t), h - padBottom);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x(series[0].t), y(series[0].h));
  for (const point of series) ctx.lineTo(x(point.t), y(point.h));
  ctx.strokeStyle = '#5eead4';
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const last = series[series.length - 1];
  ctx.beginPath();
  ctx.arc(x(last.t), y(last.h), 3, 0, Math.PI * 2);
  ctx.fillStyle = '#5eead4';
  ctx.fill();

  ctx.fillStyle = '#5c6980';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`${(max / 1e6).toFixed(2)} MH/s`, 2, 10);
  ctx.textAlign = 'right';
  ctx.fillText(new Date(minT).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), w - 2, h - 2);
}

/* --------------------------------- node -------------------------------- */

function mountNode(view) {
  view.innerHTML = `
    <div class="grid c2">
      <div class="card">
        <div class="card-head">
          <div><div class="card-title">${icon('server', 14)} Node runtime</div>
          <div class="card-sub">kaspad process managed by this panel</div></div>
          <span class="pill stopped" id="node-status">—</span>
        </div>
        <div class="mini-row"><span class="k">PID</span><span class="v" id="node-pid">—</span></div>
        <div class="mini-row"><span class="k">gRPC endpoint</span><span class="v" id="node-grpc">—</span></div>
        <div class="mini-row"><span class="k">P2P port</span><span class="v" id="node-p2p">—</span></div>
        <div class="mini-row"><span class="k">Synced</span><span class="v" id="node-synced">—</span></div>
        <div class="mini-row"><span class="k">Peers</span><span class="v" id="node-peers">—</span></div>
        <div class="mini-row"><span class="k">DAA score</span><span class="v" id="node-daa">—</span></div>
        <div class="mini-row"><span class="k">Uptime</span><span class="v" id="node-uptime">—</span></div>
        <div class="mini-row"><span class="k">Chain data</span><span class="v" id="node-chain">—</span></div>
        <div class="row mt-14">
          <button class="btn btn-sm" data-action="node-start">Start node</button>
          <button class="btn btn-sm btn-ghost danger" data-action="node-stop">Stop all</button>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">${icon('box', 14)} Sync &amp; storage plan</div></div>
        <div class="meter">
          <div class="meter-head"><span>Disk used by chain data</span><span id="node-disk-text">—</span></div>
          <div class="bar violet"><i id="node-disk-bar" style="width:0%"></i></div>
        </div>
        <p class="small muted mt-14">
          A pruned mainnet node needs roughly 60–120 GB; archival keeps everything and grows past 600 GB.
          Your server has <strong id="node-host-disk">—</strong> of disk.
        </p>
        <div class="mini-row mt-14"><span class="k">Mode</span><span class="v" id="node-mode">—</span></div>
        <div class="mini-row"><span class="k">Retention</span><span class="v" id="node-retention">—</span></div>
        <div class="mini-row"><span class="k">RAM scale</span><span class="v" id="node-ram">—</span></div>
        <div class="mini-row"><span class="k">UTXO index</span><span class="v" id="node-utxo">—</span></div>
        <div class="mini-row"><span class="k">Data directory</span><span class="v truncate" id="node-dir">—</span></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head">
        <div><div class="card-title">${icon('terminal', 14)} Node output</div>
        <div class="card-sub">Last lines written by kaspad</div></div>
        <div class="log-toolbar"><button class="btn btn-sm btn-ghost" data-action="goto-logs">Open full logs</button></div>
      </div>
      <div class="logs" id="node-log-mini"><div class="log-empty">No output yet.</div></div>
    </div>`;
  updateNodeView();
  refreshNodeMiniLog();
}

function updateNodeView() {
  const s = state.status;
  if (!s) return;
  const pill = $('#node-status');
  if (!pill) return;
  const status = s.node.simulated ? 'simulated' : s.node.status;
  pill.textContent = status;
  pill.className = `pill ${s.node.simulated ? 'demo' : s.node.status === 'running' ? 'running' : s.node.status === 'error' ? 'error' : 'stopped'}`;
  $('#node-pid').textContent = s.node.pid || '—';
  $('#node-grpc').textContent = `127.0.0.1:${s.node.rpcPort}${s.node.listening ? ' (open)' : ' (closed)'}`;
  $('#node-p2p').textContent = s.mining.network === 'testnet' ? '16211' : '16111';
  $('#node-synced').textContent = s.node.synced === true ? 'yes' : s.node.synced === false ? 'no' : 'unknown';
  $('#node-peers').textContent = s.node.peers ?? '—';
  $('#node-daa').textContent = s.node.daaScore ? fmtNum(s.node.daaScore) : '—';
  $('#node-uptime').textContent = s.node.uptimeSec ? duration(s.node.uptimeSec) : '—';
  $('#node-chain').textContent = fmtBytes(s.node.dataBytes);

  const pct = s.host.diskTotal ? (s.node.dataBytes / s.host.diskTotal) * 100 : 0;
  const bar = $('#node-disk-bar');
  if (bar) bar.style.width = `${Math.min(100, pct).toFixed(1)}%`;
  $('#node-disk-text').textContent = `${fmtBytes(s.node.dataBytes)} (${pct.toFixed(1)}% of disk)`;
  $('#node-host-disk').textContent = fmtBytes(s.host.diskTotal);

  const cfg = state.config || {};
  $('#node-mode').textContent = cfg.node?.archival ? 'archival' : 'pruned';
  $('#node-retention').textContent = cfg.node?.retentionDays ? `${cfg.node.retentionDays} days` : 'node default';
  $('#node-ram').textContent = `${cfg.node?.ramScale ?? 1}×`;
  $('#node-utxo').textContent = cfg.node?.utxoIndex ? 'enabled' : 'disabled';
  $('#node-dir').textContent = s.node.dataDir || '—';
}

async function refreshNodeMiniLog() {
  try {
    const data = await api('/api/logs?kind=node&preset=recent');
    const box = $('#node-log-mini');
    if (!box) return;
    const lines = data.lines.slice(-12);
    box.innerHTML = lines.length
      ? lines.map((l) => `<div class="log-line"><span class="ts">${new Date(l.t).toLocaleTimeString()}</span><span class="msg">${esc(l.line)}</span></div>`).join('')
      : '<div class="log-empty">No output yet.</div>';
    box.scrollTop = box.scrollHeight;
  } catch {
    /* ignore */
  }
}

/* --------------------------------- setup ------------------------------- */

function mountSetup(view) {
  const c = state.config;
  if (!c) {
    view.innerHTML = `<div class="card"><p class="muted">Configuration not loaded.</p></div>`;
    return;
  }
  const cores = state.status?.host?.cores || state.system?.cores || 4;
  const threads = c.mining.threads || 0;
  const autoThreads = Math.max(1, cores - 1);

  view.innerHTML = `
    <div class="grid hero">
      <div class="card">
        <div class="card-head">
          <div><div class="card-title">${icon('sliders', 14)} Mining requirements</div>
          <div class="card-sub">Everything the miner needs, in one place</div></div>
          <span class="pill ${c.mining.address ? 'running' : 'waiting'}">${c.mining.address ? 'address set' : 'address missing'}</span>
        </div>

        <div class="field full">
          <label>How should this server mine?</label>
          <div class="choice-grid" id="mode-choices">
            ${[
              ['solo', 'Solo — full node', 'Run kaspad on this server and mine its block templates. Self-sovereign, needs disk + sync time.'],
              ['remote', 'Remote node (gRPC)', 'Reuse a kaspad you already run somewhere else. Only the CPU miner runs here.'],
              ['custom', 'Custom command', 'Any miner binary or pool client (GPU miners, stratum pools). The panel supervises and parses its logs.'],
            ]
              .map(
                ([value, title, desc]) => `<button type="button" class="choice ${c.mining.mode === value ? 'active' : ''}" data-mode="${value}">
                  <strong>${title}</strong><small>${esc(desc)}</small></button>`,
              )
              .join('')}
          </div>
        </div>

        <div class="form-grid mt-14">
          <div class="field">
            <label>Network</label>
            <div class="segmented" id="network-seg">
              <button type="button" data-network="mainnet" class="${c.mining.network === 'mainnet' ? 'active' : ''}">Mainnet</button>
              <button type="button" data-network="testnet" class="${c.mining.network === 'testnet' ? 'active' : ''}">Testnet</button>
            </div>
            <span class="hint">Testnet is the safe place to validate the whole pipeline.</span>
          </div>
          <div class="field">
            <label>CPU threads</label>
            <div class="range-row">
              <input type="range" id="threads-range" min="0" max="${cores}" step="1" value="${threads || autoThreads}" />
              <span class="range-val" id="threads-val">${threads || `auto (${autoThreads})`}</span>
            </div>
            <span class="hint">${cores} vCPU detected. Leave one core for the node and the panel.</span>
          </div>
          <div class="field full">
            <label for="address-input">Kaspa payout address</label>
            <div class="row" style="gap:8px">
              <input class="input mono" id="address-input" style="flex:1" spellcheck="false" placeholder="kaspa:..." value="${esc(c.mining.address || '')}" />
              <button class="btn btn-sm" type="button" data-action="goto-wallet">Generate</button>
            </div>
            <span class="hint" id="address-hint">Mined blocks are paid to this address.</span>
          </div>

          <div class="field full ${c.mining.mode === 'remote' ? '' : 'hidden'}" id="remote-fields">
            <div class="form-grid">
              <div class="field">
                <label for="remote-host">Remote kaspad host</label>
                <input class="input mono" id="remote-host" value="${esc(c.mining.remoteHost || '')}" placeholder="10.0.0.5" />
              </div>
              <div class="field">
                <label for="remote-port">gRPC port</label>
                <input class="input mono" id="remote-port" type="number" value="${c.mining.remotePort || 16110}" />
              </div>
            </div>
          </div>

          <div class="field full ${c.mining.mode === 'custom' ? '' : 'hidden'}" id="custom-fields">
            <label for="custom-command">Miner command</label>
            <textarea class="textarea mono" id="custom-command" placeholder="./lolMiner --algo KASPA --pool {{pool}} --user {{address}}.{{worker}}">${esc(c.mining.customCommand || '')}</textarea>
            <span class="hint">Tokens: <span class="mono">{{address}}</span> <span class="mono">{{worker}}</span> <span class="mono">{{threads}}</span> <span class="mono">{{network}}</span> <span class="mono">{{pool}}</span></span>
            <div class="form-grid mt-8">
              <div class="field"><label for="pool-url">Pool URL</label><input class="input mono" id="pool-url" value="${esc(c.mining.poolUrl || '')}" placeholder="pool.example.com:3112" /></div>
              <div class="field"><label for="worker-name">Worker name</label><input class="input mono" id="worker-name" value="${esc(c.mining.workerName || '')}" placeholder="rig-1" /></div>
            </div>
            <div class="row mt-8">
              <span class="tiny muted">Presets:</span>
              <button class="btn btn-sm btn-ghost" type="button" data-preset="lolminer">lolMiner</button>
              <button class="btn btn-sm btn-ghost" type="button" data-preset="srbminer">SRBMiner</button>
              <button class="btn btn-sm btn-ghost" type="button" data-preset="cpuminer-remote">kaspa-miner → remote node</button>
            </div>
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div class="card-title">${icon('cpu', 14)} Server plan</div>
          <span class="tiny muted" id="plan-badge"></span></div>
          <div id="plan-checks"></div>
          <p class="form-note mt-8" id="plan-note"></p>
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">${icon('box', 14)} Binaries</div></div>
          <div class="stack" id="binaries-box"></div>
        </div>
      </div>
    </div>

    <div class="grid c2">
      <div class="card">
        <div class="card-head"><div class="card-title">${icon('server', 14)} Node options</div></div>
        <div class="form-grid">
          <div class="field">
            <label for="node-datadir">Data directory</label>
            <input class="input mono" id="node-datadir" value="${esc(c.node.dataDir || '')}" placeholder="default: ./data/kaspad" />
          </div>
          <div class="field">
            <label for="node-retention">Retention (days)</label>
            <input class="input mono" id="node-retention" type="number" min="0" max="3650" value="${c.node.retentionDays || 0}" />
            <span class="hint">0 = node default pruning. Archival keeps everything.</span>
          </div>
          <div class="field">
            <label for="node-ram">RAM scale</label>
            <input class="input mono" id="node-ram" type="number" min="0.1" max="10" step="0.1" value="${c.node.ramScale || 1}" />
            <span class="hint">1.0 is balanced; lower it on small machines.</span>
          </div>
          <div class="field">
            <label for="miner-path">Custom miner path <span class="muted tiny">(optional)</span></label>
            <input class="input mono" id="miner-path" value="${esc(c.mining.minerPath || '')}" placeholder="/usr/local/bin/kaspa-miner" />
          </div>
        </div>
        <div class="mt-14">
          ${switchRow('node-archival', 'Archival node', 'Keep all block data (very large disk usage)', c.node.archival)}
          ${switchRow('node-utxo', 'UTXO index', 'Needed for wallet balance queries over RPC', c.node.utxoIndex)}
          ${switchRow('node-expose-rpc', 'Expose gRPC publicly', 'Allow remote miners to connect to port 16110', c.node.exposeRpc)}
          ${switchRow('node-expose-p2p', 'Listen for P2P peers', 'Required for a healthy mainnet node', c.node.exposeP2P !== false)}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">${icon('zap', 14)} Runtime behaviour</div></div>
        ${switchRow('mining-autostart', 'Start mining on boot', 'Restart the miner automatically when the panel starts', c.mining.autoStart)}
        ${switchRow('mining-restart', 'Restart on crash', 'Supervisor restarts the process with backoff', c.mining.restartOnCrash)}
        ${switchRow('panel-demo', 'Demo mode', 'Use the built-in simulator (no binaries, no rewards)', c.panel.demoMode)}
        <div class="field mt-14">
          <label for="miner-extra">Extra miner arguments</label>
          <input class="input mono" id="miner-extra" value="${esc(c.mining.minerExtraArgs || '')}" placeholder="--altlogs" />
        </div>
        <div class="field mt-8">
          <label for="node-extra">Extra node arguments</label>
          <input class="input mono" id="node-extra" value="${esc(c.node.extraArgs || '')}" placeholder="--loglevel=info" />
        </div>
        <div class="form-actions mt-14">
          <button class="btn btn-primary" type="button" data-action="save-setup">Save configuration</button>
          <button class="btn btn-ghost" type="button" data-action="start-after-save">Save &amp; start mining</button>
        </div>
        <p class="form-note" id="setup-note"></p>
      </div>
    </div>`;

  renderPlan();
  renderBinaries();
  wireSetupForm();
}

function switchRow(id, title, desc, checked) {
  return `<div class="switch">
    <div class="switch-text"><strong>${esc(title)}</strong><small>${esc(desc)}</small></div>
    <label class="toggle"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} /><span></span></label>
  </div>`;
}

function wireSetupForm() {
  const view = $('#view');
  let mode = state.config.mining.mode;
  let network = state.config.mining.network;

  view.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.mode;
      view.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
      $('#remote-fields').classList.toggle('hidden', mode !== 'remote');
      $('#custom-fields').classList.toggle('hidden', mode !== 'custom');
    });
  });

  view.querySelectorAll('[data-network]').forEach((btn) => {
    btn.addEventListener('click', () => {
      network = btn.dataset.network;
      view.querySelectorAll('[data-network]').forEach((b) => b.classList.toggle('active', b === btn));
      validateAddressField();
    });
  });

  const range = $('#threads-range');
  const rangeVal = $('#threads-val');
  range.addEventListener('input', () => {
    const cores = state.status?.host?.cores || 4;
    rangeVal.textContent = Number(range.value) === 0 ? 'auto' : `${range.value} of ${cores}`;
  });

  const addressInput = $('#address-input');
  let addressValid = Boolean(state.config.mining.address);
  const validateAddressField = async () => {
    const value = addressInput.value.trim();
    const hint = $('#address-hint');
    if (!value) {
      addressValid = false;
      addressInput.classList.remove('valid', 'invalid');
      hint.textContent = 'Mined blocks are paid to this address.';
      hint.className = 'hint';
      return;
    }
    try {
      const check = await api('/api/address/validate', { method: 'POST', body: { address: value } });
      const networkOk = check.valid && check.network === network;
      addressValid = networkOk;
      addressInput.classList.toggle('valid', networkOk);
      addressInput.classList.toggle('invalid', !networkOk);
      hint.textContent = !check.valid ? check.error : networkOk ? `Valid ${check.network} ${check.versionName} address` : `This is a ${check.network} address — switch the network or use a ${network} address`;
      hint.className = `hint ${networkOk ? 'green' : 'red'}`;
    } catch {
      addressValid = false;
    }
  };
  addressInput.addEventListener('input', validateAddressField);
  if (state.config.mining.address) validateAddressField();

  view.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const presets = {
        lolminer: { command: './lolMiner --algo KASPA --pool {{pool}} --user {{address}}.{{worker}}', pool: 'kaspa.woolypooly.com:3112' },
        srbminer: {
          command: './SRBMiner-MULTI --algorithm heavyhash --pool {{pool}} --wallet {{address}} --worker {{worker}}',
          pool: 'pool.example.com:3112',
        },
        'cpuminer-remote': { command: '', pool: '' },
      };
      const preset = presets[btn.dataset.preset];
      if (preset) {
        $('#custom-command').value = preset.command;
        $('#pool-url').value = preset.pool;
      }
      if (btn.dataset.preset === 'cpuminer-remote') {
        view.querySelector('[data-mode="remote"]').click();
      }
    });
  });

  view.querySelectorAll('[data-action="goto-wallet"]').forEach((b) => b.addEventListener('click', () => setTab('wallet')));

  view.querySelector('[data-action="save-setup"]').addEventListener('click', () => saveSetup({ start: false }));
  view.querySelector('[data-action="start-after-save"]').addEventListener('click', () => saveSetup({ start: true }));

  function collect() {
    return {
      mining: {
        mode,
        network,
        address: addressInput.value.trim(),
        threads: Number(range.value) === 0 ? 0 : Number(range.value),
        minerPath: $('#miner-path').value.trim(),
        minerExtraArgs: $('#miner-extra').value.trim(),
        remoteHost: $('#remote-host').value.trim(),
        remotePort: Number($('#remote-port').value),
        customCommand: $('#custom-command').value,
        poolUrl: $('#pool-url').value.trim(),
        workerName: $('#worker-name').value.trim(),
        autoStart: $('#mining-autostart').checked,
        restartOnCrash: $('#mining-restart').checked,
      },
      node: {
        dataDir: $('#node-datadir').value.trim(),
        retentionDays: Number($('#node-retention').value),
        ramScale: Number($('#node-ram').value),
        archival: $('#node-archival').checked,
        utxoIndex: $('#node-utxo').checked,
        exposeRpc: $('#node-expose-rpc').checked,
        exposeP2P: $('#node-expose-p2p').checked,
        extraArgs: $('#node-extra').value.trim(),
      },
      panel: { demoMode: $('#panel-demo').checked },
    };
  }

  async function saveSetup({ start }) {
    const note = $('#setup-note');
    note.textContent = 'Saving…';
    note.className = 'form-note';
    try {
      await api('/api/setup', { method: 'POST', body: { config: collect() } });
      state.config = (await api('/api/config')).config;
      note.textContent = 'Saved.';
      note.className = 'form-note green';
      toast('Configuration saved', 'success');
      await refreshStatus();
      if (start) await startMining();
    } catch (err) {
      note.textContent = err.message;
      note.className = 'form-note red';
      toast(err.message, 'error');
    }
  }
}

function renderPlan() {
  const box = $('#plan-checks');
  if (!box) return;
  const plan = state.status?.resources?.plan;
  if (!plan) {
    box.innerHTML = '<p class="small muted">Collecting server details…</p>';
    return;
  }
  box.innerHTML = plan.checks
    .map(
      (c) => `<div class="mini-row">
        <span class="k">${esc(c.label)}</span>
        <span class="v">
          <span class="${c.ok ? 'green' : 'red'}">${c.ok ? '✓' : '✕'}</span>
          ${c.value} ${c.unit}
          <span class="muted tiny">/ ${c.recommended} recommended</span>
        </span>
      </div>`,
    )
    .join('');
  const badge = $('#plan-badge');
  if (badge) {
    badge.textContent = plan.ok ? 'meets the plan' : 'below recommendation';
    badge.className = `tiny ${plan.ok ? 'green' : 'amber'}`;
  }
  const note = $('#plan-note');
  if (note) {
    note.innerHTML = `Detected plan: <strong>${plan.checks[0].value} vCPU · ${plan.checks[1].value} GB RAM · ${plan.checks[2].value} GB free</strong>.
      This is enough for ${plan.mode === 'solo' ? 'a pruned mainnet node plus the CPU miner' : 'the CPU miner alone'}.
      Suggested miner threads: <strong>${plan.suggestedThreads}</strong>.`;
  }
}

function renderBinaries() {
  const box = $('#binaries-box');
  if (!box) return;
  const s = state.status;
  const inst = s?.install || {};
  const binaries = s?.binaries || {};
  const rows = [
    ['kaspad', 'Node', binaries.node],
    ['kaspa-miner', 'CPU miner', binaries.miner],
  ];

  box.innerHTML = `
    ${rows
      .map(
        ([name, label, path]) => `<div class="mini-row">
          <span class="k">${label} <span class="mono tiny">${name}</span></span>
          <span class="v ${path ? 'green' : 'red'}">${path ? 'installed' : 'missing'}</span>
        </div>`,
      )
      .join('')}
    ${inst.running ? `<div class="mt-8">
        <div class="meter-head"><span>${esc(inst.message || 'working…')}</span><span>${inst.percent || 0}%</span></div>
        <div class="bar"><i style="width:${inst.percent || 0}%"></i></div>
      </div>` : ''}
    ${inst.error ? `<p class="small red">${esc(inst.error)}</p>` : ''}
    <div class="row mt-8">
      <button class="btn btn-sm" data-install="node" ${inst.running ? 'disabled' : ''}>Install kaspad</button>
      <button class="btn btn-sm" data-install="miner" ${inst.running ? 'disabled' : ''}>Install kaspa-miner</button>
      <button class="btn btn-sm btn-ghost" data-action="refresh-status">Refresh</button>
    </div>
    <p class="form-note">Downloads the official release from GitHub into <span class="mono">data/bin</span> (about 50 MB total).</p>`;

  box.querySelectorAll('[data-install]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('/api/install', { method: 'POST', body: { target: btn.dataset.install } });
        toast('Install started — this can take a minute', 'info');
        pollInstall();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    }),
  );
  box.querySelector('[data-action="refresh-status"]')?.addEventListener('click', () => refreshStatus());
}

function pollInstall() {
  if (state.installPoll) clearInterval(state.installPoll);
  state.installPoll = setInterval(async () => {
    try {
      const inst = await api('/api/install');
      if (state.status) {
        state.status.install = inst;
        state.status.binaries = inst.binaries;
      }
      renderBinaries();
      if (!inst.running) {
        clearInterval(state.installPoll);
        state.installPoll = null;
        if (inst.done) toast(inst.message || 'Installed', 'success');
        else if (inst.error) toast(inst.error, 'error');
        await refreshStatus();
      }
    } catch {
      clearInterval(state.installPoll);
      state.installPoll = null;
    }
  }, 1500);
}

/* -------------------------------- wallet ------------------------------- */

function mountWallet(view) {
  const c = state.config;
  const address = state.wallet?.address || c?.mining.address || '';
  view.innerHTML = `
    <div class="grid c2">
      <div class="card">
        <div class="card-head">
          <div><div class="card-title">${icon('key', 14)} Mining address</div>
          <div class="card-sub">Where block rewards are paid</div></div>
          <span class="pill ${address ? 'running' : 'waiting'}">${address ? 'configured' : 'not set'}</span>
        </div>
        ${
          address
            ? `<div class="copy-addr">
                 <code class="mono small wrap-anywhere" id="wallet-address" style="flex:1">${esc(address)}</code>
                 <button class="btn btn-sm" data-copy="${esc(address)}" type="button">Copy</button>
               </div>`
            : `<p class="small muted">No address configured yet. Generate one below, or paste an address from your own wallet in Settings → Setup.</p>`
        }
        <div class="mini-row mt-14"><span class="k">Network</span><span class="v" id="wallet-network">${esc(c?.mining.network || 'mainnet')}</span></div>
        <div class="mini-row"><span class="k">Keystore in panel</span><span class="v" id="wallet-store">${state.wallet?.exists ? 'yes' : 'no'}</span></div>
        <div class="mini-row"><span class="k">Balance on chain</span><span class="v" id="wallet-balance">loading…</span></div>
        <div class="row mt-14">
          <button class="btn btn-sm btn-primary" data-action="gen-wallet" type="button">Generate new address</button>
          <button class="btn btn-sm" data-action="import-wallet" type="button">Import private key</button>
          ${state.wallet?.exists ? '<button class="btn btn-sm btn-ghost" data-action="reveal-key" type="button">Reveal key</button>' : ''}
          <button class="btn btn-sm btn-ghost" data-action="refresh-balance" type="button">Refresh balance</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">${icon('box', 14)} How to get a Kaspa wallet</div></div>
        <ol class="small muted" style="margin:0;padding-left:18px;line-height:1.9">
          <li><a href="https://kaspium.io" target="_blank" rel="noreferrer noopener">Kaspium</a> (mobile) — fastest path, works on mainnet and testnet.</li>
          <li><a href="https://kdx.app" target="_blank" rel="noreferrer noopener">KDX</a> — desktop wallet with a testnet switch.</li>
          <li><a href="https://kaspad.com" target="_blank" rel="noreferrer noopener">Kaspa NG / kaspad CLI</a> — for servers and scripting.</li>
        </ol>
        <div class="callout warn mt-14">
          <span class="ico">!</span>
          <div><strong>About the built-in generator</strong>
          <p class="small muted mt-8">The panel can create a secp256k1 keypair and store it encrypted with your panel password.
          That is convenient, but a web panel is not a hardware wallet: back up the private key and, for meaningful amounts,
          use an address created in an official wallet instead.</p></div>
        </div>
      </div>
    </div>`;

  view.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', () => copyText(btn.dataset.copy)));
  view.querySelector('[data-action="gen-wallet"]')?.addEventListener('click', generateWalletFlow);
  view.querySelector('[data-action="import-wallet"]')?.addEventListener('click', importWalletFlow);
  view.querySelector('[data-action="reveal-key"]')?.addEventListener('click', revealKeyFlow);
  view.querySelector('[data-action="refresh-balance"]')?.addEventListener('click', () => {
    const el = $('#wallet-balance');
    if (el) el.textContent = 'loading…';
    loadBalance();
  });
  loadBalance();
}

async function loadBalance() {
  const el = $('#wallet-balance');
  if (!el) return;
  const address = state.wallet?.address || state.config?.mining.address;
  if (!address) {
    el.textContent = 'no address';
    return;
  }
  try {
    // Proxied through the panel so the browser never talks to a third party
    const data = await api(`/api/wallet/balance?address=${encodeURIComponent(address)}`);
    el.textContent = data.available ? `${Number(data.kas).toFixed(4)} KAS` : 'unavailable (no internet)';
  } catch {
    el.textContent = '—';
  }
}

async function generateWalletFlow() {
  const password = await promptPassword({
    title: 'Generate a new Kaspa address',
    sub: 'A fresh secp256k1 keypair is created on the server and encrypted with this password.',
  });
  if (!password) return;
  try {
    const res = await api('/api/wallet/generate', { method: 'POST', body: { password, network: state.config?.mining.network || 'mainnet' } });
    state.wallet = { exists: true, address: res.address };
    openModal({
      title: 'New address created',
      sub: 'Mined blocks will be paid to this address.',
      body: `<div class="field"><label>Address</label><code class="code">${esc(res.address)}</code></div>
        <div class="field mt-14"><label>Private key — shown once</label>
        <code class="code" style="color:#ffd6a5">${esc(res.privateKey)}</code>
        <span class="hint red">Write this down now. Anyone with this key controls the funds. The panel keeps an encrypted copy while this password is unchanged.</span></div>`,
      actions: [
        { label: 'Copy address', onClick: () => { copyText(res.address); return false; } },
        { label: 'Done', className: 'btn-primary', onClick: () => {} },
      ],
      wide: true,
    });
    state.config = (await api('/api/config')).config;
    await refreshStatus();
    setTab('wallet');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function importWalletFlow() {
  openModal({
    title: 'Import a private key',
    sub: 'Paste a 64-character hex secp256k1 private key. It is encrypted with your panel password.',
    body: `<div class="field"><label for="import-key">Private key</label>
      <input class="input mono" id="import-key" type="password" autocomplete="off" placeholder="64 hex characters" /></div>
      <div class="field mt-14"><label for="import-password">Panel password</label>
      <input class="input" id="import-password" type="password" autocomplete="current-password" /></div>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Import',
        className: 'btn-primary',
        keepOpen: true,
        onClick: async (bodyEl, btn) => {
          btn.disabled = true;
          try {
            const res = await api('/api/wallet/import', {
              method: 'POST',
              body: {
                privateKey: $('#import-key', bodyEl).value.trim(),
                password: $('#import-password', bodyEl).value,
                network: state.config?.mining.network || 'mainnet',
              },
            });
            toast(`Imported: ${res.address}`, 'success');
            closeModal();
            state.config = (await api('/api/config')).config;
            state.wallet = { exists: true, address: res.address };
            await refreshStatus();
            setTab('wallet');
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });
}

async function revealKeyFlow() {
  const password = await promptPassword({ title: 'Reveal private key', sub: 'Only do this on a trusted machine.' });
  if (!password) return;
  try {
    const res = await api('/api/wallet/reveal', { method: 'POST', body: { password } });
    openModal({
      title: 'Private key',
      sub: 'Keep this secret. Anyone who has it controls the funds.',
      body: `<code class="code" style="color:#ffd6a5">${esc(res.privateKey)}</code>`,
      actions: [
        { label: 'Copy', onClick: () => { copyText(res.privateKey); return false; } },
        { label: 'Close', className: 'btn-primary' },
      ],
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* --------------------------------- logs -------------------------------- */

function mountLogs(view) {
  view.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div><div class="card-title">${icon('terminal', 14)} Process output</div>
        <div class="card-sub">Live tail from this server</div></div>
        <div class="log-toolbar">
          <div class="segmented" id="log-kind">
            <button type="button" data-kind="miner" class="active">Miner</button>
            <button type="button" data-kind="node">Node</button>
          </div>
          <label class="toggle" title="follow"><input type="checkbox" id="log-follow" checked /><span></span></label>
          <span class="tiny muted">follow</span>
          <button class="btn btn-sm btn-ghost" data-action="log-download">Download</button>
        </div>
      </div>
      <div class="logs" id="log-box"><div class="log-empty">Waiting for output…</div></div>
      <p class="form-note mt-8">Full logs are written to <span class="mono">data/logs/miner.log</span> and <span class="mono">data/logs/node.log</span> (rotated at 8 MB).</p>
    </div>`;

  state.logCursor = { miner: 0, node: 0 };
  state.logLines = { miner: [], node: [] };
  let kind = 'miner';

  const box = $('#log-box');
  view.querySelectorAll('[data-kind]').forEach((btn) =>
    btn.addEventListener('click', () => {
      kind = btn.dataset.kind;
      view.querySelectorAll('[data-kind]').forEach((b) => b.classList.toggle('active', b === btn));
      state.logCursor[kind] = 0;
      box.innerHTML = '';
      pollLogs({ recent: true });
    }),
  );
  view.querySelector('[data-action="log-download"]').addEventListener('click', () => {
    window.location.href = `/api/logs/download?kind=${kind}`;
  });

  async function pollLogs({ recent = false } = {}) {
    if (state.tab !== 'logs') return;
    try {
      const cursor = state.logCursor[kind];
      const query = recent || !cursor ? `kind=${kind}&preset=recent` : `kind=${kind}&since=${cursor}`;
      const data = await api(`/api/logs?${query}`);
      state.logCursor[kind] = Math.max(data.lastId, cursor);
      if (data.lines.length) {
        const html = data.lines
          .map((l) => {
            const level = /error|panic/i.test(l.line) ? 'error' : /warn/i.test(l.line) ? 'warn' : /debug/i.test(l.line) ? 'debug' : /\[demo\]/.test(l.line) ? 'demo' : '';
            return `<div class="log-line ${level}"><span class="ts">${new Date(l.t).toLocaleTimeString()}</span><span class="msg">${esc(l.line)}</span></div>`;
          })
          .join('');
        box.insertAdjacentHTML('beforeend', html);
        while (box.childElementCount > 1200) box.removeChild(box.firstChild);
        if ($('#log-follow')?.checked) box.scrollTop = box.scrollHeight;
      }
    } catch {
      /* ignore */
    }
  }

  pollLogs({ recent: true });
  if (state.loop) clearInterval(state.loop);
  state.loop = setInterval(() => pollLogs(), 2000);
}

/* -------------------------------- deploy ------------------------------- */

async function mountDeploy(view) {
  view.innerHTML = `<div class="card"><div class="row"><div class="spinner"></div><span class="muted small">Generating deployment kit…</span></div></div>`;
  try {
    const data = await api('/api/deploy');
    state.deploy = data;
    let active = data.files[0]?.name;
    view.innerHTML = `
      <div class="grid c2">
        <div class="card">
          <div class="card-head"><div class="card-title">${icon('ship', 14)} Install on your server</div>
          <button class="btn btn-sm btn-primary" data-action="download-zip">Download kit (.zip)</button></div>
          <p class="small muted">Two supported paths. Both run the panel, kaspad and the miner on the same host.</p>
          <div class="stack mt-14">
            <div>
              <div class="card-sub">Option A — Docker (fastest)</div>
              <pre class="code">git clone ${data.repo || '<your-repo>'} kaspa-console &amp;&amp; cd kaspa-console
cp .env.example .env        # optional
docker compose up -d --build
# panel:  http://SERVER_IP:${data.port}</pre>
            </div>
            <div>
              <div class="card-sub">Option B — native systemd</div>
              <pre class="code">git clone ${data.repo || '<your-repo>'} kaspa-console &amp;&amp; cd kaspa-console
sudo bash deploy/install.sh
# prints the URL and the one-time setup token</pre>
            </div>
            <div>
              <div class="card-sub">HTTPS</div>
              <pre class="code">sudo cp deploy/nginx.conf /etc/nginx/sites-available/kaspa-console
sudo ln -s ../sites-available/kaspa-console /etc/nginx/sites-enabled/
sudo certbot --nginx -d console.example.com</pre>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">${icon('box', 14)} Aiven note</div></div>
          <p class="small muted">Aiven is a managed-data platform: it runs PostgreSQL, Kafka, Redis, OpenSearch and similar services.
          It has no shell and does not host long-running mining daemons, so the node and the miner cannot run inside the Aiven console.</p>
          <p class="small muted mt-8">What you <em>can</em> do is keep this panel's state in an Aiven for PostgreSQL service:</p>
          <pre class="code mt-8">DATABASE_URL="postgres://avnadmin:PASS@pg-xyz.aivencloud.com:PORT/defaultdb?sslmode=require" \\
  docker compose up -d --build</pre>
          <p class="small muted mt-8">The panel creates its table automatically and falls back to local files if the database is unreachable, so mining never stops on a DB hiccup.</p>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div><div class="card-title">Generated files</div>
          <div class="card-sub">Tailored to your current configuration</div></div>
          <div class="file-tabs" id="file-tabs">
            ${data.files.map((f) => `<button class="file-tab ${f.name === active ? 'active' : ''}" data-file="${esc(f.name)}">${esc(f.name)}</button>`).join('')}
          </div>
        </div>
        <div class="code-head">
          <span class="tiny muted mono" id="file-name">${esc(active)}</span>
          <div class="row">
            <button class="btn btn-sm btn-ghost" data-action="copy-file">Copy</button>
            <button class="btn btn-sm btn-ghost" data-action="download-file">Download</button>
          </div>
        </div>
        <pre class="code" id="file-content"></pre>
      </div>`;

    const showFile = (name) => {
      active = name;
      const file = data.files.find((f) => f.name === name);
      $('#file-content').textContent = file?.content || '';
      $('#file-name').textContent = name;
      view.querySelectorAll('[data-file]').forEach((b) => b.classList.toggle('active', b.dataset.file === name));
    };
    view.querySelectorAll('[data-file]').forEach((btn) => btn.addEventListener('click', () => showFile(btn.dataset.file)));
    showFile(active);

    view.querySelector('[data-action="copy-file"]').addEventListener('click', () => {
      const file = data.files.find((f) => f.name === active);
      copyText(file?.content || '');
    });
    view.querySelector('[data-action="download-file"]').addEventListener('click', () => {
      window.location.href = `/api/deploy/download?file=${encodeURIComponent(active)}`;
    });
    view.querySelector('[data-action="download-zip"]').addEventListener('click', () => {
      window.location.href = '/api/deploy/zip';
    });
  } catch (err) {
    view.innerHTML = `<div class="card"><p class="red">${esc(err.message)}</p></div>`;
  }
}

/* ------------------------------- settings ------------------------------ */

function mountSettings(view) {
  const c = state.config;
  if (!c) return;
  view.innerHTML = `
    <div class="grid c2">
      <div class="card">
        <div class="card-head"><div class="card-title">${icon('gear', 14)} Panel</div></div>
        <div class="field">
          <label for="panel-name">Console name</label>
          <input class="input" id="panel-name" value="${esc(c.panel.name)}" maxlength="60" />
        </div>
        <div class="field mt-14">
          <label for="panel-refresh">Refresh interval (ms)</label>
          <input class="input mono" id="panel-refresh" type="number" min="1000" max="30000" step="500" value="${c.panel.refreshMs}" />
        </div>
        <div class="form-actions mt-14">
          <button class="btn btn-primary" data-action="save-panel">Save</button>
          <button class="btn btn-ghost" data-action="export-config">Export config</button>
        </div>
        <div class="mini-row mt-14"><span class="k">Storage backend</span><span class="v">${esc(state.status?.backend || 'file')}</span></div>
        <div class="mini-row"><span class="k">Data directory</span><span class="v truncate">${esc(state.system?.dataDir || '')}</span></div>
        <div class="mini-row"><span class="k">Node.js</span><span class="v">${esc(state.system?.nodeVersion || '')}</span></div>
        <div class="mini-row"><span class="k">Host</span><span class="v">${esc(state.system?.hostname || '')}</span></div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">${icon('key', 14)} Security</div></div>
        <div class="field">
          <label for="pw-current">Current password</label>
          <input class="input" id="pw-current" type="password" autocomplete="current-password" />
        </div>
        <div class="form-grid mt-8">
          <div class="field"><label for="pw-next">New password</label><input class="input" id="pw-next" type="password" autocomplete="new-password" /></div>
          <div class="field"><label for="pw-next2">Repeat</label><input class="input" id="pw-next2" type="password" autocomplete="new-password" /></div>
        </div>
        <div class="form-actions mt-14">
          <button class="btn" data-action="change-password">Change password</button>
          <button class="btn btn-ghost" data-action="logout">Sign out</button>
        </div>
        <p class="form-note">Changing the password signs out every session and re-encrypts the stored mining key.</p>
        <div class="mt-14" id="sessions-box"></div>
      </div>
    </div>

    <div class="grid c2">
      <div class="card">
        <div class="card-head"><div class="card-title">${icon('zap', 14)} Alerts</div></div>
        <div class="field">
          <label for="webhook">Webhook URL <span class="muted tiny">(Slack, Discord or any JSON endpoint)</span></label>
          <input class="input mono" id="webhook" value="${esc(c.alerts.webhookUrl || '')}" placeholder="https://hooks.slack.com/services/..." />
        </div>
        <div class="mt-14">
          ${switchRow('alert-block', 'Notify on block found', 'Send the block hash when the miner submits a block', c.alerts.notifyOnBlock)}
          ${switchRow('alert-crash', 'Notify on crashes', 'Send an alert when the miner exits unexpectedly', c.alerts.notifyOnCrash)}
        </div>
        <div class="form-actions mt-14"><button class="btn btn-primary" data-action="save-alerts">Save alerts</button></div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">${icon('coins', 14)} Network data</div></div>
        <p class="small muted">Estimates pull live hashrate and price from <span class="mono">api.kaspa.org</span>. Override them if that endpoint is unreachable or you prefer fixed values.</p>
        <div class="form-grid mt-14">
          <div class="field"><label for="reward-override">Block reward (KAS)</label><input class="input mono" id="reward-override" type="number" step="0.0001" value="${c.network.blockRewardOverride || 0}" /></div>
          <div class="field"><label for="price-override">KAS price (USD)</label><input class="input mono" id="price-override" type="number" step="0.0001" value="${c.network.priceOverride || 0}" /></div>
        </div>
        <div class="form-actions mt-14">
          <button class="btn btn-primary" data-action="save-network">Save</button>
          <button class="btn btn-ghost" data-action="refresh-network">Refresh now</button>
        </div>
        <div class="callout warn mt-14">
          <span class="ico">!</span>
          <div><strong>Danger zone</strong>
          <p class="small muted mt-8">Stopping the panel leaves kaspad and the miner stopped. Node data is never deleted by the panel.</p>
          <button class="btn btn-sm danger mt-8" data-action="stop-all">Stop everything</button></div>
        </div>
      </div>
    </div>`;

  view.querySelector('[data-action="save-panel"]').addEventListener('click', () =>
    savePartial({ panel: { name: $('#panel-name').value, refreshMs: Number($('#panel-refresh').value) } }, 'Panel settings saved'),
  );
  view.querySelector('[data-action="save-alerts"]').addEventListener('click', () =>
    savePartial(
      { alerts: { webhookUrl: $('#webhook').value, notifyOnBlock: $('#alert-block').checked, notifyOnCrash: $('#alert-crash').checked } },
      'Alert settings saved',
    ),
  );
  view.querySelector('[data-action="save-network"]').addEventListener('click', () =>
    savePartial(
      { network: { blockRewardOverride: Number($('#reward-override').value), priceOverride: Number($('#price-override').value) } },
      'Network overrides saved',
    ),
  );
  view.querySelectorAll('[data-action="refresh-network"]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api('/api/network/refresh', { method: 'POST' });
        await refreshStatus();
        toast('Network data refreshed', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    }),
  );
  view.querySelector('[data-action="export-config"]').addEventListener('click', () => {
    window.location.href = '/api/export/config';
  });
  view.querySelector('[data-action="logout"]').addEventListener('click', logout);
  view.querySelector('[data-action="stop-all"]').addEventListener('click', async () => {
    try {
      await api('/api/miner/stop', { method: 'POST' });
      toast('All mining processes stopped', 'info');
      await refreshStatus();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  view.querySelector('[data-action="change-password"]').addEventListener('click', async () => {
    const current = $('#pw-current').value;
    const next = $('#pw-next').value;
    if (next !== $('#pw-next2').value) return toast('New passwords do not match', 'error');
    try {
      await api('/api/auth/password', { method: 'POST', body: { current, next } });
      authToken.set('');
      toast('Password changed — sign in again', 'success');
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  updateSessionInfo();
}

function updateSessionInfo() {
  const box = $('#sessions-box');
  if (!box) return;
  api('/api/config')
    .then((data) => {
      const sessions = data.sessions || [];
      box.innerHTML = `<div class="card-sub">Active sessions</div>
        <table class="table mt-8"><tr><th>Since</th><th>IP</th><th>Client</th></tr>
        ${sessions
          .map(
            (s) =>
              `<tr><td>${new Date(s.createdAt).toLocaleString()}</td><td>${esc(s.ip || '—')}</td><td class="truncate" style="max-width:200px">${esc(
                (s.ua || '').slice(0, 60),
              )}</td></tr>`,
          )
          .join('')}</table>`;
    })
    .catch(() => {});
}

async function savePartial(patch, message) {
  try {
    await api('/api/config', { method: 'PUT', body: patch });
    state.config = (await api('/api/config')).config;
    toast(message, 'success');
    await refreshStatus();
    if (patch.panel?.refreshMs) startPolling();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST', body: {} });
  } catch {
    /* ignore */
  }
  authToken.set('');
  stopPolling();
  window.location.reload();
}

/* ------------------------------ global acts ---------------------------- */

async function startMining() {
  const s = state.status;
  const btn = $('#btn-start');
  btn.disabled = true;
  try {
    const res = await api('/api/miner/start', { method: 'POST', body: { demo: Boolean(s?.miner?.simulated) } });
    toast(res.demo ? 'Demo miner started' : 'Mining started', 'success');
    await refreshStatus();
  } catch (err) {
    if (err.data?.code === 'NODE_BINARY_MISSING' || err.data?.code === 'MINER_BINARY_MISSING') {
      openModal({
        title: 'Binaries not installed',
        sub: 'The miner needs the official Kaspa binaries before it can start.',
        body: `<p class="small muted">Install kaspad and kaspa-miner from the Setup tab, or keep exploring with the simulator.</p>`,
        actions: [
          { label: 'Start demo instead', onClick: () => startDemo() },
          {
            label: 'Open setup',
            className: 'btn-primary',
            onClick: () => {
              setTab('setup');
            },
          },
        ],
      });
    } else {
      openModal({
        title: 'Cannot start mining yet',
        sub: esc(err.message),
        body: `<p class="small muted">Fix the highlighted requirement in Setup, or explore the dashboard with the simulator.</p>`,
        actions: [
          { label: 'Start demo instead', onClick: () => startDemo() },
          {
            label: 'Open setup',
            className: 'btn-primary',
            onClick: () => {
              setTab('setup');
            },
          },
        ],
      });
    }
  } finally {
    btn.disabled = false;
  }
}

async function startDemo() {
  try {
    await api('/api/miner/start', { method: 'POST', body: { demo: true } });
    toast('Demo simulator started', 'success');
    await refreshStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function stopMining() {
  const btn = $('#btn-stop');
  btn.disabled = true;
  try {
    await api('/api/miner/stop', { method: 'POST' });
    toast('Mining stopped', 'info');
    await refreshStatus();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function restartMining() {
  try {
    await api('/api/miner/restart', { method: 'POST' });
    toast('Restarted', 'info');
    await refreshStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* -------------------------------- views -------------------------------- */

const VIEWS = {
  overview: mountOverview,
  setup: mountSetup,
  node: mountNode,
  wallet: mountWallet,
  logs: mountLogs,
  deploy: mountDeploy,
  settings: mountSettings,
};

/* ------------------------------- wiring -------------------------------- */

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'goto-setup') setTab('setup');
  if (action === 'goto-logs') setTab('logs');
  if (action === 'goto-wallet') setTab('wallet');
  if (action === 'refresh-status') refreshStatus();
  if (action === 'stop-demo') await stopMining();
  if (action === 'refresh-network') {
    try {
      await api('/api/network/refresh', { method: 'POST' });
      await refreshStatus();
      toast('Network data refreshed', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  if (action === 'node-start') {
    try {
      await api('/api/node/start', { method: 'POST' });
      toast('Node starting', 'info');
      await refreshStatus();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  if (action === 'node-stop') await stopMining();
});

$('#btn-start')?.addEventListener('click', startMining);
$('#btn-stop')?.addEventListener('click', stopMining);
$('#btn-restart')?.addEventListener('click', restartMining);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'r' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    e.preventDefault();
    refreshStatus();
  }
});

boot();
