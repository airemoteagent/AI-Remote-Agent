// fleet-console — the enterprise surface: ALL devices, ALL agents, one view.
//
// Composes the local deep-dive (device-sampler → device-control) with a fleet
// roster so the console covers every paired device and every agent process on
// them. Dynamic (SSE), full transparency, full control. Binds 127.0.0.1 only.
//
//   remote-agent fleet                 console at http://127.0.0.1:3095
//   remote-agent fleet --snapshot      JSON census of device + agents
//   remote-agent fleet --resume-all    un-stop everything focus paused
//
//   GET  /agents       the roster of every known agent (running or not)
//   GET  /overview     head + roster + devices + device census, one JSON
//   POST /agents/run   {id} — run one (skill enable/install, daemon spawn)
//   POST /agents/stop  {id} — stop one (skill disable, audited kill)
//
// Fleet roster file (optional): ~/.remote-agent/fleet.json
//   { "devices": [ { "id":"pi-1", "host":"pi-1.lan", "platform":"linux", "cores":4 } ] }
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sampler from './device-sampler.js';
import { catalog, listAgents, startAgent, stopAgent } from './agent-catalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FLEET_PORT || 3095);
const HOME = process.env.REMOTE_AGENT_HOME || join(os.homedir(), '.remote-agent');
const FLEET_FILE = join(HOME, 'fleet.json');

export function deviceFacts() {
  const cpus = os.cpus();
  return {
    id: os.hostname(), host: os.hostname(), role: 'self', online: true,
    platform: process.platform, arch: os.arch(), release: os.release(),
    cores: cpus.length, model: cpus[0]?.model || 'cpu',
    memTotalMB: Math.round(os.totalmem() / 1048576), memFreeMB: Math.round(os.freemem() / 1048576),
    uptimeS: Math.round(os.uptime()),
  };
}
function readFleet() {
  try { const j = JSON.parse(readFileSync(FLEET_FILE, 'utf8')); return Array.isArray(j.devices) ? j.devices : []; }
  catch { return []; }
}

export function snapshot() {
  const c = sampler.sample({ minCpu: 0.3 });
  const agents = c.rows.filter((r) => r.bucket === 'agents');
  const self = deviceFacts();
  const devices = [{ ...self, agents: agents.length, busy: c.busy, paused: sampler.paused.size }, ...readFleet()];
  // The head reads this roster: every known agent, running or not, plus the
  // devices it reports on. One catalogue, so the console and the head agree.
  const cat = catalog({ running: agents, devices });
  return {
    at: Date.now(), console: 'fleet', port: PORT,
    device: self, devices, head: cat.head, counts: cat.counts, catalog: cat.agents,
    policy: cat.policy, audit: cat.audit, models: cat.models, modelsError: cat.modelsError,
    busy: c.busy, budget: c.budget, groups: c.groups,
    agents, procs: c.rows.slice(0, 250),
    load: sampler.readLoad(), swap: sampler.readSwap(),
    gate: sampler.readGate(),
    paused: [...sampler.paused.entries()].map(([pid, v]) => ({ pid: Number(pid), at: v.at })),
  };
}

const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
const clients = new Set();
let last = null;

export function createFleetServer() {
  return createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    try {
      if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(readFileSync(join(HERE, 'fleet-console.html'))); }
      if (url === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write(`data: ${JSON.stringify(last ?? snapshot())}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return; }
      if (url === '/status' || url === '/overview') return json(res, 200, last ?? snapshot());
      if (url === '/agents') return json(res, 200, { head: (last ?? snapshot()).head, agents: listAgents({ running: (last ?? snapshot()).agents }) });
      if (url === '/agents/run' && req.method === 'POST') { const b = await body(req); return json(res, 200, b.id ? startAgent(String(b.id)) : { ok: false, message: 'need id' }); }
      if (url === '/agents/stop' && req.method === 'POST') { const b = await body(req); return json(res, 200, b.id ? stopAgent(String(b.id)) : { ok: false, message: 'need id' }); }
      if (url === '/gate' && req.method === 'POST') { const b = await body(req); return json(res, 200, { ok: true, gate: sampler.setGate(b) }); }
      if (url === '/mode' && req.method === 'POST') { const b = await body(req); return json(res, 200, sampler.applyMode(String(b.mode || ''), snapshot())); }
      if (url === '/pause' && req.method === 'POST') { const b = await body(req); if (b.pid) return json(res, 200, sampler.pausePids([b.pid])); const { selectGroup } = await import('@remote-agent/engine'); return json(res, 200, sampler.pausePids(selectGroup(b.target || 'agents', snapshot().procs))); }
      if (url === '/resume' && req.method === 'POST') { const b = await body(req); return json(res, 200, b.pid ? sampler.resumePids([b.pid]) : sampler.resumeAll()); }
      if (url === '/renice' && req.method === 'POST') { const b = await body(req); return json(res, 200, b.pid ? sampler.renicePid(b.pid, b.nice ?? 20) : { ok: false, message: 'need pid' }); }
      if (url === '/kill' && req.method === 'POST') { const b = await body(req); return json(res, 200, b.pid ? sampler.killPid(b.pid, b.signal || 'SIGTERM') : { ok: false, message: 'need pid' }); }
      return json(res, 404, { ok: false, message: 'not found' });
    } catch (e) { try { json(res, 500, { ok: false, message: String(e?.message ?? e) }); } catch { /* gone */ } }
  });
}

export function startFleetServer() {
  const server = createFleetServer();
  server.listen(PORT, '127.0.0.1', () => console.log(`fleet console http://127.0.0.1:${PORT}/`));
  let busy = false;
  const tick = () => { if (busy) return; busy = true; try { last = snapshot(); const p = `data: ${JSON.stringify(last)}\n\n`; for (const r of clients) { try { r.write(p); } catch { /* gone */ } } } catch (e) { console.error(`fleet tick: ${e?.message}`); } finally { busy = false; } };
  setTimeout(tick, 200);
  setInterval(tick, 2000);
  return server;
}

export async function runFleetCli(args = []) {
  if (args.includes('--resume-all')) { console.log(`resumed ${sampler.resumeAll().resumed.length} process(es)`); return; }
  if (args.includes('--snapshot') || args.includes('--json') || args.includes('-j')) {
    const s = snapshot();
    console.log(JSON.stringify({ device: s.device, devices: s.devices.length, busy: s.busy, budget: s.budget, agents: s.agents.length, gate: s.gate, paused: s.paused }, null, 2));
    return;
  }
  startFleetServer();
}
