// focus — the local deep-dive + control console for this device.
//
// The dashboard watches; this hands the machine back. One JSON frame per tick to
// the browser (SSE), one snapshot for headless (`remote-agent focus --snapshot`),
// and POST endpoints to pause / resume / renice / kill and to switch focus MODES.
// Binds 127.0.0.1 only: control never leaves the device.
//
//   remote-agent focus                 start the console (127.0.0.1:3097)
//   remote-agent focus --snapshot      print the current census as JSON and exit
//   remote-agent focus --resume-all    un-stop everything focus paused, then exit
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sampler from './device-sampler.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FOCUS_PORT || 3097);

export function snapshot() {
  const c = sampler.sample({ minCpu: 0.3 });
  return {
    at: Date.now(), port: PORT, platform: process.platform,
    host: os.hostname(), model: os.cpus()[0]?.model || 'cpu',
    cores: os.cpus().length,
    busy: c.busy, budget: c.budget, groups: c.groups,
    procs: c.rows.slice(0, 200),
    agents: c.rows.filter((r) => r.bucket === 'agents'),
    load: sampler.readLoad(), swap: sampler.readSwap(),
    gate: sampler.readGate(),
    paused: [...sampler.paused.entries()].map(([pid, v]) => ({ pid: Number(pid), at: v.at })),
  };
}

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); });

const clients = new Set();
let last = null;

export function createFocusServer() {
  return createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    try {
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(readFileSync(join(HERE, 'focus.html')));
      }
      if (url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(last ?? snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url === '/status') return json(res, 200, last ?? snapshot());
      if (url === '/gate' && req.method === 'POST') { const b = await body(req); return json(res, 200, { ok: true, gate: sampler.setGate(b) }); }
      if (url === '/mode' && req.method === 'POST') { const b = await body(req); return json(res, 200, sampler.applyMode(String(b.mode || ''), snapshot())); }
      if (url === '/pause' && req.method === 'POST') {
        const b = await body(req);
        if (b.pid) return json(res, 200, sampler.pausePids([b.pid]));
        const c = snapshot();
        const { selectGroup } = await import('@remote-agent/engine');
        return json(res, 200, sampler.pausePids(selectGroup(b.target || 'agents', c.procs)));
      }
      if (url === '/resume' && req.method === 'POST') { const b = await body(req); return json(res, 200, b.pid ? sampler.resumePids([b.pid]) : sampler.resumeAll()); }
      if (url === '/renice' && req.method === 'POST') { const b = await body(req); return json(res, 200, b.pid ? sampler.renicePid(b.pid, b.nice ?? 20) : { ok: false, message: 'need pid' }); }
      if (url === '/kill' && req.method === 'POST') { const b = await body(req); return json(res, 200, b.pid ? sampler.killPid(b.pid, b.signal || 'SIGTERM') : { ok: false, message: 'need pid' }); }
      return json(res, 404, { ok: false, message: 'not found' });
    } catch (e) { try { json(res, 500, { ok: false, message: String(e?.message ?? e) }); } catch { /* gone */ } }
  });
}

export function startServer() {
  const server = createFocusServer();
  server.listen(PORT, '127.0.0.1', () => console.log(`focus console http://127.0.0.1:${PORT}/`));
  let ticking = false;
  const tick = () => {
    if (ticking) return; ticking = true;
    try { last = snapshot(); const p = `data: ${JSON.stringify(last)}\n\n`; for (const r of clients) { try { r.write(p); } catch { /* gone */ } } }
    catch (e) { console.error(`focus tick: ${e?.message}`); }
    finally { ticking = false; }
  };
  setTimeout(tick, 200);
  setInterval(tick, 2000);
  return server;
}

/** CLI entry (`remote-agent focus ...`). */
export async function runFocusCli(args = []) {
  if (args.includes('--resume-all')) { const r = sampler.resumeAll(); console.log(`resumed ${r.resumed.length} process(es)`); return; }
  if (args.includes('--snapshot') || args.includes('--json') || args.includes('-j')) {
    const s = snapshot();
    console.log(JSON.stringify({ busy: s.busy, budget: s.budget, gate: s.gate, paused: s.paused, top: s.procs.slice(0, 12) }, null, 2));
    return;
  }
  startServer();
}
