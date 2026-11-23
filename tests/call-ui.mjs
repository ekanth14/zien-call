// Browser test for minimise / picture-in-picture / audio-device picker, with a scripted LiveKit
// stand-in and (second part) a simulated Android bridge. Needs the local demo server + puppeteer-core.
//   BASE=http://localhost:3998 ZIEN_PASS=... node tests/call-ui.mjs
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://localhost:3998';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? ' -> ' + JSON.stringify(d) : '')); } };

const STUB = `(() => {
  const RoomEvent = { TrackSubscribed:'ts', TrackUnsubscribed:'tu', LocalTrackPublished:'ltp', LocalTrackUnpublished:'ltu', TrackMuted:'tm', TrackUnmuted:'tum',
    ParticipantConnected:'pc', ParticipantDisconnected:'pd', ActiveSpeakersChanged:'as', Reconnecting:'rc', Reconnected:'rd', Disconnected:'disconnected' };
  const DisconnectReason = { CLIENT_INITIATED:1, DUPLICATE_IDENTITY:2, PARTICIPANT_REMOVED:4, ROOM_DELETED:5, SIGNAL_CLOSE:9 };
  window.__rooms = []; window.__switched = [];
  class Room {
    static async getLocalDevices(kind) {
      return kind === 'audiooutput'
        ? [{ deviceId: 'default', label: 'Default - Speakers' }, { deviceId: 'bt1', label: 'Bluetooth Headset (Pixel Buds)' }]
        : [{ deviceId: 'default', label: 'Default - Microphone' }, { deviceId: 'mic2', label: 'USB Microphone' }];
    }
    constructor(opts) { this.opts = opts; this.h = {}; this.state = 'disconnected'; this.remoteParticipants = new Map(); this.active = new Map();
      this.localParticipant = { identity: 'me', isMicrophoneEnabled: false, isCameraEnabled: false,
        async setMicrophoneEnabled(v) { this.isMicrophoneEnabled = v; }, async setCameraEnabled(v) { this.isCameraEnabled = v; }, getTrackPublication() { return null; } };
      window.__rooms.push(this); }
    on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; }
    async connect() { this.state = 'connected'; }
    async startAudio() {}
    getActiveDevice(kind) { return this.active.get(kind); }
    async switchActiveDevice(kind, id) { this.active.set(kind, id); window.__switched.push([kind, id]); return true; }
    async disconnect() { if (this.state === 'disconnected') return; this.state = 'disconnected'; (this.h.disconnected || []).forEach(f => f(1)); }
  }
  window.LivekitClient = { Room, RoomEvent, DisconnectReason, VideoPresets: { h540: { resolution: {} } }, Track: { Source: { Camera: 'camera' } } };
})();`;

// Simulated Capacitor bridge of the Android app (records calls, lets the test fire native events).
const NATIVE = `(() => {
  const listeners = {}; window.__native = []; window.__route = 'earpiece';
  const routes = () => ['earpiece', 'speaker', 'bluetooth'].map(id => ({ id, name: { earpiece: 'Phone earpiece', speaker: 'Speaker', bluetooth: 'Pixel Buds' }[id], active: id === window.__route }));
  window.Capacitor = {
    isNativePlatform: () => true,
    nativePromise: async (plugin, method, opts) => {
      window.__native.push([method, opts]);
      if (method === 'setAudioRoute') window.__route = opts.id;
      if (['start', 'getAudioRoutes', 'setAudioRoute', 'requestBluetooth'].includes(method)) return { routes: routes(), current: window.__route, bluetoothPermission: 'granted' };
      return {};
    },
    addListener: (plugin, ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); return { remove() {} }; },
  };
  window.__fire = (ev, data) => (listeners[ev] || []).forEach(cb => cb(data || {}));
})();`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-fake-ui-for-media-stream'] });
async function open(native) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 1200, height: 800 });
  await p.setRequestInterception(true);
  p.on('request', r => r.url().endsWith('/livekit-client.js') ? r.respond({ status: 200, contentType: 'application/javascript', body: STUB }) : r.continue());
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => console.log('  page error: ' + e.message));
  await p.evaluateOnNewDocument(() => { try { localStorage.setItem('conv', JSON.stringify('c:1')); localStorage.setItem('sound', 'false'); } catch {} });
  if (native) await p.evaluateOnNewDocument(NATIVE);
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.evaluate(async pw => { await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'zien', password: pw }) }); }, process.env.ZIEN_PASS);
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.waitForSelector('#msgList .m, #msgList .empty');
  await sleep(600);
  return p;
}
const vis = (p, sel) => p.evaluate(s => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && !e.closest('.hidden'); }, sel);
const room = p => p.evaluate(() => { const r = window.__rooms.at(-1); return r ? { state: r.state, mic: r.localParticipant.isMicrophoneEnabled } : null; });

try {
  console.log('[web: minimise and keep chatting]');
  const w = await open(false);
  await w.click('#btnAudio'); await sleep(1200);
  check('call screen open', await vis(w, '#call'));
  check('call timer runs', /^\d+:\d\d$/.test(await w.$eval('#callTimer', e => e.textContent)), await w.$eval('#callTimer', e => e.textContent));
  await w.click('#cMin'); await sleep(800);
  const pipDoc = await w.evaluate(() => !!(window.documentPictureInPicture && window.documentPictureInPicture.window));
  check('minimise hides the call screen', !(await vis(w, '#call')));
  check('green call bar shown above the chat', await vis(w, '#miniCall'));
  check('call bar shows name, people and time', /#general/.test(await w.$eval('#miniTitle', e => e.textContent)) && /1 in call · \d+:\d\d/.test(await w.$eval('#miniInfo', e => e.textContent)), await w.$eval('#miniInfo', e => e.textContent));
  check('chat still usable while minimised', await vis(w, '#composer') && await vis(w, '#msgInput'));
  check('call keeps running', (await room(w)).state === 'connected');
  console.log('  info browser floating window opened: ' + (pipDoc ? 'yes (Document PiP)' : 'not available in headless Chrome'));
  await w.click('#miniMic'); await sleep(300);
  check('mute from the call bar', (await room(w)).mic === false && await w.$eval('#miniMic', e => e.classList.contains('off')));
  await w.click('#miniMic'); await sleep(300);
  await w.click('#miniCall .mini-text'); await sleep(500);
  check('tap the bar to return to the call', await vis(w, '#call') && !(await vis(w, '#miniCall')));
  check('video grid back in the call screen', await w.evaluate(() => !!document.querySelector('#call #grid')));

  console.log('\n[web: audio device picker]');
  await w.click('#cAudio'); await sleep(500);
  const opts = await w.$$eval('#audioList .audio-opt span', a => a.map(x => x.textContent));
  check('lists speakers and microphones', opts.includes('Bluetooth Headset (Pixel Buds)') && opts.includes('USB Microphone'), opts);
  await w.evaluate(() => [...document.querySelectorAll('#audioList .audio-opt')].find(b => /Pixel Buds/.test(b.textContent)).click()); await sleep(400);
  check('switches output to Bluetooth', (await w.evaluate(() => window.__switched)).some(([k, id]) => k === 'audiooutput' && id === 'bt1'));
  check('choice is marked', await w.evaluate(() => [...document.querySelectorAll('#audioList .audio-opt.active span')].map(s => s.textContent).includes('Bluetooth Headset (Pixel Buds)')));
  await w.evaluate(() => document.getElementById('dlgAudio').close());
  await w.click('#cLeave'); await sleep(300);
  check('hang up clears call bar', !(await vis(w, '#miniCall')) && !(await vis(w, '#call')));

  console.log('\n[Android app: native audio routes, PiP, notification buttons]');
  const a = await open(true);
  await a.click('#btnAudio'); await sleep(1200);
  let calls = await a.evaluate(() => window.__native);
  const start = calls.find(c => c[0] === 'start');
  check('starts the call service with PiP + mic state', start && start[1].pip === true && start[1].mic === true && start[1].title === '#general', start);
  check('audio button shows the earpiece', /earpiece/i.test(await a.$eval('#cAudio', e => e.title)), await a.$eval('#cAudio', e => e.title));
  await a.click('#cAudio'); await sleep(500);
  check('picker lists earpiece / speaker / Bluetooth', JSON.stringify(await a.$$eval('#audioList .audio-opt span', x => x.map(s => s.textContent))) === '["Phone earpiece","Speaker","Pixel Buds"]');
  await a.evaluate(() => [...document.querySelectorAll('#audioList .audio-opt')].find(b => /Speaker/.test(b.textContent)).click()); await sleep(400);
  check('picking Speaker calls setAudioRoute', (await a.evaluate(() => window.__native)).some(c => c[0] === 'setAudioRoute' && c[1].id === 'speaker'));
  check('button now shows the speaker', /Speaker/.test(await a.$eval('#cAudio', e => e.title)));
  await a.evaluate(() => { window.__route = 'bluetooth'; window.__fire('audioRoutes', { routes: [{ id: 'earpiece', name: 'Phone earpiece', active: false }, { id: 'speaker', name: 'Speaker', active: false }, { id: 'bluetooth', name: 'Pixel Buds', active: true }], current: 'bluetooth' }); }); await sleep(400);
  check('headset connecting updates the picker live', /Pixel Buds/.test(await a.$eval('#cAudio', e => e.title)) && /Pixel Buds/.test(await a.$eval('#audioList .audio-opt.active', e => e.textContent)));
  await a.evaluate(() => document.getElementById('dlgAudio').close());
  await a.click('#cMin'); await sleep(300);
  await a.evaluate(() => window.__fire('pip', { active: true })); await sleep(300);
  const shown = sel => a.evaluate(q => getComputedStyle(document.querySelector(q)).display, sel);   // real rendered display
  check('floating window shows the call even when minimised', await a.evaluate(() => document.body.classList.contains('in-pip')) && (await shown('#call')) === 'flex' && (await shown('#app')) === 'none', [await shown('#call'), await shown('#app')]);
  await a.evaluate(() => window.__fire('toggleMic')); await sleep(300);
  check('PiP / notification mute button mutes', (await room(a)).mic === false && (await a.evaluate(() => window.__native)).some(c => c[0] === 'update' && c[1].mic === false));
  await a.evaluate(() => window.__fire('pip', { active: false })); await sleep(300);
  check('back from floating window: minimised bar again', !(await a.evaluate(() => document.body.classList.contains('in-pip'))) && await vis(a, '#miniCall'));
  await a.evaluate(() => window.__fire('hangup')); await sleep(400);
  calls = await a.evaluate(() => window.__native);
  check('notification hang up ends the call', (await room(a)).state === 'disconnected' && calls.some(c => c[0] === 'stop') && !(await vis(a, '#miniCall')));
} catch (e) { fail++; console.log('  FAIL crashed: ' + e.stack); }
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
