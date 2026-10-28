'use strict';
/**
 * Persistence layer.
 *
 * Default: a JSON file in ./data/config.json.
 * Optional: PostgreSQL (for example an Aiven PostgreSQL service) when
 * DATABASE_URL is set. The table is created automatically.
 *
 * Any database problem degrades gracefully to the JSON file so the panel keeps
 * running even if the managed database is unreachable.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, readJson, writeJson } = require('./util');

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function defaultConfig() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    setupComplete: false,
    auth: { password: null, salt: null, updatedAt: null, sessions: [] },
    panel: {
      name: 'Kaspa Mining Console',
      demoMode: false,
      refreshMs: 3000,
      publicUrl: '',
    },
    mining: {
      mode: 'solo', // solo | remote | custom
      network: 'mainnet',
      address: '',
      threads: 0, // 0 = auto
      autoStart: false,
      restartOnCrash: true,
      minerPath: '',
      minerExtraArgs: '',
      remoteHost: '127.0.0.1',
      remotePort: 16110,
      customCommand: '',
      customWorkDir: '',
      poolUrl: '',
      workerName: '',
    },
    node: {
      enabled: true,
      path: '',
      dataDir: '',
      utxoIndex: false,
      archival: false,
      retentionDays: 0, // 0 = node default (pruned)
      ramScale: 1,
      exposeRpc: false,
      exposeP2P: true,
      disableUpnp: true,
      extraArgs: '',
    },
    alerts: {
      webhookUrl: '',
      notifyOnBlock: true,
      notifyOnCrash: true,
      lowHashratePct: 0,
    },
    network: {
      blockRewardOverride: 0, // KAS per block, 0 = auto
      priceOverride: 0, // USD per KAS, 0 = auto
    },
  };
}

/** Copy `source` into `target` in place, keeping object identity intact. */
function assignInPlace(target, source) {
  for (const key of Object.keys(source)) {
    const incoming = source[key];
    const current = target[key];
    if (incoming && typeof incoming === 'object' && !Array.isArray(incoming) && current && typeof current === 'object' && !Array.isArray(current)) {
      assignInPlace(current, incoming);
    } else {
      target[key] = incoming;
    }
  }
  return target;
}

function mergeDeep(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch ?? base;
  if (typeof base !== 'object' || base === null) return patch ?? base;
  if (typeof patch !== 'object' || patch === null) return base;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    out[key] = key in base ? mergeDeep(base[key], patch[key]) : patch[key];
  }
  return out;
}

class Store {
  constructor() {
    this.backend = 'file';
    this.pool = null;
    this.cache = readJson(CONFIG_FILE, null);
    this.writeQueue = Promise.resolve();
  }

  async init() {
    const url = process.env.DATABASE_URL;
    if (!url) {
      if (!this.cache) this.cache = defaultConfig();
      this.cache = mergeDeep(defaultConfig(), this.cache);
      this.persistFile();
      return { backend: 'file' };
    }
    try {
      const { Pool } = require('pg');
      const ssl = /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: false } : undefined;
      this.pool = new Pool({ connectionString: url, ssl, max: 4, connectionTimeoutMillis: 8000 });
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS panel_state (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      const { rows } = await this.pool.query("SELECT value FROM panel_state WHERE key = 'config'");
      this.cache = mergeDeep(defaultConfig(), rows[0]?.value || {});
      this.backend = 'postgres';
      // Keep a local mirror so a DB outage never blocks the panel.
      writeJson(CONFIG_FILE, this.cache);
      return { backend: 'postgres' };
    } catch (err) {
      this.backend = 'file';
      this.pool = null;
      if (!this.cache) this.cache = defaultConfig();
      this.cache = mergeDeep(defaultConfig(), this.cache);
      this.persistFile();
      return { backend: 'file', warning: `Postgres unavailable (${err.message}); using local file.` };
    }
  }

  get config() {
    return this.cache;
  }

  persistFile() {
    try {
      writeJson(CONFIG_FILE, this.cache);
    } catch (err) {
      console.error('[store] failed to write config:', err.message);
    }
  }

  async save() {
    // Merge into the existing object so references captured earlier stay valid.
    assignInPlace(this.cache, mergeDeep(defaultConfig(), this.cache));
    this.persistFile();
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO panel_state (key, value, updated_at) VALUES ('config', $1::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(this.cache)],
      );
    } catch (err) {
      console.error('[store] postgres write failed:', err.message);
    }
  }

  /** Persist an arbitrary document (history, wallet, ...) next to the config. */
  writeDoc(name, value) {
    writeJson(path.join(DATA_DIR, `${name}.json`), value);
  }

  readDoc(name, fallback = null) {
    return readJson(path.join(DATA_DIR, `${name}.json`), fallback);
  }

  async close() {
    if (this.pool) await this.pool.end().catch(() => {});
  }
}

module.exports = { Store, defaultConfig, mergeDeep, assignInPlace, CONFIG_FILE, DATA_DIR };
