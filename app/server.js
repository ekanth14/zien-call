'use strict';
// Zien Call — chat + audio/video calling. Built by Zien Technologies.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { promisify } = require('util');
const { DatabaseSync } = require('node:sqlite');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

const env = process.env;
const {
  LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_WS_URL,
  LIVEKIT_HOST = '127.0.0.1:7880',
  RESEND_API_KEY = '', RESEND_API_URL = 'https://api.resend.com/emails',
} = env;
const MAIL_FROM = env.MAIL_FROM || '';   // e.g. "Zien Call <no-reply@zienorganisation.online>" (domain verified in Resend)
const MAX_PARTICIPANTS = parseInt(env.MAX_PARTICIPANTS || '10', 10);
const MAX_USERS = parseInt(env.MAX_USERS || '10', 10);   // regular members; admins don't count
const PORT = parseInt(env.PORT || '3000', 10);
const HOST = env.HOST || '127.0.0.1';                 // only Caddy (same machine) should reach the app
const PROXY_PROTOCOL = env.PROXY_PROTOCOL === '1';     // Caddy sends the real client IP via PROXY protocol v1
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const DEV_LOG_CODES = env.DEV_LOG_CODES === '1';
const COOKIE_SECURE = env.COOKIE_SECURE !== '0';
const APP_NAME = env.APP_NAME || 'Zien Call';
const SESSION_DAYS = 30;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_WS_URL) {
  console.error('Missing LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_WS_URL');
  process.exit(1);
}

// ---------- database ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'zien.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT UNIQUE COLLATE NOCASE, pass TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0, legacy INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending (
  email TEXT PRIMARY KEY COLLATE NOCASE, purpose TEXT NOT NULL, username TEXT, pass TEXT,
  code_hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  last_sent INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, conv TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conv, id);
`);
const monitor = require('./metrics').createMonitor({ db });
if (!db.prepare('SELECT 1 FROM channels LIMIT 1').get()) {
  db.prepare('INSERT INTO channels(name, created) VALUES (?, ?)').run('general', Date.now());
}

const scrypt = promisify(crypto.scrypt);
async function hashPass(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return salt.toString('hex') + ':' + key.toString('hex');
}
async function checkPass(pw, stored) {
  const [saltHex, keyHex] = String(stored || '').split(':');
  if (!saltHex || !keyHex) { await scrypt(pw, 'x', 64); return false; }
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function safeEq(a, b) {
  return crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
}

// Accounts are managed in the app (admin page / email sign-up). USER_ALLOWLIST is no longer used.
if (env.USER_ALLOWLIST) console.warn('USER_ALLOWLIST is set but ignored; manage users from the admin page');
const memberCount = () => db.prepare('SELECT COUNT(*) n FROM users WHERE is_admin = 0').get().n;
const adminCount = () => db.prepare('SELECT COUNT(*) n FROM users WHERE is_admin = 1').get().n;
const FULL_MSG = `Member limit reached (${MAX_USERS}). Ask an admin to free a spot.`;
const PASSWORD_MSG = 'Password must be 8–128 characters';
const validPassword = pw => typeof pw === 'string' && pw.length >= 8 && pw.length <= 128;

// ---------- Oracle Cloud instance identity (free metadata service, no API keys) ----------
let oci = null;
async function loadOci() {
  try {
    const r = await fetch('http://169.254.169.254/opc/v2/instance/', { headers: { Authorization: 'Bearer Oracle' }, signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    oci = {
      name: d.displayName, shape: d.shape, region: d.canonicalRegionName || d.region,
      availabilityDomain: d.availabilityDomain, ocpus: d.shapeConfig && d.shapeConfig.ocpus,
      memoryGB: d.shapeConfig && d.shapeConfig.memoryInGBs, bandwidthGbps: d.shapeConfig && d.shapeConfig.networkingBandwidthInGbps,
      created: d.timeCreated, state: d.state,
      alwaysFree: d.shape === 'VM.Standard.E2.1.Micro' || d.shape === 'VM.Standard.A1.Flex',
    };
    console.log(`Oracle Cloud instance: ${oci.name} (${oci.shape}, ${oci.region})`);
  } catch (e) {
    oci = null;
    setTimeout(loadOci, 600000).unref();
  }
}
loadOci();
function hostInfo() {
  const read = f => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
  const cpu = /model name\s*:\s*(.+)/.exec(read('/proc/cpuinfo') || '');
  return {
    oci, hostname: read('/proc/sys/kernel/hostname') || require('os').hostname(),
    kernel: read('/proc/sys/kernel/osrelease'), cpuModel: cpu ? cpu[1] : null,
    cpus: ((read('/proc/cpuinfo') || '').match(/^processor\s*:/gm) || []).length || null,
  };
}

// ---------- email (Resend HTTP API — free tier: 3,000/month, 100/day) ----------
const emailReady = !!RESEND_API_KEY && !!MAIL_FROM;
if (emailReady) console.log(`Email: Resend ready (from ${MAIL_FROM})`);
else if (!DEV_LOG_CODES) console.warn('RESEND_API_KEY / MAIL_FROM not set: email sign-up is disabled');

async function sendEmail({ to, subject, text, html }) {
  const r = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(10000),
  });
  let data = {};
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) {
    const e = new Error(`Resend ${r.status}: ${data.message || data.name || 'request failed'}`);
    e.status = r.status;
    throw e;
  }
  return data.id;
}

const emailHtml = inner => `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:440px;margin:0 auto;padding:8px">
  <h2 style="margin:0 0 12px;color:#5b4ff0">${APP_NAME}</h2>${inner}
  <p style="color:#999;font-size:12px;margin-top:24px">Built by Zien Technologies — a vision of Zien Organisation</p></div>`;

async function sendCode(email, code, purpose) {
  const what = purpose === 'reset' ? 'reset your password' : 'verify your email';
  if (DEV_LOG_CODES) console.log(`[dev] ${purpose} code for ${email}: ${code}`);
  if (!emailReady) { if (DEV_LOG_CODES) return; throw new Error('Email is not configured on the server'); }
  await sendEmail({
    to: email,
    subject: `${APP_NAME} code: ${code}`,
    text: `Your ${APP_NAME} code to ${what} is ${code}\n\nIt expires in 10 minutes. If you didn't ask for this, ignore this email.\n\n— Built by Zien Technologies, a vision of Zien Organisation`,
    html: emailHtml(`<p>Your code to ${what}:</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:8px 0">${code}</p>
      <p style="color:#666">It expires in 10 minutes. If you didn't ask for this, ignore this email.</p>`),
  });
}

// ---------- livekit ----------
function findBundle() {
  const dist = path.join(__dirname, 'node_modules', 'livekit-client', 'dist');
  const files = fs.readdirSync(dist).filter(f => /umd.*\.(c|m)?js$/.test(f) && !f.endsWith('.map'));
  files.sort((a, b) => (b.endsWith('.umd.js') ? 1 : 0) - (a.endsWith('.umd.js') ? 1 : 0));
  if (!files.length) throw new Error('No UMD bundle in ' + dist + ': ' + fs.readdirSync(dist).join(', '));
  return path.join(dist, files[0]);
}
const BUNDLE = findBundle();
const roomSvc = new RoomServiceClient(`http://${LIVEKIT_HOST}`, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// ---------- helpers ----------
const fails = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const arr = (fails.get(key) || []).filter(t => now - t < windowMs);
  fails.set(key, arr);
  return arr.length >= max;
}
const hit = key => { (fails.get(key) || fails.set(key, []).get(key)).push(Date.now()); };

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const USER_RE = /^[a-z0-9_.-]{3,20}$/;
const CHANNEL_RE = /^[a-z0-9-]{2,24}$/;
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO sessions(token_hash, user_id, expires) VALUES (?,?,?)').run(sha(token), userId, expires);
  res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${COOKIE_SECURE ? '; Secure' : ''}`);
}
function currentUser(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.username, u.email, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires > ?`).get(sha(token), Date.now()) || null;
}
function auth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Please log in' });
  req.user = u;
  next();
}
const pub = u => ({ id: u.id, username: u.username, email: u.email || null, isAdmin: !!u.is_admin });

// Conversation ids: "c:<channelId>" or "d:<lowUserId>-<highUserId>"
function convAccess(conv, userId) {
  let m = /^c:(\d+)$/.exec(conv);
  if (m) {
    const ch = db.prepare('SELECT id, name FROM channels WHERE id = ?').get(Number(m[1]));
    return ch ? { kind: 'channel', title: '#' + ch.name, members: null } : null;
  }
  m = /^d:(\d+)-(\d+)$/.exec(conv);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a >= b || (userId !== a && userId !== b)) return null;
    const other = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId === a ? b : a);
    return other ? { kind: 'dm', title: other.username, members: [a, b] } : null;
  }
  return null;
}

// ---------- realtime (Server-Sent Events) ----------
const streams = new Map(); // userId -> Set<res>
function send(userId, event) {
  for (const res of streams.get(userId) || []) res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function broadcast(event, members) {
  if (members) members.forEach(id => send(id, event));
  else for (const id of streams.keys()) send(id, event);
}
const onlineIds = () => [...streams.keys()];
setInterval(() => { for (const set of streams.values()) for (const r of set) r.write(': ping\n\n'); }, 25000);

// ---------- app ----------
const app = express();
app.set('trust proxy', false);
// Real visitor IP: from the PROXY protocol header Caddy sends, else the socket address.
const clientIp = req => req.socket.clientIp || req.socket.remoteAddress || 'unknown';
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.method === 'POST' || req.method === 'DELETE') {
    // JSON-only writes + SameSite cookie blocks cross-site form posts.
    if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
  }
  next();
});

app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/livekit-client.js', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('application/javascript').sendFile(BUNDLE);
});
app.get('/api/config', (_req, res) => res.json({
  appName: APP_NAME,
  signup: emailReady || DEV_LOG_CODES,
  apk: fs.existsSync(path.join(__dirname, 'public', 'zien-call.apk')),
}));
// no-cache = always revalidate (cheap 304s), so new deploys show up immediately.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => res.setHeader('Cache-Control', file.endsWith('.apk') ? 'public, max-age=300' : 'no-cache'),
}));

// --- sign up / verify ---
app.post('/api/signup', async (req, res) => {
  try {
    const ip = clientIp(req);
    if (rateLimited('signup:' + ip, 10, 36e5)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!USER_RE.test(username)) return res.status(400).json({ error: 'Username: 3–20 letters, numbers, . _ or -' });
    if (!validPassword(password)) return res.status(400).json({ error: PASSWORD_MSG });
    if (!emailReady && !DEV_LOG_CODES) return res.status(503).json({ error: 'Sign-up is not available yet (email not configured). Ask an admin to create your account.' });
    if (memberCount() >= MAX_USERS) return res.status(403).json({ error: FULL_MSG });
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'That email already has an account. Log in instead.' });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'That username is taken' });
    const p = db.prepare('SELECT last_sent FROM pending WHERE email = ?').get(email);
    if (p && Date.now() - p.last_sent < 60000) return res.status(429).json({ error: 'Wait a minute before requesting another code' });
    hit('signup:' + ip);
    const code = newCode();
    db.prepare(`INSERT OR REPLACE INTO pending(email, purpose, username, pass, code_hash, expires, attempts, last_sent)
      VALUES (?, 'signup', ?, ?, ?, ?, 0, ?)`).run(email, username, await hashPass(password), sha(email + code), Date.now() + 6e5, Date.now());
    await sendCode(email, code, 'signup');
    res.json({ ok: true });
  } catch (e) {
    console.error('signup:', e.message);
    res.status(500).json({ error: 'Could not send the email. Try again shortly.' });
  }
});

function checkCode(email, code, purpose) {
  const p = db.prepare('SELECT * FROM pending WHERE email = ? AND purpose = ?').get(email, purpose);
  if (!p || p.expires < Date.now()) return { error: 'Code expired. Request a new one.' };
  if (p.attempts >= 5) return { error: 'Too many wrong codes. Request a new one.' };
  if (!safeEq(p.code_hash, sha(email + code))) {
    db.prepare('UPDATE pending SET attempts = attempts + 1 WHERE email = ?').run(email);
    return { error: 'Wrong code' };
  }
  db.prepare('DELETE FROM pending WHERE email = ?').run(email);
  return { p };
}

app.post('/api/verify', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const r = checkCode(email, code, 'signup');
  if (r.error) return res.status(400).json({ error: r.error });
  try {
    if (memberCount() >= MAX_USERS) return res.status(403).json({ error: FULL_MSG });
    const info = db.prepare('INSERT INTO users(username, email, pass, is_admin, legacy, created) VALUES (?,?,?,0,0,?)')
      .run(r.p.username, email, r.p.pass, Date.now());
    startSession(res, Number(info.lastInsertRowid));
    broadcast({ type: 'users' });
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: 'That username or email was just taken. Sign up again.' });
  }
});

// --- login / logout ---
app.post('/api/login', async (req, res) => {
  const ip = clientIp(req);
  if (rateLimited('login:' + ip, 10, 6e5)) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  const login = String(req.body.login || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (rateLimited('login-acct:' + login, 10, 6e5)) return res.status(429).json({ error: 'Too many wrong passwords for this account. Try again in 10 minutes.' });
  const u = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(login, login);
  const ok = await checkPass(password, u ? u.pass : '');
  if (!u || !ok) { hit('login:' + ip); hit('login-acct:' + login); return res.status(401).json({ error: 'Wrong username/email or password' }); }
  startSession(res, u.id);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  res.setHeader('Set-Cookie', `sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`);
  res.json({ ok: true });
});

// --- forgot password ---
app.post('/api/forgot', async (req, res) => {
  try {
    const ip = clientIp(req);
    if (rateLimited('forgot:' + ip, 5, 36e5)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    hit('forgot:' + ip);
    const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    const p = db.prepare('SELECT last_sent FROM pending WHERE email = ?').get(email);
    if (u && !(p && Date.now() - p.last_sent < 60000)) {
      const code = newCode();
      db.prepare(`INSERT OR REPLACE INTO pending(email, purpose, code_hash, expires, attempts, last_sent)
        VALUES (?, 'reset', ?, ?, 0, ?)`).run(email, sha(email + code), Date.now() + 6e5, Date.now());
      await sendCode(email, code, 'reset');
    }
    res.json({ ok: true }); // same answer whether or not the account exists
  } catch (e) {
    console.error('forgot:', e.message);
    res.status(500).json({ error: 'Could not send the email. Try again shortly.' });
  }
});
app.post('/api/reset', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const password = String(req.body.password || '');
  if (!validPassword(password)) return res.status(400).json({ error: PASSWORD_MSG });
  const r = checkCode(email, code, 'reset');
  if (r.error) return res.status(400).json({ error: r.error });
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!u) return res.status(400).json({ error: 'Account not found' });
  db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPass(password), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  startSession(res, u.id);
  res.json({ ok: true });
});

// --- own account ---
app.post('/api/password', auth, async (req, res) => {
  const current = String(req.body.current || '');
  const password = String(req.body.password || '');
  if (rateLimited('pw:' + req.user.id, 5, 6e5)) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  if (!validPassword(password)) return res.status(400).json({ error: PASSWORD_MSG });
  const row = db.prepare('SELECT pass FROM users WHERE id = ?').get(req.user.id);
  if (!(await checkPass(current, row.pass))) { hit('pw:' + req.user.id); return res.status(400).json({ error: 'Current password is wrong' }); }
  db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPass(password), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);   // sign out other devices
  startSession(res, req.user.id);
  res.json({ ok: true });
});

// Latency probe for the ping badge. Tiny response, never cached.
app.get('/api/ping', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ t: Date.now(), ip: clientIp(req) }); });

// --- dashboard data ---
app.get('/api/me', auth, (req, res) => res.json(pub(req.user)));
app.get('/api/users', auth, (_req, res) => {
  const online = new Set(onlineIds());
  res.json(db.prepare('SELECT id, username FROM users ORDER BY username').all()
    .map(u => ({ id: u.id, username: u.username, online: online.has(u.id) })));
});
app.get('/api/channels', auth, (_req, res) => res.json(db.prepare('SELECT id, name FROM channels ORDER BY name').all()));
app.post('/api/channels', auth, (req, res) => {
  const name = String(req.body.name || '').trim().toLowerCase();
  if (!CHANNEL_RE.test(name)) return res.status(400).json({ error: 'Channel name: 2–24 lowercase letters, numbers or -' });
  if (db.prepare('SELECT COUNT(*) n FROM channels').get().n >= 30) return res.status(403).json({ error: 'Channel limit reached' });
  try {
    const info = db.prepare('INSERT INTO channels(name, created) VALUES (?, ?)').run(name, Date.now());
    broadcast({ type: 'channels' });
    res.json({ id: Number(info.lastInsertRowid), name });
  } catch { res.status(409).json({ error: 'That channel already exists' }); }
});
app.delete('/api/channels/:id', auth, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only' });
  const id = Number(req.params.id);
  if (db.prepare('SELECT COUNT(*) n FROM channels').get().n <= 1) return res.status(400).json({ error: 'Keep at least one channel' });
  db.prepare('DELETE FROM messages WHERE conv = ?').run('c:' + id);
  db.prepare('DELETE FROM channels WHERE id = ?').run(id);
  broadcast({ type: 'channels' });
  res.json({ ok: true });
});

app.get('/api/messages', auth, (req, res) => {
  const conv = String(req.query.conv || '');
  if (!convAccess(conv, req.user.id)) return res.status(404).json({ error: 'Not found' });
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = db.prepare(`SELECT m.id, m.body, m.created, m.user_id AS userId, u.username FROM messages m
    JOIN users u ON u.id = m.user_id WHERE m.conv = ? AND m.id < ? ORDER BY m.id DESC LIMIT 50`).all(conv, before);
  res.json(rows.reverse());
});
app.post('/api/messages', auth, (req, res) => {
  const conv = String(req.body.conv || '');
  const body = String(req.body.body || '').trim();
  const access = convAccess(conv, req.user.id);
  if (!access) return res.status(404).json({ error: 'Not found' });
  if (!body || body.length > 2000) return res.status(400).json({ error: 'Message must be 1–2000 characters' });
  if (rateLimited('msg:' + req.user.id, 30, 10000)) return res.status(429).json({ error: 'Slow down a little' });
  hit('msg:' + req.user.id);
  const created = Date.now();
  const info = db.prepare('INSERT INTO messages(conv, user_id, body, created) VALUES (?,?,?,?)').run(conv, req.user.id, body, created);
  const msg = { id: Number(info.lastInsertRowid), conv, body, created, userId: req.user.id, username: req.user.username };
  broadcast({ type: 'message', msg }, access.members);
  res.json(msg);
});

app.get('/api/events', auth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const id = req.user.id;
  const wasOnline = streams.has(id);
  if (!wasOnline) streams.set(id, new Set());
  streams.get(id).add(res);
  if (!wasOnline) broadcast({ type: 'presence', online: onlineIds() });
  else send(id, { type: 'presence', online: onlineIds() });
  req.on('close', () => {
    const set = streams.get(id);
    if (!set) return;
    set.delete(res);
    if (!set.size) { streams.delete(id); broadcast({ type: 'presence', online: onlineIds() }); }
  });
});

// --- calls ---
app.post('/api/call', auth, async (req, res) => {
  try {
    const conv = String(req.body.conv || '');
    const video = !!req.body.video;
    const access = convAccess(conv, req.user.id);
    if (!access) return res.status(404).json({ error: 'Not found' });
    const room = conv.replace(':', '_');
    let participants = 0;
    try {
      const list = await roomSvc.listParticipants(room);
      participants = list.length;
    } catch { /* room does not exist yet */ }
    if (participants >= MAX_PARTICIPANTS) return res.status(403).json({ error: `Call is full (${MAX_PARTICIPANTS} people max)` });
    if (!participants) {
      try { await roomSvc.createRoom({ name: room, maxParticipants: MAX_PARTICIPANTS, emptyTimeout: 120 }); }
      catch (e) { console.warn('createRoom:', e.message); }
    }
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: req.user.username, name: req.user.username, ttl: '2h' });
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
    const token = await at.toJwt();
    if (!participants && !req.body.rejoin) {   // automatic reconnects don't ring everyone again
      const ring = { type: 'call', conv, title: access.kind === 'dm' ? req.user.username : access.title, from: req.user.username, fromId: req.user.id, video };
      broadcast(ring, access.members);
    }
    res.json({ token, url: LIVEKIT_WS_URL, room, title: access.title });
  } catch (e) {
    console.error('call:', e);
    res.status(500).json({ error: 'Could not start the call' });
  }
});

// --- admin: members ---
function adminOnly(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only' });
  next();
}
app.get('/api/admin/users', auth, adminOnly, (_req, res) => {
  const online = new Set(onlineIds());
  res.json({
    max: MAX_USERS, members: memberCount(), admins: adminCount(),
    users: db.prepare('SELECT id, username, email, is_admin AS isAdmin, created FROM users ORDER BY is_admin DESC, created').all()
      .map(u => ({ ...u, isAdmin: !!u.isAdmin, online: online.has(u.id) })),
  });
});
app.post('/api/admin/users', auth, adminOnly, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  const isAdmin = req.body.isAdmin ? 1 : 0;
  if (!USER_RE.test(username)) return res.status(400).json({ error: 'Username: 3–20 letters, numbers, . _ or -' });
  if (!validPassword(password)) return res.status(400).json({ error: PASSWORD_MSG });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email address looks wrong' });
  if (!isAdmin && memberCount() >= MAX_USERS) return res.status(403).json({ error: FULL_MSG });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'That username is taken' });
  if (email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'That email already has an account' });
  const info = db.prepare('INSERT INTO users(username, email, pass, is_admin, legacy, created) VALUES (?,?,?,?,0,?)')
    .run(username, email, await hashPass(password), isAdmin, Date.now());
  broadcast({ type: 'users' });
  res.json({ id: Number(info.lastInsertRowid), username });
});
app.post('/api/admin/users/:id/password', auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const password = String(req.body.password || '');
  if (!validPassword(password)) return res.status(400).json({ error: PASSWORD_MSG });
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPass(password), id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  for (const r of streams.get(id) || []) r.end();
  if (id === req.user.id) startSession(res, id);
  res.json({ ok: true });
});
app.post('/api/admin/users/:id/admin', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const makeAdmin = req.body.isAdmin ? 1 : 0;
  const u = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (id === req.user.id) return res.status(400).json({ error: "You can't change your own admin role" });
  if (!makeAdmin && u.is_admin && memberCount() >= MAX_USERS) return res.status(403).json({ error: FULL_MSG });
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(makeAdmin, id);
  broadcast({ type: 'users' });
  res.json({ ok: true });
});
app.delete('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  db.prepare('DELETE FROM messages WHERE conv LIKE ? OR conv LIKE ?').run(`d:${id}-%`, `d:%-${id}`);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);   // sessions + their messages cascade
  for (const r of streams.get(id) || []) r.end();
  streams.delete(id);
  // drop them from any live call
  try {
    for (const room of await roomSvc.listRooms()) {
      await roomSvc.removeParticipant(room.name, u.username).catch(() => {});
    }
  } catch { /* livekit unreachable */ }
  broadcast({ type: 'users' });
  broadcast({ type: 'presence', online: onlineIds() });
  res.json({ ok: true });
});

let roomsCache = { t: 0, rooms: [] };
async function liveRooms() {
  if (Date.now() - roomsCache.t < 10000) return roomsCache.rooms;
  try {
    const rooms = await roomSvc.listRooms();
    roomsCache = { t: Date.now(), rooms: rooms.map(r => ({ name: r.name, participants: r.numParticipants })) };
  } catch (e) { roomsCache = { t: Date.now(), rooms: [], error: e.message }; }
  return roomsCache.rooms;
}
function roomLabel(name) {
  let m = /^c_(\d+)$/.exec(name);
  if (m) { const c = db.prepare('SELECT name FROM channels WHERE id = ?').get(Number(m[1])); return c ? '#' + c.name : name; }
  m = /^d_(\d+)-(\d+)$/.exec(name);
  if (m) {
    const n = id => (db.prepare('SELECT username FROM users WHERE id = ?').get(Number(id)) || {}).username || '?';
    return `${n(m[1])} ↔ ${n(m[2])}`;
  }
  return name;
}
app.post('/api/admin/test-email', auth, adminOnly, async (req, res) => {
  const to = String(req.body.to || '').trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!emailReady) return res.status(503).json({ error: 'Resend is not configured: RESEND_API_KEY / MAIL_FROM missing in .env' });
  if (rateLimited('testmail:' + req.user.id, 5, 36e5)) return res.status(429).json({ error: 'Test email limit reached (5 per hour)' });
  hit('testmail:' + req.user.id);
  try {
    const id = await sendEmail({
      to, subject: `${APP_NAME} test email`,
      text: `This is a test email from ${APP_NAME}. Email verification is working.

— Built by Zien Technologies, a vision of Zien Organisation`,
      html: emailHtml('<p>This is a test email. Email verification is working ✅</p>'),
    });
    res.json({ ok: true, id, from: MAIL_FROM });
  } catch (e) {
    console.error('test-email:', e.message);
    res.status(502).json({ error: e.message });   // admins see Resend's reason (e.g. domain not verified)
  }
});
app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
  const dayAgo = Date.now() - 864e5;
  const rooms = (await liveRooms()).map(r => ({ ...r, label: roomLabel(r.name) }));
  res.json({
    host: hostInfo(),
    system: monitor.snapshot(),
    history: req.query.history ? monitor.history() : undefined,
    app: {
      users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
      members: memberCount(), admins: adminCount(),
      maxUsers: MAX_USERS,
      online: streams.size,
      onlineNames: onlineIds().map(id => (db.prepare('SELECT username FROM users WHERE id = ?').get(id) || {}).username).filter(Boolean),
      channels: db.prepare('SELECT COUNT(*) n FROM channels').get().n,
      messages: db.prepare('SELECT COUNT(*) n FROM messages').get().n,
      messages24h: db.prepare('SELECT COUNT(*) n FROM messages WHERE created > ?').get(dayAgo).n,
      signups24h: db.prepare('SELECT COUNT(*) n FROM users WHERE created > ? AND email IS NOT NULL').get(dayAgo).n,
      dbBytes: ['zien.db', 'zien.db-wal'].reduce((a, f) => { try { return a + fs.statSync(path.join(DATA_DIR, f)).size; } catch { return a; } }, 0),
      emailReady, mailFrom: MAIL_FROM || null,
      rooms, inCalls: rooms.reduce((a, r) => a + r.participants, 0),
    },
  });
});
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// housekeeping
setInterval(() => {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
  db.prepare('DELETE FROM pending WHERE expires < ?').run(now - 36e5);
  for (const [k, v] of fails) if (!v.some(t => now - t < 36e5)) fails.delete(k);
}, 36e5);

const nUsers = db.prepare('SELECT COUNT(*) n FROM users').get().n;
// TCP server that understands the optional PROXY protocol v1 header from Caddy, then hands the socket to HTTP.
const httpServer = http.createServer(app);
httpServer.keepAliveTimeout = 65000;
const tcpServer = net.createServer(socket => {
  socket.on('error', () => {});
  if (!PROXY_PROTOCOL) return httpServer.emit('connection', socket);
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => socket.destroy(), 10000);
  const onData = chunk => {
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n');
    if (idx === -1) { if (buf.length > 107) { clearTimeout(timer); socket.destroy(); } return; }
    clearTimeout(timer);
    socket.removeListener('data', onData);
    socket.pause();
    const line = buf.subarray(0, idx).toString('latin1');
    let rest = buf;
    if (line.startsWith('PROXY ')) {
      const parts = line.split(' ');              // PROXY TCP4 <src> <dst> <srcport> <dstport>
      if ((parts[1] === 'TCP4' || parts[1] === 'TCP6') && net.isIP(parts[2])) socket.clientIp = parts[2];
      rest = buf.subarray(idx + 2);
    }
    if (rest.length) socket.unshift(rest);
    httpServer.emit('connection', socket);
    socket.resume();
  };
  socket.on('data', onData);
});
tcpServer.listen(PORT, HOST, () => console.log(`${APP_NAME} listening on ${HOST}:${PORT}${PROXY_PROTOCOL ? ' (PROXY protocol)' : ''} (bundle: ${path.basename(BUNDLE)}, ${nUsers} account(s), member limit ${MAX_USERS})`));
