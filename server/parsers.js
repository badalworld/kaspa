'use strict';
/**
 * Log parsers for kaspanet/cpuminer (kaspa-miner), rusty-kaspa (kaspad) and
 * generic stratum miners running in "custom command" mode.
 *
 * cpuminer output lines we care about (from src/miner.rs):
 *   Launching: 4 cpu miners
 *   Current hashrate is: 4.21 Mhash/s
 *   Found a block: 1a2b3c...
 *   Kaspad is not synced, skipping current template
 *   Kaspad is still not synced
 *   Disconnected from kaspad, retrying
 */

const HASHRATE_UNITS = {
  'hash/s': 1,
  'khash/s': 1e3,
  'mhash/s': 1e6,
  'ghash/s': 1e9,
  'thash/s': 1e12,
  'phash/s': 1e15,
};

function parseHashrate(text) {
  const match = text.match(/hashrate[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*([kmgtp]?hash\/s)/i);
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const mult = HASHRATE_UNITS[unit] ?? 1;
  const value = Number(match[1]) * mult;
  return Number.isFinite(value) ? value : null;
}

/** Extract a log level from lines like `[2024-01-01T.. INFO kaspa_miner::miner] msg`. */
function parseLevel(line) {
  const bracket = line.match(/\[(?:[^\]]*?)\b(TRACE|DEBUG|INFO|WARN|ERROR)\b/);
  if (bracket) return bracket[1].toLowerCase();
  if (/\b(ERROR|FATAL|panic)\b/i.test(line)) return 'error';
  if (/\bWARN\b/i.test(line)) return 'warn';
  if (/\bDEBUG\b/i.test(line)) return 'debug';
  return 'info';
}

const SHARE_PATTERNS = [
  { kind: 'accepted', re: /(share|accepted|solution)[^.\n]*\baccepted\b/i },
  { kind: 'accepted', re: /\baccepted\s*\(/i },
  { kind: 'rejected', re: /\breject(ed|ing)?\b/i },
  { kind: 'stale', re: /\bstale\b/i },
];

/**
 * Feed one miner log line into the runtime state.
 * Returns a list of events to apply.
 */
function inspectMinerLine(line, state) {
  const events = [];
  const hashrate = parseHashrate(line);
  if (hashrate !== null) events.push({ type: 'hashrate', value: hashrate });

  const launched = line.match(/launching:\s*(\d+)\s+cpu miners/i);
  if (launched) events.push({ type: 'threads', value: Number(launched[1]) });

  if (/not synced/i.test(line) || /still not synced/i.test(line)) {
    events.push({ type: 'node-unsynced' });
  }
  if (/disconnected from kaspad/i.test(line)) events.push({ type: 'node-disconnected' });
  if (/connected to kaspad|connected to node/i.test(line)) events.push({ type: 'node-connected' });

  const block = line.match(/found a block[:\s]+([0-9a-f]{16,64})/i);
  if (block) events.push({ type: 'block', hash: block[1] });

  if (!state?.mode || state.mode !== 'solo') {
    for (const { kind, re } of SHARE_PATTERNS) {
      if (re.test(line)) {
        events.push({ type: 'share', kind });
        break;
      }
    }
  }
  return events;
}

/** Extract a few useful facts from kaspad output (best effort). */
function inspectNodeLine(line) {
  const events = [];
  const ia = line.match(/initial\s+block\s+download[^0-9]{0,20}([0-9.]+)\s*%/i) || line.match(/\bIBD\b[^0-9]{0,20}([0-9.]+)\s*%/i);
  if (ia) events.push({ type: 'sync-progress', value: Number(ia[1]) });
  const daa = line.match(/daa\s*score[:\s=]+(\d+)/i);
  if (daa) events.push({ type: 'daa-score', value: Number(daa[1]) });
  const peers = line.match(/(\d+)\s+(?:connected\s+)?peers/i);
  if (peers) events.push({ type: 'peers', value: Number(peers[1]) });
  const height = line.match(/(?:block\s+count|height)[:\s=]+(\d+)/i);
  if (height) events.push({ type: 'height', value: Number(height[1]) });
  if (/\b(synced|fully synced|is synced)\b/i.test(line)) events.push({ type: 'synced', value: true });
  if (/\b(IBD|sync(ing|hronizing))\b/i.test(line) && !/synced/i.test(line)) events.push({ type: 'syncing' });
  return events;
}

module.exports = { parseHashrate, parseLevel, inspectMinerLine, inspectNodeLine, HASHRATE_UNITS };
