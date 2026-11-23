// Browser test for background-call handling, using a scripted stand-in for LiveKit.
// Needs the local demo server (see README) on BASE with users zien + meera, and puppeteer-core + Chrome.
//   BASE=http://localhost:3998 ZIEN_PASS=... MEERA_PASS=... node tests/background-call.mjs
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://localhost:3998';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? ' -> ' + JSON.stringify(d) : '')); } };

// Behaves like livekit-client 2.25 where it matters: "freeze" listener on connect (even with
// disconnectOnPageLeave:false), disconnect() emits Disconnected(CLIENT_INITIATED).
const STUB = `(() => {
  const RoomEvent = { TrackSubscribed:'ts', TrackUnsubscribed:'tu', LocalTrackPublished:'ltp', LocalTrackUnpublished:'ltu', TrackMuted:'tm', TrackUnmuted:'tum',
    ParticipantConnected:'pc', ParticipantDisconnected:'pd', ActiveSpeakersChanged:'as', Reconnecting:'rc', Reconnected:'rd', Disconnected:'disconnected' };
  const DisconnectReason = { UNKNOWN_REASON:0, CLIENT_INITIATED:1, DUPLICATE_IDENTITY:2, SERVER_SHUTDOWN:3, PARTICIPANT_REMOVED:4, ROOM_DELETED:5, SIGNAL_CLOSE:9 };
  window.__rooms = [];
  class Room {
    constructor(opts) { this.opts = opts; this.h = {}; this.state = 'disconnected'; this.remoteParticipants = new Map();
      this.localParticipant = { identity: 'me', isMicrophoneEnabled: false, isCameraEnabled: false,
        async setMicrophoneEnabled(v) { this.isMicrophoneEnabled = v; }, async setCameraEnabled(v) { this.isCameraEnabled = v; }, getTrackPublication() { return null; } };
      window.__rooms.push(this); }
    on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; }
    emit(e, ...a) { (this.h[e] || []).forEach(f => f(...a)); }
    async connect() { if (window.__failConnect) throw new Error('network down'); this.state = 'connected';
      this.onPageLeave = () => this.disconnect();
      if (this.opts.disconnectOnPageLeave !== false) window.addEventListener('pagehide', this.onPageLeave);
      window.addEventListener('freeze', this.onPageLeave); }
    async startAudio() {}
    async disconnect() { if (this.state === 'disconnected') return; this.state = 'disconnected'; window.removeEventListener('freeze', this.onPageLeave); this.emit('disconnected', DisconnectReason.CLIENT_INITIATED); }
    drop(reason) { this.state = 'disconnected'; window.removeEventListener('freeze', this.onPageLeave); this.emit('disconnected', reason); }
  }
  window.LivekitClient = { Room, RoomEvent, DisconnectReason, VideoPresets: { h540: { resolution: {} } }, Track: { Source: { Camera: 'camera' } } };
})();`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
async function openAs(user, pass) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setRequestInterception(true);
  p.on('request', r => r.url().endsWith('/livekit-client.js') ? r.respond({ status: 200, contentType: 'application/javascript', body: STUB }) : r.continue());
  p.dialogs = []; p.on('dialog', d => { p.dialogs.push(d.message()); d.accept(); });
  p.calls = []; p.on('request', r => { if (r.url().endsWith('/api/call')) p.calls.push(JSON.parse(r.postData() || '{}')); });
  await p.evaluateOnNewDocument(() => { try { localStorage.setItem('conv', JSON.stringify('c:1')); localStorage.setItem('sound', 'false'); } catch {} });
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.evaluate(async (u, pw) => { await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: u, password: pw }) }); }, user, pass);
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.waitForSelector('#msgList .m, #msgList .empty');
  await sleep(800);
  return p;
}
const state = p => p.evaluate(() => ({
  overlay: !document.getElementById('call').classList.contains('hidden'),
  text: document.getElementById('callState').textContent,
  rooms: window.__rooms.length,
  last: window.__rooms.length ? window.__rooms[window.__rooms.length - 1].state : null,
  mic: window.__rooms.length ? window.__rooms[window.__rooms.length - 1].localParticipant.isMicrophoneEnabled : null,
  media: navigator.mediaSession && navigator.mediaSession.metadata ? navigator.mediaSession.metadata.title : null,
}));
const ringVisible = p => p.evaluate(() => !document.getElementById('ring').classList.contains('hidden'));

try {
  const zien = await openAs('zien', process.env.ZIEN_PASS);
  const meera = await openAs('meera', process.env.MEERA_PASS);

  console.log('[start a call]');
  await zien.click('#btnAudio'); await sleep(1200);
  let s = await state(zien);
  check('call connects', s.overlay && s.rooms === 1 && s.last === 'connected' && s.mic, s);
  check('first token request is not a rejoin', zien.calls.length === 1 && !zien.calls[0].rejoin, zien.calls);
  check('other member gets the ring', await ringVisible(meera));
  await meera.click('#ringDismiss');
  check('phone media controls show the call', s.media === 'In call · #general', s.media);

  console.log('\n[tab frozen by mobile browser]');
  await zien.evaluate(() => document.dispatchEvent(new Event('freeze', { bubbles: true })));
  await sleep(300); s = await state(zien);
  check('freeze no longer hangs up', s.last === 'connected' && s.rooms === 1, s);

  console.log('\n[connection dropped in background]');
  await zien.evaluate(() => window.__rooms[0].drop(window.LivekitClient.DisconnectReason.SIGNAL_CLOSE));
  await sleep(200); s = await state(zien);
  check('call screen stays open while reconnecting', s.overlay && /reconnect/i.test(s.text), s);
  await sleep(2500); s = await state(zien);
  check('rejoins automatically', s.rooms === 2 && s.last === 'connected', s);
  check('rejoin requests a token with rejoin:true', zien.calls.length === 2 && zien.calls[1].rejoin === true, zien.calls);
  check('microphone switched back on', s.mic === true, s);
  check('rejoin does not ring others again', !(await ringVisible(meera)));

  console.log('\n[network still down, then back]');
  await zien.evaluate(() => { window.__failConnect = true; window.__rooms[1].drop(window.LivekitClient.DisconnectReason.SIGNAL_CLOSE); });
  await sleep(3500); s = await state(zien);
  check('keeps retrying while the network is down', s.overlay && /reconnect/i.test(s.text) && s.last !== 'connected', s);
  await zien.evaluate(() => { window.__failConnect = false; document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(1500); s = await state(zien);
  check('reconnects right away when the app is opened again', s.last === 'connected', s);

  console.log('\n[same account joins on another device]');
  await zien.evaluate(() => window.__rooms[window.__rooms.length - 1].drop(window.LivekitClient.DisconnectReason.DUPLICATE_IDENTITY));
  await sleep(500); s = await state(zien);
  check('call ends here instead of fighting', !s.overlay, s);
  check('user is told why', zien.dialogs.some(m => /another device/.test(m)), zien.dialogs);
  const roomsAfter = s.rooms; await sleep(2500);
  check('no rejoin after that', (await state(zien)).rooms === roomsAfter);

  console.log('\n[hang up]');
  await zien.click('#btnAudio'); await sleep(1200);
  check('second call connects', (await state(zien)).last === 'connected');
  await zien.click('#cLeave'); await sleep(300);
  s = await state(zien); const n = s.rooms;
  check('leave closes the call', !s.overlay && s.last === 'disconnected', s);
  check('media controls cleared', s.media === null, s.media);
  await sleep(2500);
  check('no rejoin after leaving', (await state(zien)).rooms === n);
} catch (e) { fail++; console.log('  FAIL crashed: ' + e.stack); }
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
