// Zien Call admin dashboard — Built by Zien Technologies, a vision of Zien Organisation.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const FREE_EGRESS = 10 * 1024 ** 4;   // Oracle Always Free: 10 TB outbound / month
  const FREE_BLOCK = 200 * 1024 ** 3;   // Oracle Always Free: 200 GB block volume total

  async function api(path, body, method) {
    const opts = { method: method || (body ? 'POST' : 'GET'), credentials: 'same-origin', headers: {} };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(path, opts);
    let d = {}; try { d = await r.json(); } catch { /* empty */ }
    if (!r.ok) { const e = new Error(d.error || 'Request failed'); e.status = r.status; throw e; }
    return d;
  }
  function bytes(n) {
    if (n == null) return '–';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
  }
  const rate = n => bytes(n) + '/s';
  const pct = n => (n == null || isNaN(n) ? '–' : (n < 10 ? n.toFixed(1) : Math.round(n)) + '%');
  function dur(s) {
    s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }
  function setBar(id, p) {
    const b = $(id); b.style.width = Math.min(100, Math.max(0, p || 0)) + '%';
    b.className = p >= 90 ? 'bad' : p >= 75 ? 'warn' : '';
  }
  function colorFor(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; }

  const NS = 'http://www.w3.org/2000/svg';
  function chart(svg, series, max) {
    svg.replaceChildren();
    const W = 600, H = 120;
    for (const y of [0.25, 0.5, 0.75]) {
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', 0); l.setAttribute('x2', W); l.setAttribute('y1', H * y); l.setAttribute('y2', H * y);
      l.setAttribute('stroke', '#2a303b'); l.setAttribute('stroke-width', 1); l.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(l);
    }
    for (const s of series) {
      if (s.data.length < 2) continue;
      const n = s.data.length;
      const pts = s.data.map((v, i) => `${(i / (n - 1)) * W},${H - Math.min(1, (v || 0) / max) * (H - 4) - 2}`).join(' ');
      const p = document.createElementNS(NS, 'polyline');
      p.setAttribute('points', pts); p.setAttribute('fill', 'none'); p.setAttribute('stroke', s.color);
      p.setAttribute('stroke-width', 2); p.setAttribute('vector-effect', 'non-scaling-stroke'); p.setAttribute('stroke-linejoin', 'round');
      svg.append(p);
    }
    if (!series.some(s => s.data.length >= 2)) {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', W / 2); t.setAttribute('y', H / 2); t.setAttribute('fill', '#8b93a1'); t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', 14);
      t.textContent = 'Collecting data (one point per minute)…'; svg.append(t);
    }
  }
  function p95(arr) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; }

  function renderHost(h) {
    if (!h) return;
    const o = h.oci;
    if (o) {
      $('hostName').textContent = `Oracle Cloud · ${o.name}`;
      $('hostSub').textContent = `${o.shape} · ${o.ocpus} OCPU · ${o.memoryGB} GB RAM · ${o.bandwidthGbps} Gbps · ${o.region} (${(o.availabilityDomain || '').split(':').pop()}) · ${h.cpuModel || ''}`;
      $('hostTag').className = 'tag ' + (o.alwaysFree ? 'ok' : 'warn');
      $('hostTag').textContent = o.alwaysFree ? 'Always Free shape' : 'Paid shape';
    } else {
      $('hostName').textContent = `Server: ${h.hostname || 'unknown'}`;
      $('hostSub').textContent = [h.cpuModel, h.kernel && 'Linux ' + h.kernel].filter(Boolean).join(' · ');
      $('hostTag').className = 'tag warn'; $('hostTag').textContent = 'Not on Oracle Cloud';
      $('hostNote').textContent = 'The Oracle metadata service did not answer, so this is not the Oracle VM (for example a local test copy).';
    }
  }

  function render(d) {
    const s = d.system, a = d.app;
    renderHost(d.host);
    if (s) {
      $('cpu').textContent = pct(s.cpu);
      $('cpuSub').textContent = `steal ${pct(s.steal)} · iowait ${pct(s.iowait)}`;
      setBar('cpuBar', s.cpu);
      if (s.mem) {
        const rp = s.mem.used / s.mem.total * 100;
        $('ram').textContent = pct(rp); $('ramSub').textContent = `${bytes(s.mem.used)} of ${bytes(s.mem.total)} · ${bytes(s.mem.available)} free`; setBar('ramBar', rp);
        const sp = s.mem.swapTotal ? s.mem.swapUsed / s.mem.swapTotal * 100 : 0;
        $('swap').textContent = s.mem.swapTotal ? pct(sp) : 'off'; $('swapSub').textContent = `${bytes(s.mem.swapUsed)} of ${bytes(s.mem.swapTotal)}`; setBar('swapBar', sp);
      }
      if (s.disk) {
        const dp = s.disk.used / s.disk.total * 100;
        $('disk').textContent = pct(dp); $('diskSub').textContent = `${bytes(s.disk.used)} of ${bytes(s.disk.total)} · ${bytes(s.disk.free)} free`; setBar('diskBar', dp);
      }
      if (s.net) { $('net').textContent = '↓ ' + rate(s.net.rxRate); $('netSub').textContent = `↑ ${rate(s.net.txRate)} · ${s.net.iface}`; }
      $('load').textContent = s.load.map(x => x.toFixed(2)).join(' ');
      $('upSub').textContent = `server up ${dur(s.uptime)} · app up ${dur(s.node.uptime)}`;

      const tb = $('conts'); tb.replaceChildren();
      for (const c of s.containers) {
        const tr = el('tr');
        tr.append(el('td', null, c.name), el('td', 'r', pct(c.cpu)), el('td', 'r', bytes(c.mem)), el('td', 'r', bytes(c.swap)));
        tb.append(tr);
      }
      if (!s.containers.length) { const tr = el('tr'); const td = el('td', 'muted', 'Container stats not available'); td.colSpan = 4; tr.append(td); tb.append(tr); }
      $('nodeInfo').textContent = `Web app process: ${bytes(s.node.rss)} RSS, ${bytes(s.node.heap)} heap`;
    }

    $('aOnline').textContent = a.online; $('aCalls').textContent = a.inCalls;
    $('aUsers').textContent = `${a.members}/${a.maxUsers} members + ${a.admins} admin${a.admins === 1 ? '' : 's'}`;
    $('aMsgs').textContent = `${a.messages24h} / ${a.messages}`; $('aSignups').textContent = a.signups24h;
    $('aDb').textContent = bytes(a.dbBytes);
    $('aEmail').replaceChildren(el('span', 'tag ' + (a.emailReady ? 'ok' : 'warn'), a.emailReady ? 'Resend ready' : 'Not configured'));
    $('mailTag').className = 'tag ' + (a.emailReady ? 'ok' : 'warn');
    $('mailTag').textContent = a.emailReady ? 'ready' : 'not configured';
    $('mailInfo').textContent = a.emailReady
      ? `Codes are sent from ${a.mailFrom}. Send yourself a test to confirm the domain is verified in Resend.`
      : 'Add RESEND_API_KEY and MAIL_FROM on the server (run set-resend-key.sh). Until then, create members with "Add member" below.';
    $('fMail').querySelector('button').disabled = !a.emailReady;
    $('aOnlineNames').textContent = a.onlineNames.length ? 'Online: ' + a.onlineNames.join(', ') : 'Nobody online';
    const rooms = $('rooms'); rooms.replaceChildren();
    for (const r of a.rooms.filter(r => r.participants)) rooms.append(el('div', 'tag', `📞 ${r.label}: ${r.participants}`), ' ');

    // free tier checks
    const free = $('free'); free.replaceChildren();
    const item = (cls, label, text) => { const li = el('li'); li.append(el('span', 'tag ' + cls, label), ' ' + text); free.append(li); };
    const o = d.host && d.host.oci;
    if (o) item(o.alwaysFree ? 'ok' : 'bad', o.shape, o.alwaysFree ? 'is an Always Free shape' : 'is NOT an Always Free shape');
    if (s) {
      const eg = s.traffic.tx / FREE_EGRESS * 100;
      item(eg < 50 ? 'ok' : eg < 90 ? 'warn' : 'bad', pct(eg), `outbound traffic this month: ${bytes(s.traffic.tx)} of 10 TB free (in: ${bytes(s.traffic.rx)})`);
      if (s.disk) item(s.disk.total <= FREE_BLOCK ? 'ok' : 'bad', bytes(s.disk.total), 'boot volume, within the 200 GB free block storage');
      const hist = window.__hist || [];
      if (hist.length >= 60) {
        const c95 = p95(hist.map(h => h.cpu));
        item(c95 >= 20 ? 'ok' : 'warn', 'CPU p95 ' + pct(c95),
          c95 >= 20 ? 'above Oracle\'s idle threshold' :
          'below 20%. Oracle\'s docs say idle Always Free VMs (CPU and network both low over 7 days) can be reclaimed. Converting the account to Pay-As-You-Go keeps Always Free resources at $0 and isn\'t subject to that.');
      } else {
        item('ok', 'idle check', `needs 1 hour of history (${hist.length}/60 min collected)`);
      }
    }
    item('ok', '$0', 'Self-hosted LiveKit, Caddy + Let\'s Encrypt TLS, Cloudflare DNS (free), Resend free tier (3,000 emails/month, 100/day)');
  }

  function renderHistory(h) {
    window.__hist = h;
    chart($('chartRes'), [
      { data: h.map(x => x.cpu), color: '#8b7dff' }, { data: h.map(x => x.mem), color: '#22c55e' },
      { data: h.map(x => x.swap), color: '#f59e0b' }, { data: h.map(x => x.steal), color: '#ef4444' },
    ], 100);
    const max = Math.max(1024, ...h.map(x => Math.max(x.rx, x.tx)));
    chart($('chartNet'), [{ data: h.map(x => x.rx), color: '#38bdf8' }, { data: h.map(x => x.tx), color: '#f472b6' }], max);
    $('netMax').textContent = 'top of chart: ' + rate(max);
  }

  // ---------- members ----------
  let me = null, passTarget = null;
  async function renderMembers() {
    const d = await api('/api/admin/users');
    $('memberCount').textContent = `${d.members}/${d.max} members · ${d.admins} admin${d.admins === 1 ? '' : 's'}`;
    $('memberCount').className = 'tag ' + (d.members >= d.max ? 'warn' : 'ok');
    const full = d.members >= d.max;
    const isAdminBox = $('fAdd').querySelector('input[name="isAdmin"]');
    $('fAdd').querySelector('button.primary').disabled = full && !isAdminBox.checked;
    $('addMsg').classList.remove('ok');
    const limitMsg = `Member limit reached (${d.max}). Delete a member to add another, or tick Admin.`;
    if (full && !isAdminBox.checked && !$('addMsg').classList.contains('ok')) $('addMsg').textContent = limitMsg;
    else if ($('addMsg').textContent === limitMsg) $('addMsg').textContent = '';

    const ul = $('members'); ul.replaceChildren();
    for (const u of d.users) {
      const li = el('li'); const info = el('div', 'info');
      const av = el('div', 'av', u.username[0].toUpperCase()); av.style.background = colorFor(u.username);
      const name = el('b', null, u.username + (u.isAdmin ? ' · admin' : '') + (u.id === me.id ? ' (you)' : ''));
      if (u.online) name.append(el('span', 'on-dot'));
      info.append(name, el('small', null, (u.email || 'no email') + ' · joined ' + new Date(u.created).toLocaleDateString()));
      li.append(av, info);
      const acts = el('div', 'acts');
      const bPass = el('button', 'ghost', 'Reset password');
      bPass.onclick = () => { passTarget = u; $('passUser').textContent = u.username; $('fPass').reset(); $('passMsg').textContent = ''; $('dlgPass').showModal(); };
      acts.append(bPass);
      if (u.id !== me.id) {
        const bRole = el('button', 'ghost', u.isAdmin ? 'Remove admin' : 'Make admin');
        bRole.onclick = async () => {
          if (!confirm(u.isAdmin ? `Remove admin rights from ${u.username}? They will count as a member.` : `Make ${u.username} an admin? They can then manage all members and see server stats.`)) return;
          try { await api(`/api/admin/users/${u.id}/admin`, { isAdmin: !u.isAdmin }); renderMembers(); } catch (e) { alert(e.message); }
        };
        const bDel = el('button', 'ghost danger', 'Delete');
        bDel.onclick = async () => {
          if (!confirm(`Delete ${u.username} permanently? Their account, messages and private chats are removed. This can't be undone.`)) return;
          try { await api('/api/admin/users/' + u.id, null, 'DELETE'); renderMembers(); } catch (e) { alert(e.message); }
        };
        acts.append(bRole, bDel);
      }
      li.append(acts);
      ul.append(li);
    }

    const chans = await api('/api/channels');
    const cl = $('chans'); cl.replaceChildren();
    for (const c of chans) {
      const li = el('li'); li.append(el('span', null, '#' + c.name));
      if (chans.length > 1) {
        const b = el('button', 'ghost', 'Delete');
        b.onclick = async () => {
          if (!confirm(`Delete #${c.name} and all its messages?`)) return;
          try { await api('/api/channels/' + c.id, null, 'DELETE'); renderMembers(); } catch (e) { alert(e.message); }
        };
        li.append(b);
      }
      cl.append(li);
    }
  }

  $('fAdd').querySelector('input[name="isAdmin"]').onchange = () => renderMembers().catch(() => {});
  $('fAdd').addEventListener('submit', async e => {
    e.preventDefault();
    const f = $('fAdd'), btn = f.querySelector('button.primary');
    const data = Object.fromEntries(new FormData(f));
    data.isAdmin = f.querySelector('input[name="isAdmin"]').checked;
    btn.disabled = true; $('addMsg').textContent = '';
    try {
      const r = await api('/api/admin/users', data);
      f.reset();
      $('addMsg').textContent = `Added ${r.username}. Share the username and password with them.`; $('addMsg').classList.add('ok');
    } catch (err) { $('addMsg').textContent = err.message; $('addMsg').classList.remove('ok'); }
    btn.disabled = false;
    renderMembers().catch(() => {});
  });
  $('fPass').addEventListener('submit', async e => {
    e.preventDefault();
    const password = $('fPass').querySelector('input[name="password"]').value;
    try { await api(`/api/admin/users/${passTarget.id}/password`, { password }); $('dlgPass').close(); $('addMsg').textContent = `Password for ${passTarget.username} changed.`; $('addMsg').classList.add('ok'); }
    catch (err) { $('passMsg').textContent = err.message; }
  });
  $('fMail').addEventListener('submit', async e => {
    e.preventDefault();
    const f = $('fMail'), btn = f.querySelector('button'), msg = $('mailMsg');
    btn.disabled = true; msg.classList.remove('ok'); msg.textContent = 'Sending…';
    try {
      const r = await api('/api/admin/test-email', { to: f.querySelector('input[name="to"]').value });
      msg.textContent = `Sent from ${r.from}. Check the inbox (and spam folder).`; msg.classList.add('ok');
    } catch (err) { msg.textContent = err.message; }
    btn.disabled = false;
  });
  document.querySelectorAll('dialog [data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());

  // ---------- ping ----------
  async function ping() {
    const t0 = performance.now();
    try {
      await fetch('/api/ping', { cache: 'no-store' });
      const ms = Math.round(performance.now() - t0);
      $('ping').className = 'ping ' + (ms < 150 ? 'good' : ms < 350 ? 'ok' : 'bad');
      $('ping').lastChild.textContent = ms + ' ms';
    } catch { $('ping').className = 'ping off'; $('ping').lastChild.textContent = 'offline'; }
  }

  let ticks = 0, timer = null;
  async function tick() {
    try {
      const withHist = ticks % 12 === 0;  // refresh 24h charts once a minute
      const d = await api('/api/admin/stats' + (withHist ? '?history=1' : ''));
      if (d.history) renderHistory(d.history);
      render(d);
      $('live').classList.remove('stale'); $('live').lastChild.textContent = 'Live · ' + new Date().toLocaleTimeString();
      if (ticks % 6 === 5) renderMembers().catch(() => {});   // keep online dots fresh
      ticks++;
    } catch (e) {
      if (e.status === 401 || e.status === 403) { $('root').classList.add('hidden'); $('denied').classList.remove('hidden'); clearInterval(timer); return; }
      $('live').classList.add('stale'); $('live').lastChild.textContent = 'Connection lost, retrying…';
    }
    ping();
  }

  (async function boot() {
    try {
      me = await api('/api/me');
      if (!me.isAdmin) throw Object.assign(new Error('no'), { status: 403 });
    } catch { $('denied').classList.remove('hidden'); return; }
    $('root').classList.remove('hidden');
    await tick(); renderMembers().catch(() => {});
    timer = setInterval(() => { if (!document.hidden) tick(); }, 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  })();
})();
