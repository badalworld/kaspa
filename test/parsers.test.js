'use strict';
/**
 * Unit tests: miner/node log parsers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseHashrate, inspectMinerLine, inspectNodeLine } = require('../server/parsers');

test('parses every hashrate unit printed by kaspa-miner', () => {
  const cases = [
    ['Current hashrate is: 4.21 Mhash/s', 4.21e6],
    ['Current hashrate is: 980.55 Khash/s', 980.55e3],
    ['Current hashrate is: 12.00 hash/s', 12],
    ['Current hashrate is: 1.50 Ghash/s', 1.5e9],
    ['unrelated line', null],
  ];
  for (const [line, expected] of cases) {
    const value = parseHashrate(line);
    if (expected === null) assert.equal(value, null);
    else assert.ok(Math.abs(value - expected) < 1e-6, `${line} -> ${value}`);
  }
});

test('detects a found block and thread count', () => {
  const block = inspectMinerLine('Found a block: 1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890', { mode: 'solo' });
  assert.equal(block[0].type, 'block');
  assert.equal(block[0].hash.length, 64);

  const threads = inspectMinerLine('Launching: 3 cpu miners', { mode: 'solo' });
  assert.deepEqual(threads[0], { type: 'threads', value: 3 });
});

test('tracks node sync state transitions', () => {
  assert.equal(inspectMinerLine('Kaspad is not synced, skipping current template', {}).at(0).type, 'node-unsynced');
  assert.equal(inspectMinerLine('Kaspad is still not synced', {}).at(0).type, 'node-unsynced');
  assert.equal(inspectMinerLine('Disconnected from kaspad, retrying', {}).at(0).type, 'node-disconnected');
});

test('counts shares only when not mining solo', () => {
  assert.equal(inspectMinerLine('share accepted (12)', { mode: 'solo' }).length, 0);
  const pool = inspectMinerLine('share accepted (12)', { mode: 'custom' });
  assert.deepEqual(pool.find((e) => e.type === 'share'), { type: 'share', kind: 'accepted' });
  const rejected = inspectMinerLine('Share rejected: low difficulty', { mode: 'remote' });
  assert.deepEqual(rejected.find((e) => e.type === 'share'), { type: 'share', kind: 'rejected' });
});

test('extracts node facts from kaspad output', () => {
  assert.equal(inspectNodeLine('Initial block download 42.5%').at(0).value, 42.5);
  assert.equal(inspectNodeLine('virtual selected parent blue score 128400000').length, 0);
  assert.equal(inspectNodeLine('daa score: 128400000').at(0).value, 128400000);
  assert.equal(inspectNodeLine('Connected to 8 peers').at(0).value, 8);
  assert.ok(inspectNodeLine('Node is synced').some((e) => e.type === 'synced'));
});
