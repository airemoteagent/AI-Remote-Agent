// Runtime collector — runs every adapter OUT OF PROCESS and prints one JSON blob.
//
// Why a separate process: an adapter reads another agent's store with sync fs/ps
// work (one measured adapter took 13 s just to import). Run in the dashboard's
// event loop, that wedges the whole control plane: the port stays bound and every
// request times out. Here the damage is bounded by the parent's execFile timeout.
//
// Per-adapter budget: an adapter slower than ADAPTER_MS is reported and skipped, so
// one bad runtime cannot starve the rest. Any throw becomes data, never a crash.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = new Set(['index.js', 'collect.mjs']);
const ADAPTER_MS = Number(process.env.RUNTIME_ADAPTER_MS ?? 4000);
const LIMIT = Number(process.env.RUNTIME_LIMIT ?? 60);

const files = readdirSync(HERE).filter((f) => f.endsWith('.js') && !SELF.has(f) && !f.startsWith('_'));

const withBudget = (fn, ms, label) => {
  const t = Date.now();
  try {
    const v = fn();
    const took = Date.now() - t;
    return { v, took, error: took > ms ? `${label} took ${took}ms (budget ${ms}ms)` : null };
  } catch (e) {
    return { v: null, took: Date.now() - t, error: String(e?.message ?? e) };
  }
};

const out = { at: Date.now(), runtimes: [], sessions: [], activity: [], errors: [] };

for (const f of files) {
  const id = f.replace(/\.js$/, '');
  let mod;
  try {
    mod = await import(pathToFileURL(join(HERE, f)).href);
  } catch (e) {
    out.errors.push(`${id}: import failed: ${String(e?.message ?? e)}`);
    out.runtimes.push({ id, label: id, verified: false, sessions: 0, running: 0, error: 'import failed' });
    continue;
  }
  const verified = mod.verified !== false;
  const got = verified
    ? withBudget(() => mod.sessions?.({ limit: LIMIT }) ?? [], ADAPTER_MS, `${id}.sessions()`)
    : { v: [], took: 0, error: null };
  const sessions = Array.isArray(got.v) ? got.v : [];
  if (got.error) out.errors.push(`${id}: ${got.error}`);
  out.sessions.push(...sessions.map((s) => ({ ...s, runtime: mod.id ?? id, runtimeLabel: mod.label ?? id, runtimeVerified: verified })));
  const summary = verified ? withBudget(() => mod.summary?.() ?? { sessions: sessions.length }, ADAPTER_MS, `${id}.summary()`) : { v: null, error: null };
  out.runtimes.push({
    id: mod.id ?? id, label: mod.label ?? id, verified,
    sessions: sessions.length, running: summary.v?.running ?? sessions.filter((s) => s.status === 'running').length,
    todos: summary.v?.todos ?? sessions.reduce((n, s) => n + (s.todos?.length ?? 0), 0),
    ms: got.took, error: got.error ?? summary.error ?? null,
  });
  if (verified && typeof mod.activity === 'function') {
    const act = withBudget(() => mod.activity?.({ limit: 30 }) ?? [], ADAPTER_MS, `${id}.activity()`);
    if (Array.isArray(act.v)) out.activity.push(...act.v.map((a) => ({ ...a, agent: mod.id ?? id })));
    if (act.error) out.errors.push(`${id}: ${act.error}`);
  }
}

// A runtime that reports processes rather than stored sessions must not push real
// sessions off the top of the list.
const weight = (s) => (s.objective || (s.files?.length ?? 0) || (s.todos?.length ?? 0) ? 0 : 1);
out.sessions.sort((a, b) => weight(a) - weight(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
out.sessions = out.sessions.slice(0, LIMIT);
out.activity = out.activity.filter((a) => a && a.at).sort((a, b) => b.at - a.at).slice(0, 80);
out.summary = {
  runtimes: out.runtimes.length,
  verified: out.runtimes.filter((r) => r.verified).length,
  withSessions: out.runtimes.filter((r) => r.sessions > 0).length,
  sessions: out.sessions.length,
  running: out.sessions.filter((s) => s.status === 'running').length,
  todos: out.sessions.reduce((n, s) => n + (s.todos?.length ?? 0), 0),
  lastAt: out.sessions.reduce((m, s) => Math.max(m, s.updatedAt ?? 0), 0) || null,
};
out.coverage = out.runtimes.map((r) => ({ id: r.id, label: r.label, verified: r.verified, sessions: r.sessions, running: r.running, ms: r.ms, error: r.error }));
out.tookMs = Date.now() - out.at;
process.stdout.write(JSON.stringify(out));
