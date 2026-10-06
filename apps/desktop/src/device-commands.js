// device-commands — the DEVICE half of the console control channel.
//
// The cloud cannot reach a device behind NAT (no WS relay on the control plane,
// control.js sets #wsSkipped), so a command queued on remoteagent.online is
// picked up here by the daemon's own poll, executed with the SAME functions the
// local dashboard uses, and reported back. Local policy decides first: a command
// this device refuses is reported `refused` with the device's own reason, and the
// cloud can never widen what the machine allows. Every command lands in the
// hash-chained audit log.
//
//   runDeviceCommand({action, payload, id, deps}) → {status, result}
//   pollDeviceCommands({apiKey, log, deps})       → in-flight guarded poll + report
import { pollCommands, reportCommand } from './cloud.js';
import { startAgent, stopAgent, deviceAction } from './agent-catalog.js';
import * as sampler from './device-sampler.js';
import { securityAction, playgroundRun } from './fleet-console.js';
import { Policy, selectGroup, auditWrite } from '@remote-agent/engine';

const NOOP = { info() {}, debug() {}, warn() {} };

// ── the policy gate, on ONE Policy instance held across polls ──────────────
// policy.js builds a NEW RateLimiter per Policy instance (policy.js:412), so the
// per-command Policy.load() the catalog does resets the fleet budget (standard
// policy: 30/min) and would leave cloud-triggered control unthrottled. One held
// instance accumulates its `hits`; a real edit to the policy file swaps it, so a
// tightened policy takes effect on the next command instead of going stale.
let heldPolicy = null;

function policy() {
  const fresh = Policy.load();
  if (!heldPolicy || JSON.stringify(heldPolicy.raw) !== JSON.stringify(fresh.raw)) heldPolicy = fresh;
  return heldPolicy;
}

/** The same capability, semantics and reason text as agent-catalog's gate(). */
function gate(action, id) {
  try {
    const v = policy().check('fleet', { action, id });
    return { ok: v.allowed === true, tier: v.tier, reason: v.reason };
  } catch (e) {
    return { ok: false, tier: 'deny', reason: `policy unreadable: ${String(e?.message ?? e)}` };
  }
}

// ── device rate ceiling ───────────────────────────────────────────────────
// A backstop no policy file can raise: above 30 executed commands a minute the
// device itself refuses, whatever `rateLimits.fleet.perMinute` says (a permissive
// policy declares none at all). The cloud can never spend a budget this device set.
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60_000;
let commanded = [];

function rateLimitReason() {
  const now = Date.now();
  commanded = commanded.filter((t) => now - t < RATE_WINDOW_MS);
  return commanded.length >= RATE_MAX ? `device rate limit: ${commanded.length} commands in the last minute` : null;
}

// Every side effect goes through this object, so a test drives the whole
// executor with stubs and nothing is spawned, signalled or written.
const DEPS = { gate, startAgent, stopAgent, deviceAction, sampler, securityAction, playgroundRun, selectGroup, auditWrite };

// Actions the wire contract defines but this client version does not implement.
// Refused out loud with one honest reason — never a fake ok.
const UNSUPPORTED = new Set(['agent.cancel', 'chat.send']);
const NOT_SUPPORTED = 'not supported by this client version';

const refuse = (reason) => ({ status: 'refused', result: { reason } });

/** A required string field of an untrusted payload. */
const nonEmpty = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A pid we are willing to signal: an integer > 1, never pid 1 or this daemon. */
function pidOf(v) {
  const n = Number(v);
  if (!Number.isInteger(n)) return { reason: 'pid must be an integer' };
  if (n <= 1) return { reason: `refusing pid ${n}: pid 1 is the init system` };
  if (n === process.pid) return { reason: 'refusing this process: the daemon itself' };
  return { pid: n };
}

/** The verdict of a call that returns the dashboard's {ok, message, denied} shape. */
function outcomeOf(r) {
  const result = r && typeof r === 'object' ? r : { value: r ?? null };
  const status = r && r.ok === false ? (r.denied ? 'refused' : 'failed') : 'done';
  if (status === 'refused' && !result.reason) result.reason = result.message || 'refused';
  if (status === 'failed' && !result.error) result.error = result.message || 'failed';
  return { status, result };
}

/** pause/resume answer {paused|resumed, refused|failed} instead of ok. */
function signalOutcome(r, doneKey, deniedKey) {
  const act = r?.[doneKey] ?? [];
  const denied = r?.[deniedKey] ?? [];
  if (denied.length && !act.length) {
    return { status: 'refused', result: { ...r, reason: denied.map((x) => `${x.pid}: ${x.why ?? 'refused'}`).join('; ') } };
  }
  return { status: 'done', result: r };
}

// ── the action map (payload fields are untrusted cloud input) ──────────────
async function execute(action, p, d) {
  switch (action) {
    case 'agents.run': {
      const id = nonEmpty(p.id);
      return id ? outcomeOf(await d.startAgent(id)) : refuse('id must be a non-empty string');
    }
    case 'agents.stop': {
      const id = nonEmpty(p.id);
      return id ? outcomeOf(await d.stopAgent(id)) : refuse('id must be a non-empty string');
    }
    case 'devices.action': {
      const id = nonEmpty(p.id), what = nonEmpty(p.action);
      return id && what
        ? outcomeOf(await d.deviceAction(id, what))
        : refuse('id and action must be non-empty strings');
    }
    case 'mode':
      return outcomeOf(await d.sampler.applyMode(String(p.mode), d.sampler.sample()));
    case 'gate':
      return outcomeOf(d.sampler.setGate(p));
    case 'pause': {
      if (p.pid === undefined || p.pid === null) {
        const pids = d.selectGroup(nonEmpty(p.target) ?? 'agents', d.sampler.sample().rows);
        return signalOutcome(d.sampler.pausePids(pids), 'paused', 'refused');
      }
      const pid = pidOf(p.pid);
      return pid.pid ? signalOutcome(d.sampler.pausePids([pid.pid]), 'paused', 'refused') : refuse(pid.reason);
    }
    case 'resume': {
      if (p.pid === undefined || p.pid === null) return signalOutcome(d.sampler.resumeAll(), 'resumed', 'failed');
      const pid = pidOf(p.pid);
      return pid.pid ? signalOutcome(d.sampler.resumePids([pid.pid]), 'resumed', 'failed') : refuse(pid.reason);
    }
    case 'renice': {
      const pid = pidOf(p.pid);
      if (!pid.pid) return refuse(pid.reason);
      // Only a finite integer ever reaches renice's argv — never `-p` or a flag.
      const nice = Number.isFinite(Number(p.nice)) ? Math.trunc(Number(p.nice)) : 20;
      return outcomeOf(d.sampler.renicePid(pid.pid, nice));
    }
    case 'kill': {
      const pid = pidOf(p.pid);
      if (!pid.pid) return refuse(pid.reason);
      const signal = /^SIG[A-Z0-9]{1,10}$/.test(String(p.signal)) ? String(p.signal) : 'SIGTERM';
      return outcomeOf(d.sampler.killPid(pid.pid, signal));
    }
    case 'security.action': {
      const what = nonEmpty(p.action);
      return what ? outcomeOf(await d.securityAction(what)) : refuse('action must be a non-empty string');
    }
    case 'playground.run': {
      const tool = nonEmpty(p.tool);
      if (!tool) return refuse('tool must be a non-empty string');
      return outcomeOf(await d.playgroundRun({ tool, args: p.args ?? {}, dryRun: p.dryRun ?? true }));
    }
    default:
      if (UNSUPPORTED.has(action)) return refuse(NOT_SUPPORTED);
      return refuse(`unknown action "${action}"`);
  }
}

/**
 * Execute one queued console command on THIS device, under THIS device's policy.
 * Never throws: a denial, an unknown action and a broken executor all come back
 * as a reported {status, result} the console renders instead of a fake success.
 */
export async function runDeviceCommand({ action, payload, id, deps } = {}) {
  const d = deps ? { ...DEPS, ...deps } : DEPS;
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const name = String(action ?? '');
  let verdict;
  try {
    // Local policy decides first — the cloud never widens what this device allows.
    const g = d.gate(name, JSON.stringify(p).slice(0, 120));
    if (!g?.ok) {
      verdict = refuse(`policy (${g?.tier ?? 'deny'}): ${g?.reason ?? 'denied'}`);
    } else {
      const capped = rateLimitReason();
      if (capped) verdict = refuse(capped);
      else { commanded.push(Date.now()); verdict = await execute(name, p, d); }
    }
  } catch (error) {
    verdict = { status: 'failed', result: { error: String(error?.message ?? error) } };
  }
  try { d.auditWrite({ kind: 'device.command', action: name, id: id ?? p.id ?? null, verdict: verdict.status }); } catch { /* audit must never break the channel */ }
  return verdict;
}

let inFlight = false;

/**
 * Poll the cloud command queue once: execute and report every offered command.
 * In-flight guarded, so a slow executor never stacks a second poll on top, and
 * an unreachable cloud is a log line — never a thrown error that stops the daemon.
 */
export async function pollDeviceCommands({ apiKey, log = NOOP, deps } = {}) {
  if (inFlight) return { skipped: 'in-flight' };
  inFlight = true;
  try {
    const data = await pollCommands(apiKey);
    const counts = { done: 0, failed: 0, refused: 0 };
    for (const cmd of Array.isArray(data?.commands) ? data.commands : []) {
      if (!cmd || !Number.isInteger(cmd.id)) { log.debug?.('Skipping malformed command row'); continue; }
      const { status, result } = await runDeviceCommand({ action: cmd.action, payload: cmd.payload, id: cmd.id, deps });
      counts[status] = (counts[status] ?? 0) + 1;
      log.info?.(`Command ${cmd.id} ${cmd.action} → ${status}`);
      // Reported even when refused: the console shows the device's own verdict.
      await reportCommand(apiKey, cmd.id, { status, result }).catch((error) => log.debug?.(`Command ${cmd.id} result report failed: ${error.message}`));
    }
    return counts;
  } catch (err) {
    log.debug?.(`Command poll failed: ${err?.message ?? err}`);
    return { error: String(err?.message ?? err) };
  } finally {
    inFlight = false;
  }
}
