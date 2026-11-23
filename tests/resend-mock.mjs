// Local test of email verification against a fake Resend API (no real emails are sent).
// Run from the project root: node tests/resend-mock.mjs
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = path.resolve('app');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zien-mail-'));
const PORT = 3997, MOCK = 4010, BASE = `http://127.0.0.1:${PORT}`;
const FROM = 'Zien Call <no-reply@zienorganisation.online>';
const KEY = 're_test_mock_key';
const sent = [];
let pass = 0, fail = 0;
const check = (n, ok, d) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? ' -> ' + JSON.stringify(d).slice(0, 300) : '')); } };

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c).on('end', () => {
    const j = JSON.parse(body || '{}');
    sent.push({ auth: req.headers.authorization, path: req.url, ...j });
    if ((j.to || [])[0]?.startsWith('fail')) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ statusCode: 403, name: 'validation_error', message: 'The zienorganisation.online domain is not verified.' })); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'mock_' + sent.length }));
  });
}).listen(MOCK, '127.0.0.1');

const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, COOKIE_SECURE: '0', MAX_USERS: '10',
  RESEND_API_KEY: KEY, RESEND_API_URL: `http://127.0.0.1:${MOCK}/emails`, MAIL_FROM: FROM,
  LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'devsecret-devsecret-devsecret-123', LIVEKIT_WS_URL: 'wss://rtc.example', LIVEKIT_HOST: '127.0.0.1:1' };
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(APP, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);

async function req(p, { body, cookie } = {}) {
  const h = {}; if (body) h['content-type'] = 'application/json'; if (cookie) h.cookie = cookie;
  const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
  let data; const t = await r.text(); try { data = JSON.parse(t); } catch { data = t; }
  const c = r.headers.getSetCookie().find(x => x.startsWith('sid='));
  return { status: r.status, data, cookie: c ? c.split(';')[0] : null };
}
const codeFrom = m => (/(\d{6})/.exec(m.subject) || [])[1];

try {
  for (let i = 0; i < 50 && !/listening/.test(log); i++) await new Promise(r => setTimeout(r, 100));
  check('server started with Resend configured', /Resend ready/.test(log), log);
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(APP, 'admin-cli.js'), 'mockadmin'], { env, input: 'mock-admin-pass-1' });
  const admin = (await req('/api/login', { body: { login: 'mockadmin', password: 'mock-admin-pass-1' } })).cookie;

  console.log('\n[sign-up with email code]');
  check('config: sign-up enabled', (await req('/api/config')).data.signup === true);
  const email = 'new.member@example.com', password = 'member-pass-123';
  const su = await req('/api/signup', { body: { email, username: 'newmember', password } });
  check('sign-up request accepted', su.status === 200, su.data);
  const m1 = sent.at(-1);
  check('Resend called with API key', m1 && m1.auth === 'Bearer ' + KEY, m1 && m1.auth);
  check('email from MAIL_FROM to the user', m1 && m1.from === FROM && m1.to[0] === email, m1);
  check('email has 6-digit code + branding', m1 && codeFrom(m1) && m1.html.includes(codeFrom(m1)) && m1.text.includes('Zien Technologies'), m1 && m1.subject);
  check('resend within 60s blocked -> 429', (await req('/api/signup', { body: { email, username: 'newmember', password } })).status === 429);
  check('wrong code -> 400', (await req('/api/verify', { body: { email, code: codeFrom(m1) === '000000' ? '111111' : '000000' } })).status === 400);
  const v = await req('/api/verify', { body: { email, code: codeFrom(m1) } });
  check('correct code creates account + logs in', v.status === 200 && v.cookie, v.data);
  const me = await req('/api/me', { cookie: v.cookie });
  check('account has verified email, not admin', me.data.email === email && me.data.isAdmin === false, me.data);
  check('code cannot be reused', (await req('/api/verify', { body: { email, code: codeFrom(m1) } })).status === 400);
  check('login with email + password', !!(await req('/api/login', { body: { login: email, password } })).cookie);
  check('duplicate email sign-up -> 409', (await req('/api/signup', { body: { email, username: 'other1', password } })).status === 409);

  console.log('\n[forgot password]');
  const fg = await req('/api/forgot', { body: { email } });
  const m2 = sent.at(-1);
  check('reset email sent', fg.status === 200 && m2 !== m1 && /reset your password/.test(m2.text), m2 && m2.text);
  const newPass = 'member-pass-456';
  check('reset with code', (await req('/api/reset', { body: { email, code: codeFrom(m2), password: newPass } })).status === 200);
  check('new password works', !!(await req('/api/login', { body: { login: email, password: newPass } })).cookie);
  const before = sent.length;
  check('unknown email: same answer, no email sent', (await req('/api/forgot', { body: { email: 'nobody@example.com' } })).status === 200 && sent.length === before);

  console.log('\n[failures]');
  const bad = await req('/api/signup', { body: { email: 'fail@example.com', username: 'failuser', password } });
  check('Resend error -> friendly 500 to the visitor', bad.status === 500 && /Could not send/.test(bad.data.error), bad.data);
  check('Resend error logged on server', /Resend 403/.test(log));

  console.log('\n[admin test email]');
  const t1 = await req('/api/admin/test-email', { cookie: admin, body: { to: 'admin@example.com' } });
  check('test email sent', t1.status === 200 && t1.data.from === FROM && sent.at(-1).subject.includes('test'), t1.data);
  const t2 = await req('/api/admin/test-email', { cookie: admin, body: { to: 'fail@example.com' } });
  check("test email shows Resend's reason to admin", t2.status === 502 && /not verified/.test(t2.data.error), t2.data);
  const memberCookie = (await req('/api/login', { body: { login: email, password: newPass } })).cookie;  // reset signed out old sessions
  check('members cannot send test emails -> 403', (await req('/api/admin/test-email', { cookie: memberCookie, body: { to: 'x@example.com' } })).status === 403);
  const stats = await req('/api/admin/stats', { cookie: admin });
  check('stats report Resend ready + sender', stats.data.app.emailReady === true && stats.data.app.mailFrom === FROM, stats.data.app);

  console.log('\n[member limit applies to sign-up]');
  for (let i = 0; i < 9; i++) await req('/api/admin/users', { cookie: admin, body: { username: 'fill' + i, password: 'fill-pass-123' } });
  const full = await req('/api/signup', { body: { email: 'late@example.com', username: 'lateuser', password } });
  check('sign-up refused at 10 members -> 403', full.status === 403 && /limit/i.test(full.data.error), full.data);
} catch (e) { fail++; console.log('  FAIL crashed: ' + e.stack); }
finally {
  srv.kill(); mock.close();
  setTimeout(() => { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { } console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }, 500);
}
