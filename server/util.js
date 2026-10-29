'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const BIN_DIR = process.env.BIN_DIR ? path.resolve(process.env.BIN_DIR) : path.join(DATA_DIR, 'bin');
const KASPAD_DIR = path.join(DATA_DIR, 'kaspad');

for (const dir of [DATA_DIR, LOG_DIR, BIN_DIR]) fs.mkdirSync(dir, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      } catch {
        /* file vanished mid-walk */
      }
    }
  }
  return total;
}

function diskInfo(targetPath) {
  try {
    const st = fs.statfsSync(targetPath);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { total, free, used: total - free };
  } catch {
    return { total: 0, free: 0, used: 0 };
  }
}

function which(bin) {
  const parts = (process.env.PATH || '').split(path.delimiter);
  for (const p of parts) {
    const candidate = path.join(p, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function isExecutable(file) {
  if (!file) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

const GB = 1024 ** 3;
const gb = (bytes, digits = 1) => (bytes / GB).toFixed(digits);

function formatHashrate(h) {
  if (!Number.isFinite(h) || h <= 0) return { value: 0, unit: 'H/s', text: '0 H/s' };
  const units = [
    [1e15, 'PH/s'],
    [1e12, 'TH/s'],
    [1e9, 'GH/s'],
    [1e6, 'MH/s'],
    [1e3, 'kH/s'],
    [1, 'H/s'],
  ];
  for (const [div, unit] of units) {
    if (h >= div) {
      const value = h / div;
      return { value, unit, text: `${value >= 100 ? value.toFixed(0) : value.toFixed(2)} ${unit}` };
    }
  }
  return { value: h, unit: 'H/s', text: `${h.toFixed(2)} H/s` };
}

function humanDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  const d = Math.floor(s / 86400);
  if (d < 365) return `${d}d ${Math.floor((s % 86400) / 3600)}h`;
  const y = s / 31557600;
  return `${y >= 1000 ? Math.round(y).toLocaleString('en-US') : y.toFixed(1)} years`;
}

/** Fixed-size ring buffer of log lines. */
class RingLog {
  constructor(limit = 3000) {
    this.limit = limit;
    this.items = [];
    this.nextId = 1;
  }

  push(line, stream = 'out') {
    const item = { id: this.nextId++, t: Date.now(), stream, line };
    this.items.push(item);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    return item;
  }

  since(id, limit = 500) {
    const out = [];
    for (let i = this.items.length - 1; i >= 0 && out.length < limit; i--) {
      if (this.items[i].id <= id) break;
      out.push(this.items[i]);
    }
    return out.reverse();
  }

  tail(n = 200) {
    return this.items.slice(-n);
  }
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function detectCpuModel() {
  try {
    const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const match = cpuinfo.match(/model name\s*:\s*(.+)/);
    if (match) return match[1].trim();
  } catch {
    /* not linux */
  }
  return os.cpus()[0]?.model || 'Unknown CPU';
}

module.exports = {
  ROOT,
  DATA_DIR,
  LOG_DIR,
  BIN_DIR,
  KASPAD_DIR,
  readJson,
  writeJson,
  dirSizeBytes,
  diskInfo,
  which,
  isExecutable,
  gb,
  GB,
  formatHashrate,
  humanDuration,
  RingLog,
  clamp,
  detectCpuModel,
};
