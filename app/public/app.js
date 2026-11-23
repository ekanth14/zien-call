// Zien Call client — Built by Zien Technologies, a vision of Zien Organisation.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const LK = window.LivekitClient;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const S = { me: null, channels: [], users: [], online: new Set(), conv: null, unread: {}, oldest: null, es: null, room: null, callConv: null, ringConv: null };

  async function api(path, body, method) {
    const opts = { method: method || (body ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(path, opts);
    let data = {};
    try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) { const e = new Error(data.error || 'Request failed (' + r.status + ')'); e.status = r.status; throw e; }
    return data;
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function colorFor(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; }
  function avatar(name) { const a = el('div', 'av', (name[0] || '?').toUpperCase()); a.style.background = colorFor(name); return a; }
  const dmId = (a, b) => 'd:' + Math.min(a, b) + '-' + Math.max(a, b);

  // ================= AUTH =================
  let pendingEmail = '', resetEmail = '';
  function showView(v) {
    document.querySelectorAll('#auth form').forEach(f => f.classList.toggle('hidden', f.dataset.view !== v));
    document.querySelectorAll('#authTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === (v === 'verify' ? 'signup' : v)));
    $('authTabs').classList.toggle('hidden', v === 'forgot' || v === 'reset');
    authMsg('');
    const first = document.querySelector(`#auth form[data-view="${v}"] input`);
    if (first) setTimeout(() => first.focus(), 30);
  }
  function authMsg(t, ok) { $('authMsg').textContent = t; $('authMsg').classList.toggle('ok', !!ok); }
  document.querySelectorAll('#authTabs button').forEach(b => b.onclick = () => showView(b.dataset.tab));
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => showView(b.dataset.go));

  function formHandler(id, fn) {
    const f = $(id);
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = f.querySelector('button.primary');
      btn.disabled = true; authMsg('');
      try { await fn(Object.fromEntries(new FormData(f))); } catch (err) { authMsg(err.message); }
      finally { btn.disabled = false; }
    });
  }
  formHandler('fLogin', async d => { await api('/api/login', d); $('fLogin').reset(); start(); });
  formHandler('fSignup', async d => {
    await api('/api/signup', d);
    pendingEmail = d.email.trim().toLowerCase();
    $('verifyEmail').textContent = pendingEmail;
    showView('verify'); authMsg('Code sent.', true);
  });
  formHandler('fVerify', async d => { await api('/api/verify', { email: pendingEmail, code: d.code }); $('fSignup').reset(); $('fVerify').reset(); start(); });
  formHandler('fForgot', async d => { await api('/api/forgot', d); resetEmail = d.email.trim().toLowerCase(); showView('reset'); });
  formHandler('fReset', async d => { await api('/api/reset', { email: resetEmail, ...d }); $('fReset').reset(); start(); });

  // ================= DASHBOARD =================
  function showAuth() {
    $('app').classList.add('hidden'); $('auth').classList.remove('hidden');
    if (S.es) { S.es.close(); S.es = null; }
    showView('login');
  }

  async function start() {
    try { S.me = await api('/api/me'); } catch { return showAuth(); }
    $('auth').classList.add('hidden'); $('app').classList.remove('hidden');
    $('me').replaceChildren(avatar(S.me.username), el('b', null, S.me.username), S.me.isAdmin ? el('span', 'badge', 'admin') : '');
    $('me').querySelector('.av').style.cssText += 'width:26px;height:26px;font-size:12px';
    $('btnAdmin').classList.toggle('hidden', !S.me.isAdmin);
    await Promise.all([loadChannels(), loadUsers()]);
    const last = store.get('conv', null);
    const valid = last && (S.channels.some(c => 'c:' + c.id === last) || S.users.some(u => u.id !== S.me.id && dmId(u.id, S.me.id) === last));
    openConv(valid ? last : 'c:' + S.channels[0].id);
    connectEvents();
  }

  async function loadChannels() { S.channels = await api('/api/channels'); renderSidebar(); }
  async function loadUsers() { S.users = await api('/api/users'); S.users.forEach(u => u.online && S.online.add(u.id)); renderSidebar(); }

  function renderSidebar() {
    if (!S.me) return;
    const cl = $('channelList'); cl.replaceChildren();
    for (const c of S.channels) {
      const id = 'c:' + c.id;
      const li = el('li', S.conv === id ? 'active' : '');
      li.append(el('span', null, '#'), el('span', 'name', c.name));
      if (S.unread[id]) li.append(el('span', 'badge', String(S.unread[id])));
      li.onclick = () => openConv(id);
      cl.append(li);
    }
    const ul = $('userList'); ul.replaceChildren();
    const others = S.users.filter(u => u.id !== S.me.id)
      .sort((a, b) => (S.online.has(b.id) - S.online.has(a.id)) || a.username.localeCompare(b.username));
    if (!others.length) ul.append(el('li', null, 'No other members yet'));
    for (const u of others) {
      const id = dmId(u.id, S.me.id);
      const li = el('li', S.conv === id ? 'active' : '');
      li.append(el('span', 'dot' + (S.online.has(u.id) ? ' on' : '')), el('span', 'name', u.username));
      if (S.unread[id]) li.append(el('span', 'badge', String(S.unread[id])));
      li.onclick = () => openConv(id);
      ul.append(li);
    }
    const total = Object.values(S.unread).reduce((a, b) => a + b, 0);
    document.title = (total ? `(${total}) ` : '') + 'Zien Call';
  }

  function convInfo(id) {
    if (id.startsWith('c:')) {
      const c = S.channels.find(x => 'c:' + x.id === id);
      return { title: c ? '#' + c.name : '#?', sub: 'Channel · everyone' };
    }
    const [a, b] = id.slice(2).split('-').map(Number);
    const other = S.users.find(u => u.id === (a === S.me.id ? b : a));
    return { title: other ? other.username : 'Unknown', sub: other && S.online.has(other.id) ? 'Online' : 'Offline', otherId: other && other.id };
  }
  function renderHeader() {
    const i = convInfo(S.conv);
    $('convTitle').textContent = i.title; $('convSub').textContent = i.sub;
  }

  async function openConv(id) {
    S.conv = id; store.set('conv', id); delete S.unread[id];
    closeSide(); renderSidebar(); renderHeader();
    $('msgList').replaceChildren(el('p', 'empty', 'Loading…'));
    try {
      const msgs = await api('/api/messages?conv=' + encodeURIComponent(id));
      if (S.conv !== id) return;
      $('msgList').replaceChildren();
      S.oldest = msgs.length ? msgs[0].id : null;
      $('older').classList.toggle('hidden', msgs.length < 50);
      if (!msgs.length) $('msgList').append(el('p', 'empty', 'No messages yet. Say hi 👋'));
      msgs.forEach(m => appendMsg(m));
      scrollBottom(true);
    } catch (e) { $('msgList').replaceChildren(el('p', 'empty', e.message)); }
    if (matchMedia('(min-width: 761px)').matches) $('msgInput').focus();
  }

  $('loadOlder').onclick = async () => {
    if (!S.oldest) return;
    const box = $('messages'), prevH = box.scrollHeight;
    const msgs = await api('/api/messages?conv=' + encodeURIComponent(S.conv) + '&before=' + S.oldest);
    const frag = document.createDocumentFragment();
    let prev = null;
    msgs.forEach(m => { frag.append(...msgNodes(m, prev)); prev = m; });
    $('msgList').prepend(frag);
    if (msgs.length) S.oldest = msgs[0].id;
    $('older').classList.toggle('hidden', msgs.length < 50);
    box.scrollTop = box.scrollHeight - prevH;
  };

  const dayKey = t => new Date(t).toDateString();
  function linkify(parent, text) {
    const re = /(https?:\/\/[^\s<>"']+)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const a = el('a', null, m[0]); a.href = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer';
      parent.append(a); last = m.index + m[0].length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }
  function msgNodes(m, prev) {
    const out = [];
    if (!prev || dayKey(prev.created) !== dayKey(m.created)) {
      const d = new Date(m.created);
      out.push(el('div', 'day', d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })));
    }
    const cont = prev && prev.userId === m.userId && m.created - prev.created < 5 * 60000 && dayKey(prev.created) === dayKey(m.created);
    const row = el('div', 'm' + (cont ? ' cont' : ''));
    row.dataset.uid = m.userId; row.dataset.t = m.created;
    const body = el('div', 'body');
    if (!cont) {
      const who = el('div', 'who', m.username);
      who.append(el('span', 'when', new Date(m.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
      body.append(who);
    }
    const txt = el('div', 'txt'); linkify(txt, m.body); body.append(txt);
    row.append(avatar(m.username), body);
    out.push(row);
    return out;
  }
  function appendMsg(m) {
    const list = $('msgList');
    const empty = list.querySelector('.empty'); if (empty) empty.remove();
    const lastRow = [...list.querySelectorAll('.m')].pop();
    const prev = lastRow ? { userId: Number(lastRow.dataset.uid), created: Number(lastRow.dataset.t) } : null;
    list.append(...msgNodes(m, prev));
  }
  function scrollBottom(force) {
    const box = $('messages');
    if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
  }

  // composer
  const input = $('msgInput');
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', async e => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    $('sendBtn').disabled = true;
    try { await api('/api/messages', { conv: S.conv, body }); input.value = ''; input.style.height = 'auto'; }
    catch (err) { alert(err.message); }
    finally { $('sendBtn').disabled = false; input.focus(); }
  });

  // events
  let esOpenedBefore = false;
  function connectEvents() {
    if (S.es) S.es.close();
    const es = new EventSource('/api/events');
    S.es = es;
    es.onopen = () => { if (esOpenedBefore && S.conv) openConv(S.conv); esOpenedBefore = true; };
    es.onerror = async () => {
      if (es.readyState === EventSource.CLOSED) {
        try { await api('/api/me'); setTimeout(connectEvents, 3000); } catch (e) { if (e.status === 401) showAuth(); else setTimeout(connectEvents, 5000); }
      }
    };
    es.onmessage = ev => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type === 'message') {
        const m = d.msg;
        if (m.conv === S.conv) { appendMsg(m); scrollBottom(m.userId === S.me.id); }
        else if (m.userId !== S.me.id) { S.unread[m.conv] = (S.unread[m.conv] || 0) + 1; renderSidebar(); }
      } else if (d.type === 'presence') {
        S.online = new Set(d.online); renderSidebar(); if (S.conv) renderHeader();
      } else if (d.type === 'channels') {
        loadChannels().then(() => { if (S.conv.startsWith('c:') && !S.channels.some(c => 'c:' + c.id === S.conv)) openConv('c:' + S.channels[0].id); });
      } else if (d.type === 'users') {
        loadUsers().then(() => {
          // the person in the open private chat was deleted
          if (S.conv && S.conv.startsWith('d:') && !convInfo(S.conv).otherId) openConv('c:' + S.channels[0].id);
        }).catch(() => {});
      } else if (d.type === 'call') {
        if (d.fromId !== S.me.id && S.callConv !== d.conv) showRing(d);
      }
    };
  }

  // sidebar on mobile
  function openSide() { $('sidebar').classList.add('open'); $('scrim').classList.remove('hidden'); }
  function closeSide() { $('sidebar').classList.remove('open'); $('scrim').classList.add('hidden'); }
  $('openSide').onclick = openSide; $('closeSide').onclick = closeSide; $('scrim').onclick = closeSide;

  $('addChannel').onclick = () => { $('fChannel').reset(); $('chanMsg').textContent = ''; $('dlgChannel').showModal(); };
  $('fChannel').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('fChannel').querySelector('input[name="name"]').value.trim().toLowerCase();
    try { const c = await api('/api/channels', { name }); $('dlgChannel').close(); await loadChannels(); openConv('c:' + c.id); }
    catch (err) { $('chanMsg').textContent = err.message; }
  });

  // settings & admin
  document.querySelectorAll('dialog [data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
  $('optRelay').checked = store.get('relay', false);
  $('optSound').checked = store.get('sound', true);
  $('optRelay').onchange = () => store.set('relay', $('optRelay').checked);
  $('optSound').onchange = () => store.set('sound', $('optSound').checked);
  $('btnSettings').onclick = () => $('dlgSettings').showModal();
  $('btnLogout').onclick = async () => { $('dlgSettings').close(); await leaveCall(); try { await api('/api/logout', {}); } catch { /* ignore */ } S.me = null; showAuth(); };

  $('btnAdmin').onclick = () => { location.href = '/admin'; };

  $('fPassword').addEventListener('submit', async e => {
    e.preventDefault();
    const f = $('fPassword'), msg = $('pwMsg');
    const current = f.querySelector('input[name="current"]').value, password = f.querySelector('input[name="password"]').value;
    msg.classList.remove('ok'); msg.textContent = '';
    try { await api('/api/password', { current, password }); f.reset(); msg.textContent = 'Password changed. Other devices were signed out.'; msg.classList.add('ok'); }
    catch (err) { msg.textContent = err.message; }
  });

  // ================= PING =================
  // Round-trip time to the server, shown next to the logo, in the mobile top bar and during calls.
  async function measurePing() {
    if (document.hidden) return;
    const badges = ['ping', 'pingTop', 'callPing'].map($).filter(Boolean);
    let text = 'offline', cls = 'ping off';
    try {
      const t0 = performance.now();
      const r = await fetch('/api/ping', { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) throw new Error();
      const ms = Math.round(performance.now() - t0);
      text = ms + ' ms'; cls = 'ping ' + (ms < 150 ? 'good' : ms < 350 ? 'ok' : 'bad');
    } catch { /* offline */ }
    for (const b of badges) { b.className = cls + (b.id === 'pingTop' ? ' mobile-only' : ''); b.lastChild.textContent = text; }
  }
  setInterval(measurePing, 5000);
  document.addEventListener('visibilitychange', measurePing);
  measurePing();

  // ================= CALLS =================
  const SVG = b => '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + b + '</svg>';
  const ICON = {
    mic: SVG('<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'),
    micOff: SVG('<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'),
  };
  let ringTimer = null, ringAudio = null;
  function showRing(d) {
    S.ringConv = d;
    $('ringFrom').textContent = d.conv.startsWith('d:') ? `${d.from} is calling you` : `${d.from} started a call in ${d.title}`;
    $('ringWhat').textContent = d.video ? 'Video call' : 'Audio call';
    $('ring').classList.remove('hidden');
    startRingSound();
    if (navigator.vibrate) navigator.vibrate([300, 200, 300]);
    clearTimeout(ringTimer); ringTimer = setTimeout(hideRing, 45000);
  }
  function hideRing() { $('ring').classList.add('hidden'); stopRingSound(); S.ringConv = null; }
  function startRingSound() {
    if (!store.get('sound', true)) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const beep = () => {
        [0, 0.25].forEach(off => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.value = 660; g.gain.setValueAtTime(0.0001, ctx.currentTime + off);
          g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + off + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + off + 0.2);
          o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + off); o.stop(ctx.currentTime + off + 0.22);
        });
      };
      beep(); ringAudio = { ctx, int: setInterval(beep, 2000) };
    } catch { /* audio blocked */ }
  }
  function stopRingSound() { if (ringAudio) { clearInterval(ringAudio.int); ringAudio.ctx.close(); ringAudio = null; } }
  $('ringDismiss').onclick = hideRing;
  $('ringJoin').onclick = () => { const d = S.ringConv; hideRing(); if (d) { if (S.conv !== d.conv) openConv(d.conv); joinCall(d.conv, d.video); } };

  $('btnAudio').onclick = () => joinCall(S.conv, false);
  $('btnVideo').onclick = () => joinCall(S.conv, true);

  const tiles = new Map();
  function tile(identity, isLocal) {
    let t = tiles.get(identity);
    if (!t) {
      t = el('div', 'tile' + (isLocal ? ' local' : ''));
      t.append(avatar(identity), el('div', 'label', identity + (isLocal ? ' (you)' : '')));
      tiles.set(identity, t);
      isLocal ? $('grid').prepend(t) : $('grid').append(t);
    }
    return t;
  }
  function removeTile(identity) { const t = tiles.get(identity); if (t) { t.remove(); tiles.delete(identity); } }
  function attachTrack(track, identity, isLocal) {
    if (track.kind === 'video') {
      const t = tile(identity, isLocal);
      t.querySelectorAll('video').forEach(v => v.remove());
      const v = track.attach(); v.playsInline = true; if (isLocal) v.muted = true;
      t.prepend(v);
    } else if (track.kind === 'audio' && !isLocal) {
      const a = track.attach(); $('audios').append(a);
    }
  }
  function detachTrack(track) { track.detach().forEach(e => e.remove()); }
  function setCallState(t) { $('callState').textContent = t; }
  function updateCallButtons() {
    const lp = S.room && S.room.localParticipant; if (!lp) return;
    $('cMic').classList.toggle('off', !lp.isMicrophoneEnabled);
    $('cMic').innerHTML = lp.isMicrophoneEnabled ? ICON.mic : ICON.micOff;   // static SVG strings
    $('cMic').title = lp.isMicrophoneEnabled ? 'Mute' : 'Unmute';
    $('cCam').classList.toggle('off', !lp.isCameraEnabled);
    $('cFlip').classList.toggle('hidden', !lp.isCameraEnabled);
  }
  function updateCount() { if (S.room) setCallState(`${S.room.remoteParticipants.size + 1} in call`); }

  // ---- keeping calls alive when the app or tab goes to the background ----
  // Android app: a native foreground service (CallService plugin) keeps the mic + network alive.
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  function nativeCall(method, data) {
    if (!isNative || !window.Capacitor.nativePromise) return Promise.resolve();
    return window.Capacitor.nativePromise('CallService', method, data || {}).catch(e => console.warn('CallService.' + method, e));
  }
  if (isNative && window.Capacitor.addListener) {
    try { window.Capacitor.addListener('CallService', 'hangup', () => leaveCall()); } catch (e) { console.warn(e); }
  }
  // Mobile Chrome "freezes" background tabs and LiveKit hangs up on that event: swallow it during calls.
  window.addEventListener('freeze', e => { if (S.call) e.stopImmediatePropagation(); }, true);
  // Real page unloads (not app switching) still end the call cleanly.
  window.addEventListener('pagehide', e => { if (!e.persisted && S.room) S.room.disconnect(); });
  window.addEventListener('beforeunload', () => { if (S.room) S.room.disconnect(); });

  let wakeLock = null;
  async function keepScreenOn() {
    try {
      if (S.call && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { wakeLock = null; }
  }
  function releaseScreen() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
  function setMediaSession(title) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = title ? new MediaMetadata({ title: 'In call · ' + title, artist: 'Zien Call', artwork: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] }) : null;
      navigator.mediaSession.playbackState = title ? 'playing' : 'none';
      for (const [action, fn] of [['hangup', () => leaveCall()], ['togglemicrophone', () => $('cMic').click()], ['togglecamera', () => $('cCam').click()]]) {
        try { navigator.mediaSession.setActionHandler(action, title ? fn : null); } catch { /* action not supported */ }
      }
    } catch { /* ignore */ }
  }
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !S.call) return;
    keepScreenOn();
    if (!S.room) return rejoinNow();
    // background capture may have been stopped by the OS: switch mic/camera back on if they should be on
    const lp = S.room.localParticipant;
    try { if (S.call.mic && !lp.isMicrophoneEnabled) await lp.setMicrophoneEnabled(true); } catch { /* ignore */ }
    try { if (S.call.cam && !lp.isCameraEnabled) await lp.setCameraEnabled(true); } catch { /* ignore */ }
    updateCallButtons();
  });
  window.addEventListener('online', () => { if (S.call && !S.room) rejoinNow(); });

  // ---- calls ----
  async function joinCall(conv, video) {
    if (!LK || !LK.Room) return alert('Calling library failed to load. Refresh the page.');
    if (S.call) { if (S.call.conv === conv) { $('call').classList.remove('hidden'); return; } endCall(); }
    hideRing();
    S.call = { conv, video: !!video, mic: true, cam: !!video, attempts: 0, timer: null, title: convInfo(conv).title };
    S.callConv = conv;
    $('call').classList.remove('hidden'); $('grid').replaceChildren(); $('audios').replaceChildren(); tiles.clear();
    $('callTitle').textContent = S.call.title;
    if (!(await connectCall(true)) && S.call && !S.room) endCall();
  }

  // Connects (or reconnects) the current call. Returns true when connected.
  async function connectCall(first) {
    const c = S.call; if (!c) return false;
    setCallState(first ? 'Connecting…' : 'Reconnecting…');
    let data;
    try { data = await api('/api/call', { conv: c.conv, video: c.video, rejoin: !first }); }
    catch (e) { if (first) alert(e.message); else if (e.status === 401 || e.status === 404) endCall('The call ended: ' + e.message); return false; }
    if (S.call !== c) return false;
    const room = new LK.Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: false, videoCaptureDefaults: { resolution: LK.VideoPresets.h540.resolution } });
    let live = false;
    const E = LK.RoomEvent;
    room
      .on(E.TrackSubscribed, (track, _pub, p) => attachTrack(track, p.identity, false))
      .on(E.TrackUnsubscribed, track => detachTrack(track))
      .on(E.LocalTrackPublished, pub => { if (pub.track) attachTrack(pub.track, room.localParticipant.identity, true); updateCallButtons(); })
      .on(E.LocalTrackUnpublished, pub => { if (pub.track) detachTrack(pub.track); updateCallButtons(); })
      .on(E.TrackMuted, (pub, p) => { if (p === room.localParticipant) updateCallButtons(); })
      .on(E.TrackUnmuted, (pub, p) => { if (p === room.localParticipant) updateCallButtons(); })
      .on(E.ParticipantConnected, p => { tile(p.identity, false); updateCount(); })
      .on(E.ParticipantDisconnected, p => { removeTile(p.identity); updateCount(); })
      .on(E.ActiveSpeakersChanged, speakers => {
        const ids = new Set(speakers.map(sp => sp.identity));
        tiles.forEach((t, id) => t.classList.toggle('speaking', ids.has(id)));
      })
      .on(E.Reconnecting, () => setCallState('Reconnecting…'))
      .on(E.Reconnected, updateCount)
      .on(E.Disconnected, reason => { if (live && S.room === room) { S.room = null; onCallDropped(reason); } });
    S.room = room;
    try {
      const opts = {};
      if (store.get('relay', false)) opts.rtcConfig = { iceTransportPolicy: 'relay' };
      await room.connect(data.url, data.token, opts);
      if (S.call !== c || S.room !== room) { room.disconnect(); return false; }
      live = true;
      $('grid').replaceChildren(); $('audios').replaceChildren(); tiles.clear();
      tile(room.localParticipant.identity, true);
      room.remoteParticipants.forEach(p => { tile(p.identity, false); p.trackPublications.forEach(pub => { if (pub.track && pub.isSubscribed) attachTrack(pub.track, p.identity, false); }); });
      updateCount();
      await room.startAudio().catch(() => {});
      if (c.mic) { try { await room.localParticipant.setMicrophoneEnabled(true); } catch (e) { if (first) alert('Microphone blocked: ' + e.message); } }
      if (c.cam) { try { await room.localParticipant.setCameraEnabled(true); } catch (e) { if (first) alert('Camera blocked: ' + e.message); } }
      c.attempts = 0;
      updateCallButtons(); setMediaSession(c.title); keepScreenOn();
      nativeCall('start', { title: c.title, video: room.localParticipant.isCameraEnabled });
      return true;
    } catch (e) {
      console.error(e);
      if (S.room === room) S.room = null;
      room.disconnect().catch(() => {});
      if (first) alert('Could not connect: ' + (e.message || e) + (store.get('relay', false) ? '' : '\n\nTip: turn on "Force port-443 relay" in Settings and try again.'));
      return false;
    }
  }

  function onCallDropped(reason) {
    const R = LK.DisconnectReason || {};
    if (!S.call || reason === R.CLIENT_INITIATED) return endCall();
    if (reason === R.DUPLICATE_IDENTITY) return endCall('You joined this call from another device, so it ended here.');
    if (reason === R.PARTICIPANT_REMOVED || reason === R.ROOM_DELETED) return endCall('You were removed from the call.');
    setCallState('Connection lost · reconnecting…');
    rejoinSoon();
  }
  function rejoinSoon(delay) {
    const c = S.call; if (!c || c.timer || S.room) return;
    if (delay === undefined) delay = Math.min(15000, 1000 * 2 ** Math.min(c.attempts, 4));
    c.timer = setTimeout(async () => {
      c.timer = null;
      if (S.call !== c || S.room) return;
      if (!navigator.onLine) { setCallState('Offline · waiting for network…'); return; }   // the 'online' event retries
      if (++c.attempts > 15) return endCall('The call dropped and could not reconnect.');
      if (!(await connectCall(false)) && S.call === c && !S.room) { setCallState('Reconnecting… (try ' + c.attempts + ')'); rejoinSoon(); }
    }, delay);
  }
  function rejoinNow() { const c = S.call; if (!c || S.room) return; if (c.timer) { clearTimeout(c.timer); c.timer = null; } rejoinSoon(0); }

  function cleanupCall() {
    $('call').classList.add('hidden'); $('grid').replaceChildren(); $('audios').replaceChildren(); tiles.clear();
  }
  function endCall(message) {
    const c = S.call; S.call = null; S.callConv = null;
    if (c && c.timer) clearTimeout(c.timer);
    const r = S.room; S.room = null;
    if (r) r.disconnect().catch(() => {});
    cleanupCall(); setMediaSession(null); releaseScreen(); nativeCall('stop');
    if (message) alert(message);
  }
  async function leaveCall() { endCall(); }

  $('cLeave').onclick = leaveCall;
  $('cMic').onclick = async () => {
    if (!S.room) return;
    const lp = S.room.localParticipant;
    try { await lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled); } catch (e) { alert('Microphone: ' + e.message); }
    if (S.call) S.call.mic = lp.isMicrophoneEnabled;
    updateCallButtons();
  };
  $('cCam').onclick = async () => {
    if (!S.room) return;
    const lp = S.room.localParticipant;
    try { await lp.setCameraEnabled(!lp.isCameraEnabled); } catch (e) { alert('Camera: ' + e.message); }
    if (!lp.isCameraEnabled) { const t = tiles.get(lp.identity); if (t) t.querySelectorAll('video').forEach(v => v.remove()); }
    if (S.call) { S.call.cam = lp.isCameraEnabled; nativeCall('start', { title: S.call.title, video: lp.isCameraEnabled }); }
    updateCallButtons();
  };
  let facing = 'user';
  $('cFlip').onclick = async () => {
    if (!S.room) return;
    const pub = S.room.localParticipant.getTrackPublication(LK.Track.Source.Camera);
    if (!pub || !pub.track) return;
    facing = facing === 'user' ? 'environment' : 'user';
    try { await pub.track.restartTrack({ facingMode: facing }); } catch (e) { alert('Could not switch camera: ' + e.message); }
    const t = tiles.get(S.room.localParticipant.identity); if (t) t.classList.toggle('local', facing === 'user');
  };

  // ================= BOOT =================
  api('/api/config').then(c => {
    $('apkLink').hidden = !c.apk || /ZienCallApp/.test(navigator.userAgent);
    $('signupOff').hidden = c.signup;
    $('fSignup').querySelector('button.primary').disabled = !c.signup;
  }).catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  start();
})();
