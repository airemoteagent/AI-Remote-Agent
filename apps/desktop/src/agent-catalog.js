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
import { existsSync, readdirSync, readFileSync, writeFileSync, openSync, closeSync, readSync, fstatSync } from 'node:fs';
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
import { collect } from './runtimes/index.js';

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

// --- agent detection -------------------------------------------------------
// Detection is EVIDENCE, not a name list baked into the engine. A process is an
// agent because (a) it matches a known agent signature, (b) it matches an entry in
// your own registry file, or (c) a conservative heuristic fired — and (c) is
// labelled "possible" instead of being asserted as fact.
//
// Two measured traps this avoids:
//   * the census only keeps processes above a cpu/memory threshold, so an IDLE
//     agent (0 % cpu) was invisible; detection scans the full process table.
//   * a shell that merely MENTIONS an agent (`bash -c grep claude`) is not one, so
//     signature matching skips shells and looks at comm + the first tokens only.
const SHELLS = new Set(['bash', 'sh', 'zsh', '-zsh', 'dash', 'fish', 'csh', 'tcsh', 'ksh']);
const SIGNATURES = [
  [/@deepseek-ai\/dsh|dsh\/lib\/bin\.js|\.dsh\/profiles\/.*bin\.js|\bdsh web\b/, 'dsh'],
  [/openclaw/i, 'openclaw'],
  [/remote-agent\b.*(start|daemon|fleet|focus)|(^|\/)remote-agent\.js\b/, 'remote-agent'],
  [/@anthropic-ai\/claude-code|\bclaude(-code)?\b/i, 'claude-code'],
  [/@openai\/codex|\bcodex\b/i, 'codex'],
  [/\baider\b/i, 'aider'],
  [/\bgoose\b/i, 'goose'],
  [/\bopencode\b/i, 'opencode'],
  [/gemini-cli|@google\/gemini/i, 'gemini-cli'],
  [/cursor-agent|@cursor\//i, 'cursor-agent'],
  [/\bcline\b|\bcontinue-dev\b|@continuedev/i, 'cline/continue'],
  [/ollama (run|serve)|lms\b|lm-?studio/i, 'local-llm'],
  [/\bautogen\b|autogenstudio/i, 'autogen'],
  [/\bcrewai\b/i, 'crewai'],
  [/\blanggraph\b|langserve/i, 'langgraph'],
  [/mcp-server|@modelcontextprotocol|mcp\b[^\n]*\bserve\b/i, 'mcp-server'],
  [/swe-?agent|openhands|devika|gpt-engineer|smol-developer/i, 'coding-agent'],
  [/browser-use|browser_use|stagehand|skyvern/i, 'browser-agent'],
  [/\bn8n\b|\bdify\b|flowise/i, 'agent-platform'],
  [/autogpt|auto-gpt|babyagi|agent-zero|\bletta\b|memgpt|\beliza\b/i, 'autonomous-agent'],
];
// A NEW agent is caught by name, not only by the list above: whatever it is called,
// "agent", "-ai", "llm", "bot", "copilot", "assistant", "mcp" in the executable name
// is an agent until proven otherwise. Shells are excluded, and a system path is never
// claimed (see detectAgents) so `systemd-agent` style OS helpers stay out.
// Full words anywhere in the name (newagent, helperbot, my-llm-hub), and `ai`/`bot`
// as separate tokens only — "Main", "Mail" and "Safari" must not become agents. Every
// hit carries its reason (`name:<comm>`) so a wrong guess is visible and correctable.
const AGENT_NAME = /(agent|assistant|copilot|chatbot|llm|mcp)|(^|[-_.])(ai|bot)([-_.]|$)|bot$/i;
const SYSTEM_PATH = /^\/(System|usr\/(bin|libexec|lib|sbin|share)|bin|sbin|Library\/Apple|private)\b/;
const POSSIBLE = /(agent|assistant|\bllm\b|\bgpt\b|\bchat\b)/i;
const RUNTIMES = new Set(['node', 'python', 'python3', 'bun', 'deno', 'ruby', 'java', 'bash', 'sh', 'zsh', 'fish', 'env']);
const REGISTRY_FILE = 'agents.json'; // ~/.remote-agent/agents.json — your own agents

function registryEntries() {
  try {
    const j = JSON.parse(readFileSync(join(HOME, REGISTRY_FILE), 'utf8'));
    const list = Array.isArray(j) ? j : (Array.isArray(j.agents) ? j.agents : []);
    return list.filter((e) => e && (e.match || e.id)).map((e) => ({ ...e, re: e.match ? new RegExp(e.match, 'i') : null }));
  } catch { return []; }
}

/** Detect agents in a process table. `scan` is the raw ps map/list from the sampler. */
export function detectAgents(scan = sampler.readProcs()) {
  const rows = Array.isArray(scan) ? scan : [...scan.values()];
  const custom = registryEntries();
  const out = [];
  for (const r of rows) {
    const comm = String(r.comm ?? '').split('/').pop();
    const args = String(r.args ?? '');
    const head = args.split(' ').slice(0, 3).join(' ');
    const hit = (() => {
      for (const e of custom) if (e.re && e.re.test(args)) return { by: `registry:${e.id ?? e.name ?? 'agent'}`, confidence: 'known' };
      if (SHELLS.has(comm)) return null; // a shell that mentions an agent is not one
      const target = `${comm} ${head}`;
      for (const [re, id] of SIGNATURES) if (re.test(target)) return { by: `signature:${id}`, confidence: 'known' };
      if (RUNTIMES.has(comm) && / -e | --eval /.test(args)) return null; // a one-liner is not an agent
      const bin = args.split(' ')[0] || '';
      if (AGENT_NAME.test(comm) && !SYSTEM_PATH.test(bin)) return { by: `name:${comm}`, confidence: 'known' };
      if (RUNTIMES.has(comm) && POSSIBLE.test(args)) return { by: 'heuristic:agent-ish runtime', confidence: 'possible' };
      return null;
    })();
    if (hit) {
      out.push({
        ...hit, pid: r.pid, name: comm || `pid ${r.pid}`, args, mb: r.rssMB ?? 0, user: r.user,
        // what a manager needs: the executable to start it again
        bin: (args.split(' ')[0] || '').trim(),
      });
    }
  }
  // Registry entries that are not local processes: a remote or not-yet-started agent.
  const external = custom
    .filter((e) => !out.some((o) => o.by === `registry:${e.id ?? e.name ?? 'agent'}`))
    .map((e) => ({ id: e.id ?? e.name, name: e.name ?? e.id, kind: 'external', role: e.role ?? 'registered',
      host: e.host ?? null, port: e.port ?? null, command: e.command ?? null, auto: e.auto === true,
      note: e.note ?? null, confidence: 'known',
      actions: e.host ? ['probe'] : (e.command ? ['start'] : []) }));
  return { agents: out, external, scanned: rows.length, custom: custom.length };
}

function processAgents(running = []) {
  const live = new Map(running.map((r) => [Number(r.pid), r]));
  const { agents, external, scanned, custom } = detectAgents();
  const local = agents.map((a) => {
    const c = live.get(Number(a.pid));
    return {
      id: `proc:${a.pid}`, name: a.name || `pid ${a.pid}`, kind: 'process',
      role: a.confidence === 'known' ? 'agent process' : 'possible agent',
      status: sampler.paused?.has?.(Number(a.pid)) ? 'paused' : 'running',
      pid: a.pid, cpu: c?.cpu ?? 0, mb: c?.mb ?? a.mb,
      match: a.by, confidence: a.confidence, user: a.user,
      // What it is doing right now: the command line, trimmed.
      activity: String(a.args ?? '').slice(0, 160) || null,
      actions: ['stop'],
    };
  });
  processAgents.scan = { scanned, matched: agents.length, custom };
  return [...local, ...external.map((e) => ({ ...e, confidence: 'known' }))];
}

// ── auto-registration ───────────────────────────────────────────────────────
// "Whatever new agent I install, remote-agent manages it" only holds if detection
// leaves something behind. Every detected agent process whose binary is not yet known
// is written to the registry ONCE (with the path to start it again), so it survives
// restarts, shows up as a first-class roster entry and can be run/stopped like any
// other. Self-written entries are marked auto and never overwrite a hand-written one.
const AUTO_MAX = Number(process.env.REMOTE_AGENT_AUTO_MAX ?? 60);

const AUTO_JUNK = /(^|\/)(node|python3?|bash|sh|zsh|ssh-agent|gpg-agent|SafeEjectGPUAgent)$/;
/** An auto entry is stale when it is junk, or when a SIGNATURE already owns that
 *  agent — a learned entry must never shadow what detection knows by itself. */
function staleAuto(e) {
  if (e.auto !== true) return false;                       // hand-written entries are never touched
  const base = String(e.command || e.match || '').split(/[\s/]/).pop() || '';
  if (AUTO_JUNK.test(base)) return true;
  const target = `${base} ${e.command || ''}`;
  return SIGNATURES.some(([re]) => re.test(target));
}
export function autoRegister({ agents = [], dryRun = false } = {}) {
  const known = registryEntries().filter((e) => !staleAuto(e));
  const knownRe = known.map((e) => e.match || '').filter(Boolean);
  const add = [];
  for (const a of agents) {
    // Only a NAME match is a new agent. A signature hit is already known, and a
    // heuristic hit is a guess — neither belongs in the registry. Measured: an
    // earlier looser rule adopted /usr/local/bin/node, ssh-agent and
    // SafeEjectGPUAgent, which would have made "node" itself look like an agent.
    if (!String(a.by || '').startsWith('name:')) continue;
    if (a.confidence !== 'known') continue;
    if (!a.bin || SYSTEM_PATH.test(a.bin)) continue;
    const base = a.bin.split('/').pop().toLowerCase();
    if (RUNTIMES.has(base) || SHELLS.has(base)) continue;     // an interpreter is not an agent
    // OS helpers that merely happen to be called *agent*: exact names only. Measured:
    // an unanchored `agent$` here rejected `newagent` — the exact case this rule exists
    // to catch — while the test still "passed" because the entry was simply absent.
    if (/^(ssh|gpg|polkit|keychain|secrets?)-?agent$|^agent$/i.test(base)) continue;
    if (/remote-agent|node_modules\/\.bin/.test(a.bin)) continue;
    const esc = a.bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (knownRe.some((m) => { try { return new RegExp(m, 'i').test(a.bin); } catch { return false; } })) continue;
    if (add.some((x) => x.command === a.bin)) continue;
    add.push({
      id: `auto-${(a.name || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`,
      name: a.name, match: esc, command: a.bin, auto: true,
      note: 'detected running on this device — edit or delete this entry freely',
      firstSeen: new Date().toISOString(),
    });
  }
  const next = [...known.map(({ re, ...e }) => e), ...add].slice(0, AUTO_MAX);
  // Rewrite when something was added OR when a previous looser rule left junk behind —
  // measured: an early run adopted node/ssh-agent/SafeEjectGPUAgent into the registry.
  const before = registryEntries();
  const cleaned = next.length !== before.length;
  if ((add.length || cleaned) && !dryRun) {
    try {
      writeFileSync(join(HOME, REGISTRY_FILE), JSON.stringify({ agents: next }, null, 2));
      auditWrite({ kind: 'agents', action: 'auto-register', count: add.length, ids: add.map((a) => a.id).join(','), verdict: 'allow' });
    } catch { /* a full disk must not break the roster */ }
  }
  return { added: add, registry: next, dryRun };
}

/** The whole roster: skills + daemon + peers + every agent process we can prove. */
export function listAgents({ running = [] } = {}) {
  const detected = detectAgents();
  if (!listAgents._autoregistered) {           // once per process, not per tick
    listAgents._autoregistered = true;
    try { autoRegister({ agents: detected.agents }); } catch { /* registry optional */ }
  }
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

/** What policy is actually in force here — the console shows it instead of asserting it.
 *  Measured: asking the live policy about itself via check() writes an audit entry,
 *  and the dashboard asks every tick — ~43k junk entries a day. So the posture is
 *  read from a copy with auditing off: same decision logic, no log spam. */
export function policyPosture() {
  let p = null;
  try { p = Policy.load(); } catch { /* unreadable policy reads as unknown */ }
  if (!p) return { source: 'unreadable', fleetTier: 'deny', audit: false };
  const probe = p.auditEnabled ? new Policy({ ...p.raw, audit: false }) : p;
  const v = probe.check('fleet', { action: 'inspect' });
  return {
    source: p.raw && Object.keys(p.raw).length ? 'policy file' : 'built-in defaults',
    fleetTier: p.toolTier?.('fleet') ?? (v.allowed ? 'allow' : v.tier),
    audit: p.auditEnabled !== false, auditPath: p.auditPath ?? null,
    maxSteps: p.maxSteps ?? null, dailyTokens: p.dailyTokens ?? null,
  };
}

/** The last things that actually happened on this device: every audited action,
 *  newest first — the runtime's own "what is doing what" (the DSH side has its
 *  own transcript feed on the :3099 dashboard). Tail read, never the whole log. */
export function activityLog(limit = 40) {
  const path = policyPosture().auditPath;
  if (!path || !existsSync(path)) return [];
  try {
    const fd = openSync(path, 'r');
    let text;
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, 131072);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { closeSync(fd); }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        out.push({
          at: r.ts ? Date.parse(r.ts) : null, seq: r.seq ?? null, kind: r.kind ?? 'audit',
          what: r.tool ?? r.action ?? r.sid ?? '—', verdict: r.verdict ?? (r.refused ? 'refused' : r.ok === false ? 'failed' : null),
          reason: r.reason ?? r.why ?? null, pid: r.pid ?? null,
        });
      } catch { /* partial first line of the window */ }
    }
    return out.slice(-limit).reverse();
  } catch { return []; }
}

// Public policy surface for the console: the same gate the roster uses, plus a
// dry-run explainer and a tier reader, so the UI can show what WOULD happen.
export function gate(action, id) { return policyGate(action, id); }

export function explain(tool, args = {}) {
  try {
    const p = Policy.load();
    const probe = p.auditEnabled ? new Policy({ ...p.raw, audit: false }) : p;
    const e = probe.explain(tool, args);
    return { tool, tier: e.tier, allowed: e.tier === 'allow', reason: e.decision ?? e.matched ?? '', policyPath: e.policyPath ?? null };
  } catch (err) { return { tool, tier: 'deny', allowed: false, reason: `policy unreadable: ${String(err?.message ?? err)}` }; }
}

export function tierOf(tool) {
  try { return Policy.load().toolTier(tool); } catch { return 'deny'; }
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
  const entry = registryEntries().find((e) => (e.id ?? e.name) === id);
  if (entry?.command) {
    const parts = String(entry.command).trim().split(/\s+/);
    const child = spawnFn(parts[0], parts.slice(1), { detached: true, stdio: 'ignore' });
    child.unref?.();
    return { ok: true, message: `started ${entry.name ?? id} (pid ${child.pid ?? '?'})` };
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

// --- runtime sessions (every agent runtime on this device) -----------------
// The registry is async and reads other runtimes' stores, so it is refreshed on a
// timer and the per-tick snapshot only reads this cache — a slow or broken runtime
// store must never stall the dashboard.
let runtimeCache = { at: 0, sessions: [], activity: [], coverage: [], summary: null, error: null };

export async function refreshRuntimes() {
  try {
    // One collect() for all of it: the registry caches the payload, and the watchdog
    // plus the per-runtime fairness counts must reach the UI, not stay in the child.
    const c = await collect();
    runtimeCache = {
      at: c.at ?? Date.now(), sessions: c.sessions ?? [], activity: c.activity ?? [],
      coverage: c.coverage ?? [], summary: c.summary ?? null,
      watch: c.watch ?? null, perRuntime: c.perRuntime ?? [], errors: c.errors ?? [],
      error: c.error ?? null,
    };
  } catch (e) {
    runtimeCache = { ...runtimeCache, at: Date.now(), error: String(e?.message ?? e) };
  }
  return runtimeCache;
}

/** Last known runtime state (sync, safe inside the 2 s tick). */
export function runtimeState() {
  return runtimeCache;
}

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
    activity: activityLog(40),
    runtime: runtimeState(),
    models: llms.models, modelsError: llms.error, anyModelConfigured: llms.anyConfigured,
    counts: {
      all: agents.length,
      running: agents.filter((a) => a.status === 'running' || a.status === 'paused').length,
      skills: agents.filter((a) => a.kind === 'skill').length,
      enabled: agents.filter((a) => a.status === 'enabled').length,
      detected: agents.filter((a) => a.kind === 'process' || a.kind === 'external').length,
      possible: agents.filter((a) => a.confidence === 'possible').length,
      scanned: processAgents.scan?.scanned ?? null,
      sessions: runtimeCache.sessions.length,
      sessionsRunning: runtimeCache.sessions.filter((s) => s.status === 'running').length,
      todoItems: runtimeCache.sessions.reduce((n, s) => n + (s.todos?.length ?? 0), 0),
      devices: live.length,
      devicesOnline: live.filter((d) => d.online === true).length,
    },
    agents, devices: live,
  };
}
