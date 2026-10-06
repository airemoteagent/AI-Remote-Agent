// device-sampler — the OS glue for the deep-dive. It only talks to the OS
// (ps / lsof / sysctl / signals); every decision lives in @remote-agent/engine
// device-control so it stays unit-testable offline. Used by the `device` tool and
// the `focus` console, so both see exactly the same machine.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildCensus, parsePsOutput, parseLoadAvg, parseSwapUsage, planMode, isProtectedPid } from '@remote-agent/engine';

const DIR = process.env.REMOTE_AGENT_HOME || join(homedir(), '.remote-agent');
const PAUSE_FILE = join(DIR, 'focus-paused.json');
const GATE_FILE = join(DIR, 'focus-gate.json');
const AUDIT_FILE = join(DIR, 'focus-audit.jsonl');
const PORT_KEYS = [process.env.FOCUS_PORT, process.env.DSH_PORT, process.env.CTL_PORT, process.env.DASH_PORT, 18789].filter(Boolean).map(Number);

const audit = (a) => { try { mkdirSync(DIR, { recursive: true }); appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...a }) + '\n'); } catch { /* disk */ } };

// ── the arm/disarm switch the automatic controllers must honour ───────────
export function readGate() {
  try { return { cpuGuard: true, priority: true, ...JSON.parse(readFileSync(GATE_FILE, 'utf8')) }; }
  catch { return { cpuGuard: true, priority: true }; }
}
export function setGate(patch) {
  const next = { ...readGate(), ...patch, updatedAt: Date.now() };
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(GATE_FILE, JSON.stringify(next, null, 2)); } catch { /* disk */ }
  return next;
}

// ── the paused set (SIGSTOP survives a crash, so it is persisted) ─────────
export function loadPaused() {
  try { return new Map(Object.entries(JSON.parse(readFileSync(PAUSE_FILE, 'utf8')))); }
  catch { return new Map(); }
}
const savePaused = (m) => { try { mkdirSync(DIR, { recursive: true }); writeFileSync(PAUSE_FILE, JSON.stringify(Object.fromEntries(m))); } catch { /* disk */ } };
export const paused = loadPaused();

export function readProcs() {
  return parsePsOutput(execFileSync('ps', ['-Ao', 'pid=,ppid=,user=,nice=,state=,time=,rss=,args='], { encoding: 'utf8', maxBuffer: 32 * 1048576 }));
}
export function portOwners(ports = PORT_KEYS) {
  const s = new Set();
  for (const p of ports) {
    try { for (const pid of execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).split('\n')) if (pid.trim()) s.add(Number(pid)); }
    catch { /* nothing listening */ }
  }
  return s;
}
export function readSwap() {
  try { return parseSwapUsage(execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' })); }
  catch { try { return parseSwapUsage(execFileSync('cat', ['/proc/meminfo'], { encoding: 'utf8' })); } catch { return { total: 0, used: 0, free: 0 }; } }
}
export function readLoad() {
  try { return parseLoadAvg(execFileSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' })); }
  catch { try { return parseLoadAvg(execFileSync('cat', ['/proc/loadavg'], { encoding: 'utf8' }).split(' ').join(' ')); } catch { return []; } }
}

let prev = null, prevAt = 0;
/** One live census. CPU is a cputime delta between calls, so call it on a timer. */
export function sample({ minCpu = 0.3, minMb = 200 } = {}) {
  const cur = readProcs();
  const dt = prev ? Math.max(0.5, (Date.now() - prevAt) / 1000) : 1;
  const census = buildCensus(prev, cur, dt, { selfPid: process.pid, portOwners: portOwners(), paused: paused.keys(), minCpu, minMb });
  prev = cur; prevAt = Date.now();
  return census;
}

const protectedNow = () => { const s = portOwners(); s.add(process.pid); s.add(1); return s; };

export function pausePids(pids = []) {
  const prot = protectedNow();
  const done = [], refused = [];
  for (const pid of pids.map(Number)) {
    if (isProtectedPid(pid, { selfPid: process.pid, portOwners: prot })) { refused.push({ pid, why: 'protected' }); continue; }
    try { process.kill(pid, 'SIGSTOP'); paused.set(pid, { at: Date.now() }); done.push(pid); }
    catch (e) { refused.push({ pid, why: e.code || String(e.message) }); }
  }
  savePaused(paused); audit({ action: 'pause', done, refused });
  return { paused: done, refused };
}
export function resumePids(pids = []) {
  const done = [], failed = [];
  for (const pid of pids.map(Number)) {
    try { process.kill(pid, 'SIGCONT'); paused.delete(pid); done.push(pid); }
    catch (e) { failed.push({ pid, why: e.code || String(e.message) }); paused.delete(pid); }
  }
  savePaused(paused); audit({ action: 'resume', done });
  return { resumed: done, failed };
}
export function resumeAll() { return resumePids([...paused.keys()]); }

export function renicePid(pid, nice) {
  try { execFileSync('renice', [String(nice), '-p', String(pid)], { stdio: 'ignore' }); audit({ action: 'renice', pid, nice }); return { ok: true, pid: Number(pid), nice: Number(nice), note: 'unprivileged renice lowers priority only (raise needs root)' }; }
  catch (e) { return { ok: false, pid: Number(pid), message: String(e.stderr || e.message).slice(0, 200) }; }
}
export function killPid(pid, signal = 'SIGTERM') {
  if (protectedNow().has(Number(pid))) { audit({ action: 'kill', pid, refused: 'protected' }); return { ok: false, pid: Number(pid), message: 'protected: a control-surface port owner, this process, or launchd' }; }
  try { process.kill(Number(pid), signal); audit({ action: 'kill', pid, signal }); return { ok: true, pid: Number(pid), signal }; }
  catch (e) { return { ok: false, pid: Number(pid), message: String(e.message) }; }
}

/** Execute a declarative mode plan from device-control. */
export function applyMode(mode, census) {
  const plan = planMode(mode, { rows: census?.rows ?? [], paused: paused.keys() });
  if (plan.error) return { ok: false, message: plan.error };
  if (plan.gate) setGate({ ...plan.gate, mode });
  else setGate({ mode });
  const out = { ok: true, mode, note: plan.note, paused: [], resumed: [] };
  if (plan.resume === 'all') out.resumed = resumeAll().resumed;
  if (plan.pause?.length) out.paused = pausePids(plan.pause).paused;
  audit({ action: 'mode', mode, paused: out.paused.length, resumed: out.resumed.length });
  return out;
}
