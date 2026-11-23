'use strict';
// Lightweight host + container monitoring from /proc and cgroup v2 files (no agents, no paid services).
// Built by Zien Technologies.
const fs = require('fs');
const path = require('path');

const HOST_CGROUP = process.env.HOST_CGROUP || '/host/cgroup';          // mount of /sys/fs/cgroup/system.slice
const HOST_CONTAINERS = process.env.HOST_CONTAINERS || '/host/containers'; // mount of /var/lib/docker/containers
const NET_IFACE = process.env.NET_IFACE || '';                          // auto-detect if empty
const SAMPLE_MS = 5000;
const HISTORY_POINTS = 24 * 60;  // 24h at 1-minute resolution

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

function cpuTimes() {
  const line = (read('/proc/stat') || '').split('\n')[0];
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  if (v.length < 8) return null;
  const [user, nice, system, idle, iowait, irq, softirq, steal] = v;
  return { idle: idle + iowait, steal, total: v.slice(0, 8).reduce((a, b) => a + b, 0), iowait };
}
function memInfo() {
  const out = {};
  for (const l of (read('/proc/meminfo') || '').split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(l);
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  if (!out.MemTotal) return null;
  return {
    total: out.MemTotal, available: out.MemAvailable, used: out.MemTotal - out.MemAvailable,
    swapTotal: out.SwapTotal || 0, swapUsed: (out.SwapTotal || 0) - (out.SwapFree || 0),
  };
}
function netBytes() {
  const lines = (read('/proc/net/dev') || '').split('\n').slice(2);
  let best = null;
  for (const l of lines) {
    const [name, rest] = l.split(':');
    if (!rest) continue;
    const iface = name.trim();
    if (iface === 'lo' || iface.startsWith('docker') || iface.startsWith('veth') || iface.startsWith('br-')) continue;
    if (NET_IFACE && iface !== NET_IFACE) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    const cur = { iface, rx: f[0], tx: f[8] };
    if (!best || cur.rx + cur.tx > best.rx + best.tx) best = cur;
  }
  return best;
}
function disk() {
  try {
    const s = fs.statfsSync('/');
    return { total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize, free: s.bavail * s.bsize };
  } catch { return null; }
}

const nameCache = new Map();
function containerName(id) {
  if (nameCache.has(id)) return nameCache.get(id);
  let name = id.slice(0, 12);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOST_CONTAINERS, id, 'config.v2.json'), 'utf8'));
    if (cfg.Name) name = cfg.Name.replace(/^\//, '').replace(/^private-call-/, '').replace(/-\d+$/, '');
  } catch { /* not mounted */ }
  nameCache.set(id, name);
  return name;
}
function containers() {
  let dirs;
  try { dirs = fs.readdirSync(HOST_CGROUP).filter(d => /^docker-[0-9a-f]{64}\.scope$/.test(d)); } catch { return []; }
  return dirs.map(d => {
    const id = d.slice(7, 71);
    const base = path.join(HOST_CGROUP, d);
    const usage = /usage_usec (\d+)/.exec(read(path.join(base, 'cpu.stat')) || '');
    const stat = read(path.join(base, 'memory.stat')) || '';
    const file = /^file (\d+)/m.exec(stat);
    const memCurrent = Number(read(path.join(base, 'memory.current')) || 0);
    return {
      id, name: containerName(id),
      cpuUsec: usage ? Number(usage[1]) : 0,
      // "working set" like docker stats: current minus page cache
      mem: Math.max(0, memCurrent - (file ? Number(file[1]) : 0)),
      swap: Number(read(path.join(base, 'memory.swap.current')) || 0),
    };
  });
}

function createMonitor({ db }) {
  db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  const kvGet = k => { const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? JSON.parse(r.v) : null; };
  const kvSet = (k, v) => db.prepare('INSERT OR REPLACE INTO kv(k, v) VALUES (?, ?)').run(k, JSON.stringify(v));

  let prevCpu = cpuTimes(), prevNet = netBytes(), prevT = Date.now();
  let prevCont = new Map(containers().map(c => [c.id, c.cpuUsec]));
  const month = () => new Date().toISOString().slice(0, 7);
  let traffic = kvGet('traffic') || { month: month(), rx: 0, tx: 0 };
  let history = kvGet('history') || [];
  let minute = { n: 0, cpu: 0, steal: 0, mem: 0, swap: 0, rx: 0, tx: 0 };
  let latest = null;

  function sample() {
    const now = Date.now();
    const dt = (now - prevT) / 1000; prevT = now;
    const c = cpuTimes();
    let cpu = 0, steal = 0, iowait = 0;
    if (c && prevCpu && c.total > prevCpu.total) {
      const dTot = c.total - prevCpu.total;
      cpu = 100 * (1 - (c.idle - prevCpu.idle) / dTot);
      steal = 100 * (c.steal - prevCpu.steal) / dTot;
      iowait = 100 * (c.iowait - prevCpu.iowait) / dTot;
    }
    prevCpu = c;

    const n = netBytes();
    let rxRate = 0, txRate = 0;
    if (n && prevNet && n.iface === prevNet.iface) {
      const dRx = n.rx >= prevNet.rx ? n.rx - prevNet.rx : n.rx;  // counter reset after reboot
      const dTx = n.tx >= prevNet.tx ? n.tx - prevNet.tx : n.tx;
      rxRate = dRx / dt; txRate = dTx / dt;
      if (traffic.month !== month()) traffic = { month: month(), rx: 0, tx: 0 };
      traffic.rx += dRx; traffic.tx += dTx;
    }
    prevNet = n;

    const raw = containers();
    const conts = raw.map(ct => {
      const prev = prevCont.get(ct.id);
      const cpuPct = prev != null && ct.cpuUsec >= prev ? (100 * (ct.cpuUsec - prev) / 1e6) / dt : 0;
      return { name: ct.name, cpu: cpuPct, mem: ct.mem, swap: ct.swap };
    }).sort((a, b) => a.name.localeCompare(b.name));
    prevCont = new Map(raw.map(ct => [ct.id, ct.cpuUsec]));

    const mem = memInfo();
    const load = (read('/proc/loadavg') || '0 0 0').split(' ').slice(0, 3).map(Number);
    const uptime = Number((read('/proc/uptime') || '0').split(' ')[0]);
    const pm = process.memoryUsage();
    latest = {
      t: now, cpu, steal, iowait, load, uptime, mem, disk: disk(),
      net: n ? { iface: n.iface, rxRate, txRate } : null,
      traffic: { ...traffic },
      containers: conts,
      node: { rss: pm.rss, heap: pm.heapUsed, uptime: process.uptime() },
    };

    minute.n++; minute.cpu += cpu; minute.steal += steal;
    if (mem) { minute.mem += mem.used / mem.total * 100; minute.swap += mem.swapTotal ? mem.swapUsed / mem.swapTotal * 100 : 0; }
    minute.rx += rxRate; minute.tx += txRate;
  }

  function flushMinute() {
    if (!minute.n) return;
    const k = minute.n, r1 = v => Math.round(v * 10) / 10;
    history.push({ t: Date.now(), cpu: r1(minute.cpu / k), steal: r1(minute.steal / k), mem: r1(minute.mem / k), swap: r1(minute.swap / k), rx: Math.round(minute.rx / k), tx: Math.round(minute.tx / k) });
    if (history.length > HISTORY_POINTS) history = history.slice(-HISTORY_POINTS);
    minute = { n: 0, cpu: 0, steal: 0, mem: 0, swap: 0, rx: 0, tx: 0 };
    try { kvSet('traffic', traffic); kvSet('history', history); } catch (e) { console.warn('metrics save:', e.message); }
  }

  setInterval(sample, SAMPLE_MS).unref();
  setInterval(flushMinute, 60000).unref();
  setTimeout(sample, 1000).unref();

  return {
    snapshot: () => latest,
    history: () => history,
  };
}

module.exports = { createMonitor };
