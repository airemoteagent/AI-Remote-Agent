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
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sampler from './device-sampler.js';
import { Policy, auditWrite } from '@remote-agent/engine';
import { tools as toolRegistry } from './tools/index.js';
import { catalog, listAgents, startAgent, stopAgent, probeDevices, deviceAction, refreshRuntimes, gate as policyGatePublic, explain as policyExplain, tierOf as policyTierOf } from './agent-catalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FLEET_PORT || 3095);
// The one web origin allowed to ask this console whether it is alive (see /ping).
const SITE_ORIGIN = process.env.REMOTEAGENT_SITE || 'https://remoteagent.online';
const VERSION = (() => { try { return JSON.parse(readFileSync(join(HERE, '..', '..', '..', 'package.json'), 'utf8')).version; } catch { return null; } })();
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
    device: self, devices: cat.devices, head: cat.head, counts: cat.counts, catalog: cat.agents,
    policy: cat.policy, audit: cat.audit, models: cat.models, modelsError: cat.modelsError,
    activity: cat.activity ?? [], runtime: cat.runtime ?? null,
    busy: c.busy, budget: c.budget, groups: c.groups,
    agents, procs: c.rows.slice(0, 250),
    load: sampler.readLoad(), swap: sampler.readSwap(),
    gate: sampler.readGate(),
    paused: [...sampler.paused.entries()].map(([pid, v]) => ({ pid: Number(pid), at: v.at })),
  };
}

/**
 * The frame the dashboard renders, from the snapshot this process already builds.
 *
 * The panels and the strip read one shape (fleet:{counts,policy,audit,devices,head,
 * runtime}, host/cores/mem/load at the top) — the shape the local dashboard composes
 * around the plane. Posting the raw snapshot instead produced a dashboard that showed
 * "plane down · agents 0 detected · devices 0/0" while the machine was plainly online:
 * right data, wrong shape, and the page said it with confidence. This is a mapping —
 * every field comes from snapshot() or deviceFacts(), nothing is invented. Session and
 * runtime counters stay absent because they live in the local session stores, and the
 * console prints "not reported" for them rather than a zero.
 */
export function consoleFrame() {
  const s = snapshot();
  const d = s.device || deviceFacts();
  // Do not publish a counter this device cannot substantiate. The session/runtime
  // counters come from local session stores; without them `counts.sessions` is a
  // literal 0, and the console prints "0 sessions · 0 running" for a machine that is
  // mid-conversation. Absent keys render as "not reported", which is the truth.
  const counts = { ...(s.counts || {}) };
  const rt = s.runtime || {};
  const hasSessionReader = Array.isArray(rt.sessions) ? rt.sessions.length > 0 : !!rt.summary;
  if (!hasSessionReader) {
    delete counts.sessions;
    delete counts.sessionsRunning;
    delete counts.todoItems;
  }
  const memTotal = d.memTotalMB || 0;
  const memFree = d.memFreeMB || 0;
  // The tool registry is read on this machine, so the hosted console can only show it
  // if the frame carries it. Names, one-line descriptions and the policy tier — the
  // same three fields the playground panel renders; a registry this process cannot
  // read stays an empty list, which the console states instead of faking.
  const tools = (() => {
    try {
      return toolRegistry.list().map((t) => ({
        name: t.name, description: String(t.description || '').slice(0, 140), tier: policyTierOf(t.name),
      }));
    } catch { return []; }
  })();
  return {
    at: s.at, host: d.id || d.host, model: d.model, cores: d.cores,
    totalMb: memTotal, busy: s.busy, load: s.load, tools,
    mem: { available: memFree, used: Math.max(0, memTotal - memFree), total: memTotal },
    tempSeries: [], budget: s.budget, groups: s.groups, procs: s.procs, agents: s.agents,
    paused: s.paused, activity: s.activity, gates: s.gate, gate: s.gate,
    fleet: {
      at: s.at, planeUp: true, planeStale: false, lastOkAt: s.at, planePort: s.port,
      error: null,
      head: s.head, counts, policy: s.policy, audit: s.audit,
      models: s.models, modelsError: s.modelsError, devices: s.devices,
      catalog: s.catalog, runtime: hasSessionReader ? rt : null,
    },
  };
}

const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
const clients = new Set();
let last = null;

// ── settings ────────────────────────────────────────────────────────────────
// Knobs a human turns. Anything that changes what the device is ALLOWED to do goes
// through the policy file and the audit chain; the rest is plain preferences.
const SETTINGS_FILE = join(HOME, 'fleet-settings.json');
const DEFAULTS = Object.freeze({
  runtimeRefreshMs: Number(process.env.RUNTIME_REFRESH_MS ?? 30000),
  scanCacheMs: Number(process.env.SAMPLER_SCAN_MS ?? 2000),
  tickFloorMs: 2000,
  tickCeilMs: 15000,
  policyTier: 'strict', // capability dial: strict | standard | permissive
});

export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2)); } catch { /* disk */ }
  return next;
}

export function settingsView() {
  const s = loadSettings();
  const snap = last ?? snapshot();
  return {
    settings: s, defaults: DEFAULTS,
    effective: {
      fleetPort: PORT, runtimeRefreshMs: Number(process.env.RUNTIME_REFRESH_MS ?? s.runtimeRefreshMs),
      snapshotMs: snap.snapshotMs ?? null, tickMs: snap.tickMs ?? null, scanned: snap.counts?.scanned ?? null,
    },
    policy: snap.policy, audit: snap.audit, head: snap.head,
    paths: { settings: SETTINGS_FILE, registry: join(HOME, 'agents.json'), audit: snap.policy?.auditPath ?? null, home: HOME },
    safety: { bindsLoopback: true, note: 'this console binds 127.0.0.1 only; policy is read from local disk and never from the network' },
  };
}

export function applySettings(patch = {}) {
  const gate = policyGatePublic('settings', JSON.stringify(patch).slice(0, 120));
  if (!gate.ok) return { ok: false, denied: true, message: `policy (${gate.tier}): ${gate.reason}` };
  const out = { ok: true, applied: [], refused: [] };

  if (patch.runtimeRefreshMs != null) {
    const ms = Math.max(5000, Math.min(600000, Number(patch.runtimeRefreshMs) || DEFAULTS.runtimeRefreshMs));
    saveSettings({ runtimeRefreshMs: ms }); out.applied.push(`runtime refresh: ${ms} ms`);
  }
  if (patch.scanCacheMs != null) {
    const ms = Math.max(500, Math.min(30000, Number(patch.scanCacheMs) || DEFAULTS.scanCacheMs));
    saveSettings({ scanCacheMs: ms }); out.applied.push(`process scan cache: ${ms} ms (applies on restart)`);
  }
  if (patch.guards && typeof patch.guards === 'object') {
    out.applied.push(`guards: ${JSON.stringify(sampler.setGate(patch.guards))}`);
  }
  if (patch.policyTier) {
    const tier = String(patch.policyTier);
    const r = setPolicyTier(tier);
    if (r.ok) out.applied.push(`policy tier: ${tier}`); else out.refused.push(r.message);
  }
  if (!out.applied.length && !out.refused.length) out.refused.push('nothing to change');
  return { ...out, settings: loadSettings() };
}

/** The capability dial writes the LOCAL policy file — the only authority there is. */
function setPolicyTier(tier) {
  try {
    const policy = Policy.preset(tier); // throws on an unknown preset
    writeFileSync(sampler.policyPath?.() ?? join(HOME, 'policy.json'), JSON.stringify(policy.raw, null, 2));
    auditWrite({ kind: 'settings', action: 'policy-tier', tier, verdict: 'allow' }, last?.policy?.auditPath ?? undefined);
    return { ok: true, tier };
  } catch (e) { return { ok: false, message: `cannot set tier "${tier}": ${String(e?.message ?? e)}` }; }
}

// ── security ────────────────────────────────────────────────────────────────
export function securityView() {
  const snap = last ?? snapshot();
  const denies = (snap.activity ?? []).filter((a) => a.verdict === 'deny' || a.verdict === 'refused' || a.verdict === 'confirm');
  const pausedList = snap.paused ?? [];
  return {
    policy: snap.policy, audit: snap.audit, head: snap.head,
    tier: snap.policy?.fleetTier ?? 'unknown',
    denied: denies.slice(0, 25),
    deniedCount: denies.length,
    paused: pausedList,
    gates: snap.gate,
    protected: {
      neverStop: ['launchd', 'WindowServer', 'loginwindow', 'Dock', 'Finder', 'SIP-protected daemons'],
      controlSurfaces: [PORT, 3099, Number(process.env.CTL_PORT ?? 3098)],
      rule: 'pid 1, this process, control-surface owners and core GUI daemons are never paused or killed',
    },
    containment: {
      binds: '127.0.0.1 only', egress: 'the device talks out; nothing listens for the network',
      policySource: 'local disk only — a remote policy update is rejected',
      auditChain: snap.audit?.ok === true ? `verified (${snap.audit.checked} entries)` : `BROKEN at ${snap.audit?.brokenAt ?? '?'} — ${snap.audit?.reason ?? 'unknown'}`,
    },
    recent: (snap.activity ?? []).slice(0, 20),
  };
}

export function securityAction(action) {
  const gate = policyGatePublic(action, 'security');
  if (!gate.ok) return { ok: false, denied: true, message: `policy (${gate.tier}): ${gate.reason}` };
  const snap = last ?? snapshot();
  switch (action) {
    case 'pause-all-agents': {
      const pids = (snap.agents ?? []).map((a) => a.pid);
      const r = sampler.pausePids(pids);
      return { ok: true, message: `paused ${r.paused?.length ?? 0} agent process(es)`, ...r };
    }
    case 'resume-all': { const r = sampler.resumeAll(); return { ok: true, message: `resumed ${r.resumed?.length ?? 0}`, ...r }; }
    case 'disarm-guards': return { ok: true, message: 'guards disarmed', gate: sampler.setGate({ cpuGuard: false, priority: false }) };
    case 'arm-guards': return { ok: true, message: 'guards armed', gate: sampler.setGate({ cpuGuard: true, priority: true }) };
    default: return { ok: false, message: `unknown action ${action}` };
  }
}

// ── playground ──────────────────────────────────────────────────────────────
// Experiments stay experiments: every attempt is policy-checked and the verdict is
// shown next to the result, so "it ran" and "policy allowed it" are never confused.
export function playgroundView() {
  const snap = last ?? snapshot();
  return {
    tools: (() => { try { return toolRegistry.list().map((t) => ({ ...t, tier: policyTierOf(t.name) })); } catch { return []; } })(),
    policy: snap.policy,
    note: 'dry-run asks the policy without running anything; run executes through the same registry the agent uses',
  };
}

export async function playgroundRun({ tool, args = {}, dryRun = true } = {}) {
  if (!tool) return { ok: false, message: 'need tool' };
  let parsed = args;
  if (typeof args === 'string') { try { parsed = args.trim() ? JSON.parse(args) : {}; } catch (e) { return { ok: false, message: `args must be JSON: ${String(e.message)}` }; } }
  const verdict = policyExplain(tool, parsed);
  if (dryRun) return { ok: true, dryRun: true, verdict, message: verdict.allowed ? 'policy would allow this' : `policy refuses: ${verdict.reason}` };
  if (!verdict.allowed) return { ok: false, denied: true, verdict, message: `policy (${verdict.tier}): ${verdict.reason}` };
  const gate = policyGatePublic(tool, JSON.stringify(parsed).slice(0, 120));
  if (!gate.ok) return { ok: false, denied: true, message: `policy (${gate.tier}): ${gate.reason}` };
  const t0 = Date.now();
  try {
    const result = await toolRegistry.run(tool, parsed);
    return { ok: !result?.error, verdict, ms: Date.now() - t0, result: JSON.parse(JSON.stringify(result ?? null)) };
  } catch (e) { return { ok: false, verdict, ms: Date.now() - t0, message: String(e?.message ?? e) }; }
}

export function createFleetServer() {
  return createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    try {
      if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(readFileSync(join(HERE, 'fleet-console.html'))); }
      if (url === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write(`data: ${JSON.stringify(last ?? snapshot())}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return; }

      // ── /ping — the only endpoint a website is allowed to call ─────────
      // remoteagent.online shows whether this console is running on the visitor's
      // machine. A public page cannot reach loopback without CORS *and* Chrome's
      // Private Network Access header, and it must not be handed the control
      // surface to get a status light: /ping answers "I am here" for one origin,
      // read-only, and no other endpoint gains a CORS header from this.
      if (url === '/ping') {
        const origin = req.headers.origin;
        const base = { 'vary': 'origin', 'access-control-allow-private-network': 'true' };
        if (origin === SITE_ORIGIN) base['access-control-allow-origin'] = SITE_ORIGIN;
        if (req.method === 'OPTIONS') {
          base['access-control-allow-methods'] = 'GET, OPTIONS';
          base['access-control-allow-headers'] = 'content-type';
          base['access-control-max-age'] = '600';
          res.writeHead(204, base); return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...base });
        return res.end(JSON.stringify({ ok: true, console: 'fleet', port: PORT, version: VERSION }));
      }
      if (url === '/status' || url === '/overview') return json(res, 200, last ?? snapshot());
      if (url === '/agents') { const s = last ?? snapshot(); return json(res, 200, { head: s.head, agents: listAgents({ running: s.agents }) }); }
      if (url === '/agents/run' && req.method === 'POST') { const b = await body(req); return json(res, 200, b.id ? startAgent(String(b.id)) : { ok: false, message: 'need id' }); }
      if (url === '/agents/stop' && req.method === 'POST') { const b = await body(req); return json(res, 200, b.id ? stopAgent(String(b.id)) : { ok: false, message: 'need id' }); }
      if (url === '/devices') { const s = last ?? snapshot(); return json(res, 200, { devices: await probeDevices(s.devices) }); }
      if (url === '/devices/action' && req.method === 'POST') { const b = await body(req); if (!b.id) return json(res, 400, { ok: false, message: 'need id' }); return json(res, 200, deviceAction(String(b.id), String(b.action || 'probe'))); }
      if (url === '/gate' && req.method === 'POST') { const b = await body(req); return json(res, 200, { ok: true, gate: sampler.setGate(b) }); }
      if (url === '/mode' && req.method === 'POST') { const b = await body(req); return json(res, 200, sampler.applyMode(String(b.mode || ''), snapshot())); }
      if (url === '/pause' && req.method === 'POST') { const b = await body(req); if (b.pid) return json(res, 200, sampler.pausePids([b.pid])); const { selectGroup } = await import('@remote-agent/engine'); return json(res, 200, sampler.pausePids(selectGroup(b.target || 'agents', snapshot().procs))); }
      if (url === '/resume' && req.method === 'POST') { const b = await body(req); return json(res, 200, b.pid ? sampler.resumePids([b.pid]) : sampler.resumeAll()); }
      if (url === '/renice' && req.method === 'POST') { const b = await body(req); return json(res, 200, b.pid ? sampler.renicePid(b.pid, b.nice ?? 20) : { ok: false, message: 'need pid' }); }
      if (url === '/kill' && req.method === 'POST') { const b = await body(req); return json(res, 200, b.pid ? sampler.killPid(b.pid, b.signal || 'SIGTERM') : { ok: false, message: 'need pid' }); }

      // ── settings: the knobs a human turns, and what they actually do ──────
      if (url === '/settings' && req.method === 'GET') return json(res, 200, settingsView());
      if (url === '/settings' && req.method === 'POST') { const b = await body(req); return json(res, 200, applySettings(b)); }

      // ── security: what is enforced, what was refused, and the kill switches ─
      if (url === '/security') return json(res, 200, securityView());
      if (url === '/security/action' && req.method === 'POST') { const b = await body(req); return json(res, 200, securityAction(String(b.action || ''))); }

      // ── playground: try a tool without handing it the machine ─────────────
      if (url === '/playground' && req.method === 'GET') return json(res, 200, playgroundView());
      if (url === '/playground' && req.method === 'POST') { const b = await body(req); return json(res, 200, await playgroundRun(b)); }
      return json(res, 404, { ok: false, message: 'not found' });
    } catch (e) { try { json(res, 500, { ok: false, message: String(e?.message ?? e) }); } catch { /* gone */ } }
  });
}

export function startFleetServer() {
  const server = createFleetServer();
  server.listen(PORT, '127.0.0.1', () => console.log(`fleet console http://127.0.0.1:${PORT}/`));
  // The tick adapts to how slow this machine is right now: on a loaded box a single
  // snapshot measured 4-6 s, and a fixed 2 s interval then queues work forever and
  // starves the HTTP handlers (measured: /overview timing out while the port was up).
  let busy = false;
  let tickMs = 2000;
  const tick = () => {
    if (busy) return;
    busy = true;
    const t0 = Date.now();
    try {
      last = snapshot();
      last.snapshotMs = Date.now() - t0;
      last.tickMs = tickMs;
      const p = `data: ${JSON.stringify(last)}\n\n`;
      for (const r of clients) { try { r.write(p); } catch { /* gone */ } }
    } catch (e) { console.error(`fleet tick: ${e?.message}`); } finally {
      const took = Date.now() - t0;
      tickMs = Math.min(15000, Math.max(2000, took * 2));
      busy = false;
    }
  };
  last = snapshot();
  setTimeout(tick, 200);
  setInterval(tick, 1000); // the tick checks the clock itself, so the interval can stay short
  // Other runtimes' stores are read on their own cadence, off the tick: their adapters
  // are heavy scans (measured 6 s for all of them) and must never block a frame.
  // Load-aware cadence. The collector reads a dozen other runtimes' stores and costs
  // seconds of disk and CPU; on a box already at 4x its core count that is the
  // instrumentation eating the machine it measures (measured: load 380 while 12
  // adapters plus the dashboard's own probes fought over 4 threads). So: back off
  // with load, and skip entirely when the box is far too busy to afford the read.
  const baseMs = Number(process.env.RUNTIME_REFRESH_MS ?? 60000);
  const cores = os.cpus().length || 4;
  const loop = async () => {
    const load = os.loadavg()[0];
    // Slow down under load, but NEVER skip: a guard that starves the data is the
    // same defect as a dashboard that shows nothing (measured: with a skip above
    // 4x cores the roster went empty on a loaded box and the page looked broken).
    const delay = load > cores * 4 ? 300000 : load > cores ? baseMs * 4 : baseMs;
    await refreshRuntimes().catch(() => {});
    setTimeout(loop, delay).unref?.();
  };
  loop();
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
