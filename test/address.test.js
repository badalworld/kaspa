'use strict';
/**
 * Unit tests: Kaspa address codec (checked against the reference vectors from
 * rusty-kaspa/crypto/addresses/src/lib.rs) and secp256k1 key handling.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  encodeAddress,
  decodeAddress,
  validateAddress,
  publicKeyFromPrivate,
  addressFromPrivateKey,
  generateWallet,
} = require('../server/address');

const REFERENCE_VECTORS = [
  ['kaspa', 0, Buffer.alloc(32), 'kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e'],
  ['kaspatest', 0, Buffer.alloc(32), 'kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya'],
  ['kaspatest', 1, Buffer.alloc(33), 'kaspatest:qyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhe837j2d'],
  [
    'kaspa',
    0,
    Buffer.from('5fff3c4da18f45adcdd499e44611e9fff148ba69db3c4ea2ddd955fc46a59522', 'hex'),
    'kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfj',
  ],
  [
    'kaspatest',
    1,
    Buffer.from('ba01fc5f4e9d9879599c69a3dafdb835a7255e5f2e934e9322ecd3af190ab0f60e', 'hex'),
    'kaspatest:qxaqrlzlf6wes72en3568khahq66wf27tuhfxn5nytkd8tcep2c0vrse6gdmpks',
  ],
];

test('encodes the reference vectors byte for byte', () => {
  for (const [prefix, version, payload, expected] of REFERENCE_VECTORS) {
    assert.equal(encodeAddress(prefix, version, payload), expected);
  }
});

test('decodes the reference vectors', () => {
  for (const [prefix, version, payload, encoded] of REFERENCE_VECTORS) {
    const decoded = decodeAddress(encoded);
    assert.equal(decoded.ok, true, `${encoded}: ${decoded.error}`);
    assert.equal(decoded.prefix, prefix);
    assert.equal(decoded.version, version);
    assert.equal(decoded.payloadHex, payload.toString('hex'));
  }
});

test('rejects corrupted, mistyped and malformed addresses', () => {
  const cases = [
    ['kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4l', 'checksum'],
    ['kaspa:qqqqqqqqqqqqq1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e', 'character'],
    ['notkaspa:qqeq69uvrh', 'prefix'],
    ['', 'empty'],
    ['kaspa', 'prefix'],
    ['kaspa:qqqq', 'short'],
  ];
  for (const [address, expected] of cases) {
    const check = validateAddress(address);
    assert.equal(check.valid, false, `${address} should be invalid`);
    assert.match(check.error.toLowerCase(), new RegExp(expected === 'checksum' ? 'checksum' : expected));
  }
});

test('testnet and mainnet addresses are distinguished', () => {
  assert.equal(validateAddress('kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya').network, 'testnet');
  assert.equal(validateAddress('kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e').network, 'mainnet');
});

test('derives the secp256k1 generator point from private key 1', () => {
  const one = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex');
  assert.equal(
    publicKeyFromPrivate(one).toString('hex'),
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  );
});

test('generated wallets round-trip through the codec', () => {
  for (const network of ['mainnet', 'testnet']) {
    const wallet = generateWallet(network);
    const check = validateAddress(wallet.address);
    assert.equal(check.valid, true);
    assert.equal(check.network, network);
    const restored = addressFromPrivateKey(wallet.privateKeyHex, network);
    assert.equal(restored.address, wallet.address);
  }
});

test('rejects invalid private keys', () => {
  assert.throws(() => addressFromPrivateKey('abcd'));
  assert.throws(() => addressFromPrivateKey('00'.repeat(32)), /out of range/);
});
