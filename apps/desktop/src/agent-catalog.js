// agent-catalog — one roster of EVERY agent this device knows, running or not.
//
// This is the appstore and the head's roster in one place: skills you can run
// (installed or still bundled), the local daemon, peer agents from .buddy/agents,
// and the live agent processes the sampler already sees. `remoteagent.online` is
// the head entry — it reads this roster and every run/stop lands in
// startAgent()/stopAgent(), so the head controls agents and devices through one
// API instead of five.
//
//   listAgents({running})   → roster entries with live status + actions
//   startAgent(id)          → run it (skill enable/install, daemon spawn)
//   stopAgent(id)           → stop it (skill disable, SIGTERM via the sampler)
//   head({agents,devices})  → the head posture (linked | offline) + roster size
//   catalog({running,devices}) → { at, head, counts, agents, devices }
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillsManager, parseSkillDoc } from './skills.js';
import { CLOUD, loadCreds, credentialStatus } from './config.js';
import { loadProviderConfig } from './transport/local.js';
import { Policy, auditVerify } from '@remote-agent/engine';
import * as sampler from './device-sampler.js';

const HOME = process.env.REMOTE_AGENT_HOME || join(homedir(), '.remote-agent');
const PID_FILE = join(HOME, 'daemon.pid');
const SKILLS_DIR = process.env.REMOTE_SKILLS_DIR || join(HOME, 'skills');
const BUNDLED = fileURLToPath(new URL('../skills/', import.meta.url));
const BUDDY = process.env.REMOTE_BUDDY_DIR || fileURLToPath(new URL('../../../.buddy/agents/', import.meta.url));
const HEAD_ID = 'remoteagent.online';
const FRESH_MS = 2 * 60 * 60 * 1000; // a peer that has not checked in for 2 h reads offline

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const dirs = (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
const files = (dir, ext) => { try { return readdirSync(dir).filter((f) => f.endsWith(ext)); } catch { return []; } };

/** PID of the running local daemon, or null (stale pid file counts as stopped). */
export function daemonPid() {
  try { const j = JSON.parse(readFileSync(PID_FILE, 'utf8')); return alive(j.pid) ? j.pid : null; } catch { return null; }
}

function skillAgents() {
  const manager = new SkillsManager({ dir: SKILLS_DIR });
  const installed = new Map(manager.list().map((s) => [s.name, s]));
  const names = [...new Set([...installed.keys(), ...dirs(BUNDLED)])].sort();
  return names.map((name) => {
    const inst = installed.get(name);
    let description = inst?.description ?? '';
    if (!description) {
      try { description = parseSkillDoc(readFileSync(join(BUNDLED, name, 'SKILL.md'), 'utf8')).description; } catch { /* unreadable */ }
    }
    const status = !inst ? 'available' : inst.enabled ? 'enabled' : 'disabled';
    return {
      id: `skill:${name}`, name, kind: 'skill', role: 'capability', status, description,
      source: inst ? 'installed' : 'bundled',
      actions: !inst ? ['install'] : inst.enabled ? ['disable'] : ['enable'],
    };
  });
}

function peerAgents() {
  return files(BUDDY, '.json').map((f) => {
    let r = {};
    try { r = JSON.parse(readFileSync(join(BUDDY, f), 'utf8')); } catch { /* torn */ }
    const name = r.agent || f.replace(/\.json$/, '');
    const seen = Date.parse(r.lastSeen ?? '') || null;
    return {
      id: `peer:${name}`, name, kind: 'peer', role: r.role || 'agent',
      status: seen && Date.now() - seen < FRESH_MS ? 'online' : 'offline',
      lastSeen: r.lastSeen ?? null, task: r.task ?? null, note: r.note ?? null,
      actions: [],
    };
  });
}

function processAgents(running = []) {
  return running.map((r) => ({
    id: `proc:${r.pid}`, name: r.cmd || `pid ${r.pid}`, kind: 'process', role: 'running',
    status: sampler.paused?.has?.(Number(r.pid)) ? 'paused' : 'running',
    pid: r.pid, cpu: r.cpu ?? 0, mb: r.mb ?? 0,
    // What it is doing right now: the census already carries the command line.
    activity: String(r.args ?? '').slice(0, 160) || null,
    actions: ['stop'],
  }));
}

/** The whole roster: skills + daemon + peers + live processes. */
export function listAgents({ running = [] } = {}) {
  const pid = daemonPid();
  const daemon = {
    id: 'daemon', name: 'remote-agent daemon', kind: 'daemon', role: 'local runtime',
    status: pid ? 'running' : 'stopped', pid, description: 'the local agent loop, tools and audit chain',
    actions: pid ? ['stop'] : ['start'],
  };
  return [daemon, ...skillAgents(), ...peerAgents(), ...processAgents(running)];
}

/** The tamper-evident audit chain, verified — the glass floor under every action.
 *  Walking a multi-MB log per tick is waste, so the verdict is memoised for a minute. */
let auditCache = { at: 0, val: null, path: null };
export function auditPosture(maxAgeMs = 60000) {
  const p = policyPosture();
  const path = p.auditPath ?? null;
  if (auditCache.val && auditCache.path === path && Date.now() - auditCache.at < maxAgeMs) return auditCache.val;
  let val = { ok: false, checked: 0, brokenAt: null, reason: 'no audit path' };
  try { val = { ...auditVerify(path ?? undefined), path }; } catch (e) { val = { ok: false, checked: 0, reason: String(e?.message ?? e), path }; }
  auditCache = { at: Date.now(), val, path };
  return val;
}

/** The model registry: every LLM this device can reach — cloud, BYO key, or local. */
export function listModels() {
  let cfg = null;
  let error = null;
  try { cfg = loadProviderConfig(); } catch (e) { error = String(e?.message ?? e); }
  const local = { anthropic: 'claude-3-5-sonnet-20241022', openai: 'gpt-4o-mini', ollama: 'llama3.2' };
  const out = [{
    id: 'cloud:remoteagent.online', provider: 'remoteagent.online', model: 'hosted (managed)',
    kind: 'cloud', configured: Boolean(loadCreds()?.apiKey), default: true,
    note: 'the head runs its own models; the device only holds the API key',
  }];
  for (const [provider, model] of Object.entries(local)) {
    const active = cfg?.provider === provider;
    out.push({
      id: `llm:${provider}`, provider, model: active ? cfg.model : model,
      kind: provider === 'ollama' ? 'local' : 'byo-key',
      configured: active ? cfg.enabled !== false : false,
      keyPresent: active ? Boolean(cfg.apiKey) : false,
      baseUrl: active ? cfg.baseUrl : null,
    });
  }
  return { error, models: out, anyConfigured: out.some((m) => m.configured) || Boolean(loadCreds()?.apiKey) };
}

/** What policy is actually in force here — the console shows it instead of asserting it. */
export function policyPosture() {
  let p = null;
  try { p = Policy.load(); } catch { /* unreadable policy reads as unknown */ }
  if (!p) return { source: 'unreadable', fleetTier: 'deny', audit: false };
  const v = p.check('fleet', { action: 'inspect' });
  return {
    source: p.raw && Object.keys(p.raw).length ? 'policy file' : 'built-in defaults',
    fleetTier: p.toolTier?.('fleet') ?? (v.allowed ? 'allow' : v.tier),
    audit: p.auditEnabled !== false, auditPath: p.auditPath ?? null,
    maxSteps: p.maxSteps ?? null, dailyTokens: p.dailyTokens ?? null,
  };
}

/** Every run/stop passes the policy gate — a deny is reported, never silently ignored. */
function policyGate(action, id) {
  try {
    const v = Policy.load().check('fleet', { action, id });
    return v.allowed ? { ok: true, tier: v.tier, reason: v.reason } : { ok: false, tier: v.tier, reason: v.reason };
  } catch (e) {
    return { ok: false, tier: 'deny', reason: `policy unreadable: ${String(e?.message ?? e)}` };
  }
}

/** Run an agent. Skills are enabled (or installed first); the daemon is spawned detached. */
export function startAgent(id, { spawnFn = spawn, bin = process.env.REMOTE_AGENT_BIN || 'remote-agent' } = {}) {
  const gate = policyGate('run', id);
  if (!gate.ok) return { ok: false, denied: true, message: `policy (${gate.tier}): ${gate.reason}` };
  if (id === 'daemon') {
    if (daemonPid()) return { ok: true, message: 'daemon already running' };
    const child = spawnFn(bin, ['start', '--force'], { detached: true, stdio: 'ignore' });
    child.unref?.();
    return { ok: true, message: `started daemon (pid ${child.pid ?? '?'})` };
  }
  if (id.startsWith('skill:')) {
    const name = id.slice(6);
    const manager = new SkillsManager({ dir: SKILLS_DIR });
    if (!existsSync(join(SKILLS_DIR, name))) {
      const r = manager.install();
      if (!r || r.installed === 0) return { ok: false, message: `no bundled skill "${name}"` };
    }
    const r = manager.enable(name);
    return r.ok ? { ok: true, message: `enabled ${name}` } : { ok: false, message: r.error };
  }
  return { ok: false, message: `cannot start ${id}` };
}

/** Stop an agent. Skills are disabled; a running pid goes through the sampler's audited kill. */
export function stopAgent(id) {
  const gate = policyGate('stop', id);
  if (!gate.ok) return { ok: false, denied: true, message: `policy (${gate.tier}): ${gate.reason}` };
  if (id === 'daemon') {
    const pid = daemonPid();
    return pid ? { ...sampler.killPid(pid, 'SIGTERM'), message: `stopped daemon (pid ${pid})` } : { ok: true, message: 'daemon not running' };
  }
  if (id.startsWith('skill:')) {
    new SkillsManager({ dir: SKILLS_DIR }).disable(id.slice(6));
    return { ok: true, message: `disabled ${id.slice(6)}` };
  }
  if (id.startsWith('proc:')) {
    const pid = Number(id.slice(5));
    return pid ? sampler.killPid(pid, 'SIGTERM') : { ok: false, message: 'bad pid' };
  }
  return { ok: false, message: `cannot stop ${id}` };
}

// Reading the credential store can hit the OS keychain, and the console asks for
// the head on every tick — so the posture is memoised, not re-read 30x a minute.
let headCache = { at: 0, val: null };

// --- devices ---------------------------------------------------------------
// A peer in fleet.json is a claim, not a fact: it is only "online" if its control
// port actually answers. Probes are bounded and cached, because snapshot() runs
// every tick and a dead peer must not cost the frame a TCP timeout.
const probeCache = new Map(); // host -> { at, online, why }
const PROBE_TTL_MS = 15000;

function probePort(d) {
  return Number(d.port || process.env.FLEET_PORT || 3095);
}

/** TCP-probe one device. Never throws, never hangs longer than timeoutMs. */
export function probeDevice(d, { timeoutMs = 1200 } = {}) {
  const host = d.host || d.id;
  if (d.role === 'self' || host === hostname()) return Promise.resolve({ online: true, why: 'self' });
  return new Promise((resolve) => {
    const sock = connect({ host, port: probePort(d) });
    const done = (online, why) => { try { sock.destroy(); } catch { /* closed */ } resolve({ online, why }); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true, `tcp ${host}:${probePort(d)} ok`));
    sock.once('timeout', () => done(false, `no answer in ${timeoutMs}ms`));
    sock.once('error', (e) => done(false, `tcp ${e.code || e.message}`));
  });
}

/** Probe every device and cache the verdict. This is what makes `online` real. */
export async function probeDevices(devices = [], opts) {
  return Promise.all(devices.map(async (d) => {
    const r = await probeDevice(d, opts);
    probeCache.set(d.host || d.id, { at: Date.now(), ...r });
    return { ...d, online: r.online, probe: r.why };
  }));
}

/** Sync wrapper for the per-tick snapshot: cached verdict now, refresh in the background. */
export function devicesWithLiveness(devices = []) {
  return devices.map((d) => {
    const key = d.host || d.id;
    const hit = probeCache.get(key);
    if (d.role === 'self' || key === hostname()) return { ...withActions(d), online: true, probe: 'self' };
    if (!hit || Date.now() - hit.at > PROBE_TTL_MS) probeDevice(d).then((r) => probeCache.set(key, { at: Date.now(), ...r })).catch(() => {});
    return { ...withActions(d), online: hit ? hit.online : null, probe: hit ? hit.why : 'probing…' };
  });
}

/** What the head may do to a device. Self: govern its local agents. Peer: probe only
 *  (no remote agent API is assumed — inventing one would be a promise we cannot keep). */
function withActions(d) {
  const self = d.role === 'self' || (d.host || d.id) === hostname();
  return { ...d, actions: self ? ['pause-agents', 'resume-agents', 'probe'] : ['probe'] };
}

/** Run one device action. Same policy gate as agents: the head asks, policy decides. */
export function deviceAction(id, action) {
  const gate = policyGate('device', `${id}:${action}`);
  if (!gate.ok) return { ok: false, denied: true, message: `policy (${gate.tier}): ${gate.reason}` };
  if (action === 'pause-agents' || action === 'resume-agents') {
    if (id !== hostname() && id !== 'self') return { ok: false, message: `refusing to ${action} on a peer — no remote control channel exists` };
    const c = sampler.sample({ minCpu: 0.3 });
    const pids = c.rows.filter((r) => r.bucket === 'agents').map((r) => r.pid);
    const r = action === 'pause-agents' ? sampler.pausePids(pids) : sampler.resumeAll();
    return { ...r, message: `${action}: ${action === 'pause-agents' ? (r.paused?.length ?? 0) : (r.resumed?.length ?? 0)} process(es)` };
  }
  if (action === 'probe') return { ok: true, message: `probe requested for ${id}` };
  return { ok: false, message: `unknown device action ${action}` };
}

/** remoteagent.online — the head: it owns the roster, the devices and the money. */export function head({ agents = 0, devices = 0 } = {}) {
  const now = Date.now();
  if (!headCache.val || now - headCache.at > 30000) {
    let meta = {};
    try { meta = credentialStatus(); } catch { /* no store yet */ }
    let linked = false;
    try { linked = Boolean(loadCreds()?.apiKey); } catch { /* unreadable store */ }
    headCache = { at: now, val: { meta, linked } };
  }
  const { meta, linked } = headCache.val;
  return {
    id: HEAD_ID, name: HEAD_ID, kind: 'head', role: 'ceo', url: CLOUD.base, platform: CLOUD.platform,
    status: linked ? 'linked' : 'offline', linked,
    agentId: meta.agentId ?? null, keyBackend: meta.backend ?? null,
    keyPresent: meta.present === true, keyExpired: meta.expired === true,
    roster: { agents, devices },
    note: linked
      ? 'head online: roster + run/stop go through this catalog'
      : 'no API key on this device — run: remote-agent login',
  };
}

export function catalog({ running = [], devices = [] } = {}) {
  const agents = listAgents({ running });
  const live = devicesWithLiveness(devices); // online is probed, never assumed
  const llms = listModels();
  return {
    at: Date.now(),
    head: head({ agents: agents.filter((a) => a.kind !== 'skill').length, devices: live.length }),
    policy: policyPosture(),
    audit: auditPosture(),
    models: llms.models, modelsError: llms.error, anyModelConfigured: llms.anyConfigured,
    counts: {
      all: agents.length,
      running: agents.filter((a) => a.status === 'running' || a.status === 'paused').length,
      skills: agents.filter((a) => a.kind === 'skill').length,
      enabled: agents.filter((a) => a.status === 'enabled').length,
      devices: live.length,
      devicesOnline: live.filter((d) => d.online === true).length,
    },
    agents, devices: live,
  };
}
