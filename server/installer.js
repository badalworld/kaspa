'use strict';
/**
 * Downloads the official Kaspa binaries from GitHub releases:
 *   kaspad      -> https://github.com/kaspanet/rusty-kaspa/releases
 *   kaspa-miner -> https://github.com/kaspanet/cpuminer/releases
 *
 * Nothing is bundled in this repository; the panel fetches the binaries at
 * runtime (or you point it at binaries you installed yourself).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { BIN_DIR } = require('./util');

const execFileAsync = promisify(execFile);
const UA = { 'user-agent': 'kaspa-mining-console/1.0', accept: 'application/vnd.github+json' };

const REPOS = {
  miner: 'kaspanet/cpuminer',
  node: 'kaspanet/rusty-kaspa',
};

class Installer {
  constructor({ onUpdate } = {}) {
    this.onUpdate = onUpdate || (() => {});
    this.state = { running: false, target: null, step: '', percent: 0, message: '', error: null, done: false, sha256: null };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onUpdate(this.state);
  }

  arch() {
    return process.arch === 'arm64' ? 'aarch64' : 'amd64';
  }

  async githubJson(url) {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
    return res.json();
  }

  async latestRelease(repo) {
    try {
      return await this.githubJson(`https://api.github.com/repos/${repo}/releases/latest`);
    } catch (err) {
      // Fall back to the plain redirect endpoint which does not need the API.
      return { tag_name: 'latest', assets: [], fallback: err.message };
    }
  }

  pickAsset(assets, patterns) {
    for (const pattern of patterns) {
      const found = assets.find((a) => pattern.test(a.name));
      if (found) return found;
    }
    return null;
  }

  async download(url, destination, { expectMinBytes = 500_000 } = {}) {
    this.set({ step: 'download', message: `Downloading ${url.split('/').pop()}`, percent: 5 });
    const res = await fetch(url, { headers: { 'user-agent': UA['user-agent'] }, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') || 0);
    const hash = crypto.createHash('sha256');
    const tmp = `${destination}.part`;
    const out = fs.createWriteStream(tmp);
    let received = 0;
    await new Promise((resolve, reject) => {
      res.body.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        if (total) {
          const pct = 10 + Math.round((received / total) * 80);
          if (pct !== this.state.percent) this.set({ percent: Math.min(92, pct) });
        }
      });
      res.body.on('error', reject);
      res.body.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    });
    if (received < expectMinBytes) throw new Error(`Downloaded file is suspiciously small (${received} bytes)`);
    fs.renameSync(tmp, destination);
    fs.chmodSync(destination, 0o755);
    const sha256 = hash.digest('hex');
    this.set({ sha256, percent: 95 });
    return { size: received, sha256 };
  }

  async extractZip(zipFile, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    const attempts = [
      ['unzip', ['-o', '-q', zipFile, '-d', destDir]],
      ['python3', ['-m', 'zipfile', '-e', zipFile, destDir]],
      ['busybox', ['unzip', '-o', zipFile, '-d', destDir]],
    ];
    let lastError = null;
    for (const [bin, args] of attempts) {
      try {
        await execFileAsync(bin, args, { timeout: 180000 });
        return true;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `Could not extract the archive (install "unzip" or python3). ${lastError ? lastError.message : ''}`.trim(),
    );
  }

  findFile(dir, name) {
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
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name === name) return full;
      }
    }
    return null;
  }

  async verifyBinary(binary, versionFlag = '--version') {
    try {
      const { stdout, stderr } = await execFileAsync(binary, [versionFlag], { timeout: 20000 });
      return `${stdout || stderr}`.trim().split('\n')[0].slice(0, 120);
    } catch (err) {
      // Some builds print help/version to stderr and exit non-zero.
      const text = `${err.stdout || ''}${err.stderr || ''}`.trim();
      return text ? text.split('\n')[0].slice(0, 120) : null;
    }
  }

  async installMiner() {
    if (this.state.running) return this.state;
    this.set({ running: true, target: 'miner', error: null, done: false, percent: 2, step: 'release', message: 'Looking up latest kaspa-miner release' });
    try {
      const release = await this.latestRelease(REPOS.miner);
      const asset = this.pickAsset(release.assets || [], [
        new RegExp(`linux-(gnu|musl)-${this.arch()}$`),
        /linux-gnu-amd64$/,
      ]);
      const version = release.tag_name && release.tag_name !== 'latest' ? release.tag_name : 'v0.2.7';
      let url = asset?.url || asset?.browser_download_url;
      if (!url) {
        url = `https://github.com/${REPOS.miner}/releases/download/${version}/kaspa-miner-${version}-linux-gnu-amd64`;
      }
      const destination = path.join(BIN_DIR, 'kaspa-miner');
      const { size, sha256 } = await this.download(url, destination);
      const info = await this.verifyBinary(destination);
      this.set({
        running: false,
        done: true,
        percent: 100,
        step: 'done',
        message: `kaspa-miner ${version} installed (${(size / 1e6).toFixed(1)} MB)`,
        version: info,
        sha256,
        path: destination,
      });
      return this.state;
    } catch (err) {
      this.set({ running: false, done: false, error: err.message, step: 'error', message: err.message, percent: 0 });
      return this.state;
    }
  }

  async installNode() {
    if (this.state.running) return this.state;
    this.set({ running: true, target: 'node', error: null, done: false, percent: 2, step: 'release', message: 'Looking up latest kaspad release' });
    const tmpZip = path.join(BIN_DIR, 'rusty-kaspa.zip');
    const tmpDir = path.join(BIN_DIR, 'rusty-kaspa-extract');
    try {
      const release = await this.latestRelease(REPOS.node);
      const asset = this.pickAsset(release.assets || [], [new RegExp(`linux-${this.arch()}\\.zip$`), /linux-amd64\.zip$/]);
      const version = release.tag_name && release.tag_name !== 'latest' ? release.tag_name : 'v2.1.0';
      const url =
        asset?.url || asset?.browser_download_url || `https://github.com/${REPOS.node}/releases/download/${version}/rusty-kaspa-${version}-linux-amd64.zip`;
      await this.download(url, tmpZip, { expectMinBytes: 5_000_000 });
      this.set({ step: 'extract', percent: 94, message: 'Extracting kaspad' });
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await this.extractZip(tmpZip, tmpDir);
      const found = this.findFile(tmpDir, 'kaspad');
      if (!found) throw new Error('kaspad binary not found inside the release archive');
      const destination = path.join(BIN_DIR, 'kaspad');
      fs.copyFileSync(found, destination);
      fs.chmodSync(destination, 0o755);
      const info = await this.verifyBinary(destination);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(tmpZip, { force: true });
      this.set({
        running: false,
        done: true,
        percent: 100,
        step: 'done',
        message: `kaspad ${version} installed`,
        version: info,
        path: destination,
      });
      return this.state;
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(tmpZip, { force: true });
      this.set({ running: false, done: false, error: err.message, step: 'error', message: err.message, percent: 0 });
      return this.state;
    }
  }
}

module.exports = { Installer, REPOS };
