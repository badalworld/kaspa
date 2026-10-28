'use strict';
/**
 * Authentication for the panel.
 *
 * - password hashed with scrypt (N=2^15, r=8, p=1) + per-password salt
 * - opaque session ids stored hashed, delivered in an httpOnly cookie
 * - login throttling per client ip
 * - first-run setup requires either a local connection or the setup token that
 *   is printed to the server console (data/SETUP_TOKEN.txt)
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./util');

const COOKIE_NAME = 'kaspa_panel_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_SESSIONS = 6;

function scrypt(password, salt, keylen = 64) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * (1 << 15) * 8 * 2 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt);
  return { hash: hash.toString('hex'), salt };
}

async function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const candidate = await scrypt(password, salt);
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== candidate.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function createSession(config, { ip, ua }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const sessions = config.auth.sessions || [];
  const now = Date.now();
  const fresh = sessions.filter((s) => now - s.createdAt < SESSION_TTL_MS);
  fresh.push({
    id: sha(token),
    createdAt: now,
    lastSeen: now,
    ip: ip || '',
    ua: String(ua || '').slice(0, 160),
  });
  config.auth.sessions = fresh.slice(-MAX_SESSIONS);
  return token;
}

function findSession(config, token) {
  if (!token) return null;
  const id = sha(token);
  const now = Date.now();
  const session = (config.auth.sessions || []).find((s) => s.id === id);
  if (!session) return null;
  if (now - session.createdAt > SESSION_TTL_MS) return null;
  return session;
}

function destroySession(config, token) {
  if (!token) return;
  const id = sha(token);
  config.auth.sessions = (config.auth.sessions || []).filter((s) => s.id !== id);
}

function destroyAllSessions(config) {
  config.auth.sessions = [];
}

/* ------------------------------- setup token ------------------------------ */

const SETUP_TOKEN_FILE = path.join(DATA_DIR, 'SETUP_TOKEN.txt');
let setupToken = null;

function getSetupToken(regenerate = false) {
  if (setupToken && !regenerate) return setupToken;
  if (!regenerate && fs.existsSync(SETUP_TOKEN_FILE)) {
    try {
      setupToken = fs.readFileSync(SETUP_TOKEN_FILE, 'utf8').trim();
      if (setupToken) return setupToken;
    } catch {
      /* regenerate below */
    }
  }
  setupToken = crypto.randomBytes(9).toString('base64url').slice(0, 12).toUpperCase();
  try {
    fs.writeFileSync(SETUP_TOKEN_FILE, setupToken, { mode: 0o600 });
  } catch {
    /* non-fatal */
  }
  return setupToken;
}

function clearSetupToken() {
  setupToken = null;
  try {
    fs.unlinkSync(SETUP_TOKEN_FILE);
  } catch {
    /* already gone */
  }
}

/* -------------------------------- throttle -------------------------------- */

const attempts = new Map(); // ip -> { count, first, blockedUntil }

function throttleKey(ip) {
  return String(ip || 'unknown');
}

function checkThrottle(ip) {
  const entry = attempts.get(throttleKey(ip));
  if (!entry) return { allowed: true };
  if (entry.blockedUntil && Date.now() < entry.blockedUntil) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.blockedUntil - Date.now()) / 1000) };
  }
  return { allowed: true };
}

function registerFailure(ip) {
  const key = throttleKey(ip);
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, first: now, blockedUntil: 0 };
  if (now - entry.first > 15 * 60 * 1000) {
    entry.count = 0;
    entry.first = now;
  }
  entry.count += 1;
  if (entry.count >= 5) {
    const penalty = Math.min(15 * 60, 60 * 2 ** (entry.count - 5));
    entry.blockedUntil = now + penalty * 1000;
  }
  attempts.set(key, entry);
}

function registerSuccess(ip) {
  attempts.delete(throttleKey(ip));
}

/* --------------------------------- cookies -------------------------------- */

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function sessionCookie(token, { secure = false, sameSite = 'Lax' } = {}) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token || '')}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`,
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  // SameSite=None is only honoured together with Secure
  if (secure || sameSite === 'None') attrs.push('Secure');
  return attrs.join('; ');
}

function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 200) return 'Password is too long.';
  if (/^(password|12345678|qwertyui|kaspa123)$/i.test(password)) return 'Pick a less predictable password.';
  return null;
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  createSession,
  findSession,
  destroySession,
  destroyAllSessions,
  getSetupToken,
  clearSetupToken,
  checkThrottle,
  registerFailure,
  registerSuccess,
  parseCookies,
  sessionCookie,
  clearCookie,
  passwordProblem,
};
