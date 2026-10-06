// Runtime registry — one place that asks EVERY agent runtime on this device what it
// is doing. Each <runtime>.js in this directory is an adapter exporting:
//
//   export const id, label, verified
//   export function sessions({limit}) → [{ id, agent, title, objective, status, cwd,
//        updatedAt, todos:[{content,status}], action, files:[], source }]
//   export function summary() → { sessions, running, todos, lastAt }
//   export function activity?({limit}) → optional step feed (think/read/edit/run)
//
// Adapters are discovered from disk, so a new runtime becomes visible by dropping a
// file here — no edit to this file, no edit to the dashboard.
//
// Isolation: adapters run through collect.mjs in a CHILD process. Measured on this
// machine: one adapter took 13 s to import and its synchronous scan wedged the
// control plane — the port stayed bound while every request timed out. Out of
// process, a hung adapter costs a bounded wait, the last good answer stays on
// screen, and the reason is reported instead of hidden.
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COLLECT = join(HERE, 'collect.mjs');
const CACHE_MS = Number(process.env.RUNTIME_CACHE_MS ?? 15000);
const TIMEOUT_MS = Number(process.env.RUNTIME_TIMEOUT_MS ?? 60000);

const EMPTY = { at: 0, sessions: [], activity: [], coverage: [], summary: null, errors: [] };
let last = { ...EMPTY };
let inflight = null;

function collectOnce() {
  return new Promise((resolve) => {
    execFile(process.execPath, [COLLECT], { maxBuffer: 32 * 1048576, timeout: TIMEOUT_MS }, (err, stdout) => {
      // Report WHY, with the child's stderr tail: "Command failed" alone cost a
      // debugging round on a box where the child was killed by the old 20 s timeout.
      if (!stdout) {
        const why = err?.killed ? `collector killed after ${TIMEOUT_MS} ms (box too loaded?)` : String(err?.message ?? 'no output').split('\n')[0];
        const stderr = String(err?.stderr ?? '').trim().split('\n').slice(-2).join(' | ');
        return resolve({ error: `collector failed: ${why}${stderr ? ` — ${stderr}` : ''}` });
      }
      try {
        const parsed = JSON.parse(stdout);
        if (err) parsed.errors = [...(parsed.errors ?? []), `collector: ${String(err.message).split('\n')[0]}`];
        return resolve(parsed);
      } catch {
        return resolve({ error: 'collector emitted non-JSON' });
      }
    });
  });
}

/** Fresh runtime state, cached briefly. Never rejects; a failure keeps the last good. */
export async function collect({ force = false } = {}) {
  if (!force && last.at && Date.now() - last.at < CACHE_MS) return last;
  if (inflight) return inflight;
  inflight = collectOnce().then((r) => {
    inflight = null;
    if (r.error) return { ...last, error: r.error, staleAt: last.at || null };
    last = r;
    return last;
  }).catch((e) => {
    inflight = null;
    return { ...last, error: String(e?.message ?? e) };
  });
  return inflight;
}

export async function runtimes() {
  return (await collect()).coverage;
}
export async function allSessions() {
  return (await collect()).sessions;
}
export async function allActivity() {
  return (await collect()).activity;
}
export async function coverage() {
  return (await collect()).coverage;
}
export async function runtimeSummary() {
  const c = await collect();
  return c.summary ?? { runtimes: c.coverage.length, verified: 0, withSessions: 0, sessions: 0, running: 0, todos: 0, lastAt: null, errors: c.errors };
}
