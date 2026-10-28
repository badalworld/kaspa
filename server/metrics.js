'use strict';
/**
 * Host sampling, hashrate history, Kaspa network data and earnings estimates.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DATA_DIR, diskInfo, readJson, writeJson, detectCpuModel } = require('./util');

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SAMPLE_MS = 5000;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

function readProcStat() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = line.split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

function readMemInfo() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = Number(text.match(/MemTotal:\s+(\d+)/)?.[1] || 0) * 1024;
    const available = Number(text.match(/MemAvailable:\s+(\d+)/)?.[1] || 0) * 1024;
    return { total, used: total - available, available };
  } catch {
    return { total: os.totalmem(), used: os.totalmem() - os.freemem(), available: os.freemem() };
  }
}

class HostMetrics {
  constructor() {
    this.lastCpu = readProcStat();
    this.cpuPct = 0;
    this.mem = readMemInfo();
    this.disk = diskInfo(DATA_DIR);
    this.cpuModel = detectCpuModel();
    this.cores = os.cpus().length;
    this.startedAt = Date.now();
    this.rx = 0;
    this.tx = 0;
  }

  sample() {
    const stat = readProcStat();
    if (stat && this.lastCpu) {
      const totalDelta = stat.total - this.lastCpu.total;
      const idleDelta = stat.idle - this.lastCpu.idle;
      if (totalDelta > 0) {
        this.cpuPct = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
      }
    }
    this.lastCpu = stat;
    this.mem = readMemInfo();
    this.disk = diskInfo(DATA_DIR);
    return this.snapshot();
  }

  snapshot() {
    const load = os.loadavg();
    return {
      cpuPct: Number(this.cpuPct.toFixed(1)),
      cpuModel: this.cpuModel,
      cores: this.cores,
      loadAvg: load.map((v) => Number(v.toFixed(2))),
      memTotal: this.mem.total,
      memUsed: this.mem.used,
      memPct: this.mem.total ? Number(((this.mem.used / this.mem.total) * 100).toFixed(1)) : 0,
      diskTotal: this.disk.total,
      diskUsed: this.disk.used,
      diskFree: this.disk.free,
      diskPct: this.disk.total ? Number(((this.disk.used / this.disk.total) * 100).toFixed(1)) : 0,
      uptimeSec: Math.floor(process.uptime()),
      hostUptimeSec: Math.floor(os.uptime()),
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      hostname: os.hostname(),
      nodeVersion: process.version,
      startedAt: this.startedAt,
    };
  }
}

class History {
  constructor() {
    this.samples = []; // { t, h }
    this.load();
    this.lastSave = 0;
    this.lastSample = 0;
  }

  load() {
    const doc = readJson(HISTORY_FILE, null);
    if (doc && Array.isArray(doc.samples)) {
      const cutoff = Date.now() - HISTORY_WINDOW_MS;
      this.samples = doc.samples.filter((s) => s && Number.isFinite(s.t) && s.t > cutoff);
    }
  }

  push(hashrate) {
    const now = Date.now();
    if (now - this.lastSample < SAMPLE_MS) {
      // refresh the latest sample instead of growing unbounded at high log rates
      const last = this.samples[this.samples.length - 1];
      if (last && now - last.t < SAMPLE_MS * 2) last.h = hashrate;
      return;
    }
    this.lastSample = now;
    this.samples.push({ t: now, h: Math.max(0, Math.round(hashrate)) });
    const cutoff = now - HISTORY_WINDOW_MS;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
    if (now - this.lastSave > 60000) {
      this.lastSave = now;
      try {
        writeJson(HISTORY_FILE, { samples: this.samples });
      } catch {
        /* non-fatal */
      }
    }
  }

  /** Average hashrate over the last `seconds`. */
  average(seconds) {
    const cutoff = Date.now() - seconds * 1000;
    const recent = this.samples.filter((s) => s.t >= cutoff);
    if (!recent.length) return 0;
    return recent.reduce((sum, s) => sum + s.h, 0) / recent.length;
  }

  /** Down-sampled series for the chart. */
  series(points = 120) {
    if (!this.samples.length) return [];
    const end = Date.now();
    const span = Math.min(HISTORY_WINDOW_MS, this.samples[this.samples.length - 1].t - this.samples[0].t);
    const bucketMs = Math.max(15000, Math.floor(span / points) || 15000);
    const buckets = new Map();
    for (const sample of this.samples) {
      const key = Math.floor(sample.t / bucketMs);
      const bucket = buckets.get(key) || { t: key * bucketMs, sum: 0, n: 0 };
      bucket.sum += sample.h;
      bucket.n += 1;
      buckets.set(key, bucket);
    }
    const out = [...buckets.values()]
      .sort((a, b) => a.t - b.t)
      .map((b) => ({ t: b.t, h: Math.round(b.sum / b.n) }));
    return out.slice(-points);
  }

  seed(values) {
    const now = Date.now();
    const step = 60000;
    this.samples = values.map((h, i) => ({ t: now - (values.length - i) * step, h }));
  }
}

const FALLBACK_NETWORK = {
  hashrate: 1.35e18,
  price: 0.032,
  blockReward: 3.45,
  blockTimeSec: 0.1,
  difficulty: 0,
  height: 0,
};

class NetworkService {
  constructor({ store }) {
    this.store = store;
    this.cache = { at: 0, data: null };
    this.balanceCache = { at: 0, address: '', data: null };
    this.offline = false;
    this.lastError = null;
  }

  async fetchJson(url, timeoutMs = 7000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': 'kaspa-mining-console/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async stats({ demo = false, force = false } = {}) {
    const now = Date.now();
    if (!force && this.cache.data && now - this.cache.at < 60000) {
      return { ...this.cache.data, demo };
    }
    const result = {
      online: false,
      demo,
      updatedAt: now,
      source: 'api.kaspa.org',
      hashrate: 0,
      price: 0,
      blockReward: 0,
      blockTimeSec: 0.1,
      difficulty: 0,
      height: 0,
      error: null,
    };
    try {
      const [hashrate, dag, price, reward] = await Promise.allSettled([
        this.fetchJson('https://api.kaspa.org/info/hashrate?stringOnly=false'),
        this.fetchJson('https://api.kaspa.org/info/blockdag?stringOnly=false'),
        this.fetchJson('https://api.kaspa.org/info/price?stringOnly=false'),
        this.fetchJson('https://api.kaspa.org/info/blockreward?stringOnly=false'),
      ]);
      if (hashrate.status === 'fulfilled' && hashrate.value) {
        const value = Number(hashrate.value.hashrate ?? hashrate.value);
        if (Number.isFinite(value) && value > 0) {
          result.hashrate = value;
          result.online = true;
        }
      }
      if (dag.status === 'fulfilled' && dag.value) {
        result.difficulty = Number(dag.value.difficulty) || 0;
        result.height = Number(dag.value.blockCount) || Number(dag.value.virtualDaaScore) || 0;
      }
      if (price.status === 'fulfilled' && price.value) {
        const value = Number(price.value.price ?? price.value);
        if (Number.isFinite(value) && value > 0) result.price = value;
      }
      if (reward.status === 'fulfilled' && reward.value) {
        const value = Number(reward.value.blockreward ?? reward.value.blockReward ?? reward.value);
        if (Number.isFinite(value) && value > 0) result.blockReward = value;
      }
    } catch (err) {
      result.error = err.message;
    }

    const overrides = this.store.config.network || {};
    if (Number(overrides.priceOverride) > 0) result.price = Number(overrides.priceOverride);
    if (Number(overrides.blockRewardOverride) > 0) result.blockReward = Number(overrides.blockRewardOverride);
    if (!result.blockReward) result.blockReward = FALLBACK_NETWORK.blockReward;
    if (!result.hashrate) result.hashrate = FALLBACK_NETWORK.hashrate;
    if (!result.price) result.price = FALLBACK_NETWORK.price;

    if (!result.online) {
      this.offline = true;
      this.lastError = result.error || 'network API unreachable';
      if (demo) {
        result.hashrate = FALLBACK_NETWORK.hashrate * (0.97 + Math.random() * 0.06);
        result.price = FALLBACK_NETWORK.price * (0.97 + Math.random() * 0.06);
        result.blockReward = FALLBACK_NETWORK.blockReward;
        result.height = 118_500_000;
        result.online = false;
        result.demo = true;
      }
    } else {
      this.offline = false;
      this.lastError = null;
    }
    this.cache = { at: now, data: result };
    return result;
  }

  async balance(address) {
    if (!address) return { available: false, error: 'no address' };
    const now = Date.now();
    if (this.balanceCache.data && this.balanceCache.address === address && now - this.balanceCache.at < 60000) {
      return this.balanceCache.data;
    }
    try {
      const data = await this.fetchJson(
        `https://api.kaspa.org/addresses/${encodeURIComponent(address)}/balance`,
        8000,
      );
      const sompi = Number(data?.balance ?? 0);
      const result = {
        available: true,
        sompi,
        kas: sompi / 1e8,
        updatedAt: now,
      };
      this.balanceCache = { at: now, address, data: result };
      return result;
    } catch (err) {
      const result = { available: false, error: err.message };
      this.balanceCache = { at: now, address, data: result };
      return result;
    }
  }
}

/**
 * Solo-mining maths: probability, expected time between blocks and earnings.
 */
function estimate({ myHashrate, network, networkId }) {
  const netHash = Number(network?.hashrate) || 0;
  const share = netHash > 0 ? myHashrate / netHash : 0;
  const blockTime = Number(network?.blockTimeSec) || 0.1;
  const blocksPerDay = 86400 / blockTime;
  const reward = Number(network?.blockReward) || 0;
  const price = Number(network?.price) || 0;
  const expectedBlocksPerDay = share * blocksPerDay;
  const kasPerDay = expectedBlocksPerDay * reward;
  const usdPerDay = kasPerDay * price;
  const expectedSecondsPerBlock = expectedBlocksPerDay > 0 ? 86400 / expectedBlocksPerDay : Infinity;
  return {
    networkId,
    networkShare: share,
    networkSharePct: share * 100,
    blocksPerDay: expectedBlocksPerDay,
    kasPerDay,
    usdPerDay,
    kasPerMonth: kasPerDay * 30,
    usdPerMonth: usdPerDay * 30,
    expectedSecondsPerBlock: Number.isFinite(expectedSecondsPerBlock) ? expectedSecondsPerBlock : null,
    reward,
    price,
    netHash,
    myHashrate,
  };
}

module.exports = { HostMetrics, History, NetworkService, estimate, FALLBACK_NETWORK };
