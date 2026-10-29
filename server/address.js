'use strict';
/**
 * Kaspa address codec + secp256k1 key handling.
 *
 * The address format is a bech32-style encoding with a 40-bit BCH checksum,
 * exactly like the reference implementation in
 * https://github.com/kaspanet/rusty-kaspa/blob/master/crypto/addresses/src/bech32.rs
 *
 * Payload = [version byte][public key / script hash]
 *   version 0 -> Schnorr x-only public key (32 bytes)
 *   version 1 -> ECDSA public key (33 bytes)
 *   version 8 -> script hash (32 bytes)
 *
 * Zero dependencies: everything below is plain BigInt / Buffer math.
 */

const crypto = require('node:crypto');

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const REV = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < CHARSET.length; i++) t[CHARSET.charCodeAt(i)] = i;
  return t;
})();

const PREFIXES = {
  kaspa: { network: 'mainnet', label: 'Mainnet' },
  kaspatest: { network: 'testnet', label: 'Testnet' },
  kaspasim: { network: 'simnet', label: 'Simnet' },
  kaspadev: { network: 'devnet', label: 'Devnet' },
};

const VERSIONS = { 0: 'PubKey', 1: 'PubKeyECDSA', 8: 'ScriptHash' };
const VERSION_LENGTH = { 0: 32, 1: 33, 8: 32 };

/* ------------------------------------------------------------------ */
/* 5-bit <-> 8-bit conversion + BCH checksum                           */
/* ------------------------------------------------------------------ */

function conv8to5(payload) {
  const padding = payload.length % 5 === 0 ? 0 : 1;
  const out = new Uint8Array(Math.floor((payload.length * 8) / 5) + padding);
  let idx = 0;
  let buff = 0;
  let bits = 0;
  for (const c of payload) {
    buff = (buff << 8) | c;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out[idx++] = (buff >> bits) & 0x1f;
      buff &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out[idx] = (buff << (5 - bits)) & 0x1f;
  return out;
}

function conv5to8(payload) {
  const out = new Uint8Array(Math.floor((payload.length * 5) / 8));
  let idx = 0;
  let buff = 0;
  let bits = 0;
  for (const c of payload) {
    buff = (buff << 5) | c;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out[idx++] = (buff >> bits) & 0xff;
      buff &= (1 << bits) - 1;
    }
  }
  return out;
}

function polymod(values) {
  let c = 1n;
  const MASK = 0x07ffffffffn;
  const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & MASK) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i];
  }
  return c ^ 1n;
}

function prefixValues(prefix) {
  return Array.from(Buffer.from(prefix, 'ascii'), (c) => c & 0x1f);
}

function checksumOf(payload5, prefix) {
  const values = [...prefixValues(prefix), 0, ...payload5, 0, 0, 0, 0, 0, 0, 0, 0];
  return polymod(values);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Encode a Kaspa address.
 * @param {string} prefix   e.g. "kaspa" or "kaspatest"
 * @param {number} version  0 | 1 | 8
 * @param {Buffer} payload  raw payload bytes
 */
function encodeAddress(prefix, version, payload) {
  if (!PREFIXES[prefix]) throw new Error(`unknown prefix "${prefix}"`);
  if (!(version in VERSIONS)) throw new Error(`unknown address version ${version}`);
  const bytes = Buffer.concat([Buffer.from([version]), Buffer.from(payload)]);
  const payload5 = conv8to5(bytes);
  const checksum = checksumOf(payload5, prefix);
  const checksum5 = conv8to5(Buffer.from(checksum.toString(16).padStart(16, '0'), 'hex').subarray(3));
  return `${prefix}:${[...payload5, ...checksum5].map((v) => CHARSET[v]).join('')}`;
}

/**
 * Decode + verify a Kaspa address.
 * @returns {{ok: true, prefix: string, network: string, version: number,
 *            versionName: string, payload: Buffer, payloadHex: string}
 *          | {ok: false, error: string}}
 */
function decodeAddress(input) {
  const address = String(input || '').trim();
  if (!address) return { ok: false, error: 'Address is empty' };
  const sep = address.indexOf(':');
  if (sep < 0) return { ok: false, error: 'Missing "prefix:" part (e.g. kaspa:qq...)' };

  const prefix = address.slice(0, sep).toLowerCase();
  const body = address.slice(sep + 1);
  const meta = PREFIXES[prefix];
  if (!meta) {
    return { ok: false, error: `Unknown prefix "${prefix}". Expected kaspa or kaspatest.` };
  }
  if (body.length < 9) return { ok: false, error: 'Address payload is too short' };
  if (body !== body.toLowerCase()) return { ok: false, error: 'Address must be lowercase' };

  const values = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    const v = code < 128 ? REV[code] : -1;
    if (v < 0) return { ok: false, error: `Invalid character "${body[i]}" in address` };
    values[i] = v;
  }

  const splitAt = values.length - 8;
  const payload5 = values.subarray(0, splitAt);
  const checksum5 = values.subarray(splitAt);
  const expected = checksumOf(payload5, prefix);
  const actualBytes = conv5to8(checksum5);
  if (actualBytes.length !== 5) return { ok: false, error: 'Bad checksum length' };
  const actual = BigInt('0x' + Buffer.from(actualBytes).toString('hex'));
  if (expected !== actual) return { ok: false, error: 'Checksum mismatch — address is mistyped or corrupted' };

  const decoded = Buffer.from(conv5to8(payload5));
  if (decoded.length < 1) return { ok: false, error: 'Empty payload' };
  const version = decoded[0];
  const payload = decoded.subarray(1);
  if (!(version in VERSIONS)) return { ok: false, error: `Unsupported address version ${version}` };
  if (payload.length !== VERSION_LENGTH[version]) {
    return {
      ok: false,
      error: `Wrong payload length ${payload.length} for ${VERSIONS[version]} address (expected ${VERSION_LENGTH[version]})`,
    };
  }
  return {
    ok: true,
    prefix,
    network: meta.network,
    version,
    versionName: VERSIONS[version],
    payload: Buffer.from(payload),
    payloadHex: Buffer.from(payload).toString('hex'),
  };
}

function validateAddress(input) {
  const res = decodeAddress(input);
  return res.ok ? { valid: true, ...res, payload: undefined } : { valid: false, error: res.error };
}

/* ------------------------------------------------------------------ */
/* secp256k1 — key generation and x-only public keys                   */
/* ------------------------------------------------------------------ */

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

const mod = (a, m = P) => ((a % m) + m) % m;

function inv(a, m = P) {
  // Extended Euclid
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error('not invertible');
  return mod(oldS, m);
}

// Jacobian point arithmetic (Z=0 means infinity)
function jDouble([x, y, z]) {
  if (z === 0n || y === 0n) return [0n, 1n, 0n];
  const ysq = mod(y * y);
  const s = mod(4n * x * ysq);
  const m = mod(3n * x * x);
  const nx = mod(m * m - 2n * s);
  const ny = mod(m * (s - nx) - 8n * ysq * ysq);
  const nz = mod(2n * y * z);
  return [nx, ny, nz];
}

function jAdd(p1, p2) {
  if (p1[2] === 0n) return p2;
  if (p2[2] === 0n) return p1;
  const [x1, y1, z1] = p1;
  const [x2, y2, z2] = p2;
  const z1z1 = mod(z1 * z1);
  const z2z2 = mod(z2 * z2);
  const u1 = mod(x1 * z2z2);
  const u2 = mod(x2 * z1z1);
  const s1 = mod(y1 * z2 * z2z2);
  const s2 = mod(y2 * z1 * z1z1);
  if (u1 === u2 && s1 !== s2) return [0n, 1n, 0n];
  if (u1 === u2) return jDouble(p1);
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const hh = mod(h * h);
  const hhh = mod(hh * h);
  const v = mod(u1 * hh);
  const nx = mod(r * r - hhh - 2n * v);
  const ny = mod(r * (v - nx) - s1 * hhh);
  const nz = mod(h * z1 * z2);
  return [nx, ny, nz];
}

function multiply(k, point = [GX, GY, 1n]) {
  let result = [0n, 1n, 0n];
  let addend = point;
  let scalar = k;
  while (scalar > 0n) {
    if (scalar & 1n) result = jAdd(result, addend);
    addend = jDouble(addend);
    scalar >>= 1n;
  }
  const [x, y, z] = result;
  if (z === 0n) return null;
  const zi = inv(z);
  const zi2 = mod(zi * zi);
  return [mod(x * zi2), mod(y * zi2 * zi)];
}

/** Derive the compressed (33 byte) public key from a 32 byte private key. */
function publicKeyFromPrivate(privKey) {
  const d = BigInt('0x' + Buffer.from(privKey).toString('hex'));
  if (d <= 0n || d >= N) throw new Error('private key out of range');
  const point = multiply(d);
  const px = point[0].toString(16).padStart(64, '0');
  const prefix = point[1] % 2n === 0n ? '02' : '03';
  return Buffer.from(prefix + px, 'hex');
}

/** x-only (Schnorr) public key = 32 byte X coordinate. */
function xOnlyPublicKey(compressed) {
  return Buffer.from(compressed.subarray(1, 33));
}

function addressFromPublicKey(compressed, network = 'mainnet') {
  const prefix = network === 'testnet' ? 'kaspatest' : 'kaspa';
  return encodeAddress(prefix, 0, xOnlyPublicKey(compressed));
}

const NETWORKS = {
  mainnet: { prefix: 'kaspa' },
  testnet: { prefix: 'kaspatest' },
};

/**
 * Create a brand new Kaspa keypair / address.
 * @param {'mainnet'|'testnet'} network
 */
function generateWallet(network = 'mainnet') {
  const net = NETWORKS[network] ? network : 'mainnet';
  let priv;
  for (;;) {
    priv = crypto.randomBytes(32);
    const d = BigInt('0x' + priv.toString('hex'));
    if (d > 0n && d < N) break;
  }
  const compressed = publicKeyFromPrivate(priv);
  return {
    network: net,
    privateKeyHex: priv.toString('hex'),
    publicKeyHex: compressed.toString('hex'),
    xOnlyHex: xOnlyPublicKey(compressed).toString('hex'),
    address: addressFromPublicKey(compressed, net),
  };
}

/** Rebuild an address from an existing private key (hex). */
function addressFromPrivateKey(hex, network = 'mainnet') {
  const buf = Buffer.from(String(hex || '').trim().replace(/^0x/i, ''), 'hex');
  if (buf.length !== 32) throw new Error('private key must be 32 bytes (64 hex characters)');
  const compressed = publicKeyFromPrivate(buf);
  return {
    network,
    publicKeyHex: compressed.toString('hex'),
    xOnlyHex: xOnlyPublicKey(compressed).toString('hex'),
    address: addressFromPublicKey(compressed, network),
  };
}

module.exports = {
  CHARSET,
  PREFIXES,
  encodeAddress,
  decodeAddress,
  validateAddress,
  publicKeyFromPrivate,
  addressFromPublicKey,
  generateWallet,
  addressFromPrivateKey,
};
