// End-to-end API test for Zien Call. Creates throwaway "zt…" accounts and removes them afterwards.
// Usage: BASE=https://call.example ADMIN_SID=<admin session token> node e2e.mjs
//   optional: EXPECT_ORACLE=1 (stats must report the Oracle VM), LIVEKIT_VALIDATE=1 (check tokens against LiveKit)
import crypto from 'node:crypto';

const BASE = (process.env.BASE || 'http://localhost:3999').replace(/\/$/, '');
const ADMIN = process.env.ADMIN_SID ? 'sid=' + process.env.ADMIN_SID : null;
const tag = 'zt' + crypto.randomBytes(2).toString('hex');
const pw = () => 'Tp-' + crypto.randomBytes(6).toString('hex');
let pass = 0, fail = 0;
const created = [], createdChannels = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' -> ' + JSON.stringify(detail).slice(0, 300) : '')); }
}
async function req(path, { cookie, body, method, raw } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  if (raw) return r;
  let data = null; const text = await r.text();
  try { data = JSON.parse(text); } catch { data = text; }
  const sc = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).find(c => c.startsWith('sid='));
  return { status: r.status, data, cookie: sc ? sc.split(';')[0] : null, headers: r.headers };
}
async function login(username, password) { const r = await req('/api/login', { body: { login: username, password } }); return r.status === 200 ? r.cookie : null; }

async function main() {
  console.log(`Testing ${BASE} (tag ${tag})`);
  if (!ADMIN) throw new Error('ADMIN_SID is required');

  console.log('\n[pages & assets]');
  for (const p of ['/', '/admin', '/app.js', '/app.css', '/admin.js', '/livekit-client.js', '/icon.svg', '/manifest.webmanifest']) {
    const r = await req(p, { raw: true }); check(`GET ${p} -> 200`, r.status === 200, r.status); await r.arrayBuffer();
  }
  const html = await (await req('/', { raw: true })).text();
  check('page has ping badge', html.includes('id="ping"'));
  check('page has Zien Technologies credit', html.includes('Zien Technologies'));
  const cc = (await req('/app.js', { raw: true })).headers.get('cache-control');
  check('app.js is revalidated (no stale UI after deploys)', /no-cache/.test(cc || ''), cc);
  const ping = await req('/api/ping');
  check('GET /api/ping returns time + client IP', ping.status === 200 && typeof ping.data.t === 'number' && ping.data.ip, ping.data);
  const cfg = await req('/api/config');
  check('GET /api/config', cfg.status === 200 && 'signup' in cfg.data, cfg.data);

  console.log('\n[access control]');
  for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/users'], ['GET', '/api/admin/stats'], ['GET', '/api/admin/users'], ['GET', '/api/events']]) {
    const r = await req(p, { method: m }); check(`${m} ${p} without login -> 401`, r.status === 401, r.status);
  }
  const anonCreate = await req('/api/admin/users', { body: { username: tag + 'x', password: pw() } });
  check('create user without login -> 401', anonCreate.status === 401, anonCreate.status);
  const form = await fetch(BASE + '/api/messages', { method: 'POST', headers: { cookie: ADMIN, 'content-type': 'application/x-www-form-urlencoded' }, body: 'conv=c:1&body=x' });
  check('form-encoded POST rejected (CSRF guard) -> 415', form.status === 415, form.status);

  console.log('\n[admin session]');
  const me = await req('/api/me', { cookie: ADMIN });
  check('admin /api/me isAdmin', me.status === 200 && me.data.isAdmin === true, me.data);
  const adminId = me.data.id;

  const stats = await req('/api/admin/stats?history=1', { cookie: ADMIN });
  check('admin stats 200', stats.status === 200, stats.status);
  const s = stats.data.system;
  check('stats: CPU % is a number', s && typeof s.cpu === 'number', s && s.cpu);
  check('stats: disk total > 0', s && s.disk && s.disk.total > 0, s && s.disk);
  check('stats: history array', Array.isArray(stats.data.history));
  if (process.env.EXPECT_ORACLE === '1') {   // Linux server only (/proc is not available on Windows test runs)
    check('stats: RAM total > 0', s && s.mem && s.mem.total > 0, s && s.mem);
    check('stats: network interface found', s && s.net && s.net.iface, s && s.net);
    const o = stats.data.host && stats.data.host.oci;
    check('stats: Oracle instance identified', o && o.shape && o.region, stats.data.host);
    check('stats: shape is Always Free', o && o.alwaysFree, o && o.shape);
    check('stats: RAM matches 1 GB VM (not viewer device)', s.mem.total < 1.2 * 1024 ** 3, s.mem.total);
    check('stats: 3 containers reported', s.containers.length === 3, s.containers.map(c => c.name));
  }

  console.log('\n[member limit]');
  let list = await req('/api/admin/users', { cookie: ADMIN });
  check('list users', list.status === 200 && Array.isArray(list.data.users), list.status);
  const max = list.data.max, startMembers = list.data.members;
  check('member limit is 10', max === 10, max);
  const accounts = [];
  for (let i = 0; startMembers + accounts.length < max; i++) {
    const a = { username: `${tag}${i}`, password: pw() };
    const r = await req('/api/admin/users', { cookie: ADMIN, body: a });
    if (r.status !== 200) { check(`create member ${a.username}`, false, r.data); break; }
    a.id = r.data.id; accounts.push(a); created.push(a.id);
  }
  check(`filled up to ${max} members`, startMembers + accounts.length === max, startMembers + accounts.length);
  const over = await req('/api/admin/users', { cookie: ADMIN, body: { username: tag + 'over', password: pw() } });
  check('11th member rejected -> 403', over.status === 403 && /limit/i.test(over.data.error), over.data);
  const signupFull = await req('/api/signup', { body: { email: tag + '@example.com', username: tag + 'su', password: pw() } });
  check('email sign-up blocked when full or email off', [403, 503].includes(signupFull.status), signupFull.data);
  const extraAdmin = { username: tag + 'adm', password: pw() };
  const ea = await req('/api/admin/users', { cookie: ADMIN, body: { ...extraAdmin, isAdmin: true } });
  check('admin account allowed even when members are full', ea.status === 200, ea.data);
  if (ea.status === 200) { extraAdmin.id = ea.data.id; created.push(ea.data.id); }
  list = await req('/api/admin/users', { cookie: ADMIN });
  check('admins not counted toward limit', list.data.members === max, list.data);

  console.log('\n[validation]');
  const v1 = await req('/api/admin/users', { cookie: ADMIN, body: { username: 'a', password: pw(), isAdmin: true } });
  check('bad username -> 400', v1.status === 400, v1.data);
  const v2 = await req('/api/admin/users', { cookie: ADMIN, body: { username: tag + 'pw', password: 'short', isAdmin: true } });
  check('short password -> 400', v2.status === 400, v2.data);
  const v3 = await req('/api/admin/users', { cookie: ADMIN, body: { username: accounts[0].username, password: pw(), isAdmin: true } });
  check('duplicate username -> 409', v3.status === 409, v3.data);

  console.log('\n[member login & permissions]');
  const [A, B, C] = accounts;
  A.cookie = await login(A.username, A.password); B.cookie = await login(B.username, B.password); C.cookie = await login(C.username, C.password);
  check('members can log in', A.cookie && B.cookie && C.cookie);
  const wrong = await req('/api/login', { body: { login: A.username, password: 'nope-nope' } });
  check('wrong password -> 401', wrong.status === 401, wrong.status);
  const aMe = await req('/api/me', { cookie: A.cookie });
  check('member is not admin', aMe.data.isAdmin === false, aMe.data);
  check('member cannot read stats -> 403', (await req('/api/admin/stats', { cookie: A.cookie })).status === 403);
  check('member cannot list admin users -> 403', (await req('/api/admin/users', { cookie: A.cookie })).status === 403);
  check('member cannot delete users -> 403', (await req('/api/admin/users/' + B.id, { cookie: A.cookie, method: 'DELETE' })).status === 403);
  check('member cannot create users -> 403', (await req('/api/admin/users', { cookie: A.cookie, body: { username: tag + 'q', password: pw() } })).status === 403);

  console.log('\n[chat]');
  const chans = await req('/api/channels', { cookie: A.cookie });
  const general = chans.data.find(c => c.name === 'general') || chans.data[0];
  const conv = 'c:' + general.id;
  // live delivery over Server-Sent Events
  const ac = new AbortController();
  const es = await fetch(BASE + '/api/events', { headers: { cookie: B.cookie }, signal: ac.signal });
  check('SSE stream opens', es.status === 200 && /event-stream/.test(es.headers.get('content-type')), es.status);
  const reader = es.body.getReader(); const dec = new TextDecoder();
  const body = `hello from ${tag} ${Date.now()}`;
  const gotLive = (async () => {
    let buf = ''; const until = Date.now() + 8000;
    while (Date.now() < until) {
      const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ value: null }), 8000))]);
      if (done) return false; if (value) buf += dec.decode(value);
      if (buf.includes(body)) return true;
    }
    return false;
  })();
  await new Promise(r => setTimeout(r, 300));
  const post = await req('/api/messages', { cookie: A.cookie, body: { conv, body } });
  check('member posts to #general', post.status === 200 && post.data.id, post.data);
  check('other member receives it live (SSE)', await gotLive);
  ac.abort();
  const hist = await req('/api/messages?conv=' + encodeURIComponent(conv), { cookie: B.cookie });
  check('message in channel history', hist.data.some(m => m.body === body), hist.data.length);
  const empty = await req('/api/messages', { cookie: A.cookie, body: { conv, body: '   ' } });
  check('empty message rejected -> 400', empty.status === 400);
  const long = await req('/api/messages', { cookie: A.cookie, body: { conv, body: 'x'.repeat(2001) } });
  check('2001-char message rejected -> 400', long.status === 400);

  const dm = `d:${Math.min(A.id, B.id)}-${Math.max(A.id, B.id)}`;
  check('private message A -> B', (await req('/api/messages', { cookie: A.cookie, body: { conv: dm, body: 'secret ' + tag } })).status === 200);
  check('B can read the private chat', (await req('/api/messages?conv=' + dm, { cookie: B.cookie })).data.some(m => m.body === 'secret ' + tag));
  check('C cannot read A-B private chat -> 404', (await req('/api/messages?conv=' + dm, { cookie: C.cookie })).status === 404);
  check('C cannot post into A-B private chat -> 404', (await req('/api/messages', { cookie: C.cookie, body: { conv: dm, body: 'x' } })).status === 404);

  const ch = await req('/api/channels', { cookie: A.cookie, body: { name: tag + '-room' } });
  check('member creates channel', ch.status === 200, ch.data);
  if (ch.status === 200) createdChannels.push(ch.data.id);
  check('bad channel name -> 400', (await req('/api/channels', { cookie: A.cookie, body: { name: 'Bad Name!' } })).status === 400);
  if (ch.status === 200) check('member cannot delete channel -> 403', (await req('/api/channels/' + ch.data.id, { cookie: A.cookie, method: 'DELETE' })).status === 403);

  console.log('\n[calls]');
  const call = await req('/api/call', { cookie: A.cookie, body: { conv, video: true } });
  check('channel call token issued', call.status === 200 && /^eyJ/.test(call.data.token) && call.data.url.startsWith('wss://'), call.data);
  const dmCall = await req('/api/call', { cookie: A.cookie, body: { conv: dm, video: false } });
  check('private call token issued', dmCall.status === 200 && dmCall.data.room === dm.replace(':', '_'), dmCall.data);
  check('outsider cannot get private call token -> 404', (await req('/api/call', { cookie: C.cookie, body: { conv: dm } })).status === 404);
  if (call.status === 200) {
    const payload = JSON.parse(Buffer.from(call.data.token.split('.')[1], 'base64url').toString());
    check('token valid for 2 hours', Math.abs(payload.exp - payload.nbf - 7200) < 5 || Math.abs(payload.exp - Math.floor(Date.now() / 1000) - 7200) < 30, payload);
    check('token is for the right room and user', payload.video && payload.video.room === conv.replace(':', '_') && payload.sub === A.username, payload.video);
    if (process.env.LIVEKIT_VALIDATE === '1') {
      const vurl = call.data.url.replace(/^wss:/, 'https:').replace(/\/$/, '') + '/rtc/validate?access_token=' + encodeURIComponent(call.data.token);
      const v = await fetch(vurl);
      check('LiveKit accepts the token (/rtc/validate)', v.status === 200, v.status + ' ' + (await v.text()).slice(0, 100));
      const bad = await fetch(vurl.replace(/access_token=[^&]+/, 'access_token=' + call.data.token.slice(0, -4) + 'AAAA'));
      check('LiveKit rejects a forged token', bad.status >= 400, bad.status);
    }
  }

  console.log('\n[passwords]');
  const newA = pw();
  check('change password: wrong current -> 400', (await req('/api/password', { cookie: A.cookie, body: { current: 'wrong-wrong', password: newA } })).status === 400);
  const chg = await req('/api/password', { cookie: A.cookie, body: { current: A.password, password: newA } });
  check('change password: ok', chg.status === 200 && chg.cookie, chg.data);
  check('old password no longer works', !(await login(A.username, A.password)));
  check('new password works', !!(A.cookie = await login(A.username, newA)));
  const newB = pw();
  check('admin resets B password', (await req(`/api/admin/users/${B.id}/password`, { cookie: ADMIN, body: { password: newB } })).status === 200);
  check('B old session signed out', (await req('/api/me', { cookie: B.cookie })).status === 401);
  check('B logs in with reset password', !!(B.cookie = await login(B.username, newB)));

  console.log('\n[admin role]');
  check('promote C to admin', (await req(`/api/admin/users/${C.id}/admin`, { cookie: ADMIN, body: { isAdmin: true } })).status === 200);
  check('C now sees stats', (await req('/api/admin/stats', { cookie: C.cookie })).status === 200);
  list = await req('/api/admin/users', { cookie: ADMIN });
  check('member count dropped after promotion', list.data.members === max - 1, list.data.members);
  check('demote C back to member', (await req(`/api/admin/users/${C.id}/admin`, { cookie: ADMIN, body: { isAdmin: false } })).status === 200);
  check('admin cannot change own role', (await req(`/api/admin/users/${adminId}/admin`, { cookie: ADMIN, body: { isAdmin: false } })).status === 400);
  check('admin cannot delete self', (await req('/api/admin/users/' + adminId, { cookie: ADMIN, method: 'DELETE' })).status === 400);

  console.log('\n[delete]');
  const del = await req('/api/admin/users/' + A.id, { cookie: ADMIN, method: 'DELETE' });
  check('admin deletes member A', del.status === 200, del.data);
  check("A's session is gone", (await req('/api/me', { cookie: A.cookie })).status === 401);
  check('A cannot log in', !(await login(A.username, newA)));
  check("A's channel messages removed", !(await req('/api/messages?conv=' + encodeURIComponent(conv), { cookie: B.cookie })).data.some(m => m.body === body));
  check("A-B private chat removed", (await req('/api/messages?conv=' + dm, { cookie: B.cookie })).status === 404);
  check('A missing from user list', !(await req('/api/users', { cookie: B.cookie })).data.some(u => u.id === A.id));
  const refill = await req('/api/admin/users', { cookie: ADMIN, body: { username: tag + 'r', password: pw() } });
  check('freed spot can be reused', refill.status === 200, refill.data);
  if (refill.status === 200) created.push(refill.data.id);
  check('deleting missing user -> 404', (await req('/api/admin/users/99999999', { cookie: ADMIN, method: 'DELETE' })).status === 404);
}

async function cleanup() {
  console.log('\n[cleanup]');
  let n = 0;
  for (const id of created) { const r = await req('/api/admin/users/' + id, { cookie: ADMIN, method: 'DELETE' }); if (r.status === 200) n++; }
  for (const id of createdChannels) await req('/api/channels/' + id, { cookie: ADMIN, method: 'DELETE' });
  const left = (await req('/api/admin/users', { cookie: ADMIN })).data.users.filter(u => u.username.startsWith(tag));
  check(`removed ${n} test accounts, none left`, left.length === 0, left.map(u => u.username));
}

main().catch(e => { fail++; console.log('  FAIL crashed: ' + (e.stack || e)); })
  .then(cleanup).catch(e => { fail++; console.log('  FAIL cleanup: ' + e); })
  .then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); });
