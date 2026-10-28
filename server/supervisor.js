'use strict';
/**
 * Process supervisor.
 *
 * Owns the lifecycle of kaspad and kaspa-miner (or a custom miner command),
 * captures their output, parses it into live state and restarts crashed
 * processes. A simulator is included so the panel can be explored (and this
 * project demonstrated) without downloading any binaries; simulated processes
 * are always flagged in the UI.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { RingLog, isExecutable, KASPAD_DIR, LOG_DIR, BIN_DIR, writeJson, readJson } = require('./util');
const { inspectMinerLine, inspectNodeLine } = require('./parsers');

const MAX_LOG_FILE = 8 * 1024 * 1024;
const MAX_RESTARTS = 15;
const RESTART_WINDOW_MS = 30 * 60 * 1000;

class LineSplitter {
  constructor(onLine) {
    this.buffer = '';
    this.onLine = onLine;
  }

  push(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length) this.onLine(line);
    }
    if (this.buffer.length > 64 * 1024) {
      this.onLine(this.buffer.slice(0, 64 * 1024));
      this.buffer = this.buffer.slice(64 * 1024);
    }
  }
}

class LogFile {
  constructor(file) {
    this.file = file;
    this.stream = null;
    this.size = 0;
    this.open();
  }

  open() {
    try {
      this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    } catch {
      this.stream = null;
    }
  }

  write(line) {
    if (!this.stream) return;
    const payload = `${new Date().toISOString()} ${line}\n`;
    try {
      this.stream.write(payload);
      this.size += payload.length;
      if (this.size > MAX_LOG_FILE) this.rotate();
    } catch {
      /* ignore disk errors */
    }
  }

  rotate() {
    try {
      this.stream?.end();
      const old = `${this.file}.1`;
      if (fs.existsSync(old)) fs.unlinkSync(old);
      fs.renameSync(this.file, old);
    } catch {
      /* ignore */
    }
    this.open();
  }
}

function portOpen(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

class Supervisor {
  constructor({ store, emit }) {
    this.store = store;
    this.emit = emit || (() => {});
    this.nodeProc = null;
    this.minerProc = null;
    this.stopRequested = false;
    this.waitingTimer = null;
    this.demoTimers = [];
    this.restartTimes = { node: [], miner: [] };
    this.logs = { node: new RingLog(2500), miner: new RingLog(2500) };
    this.logFiles = {
      node: new LogFile(path.join(LOG_DIR, 'node.log')),
      miner: new LogFile(path.join(LOG_DIR, 'miner.log')),
    };
    this.state = {
      node: {
        status: 'stopped',
        simulated: false,
        pid: null,
        startedAt: null,
        synced: null,
        syncProgress: null,
        peers: null,
        daaScore: null,
        height: null,
        listening: false,
        restarts: 0,
        lastLineAt: null,
      },
      miner: {
        status: 'stopped',
        simulated: false,
        pid: null,
        startedAt: null,
        stoppedAt: null,
        threads: null,
        hashrate: 0,
        hashrateAt: null,
        shares: { accepted: 0, rejected: 0, stale: 0 },
        blocks: [],
        restarts: 0,
        lastLineAt: null,
        lastError: null,
      },
    };
  }

  get config() {
    return this.store.config;
  }

  /* ----------------------------- binaries ----------------------------- */

  nodeBinary() {
    const configured = this.config.node?.path;
    if (isExecutable(configured)) return configured;
    for (const candidate of [path.join(BIN_DIR, 'kaspad'), '/usr/local/bin/kaspad', '/usr/bin/kaspad']) {
      if (isExecutable(candidate)) return candidate;
    }
    return null;
  }

  minerBinary() {
    const configured = this.config.mining?.minerPath;
    if (isExecutable(configured)) return configured;
    for (const candidate of [path.join(BIN_DIR, 'kaspa-miner'), '/usr/local/bin/kaspa-miner']) {
      if (isExecutable(candidate)) return candidate;
    }
    return null;
  }

  binaries() {
    return {
      node: this.nodeBinary(),
      miner: this.minerBinary(),
      ready: Boolean(this.minerBinary()) && (this.config.mining.mode !== 'solo' || Boolean(this.nodeBinary())),
    };
  }

  nodeDataDir() {
    return this.config.node?.dataDir || KASPAD_DIR;
  }

  rpcPort() {
    return this.config.mining.network === 'testnet' ? 16210 : 16110;
  }

  /* ------------------------------ args -------------------------------- */

  nodeArgs() {
    const node = this.config.node || {};
    const args = ['-b', this.nodeDataDir(), '--yes', '--nologfiles'];
    args.push(`--rpclisten=${node.exposeRpc ? '0.0.0.0' : '127.0.0.1'}:${this.rpcPort()}`);
    const p2pPort = this.config.mining.network === 'testnet' ? 16211 : 16111;
    args.push(node.exposeP2P === false ? `--listen=127.0.0.1:${p2pPort}` : `--listen=0.0.0.0:${p2pPort}`);
    if (node.disableUpnp !== false) args.push('--disable-upnp');
    if (node.utxoIndex) args.push('--utxoindex');
    if (node.archival) args.push('--archival');
    const retention = Number(node.retentionDays) || 0;
    if (!node.archival && retention > 0) args.push(`--retention-period-days=${retention}`);
    const ramScale = Number(node.ramScale);
    if (Number.isFinite(ramScale) && ramScale > 0 && Math.abs(ramScale - 1) > 0.001) args.push(`--ram-scale=${ramScale}`);
    if (this.config.mining.network === 'testnet') args.push('--testnet');
    if (node.extraArgs) args.push(...String(node.extraArgs).split(/\s+/).filter(Boolean));
    return args;
  }

  minerArgs() {
    const mining = this.config.mining || {};
    const args = ['-a', mining.address];
    if (mining.mode === 'solo') {
      args.push('-s', '127.0.0.1', '-p', String(this.rpcPort()));
    } else {
      args.push('-s', mining.remoteHost || '127.0.0.1', '-p', String(mining.remotePort || this.rpcPort()));
    }
    const threads = Number(mining.threads) || 0;
    if (threads > 0) args.push('-t', String(threads));
    if (mining.network === 'testnet') args.push('--testnet');
    if (mining.minerExtraArgs) args.push(...String(mining.minerExtraArgs).split(/\s+/).filter(Boolean));
    return args;
  }

  customCommand() {
    const mining = this.config.mining || {};
    const replacements = {
      '{{address}}': mining.address || '',
      '{{worker}}': mining.workerName || os.hostname(),
      '{{threads}}': String(Number(mining.threads) || os.cpus().length),
      '{{network}}': mining.network || 'mainnet',
      '{{pool}}': mining.poolUrl || '',
      '{{port}}': String(this.rpcPort()),
    };
    let command = mining.customCommand || '';
    for (const [token, value] of Object.entries(replacements)) {
      command = command.split(token).join(value);
    }
    return command;
  }

  /* ----------------------------- lifecycle ---------------------------- */

  async start({ demo = false } = {}) {
    this.stopRequested = false;
    if (demo) {
      this.startDemo();
      return { ok: true, demo: true };
    }
    this.stopDemo();
    const config = this.config;
    const mode = config.mining.mode;

    if (!config.mining.address) return { ok: false, error: 'Set a mining address before starting.' };
    if (mode === 'custom') {
      if (!config.mining.customCommand) return { ok: false, error: 'No custom miner command configured.' };
      return this.startMiner();
    }
    const binaries = this.binaries();
    if (mode === 'solo' && !binaries.node) {
      return {
        ok: false,
        code: 'NODE_BINARY_MISSING',
        error: 'kaspad binary not found. Install it from the Setup page or set a custom path.',
      };
    }
    if (!binaries.miner) {
      return {
        ok: false,
        code: 'MINER_BINARY_MISSING',
        error: 'kaspa-miner binary not found. Install it from the Setup page or set a custom path.',
      };
    }
    if (mode === 'solo' && config.node.enabled !== false) {
      await this.startNode();
      return this.startMinerWhenReady();
    }
    return this.startMinerWhenReady();
  }

  async startNode() {
    if (this.nodeProc) return { ok: true, already: true };
    const binary = this.nodeBinary();
    if (!binary) return { ok: false, error: 'kaspad binary not found' };
    const dataDir = this.nodeDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const args = this.nodeArgs();
    this.setState('node', { status: 'starting', startedAt: Date.now(), pid: null, simulated: false, lastError: null });
    this.pushLog('node', `$ ${binary} ${args.join(' ')}`);
    let proc;
    try {
      proc = spawn(binary, args, { cwd: dataDir, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      this.setState('node', { status: 'error', lastError: err.message });
      return { ok: false, error: err.message };
    }
    this.nodeProc = proc;
    this.setState('node', { status: 'running', pid: proc.pid });
    this.attachLogs('node', proc, (line) => this.handleNodeLine(line));
    proc.on('exit', (code, signal) => this.handleNodeExit(code, signal));
    proc.on('error', (err) => {
      this.pushLog('node', `spawn error: ${err.message}`);
      this.setState('node', { status: 'error', lastError: err.message });
    });
    return { ok: true, pid: proc.pid, args };
  }

  attachLogs(kind, proc, handler) {
    const out = new LineSplitter(handler);
    const err = new LineSplitter(handler);
    proc.stdout?.on('data', (chunk) => out.push(chunk.toString()));
    proc.stderr?.on('data', (chunk) => err.push(chunk.toString()));
  }

  async startMinerWhenReady() {
    const mode = this.config.mining.mode;
    const host = mode === 'solo' ? '127.0.0.1' : this.config.mining.remoteHost || '127.0.0.1';
    const port = mode === 'solo' ? this.rpcPort() : Number(this.config.mining.remotePort) || this.rpcPort();
    this.setState('miner', { status: 'waiting-node', simulated: false, lastError: null });
    this.pushLog('miner', `Waiting for the node gRPC endpoint on ${host}:${port} ...`);

    const attempt = async () => {
      if (this.stopRequested) return;
      const open = await portOpen(host, port);
      if (this.stopRequested) return;
      if (open) {
        this.waitingTimer = null;
        await this.startMiner();
      } else {
        this.waitingTimer = setTimeout(attempt, 5000);
      }
    };
    await attempt();
    return { ok: true, waiting: true };
  }

  async startMiner() {
    if (this.minerProc) return { ok: true, already: true };
    const mode = this.config.mining.mode;
    let command;
    let args;
    let cwd = process.cwd();
    if (mode === 'custom') {
      const raw = this.customCommand();
      if (!raw.trim()) return { ok: false, error: 'custom command is empty' };
      command = '/bin/sh';
      args = ['-c', raw];
      if (this.config.mining.customWorkDir) cwd = this.config.mining.customWorkDir;
    } else {
      command = this.minerBinary();
      if (!command) return { ok: false, error: 'kaspa-miner binary not found' };
      args = this.minerArgs();
    }
    this.setState('miner', { status: 'starting', startedAt: Date.now(), simulated: false, lastError: null });
    this.pushLog('miner', `$ ${command} ${(args || []).join(' ')}`);
    let proc;
    try {
      proc = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      this.setState('miner', { status: 'error', lastError: err.message });
      return { ok: false, error: err.message };
    }
    this.minerProc = proc;
    this.setState('miner', { status: 'running', pid: proc.pid, hashrate: 0, lastError: null });
    this.attachLogs('miner', proc, (line) => this.handleMinerLine(line));
    proc.on('exit', (code, signal) => this.handleMinerExit(code, signal));
    proc.on('error', (err) => {
      this.pushLog('miner', `spawn error: ${err.message}`);
      this.setState('miner', { status: 'error', lastError: err.message });
    });
    return { ok: true, pid: proc.pid };
  }

  handleNodeLine(line) {
    this.pushLog('node', line);
    this.state.node.lastLineAt = Date.now();
    for (const event of inspectNodeLine(line)) {
      if (event.type === 'sync-progress') this.state.node.syncProgress = event.value;
      if (event.type === 'daa-score') this.state.node.daaScore = event.value;
      if (event.type === 'peers') this.state.node.peers = event.value;
      if (event.type === 'height') this.state.node.height = event.value;
      if (event.type === 'synced') this.state.node.synced = true;
      if (event.type === 'syncing') this.state.node.synced = false;
    }
    if (/listening|rpc.*started|grpc server/i.test(line)) this.state.node.listening = true;
    if (this.state.node.status !== 'running') this.state.node.status = 'running';
  }

  handleMinerLine(line) {
    this.pushLog('miner', line);
    const miner = this.state.miner;
    miner.lastLineAt = Date.now();
    if (miner.status === 'waiting-node' || miner.status === 'starting') miner.status = 'running';
    for (const event of inspectMinerLine(line, { mode: this.config.mining.mode })) {
      switch (event.type) {
        case 'hashrate':
          miner.hashrate = event.value;
          miner.hashrateAt = Date.now();
          this.emit('hashrate', { value: event.value, at: miner.hashrateAt });
          break;
        case 'threads':
          miner.threads = event.value;
          break;
        case 'node-unsynced':
          this.state.node.synced = false;
          break;
        case 'node-disconnected':
          this.state.node.synced = null;
          break;
        case 'node-connected':
          this.state.node.synced = true;
          break;
        case 'block': {
          const block = { hash: event.hash, at: Date.now() };
          miner.blocks.unshift(block);
          miner.blocks = miner.blocks.slice(0, 50);
          this.emit('block', block);
          break;
        }
        case 'share':
          if (event.kind in miner.shares) miner.shares[event.kind] += 1;
          this.emit('share', event.kind);
          break;
        default:
          break;
      }
    }
  }

  handleNodeExit(code, signal) {
    this.nodeProc = null;
    const crashed = !this.stopRequested;
    this.setState('node', { status: crashed ? 'error' : 'stopped', pid: null });
    this.pushLog('node', `process exited (code=${code ?? '-'} signal=${signal ?? '-'})`);
    if (crashed && this.config.mining.restartOnCrash && this.maybeRestart('node')) {
      setTimeout(() => this.startNode(), 5000);
    }
  }

  handleMinerExit(code, signal) {
    this.minerProc = null;
    const crashed = !this.stopRequested;
    this.setState('miner', {
      status: crashed ? 'error' : 'stopped',
      pid: null,
      hashrate: 0,
      stoppedAt: crashed ? null : Date.now(),
    });
    this.pushLog('miner', `process exited (code=${code ?? '-'} signal=${signal ?? '-'})`);
    if (crashed && this.config.mining.restartOnCrash && this.maybeRestart('miner')) {
      setTimeout(() => {
        if (this.config.mining.mode === 'solo') this.startMinerWhenReady();
        else this.startMiner();
      }, 5000);
    }
  }

  maybeRestart(kind) {
    const now = Date.now();
    const list = (this.restartTimes[kind] || []).filter((t) => now - t < RESTART_WINDOW_MS);
    if (list.length >= MAX_RESTARTS) {
      this.pushLog(kind, `too many crashes (${list.length} in 30 min) — auto-restart disabled`);
      this.setState(kind, { status: 'error', lastError: 'Crash loop detected, auto-restart stopped.' });
      return false;
    }
    list.push(now);
    this.restartTimes[kind] = list;
    this.state[kind].restarts = (this.state[kind].restarts || 0) + 1;
    return true;
  }

  async stop({ keepNode = false } = {}) {
    this.stopRequested = true;
    this.stopDemo();
    if (this.waitingTimer) {
      clearTimeout(this.waitingTimer);
      this.waitingTimer = null;
    }
    const kill = (proc, label) =>
      new Promise((resolve) => {
        if (!proc) return resolve();
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        proc.once('exit', finish);
        try {
          proc.kill('SIGINT'); // kaspad/cpuminer shut down gracefully on ctrl-c
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          finish();
        }, 12000);
        this.pushLog(label, 'stop requested');
      });

    await kill(this.minerProc, 'miner');
    this.minerProc = null;
    this.setState('miner', { status: 'stopped', pid: null, hashrate: 0, stoppedAt: Date.now() });
    if (!keepNode) {
      await kill(this.nodeProc, 'node');
      this.nodeProc = null;
      this.setState('node', { status: 'stopped', pid: null, synced: null });
    }
    return { ok: true };
  }

  async restart() {
    const wasDemo = this.state.miner.simulated;
    const demo = wasDemo;
    await this.stop();
    await new Promise((r) => setTimeout(r, 800));
    return this.start({ demo });
  }

  /* ------------------------------- logs ------------------------------- */

  pushLog(kind, line) {
    if (!line) return;
    const entry = this.logs[kind].push(line, 'out');
    this.logFiles[kind].write(line);
    this.emit('log', { kind, entry });
  }

  setState(kind, patch) {
    Object.assign(this.state[kind], patch);
    this.state[kind].updatedAt = Date.now();
    this.emit('state', this.state);
  }

  /* ------------------------------ simulator ---------------------------- */

  startDemo() {
    this.stopDemo();
    const address = this.config.mining.address || 'kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e';
    const threads = Number(this.config.mining.threads) || Math.max(1, os.cpus().length);
    const perThread = 1.15e6;
    this.setState('node', {
      status: 'running',
      simulated: true,
      pid: 0,
      startedAt: Date.now(),
      synced: true,
      syncProgress: 100,
      peers: 8 + Math.floor(Math.random() * 6),
      daaScore: 128_400_000 + Math.floor(Math.random() * 5000),
      height: 118_500_000,
      listening: true,
      lastError: null,
    });
    this.setState('miner', {
      status: 'running',
      simulated: true,
      pid: 0,
      startedAt: Date.now(),
      stoppedAt: null,
      threads,
      hashrate: threads * perThread,
      hashrateAt: Date.now(),
      lastError: null,
    });
    this.pushLog('node', `[demo] kaspad v2.1.0 (simulated) starting with address ${address.slice(0, 14)}...`);
    this.pushLog('miner', `[demo] kaspa-miner v0.2.7 (simulated) Launching: ${threads} cpu miners`);

    const nodeTimer = setInterval(() => {
      const n = this.state.node;
      n.daaScore += Math.floor(50 + Math.random() * 40);
      n.height += Math.floor(5 + Math.random() * 10);
      if (Math.random() < 0.05) n.peers = 8 + Math.floor(Math.random() * 8);
      n.demoTicks = (n.demoTicks || 0) + 1;
      // Keep the demo log readable: one summary line per minute.
      if (n.demoTicks % 8 === 0) {
        this.pushLog('node', `[demo] virtual DAA score: ${n.daaScore} peers: ${n.peers} (simulated)`);
      }
    }, 7000);

    const minerTimer = setInterval(() => {
      const m = this.state.miner;
      const jitter = 0.85 + Math.random() * 0.3;
      const rate = threads * perThread * jitter;
      m.hashrate = rate;
      m.hashrateAt = Date.now();
      this.emit('hashrate', { value: rate, at: m.hashrateAt });
      const unit = rate >= 1e6 ? `${(rate / 1e6).toFixed(2)} Mhash/s` : `${(rate / 1e3).toFixed(2)} Khash/s`;
      this.pushLog('miner', `[demo] Current hashrate is: ${unit}`);

      if (this.config.mining.mode !== 'solo' && Math.random() < 0.18) {
        const accepted = Math.random() < 0.94;
        m.shares[accepted ? 'accepted' : 'rejected'] += 1;
        this.pushLog('miner', accepted ? `[demo] share accepted (${m.shares.accepted})` : '[demo] share rejected: low difficulty');
        this.emit('share', accepted ? 'accepted' : 'rejected');
      }
      if (Math.random() < 0.004) {
        const hash = require('node:crypto').randomBytes(32).toString('hex');
        m.blocks.unshift({ hash, at: Date.now() });
        m.blocks = m.blocks.slice(0, 50);
        this.pushLog('miner', `[demo] Found a block: ${hash}`);
        this.emit('block', { hash, at: Date.now() });
      }
    }, 5000);

    this.demoTimers = [nodeTimer, minerTimer];
  }

  stopDemo() {
    for (const timer of this.demoTimers) clearInterval(timer);
    this.demoTimers = [];
    if (this.state.miner.simulated) {
      this.setState('miner', { status: 'stopped', simulated: false, pid: null, hashrate: 0, stoppedAt: Date.now() });
    }
    if (this.state.node.simulated) {
      this.setState('node', { status: 'stopped', simulated: false, pid: null, synced: null });
    }
  }

  isDemoRunning() {
    return this.state.miner.simulated && this.state.miner.status === 'running';
  }

  /** Restore persisted sample history so charts are not empty after a restart. */
  snapshot() {
    return {
      node: { ...this.state.node },
      miner: { ...this.state.miner },
      demo: this.isDemoRunning(),
    };
  }

  async shutdown() {
    await this.stop();
    writeJson(path.join(LOG_DIR, '..', 'last-shutdown.json'), { at: Date.now() });
  }
}

module.exports = { Supervisor, portOpen, LineSplitter };
