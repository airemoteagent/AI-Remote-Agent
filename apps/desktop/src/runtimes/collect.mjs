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
const ADAPTER_MS = Number(process.env.RUNTIME_ADAPTER_MS ?? 8000);
const LIMIT = Number(process.env.RUNTIME_LIMIT ?? 150);

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


// ── detection watchdog ──────────────────────────────────────────────────────
// "Always detects everything" cannot be a promise, so it is a measurement: for each
// known store, compare the newest file WRITTEN on disk with the newest session that
// runtime actually reported. If the disk moved and the roster did not, that is a
// miss, it is named with its path and its lag, and it shows up on the dashboard.
// Ground truth is the filesystem, not the adapter's own opinion of itself.
import { homedir } from 'node:os';
import { statSync as statSyncW, readdirSync as readdirSyncW } from 'node:fs';

const HOME_DIR = process.env.HOME || homedir();
const WATCH_STORES = [
  { id: 'dsh-projections', root: `${HOME_DIR}/.dsh/storages/session_projcache/sessions`, ext: '.json', depth: 0, runtime: 'dsh' },
  { id: 'dsh-transcripts', root: `${HOME_DIR}/.dsh/sessions`, ext: '.zstd', depth: 3, runtime: 'dsh' },
  { id: 'openclaw-transcripts', root: `${HOME_DIR}/.openclaw/agents`, ext: '.jsonl', depth: 3, runtime: 'openclaw' },
  { id: 'claude-transcripts', root: `${HOME_DIR}/.claude/projects`, ext: '.jsonl', depth: 2, runtime: 'claude-code' },
  { id: 'codex-sessions', root: `${HOME_DIR}/.codex/sessions`, ext: '.jsonl', depth: 3, runtime: 'codex' },
];

function newestUnder(root, ext, depth, cap = 4000) {
  let newest = 0, newestFile = null, seen = 0;
  const walk = (dir, d) => {
    if (seen > cap) return;
    let entries = [];
    try { entries = readdirSyncW(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (seen++ > cap) return;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (d < depth) walk(p, d + 1); continue; }
      if (ext && !e.name.endsWith(ext)) continue;
      try { const m = statSyncW(p).mtimeMs; if (m > newest) { newest = m; newestFile = p; } } catch { /* vanished */ }
    }
  };
  walk(root, 0);
  return { at: newest || null, file: newestFile, scanned: seen };
}

function watchDetection(sessions) {
  const stores = [];
  const misses = [];
  for (const st of WATCH_STORES) {
    const { at, file, scanned } = newestUnder(st.root, st.ext, st.depth);
    if (!at) { stores.push({ ...st, at: null, scanned, newestSessionAt: null, lagMs: null }); continue; }
    const forRuntime = sessions.filter((x) => (x.runtime || '').includes(st.runtime.split('-')[0]));
    const newestSessionAt = forRuntime.reduce((m, x) => Math.max(m, x.updatedAt ?? 0), 0) || null;
    const lagMs = newestSessionAt ? at - newestSessionAt : null;
    stores.push({ id: st.id, runtime: st.runtime, at, file, scanned, newestSessionAt, lagMs, sessions: forRuntime.length });
    if ((!newestSessionAt || lagMs > 120000) && Date.now() - at < 30 * 60 * 1000) {
      misses.push({ store: st.id, runtime: st.runtime, file, diskAt: at, newestSessionAt, lagMs });
    }
  }
  return { at: Date.now(), stores, misses };
}

// Fair per-runtime selection. A flat cap let two chatty runtimes bury the rest:
// measured — with 40 "discovered stores" + 12 openclaw + 9 process rows, the 182 DSH
// sessions and 124 subsessions fell off the end of a 60-item list and the console
// showed "no DSH sessions" while the store was writing every second. Every runtime now
// gets up to PER_RUNTIME slots before the global cap applies, so no runtime can be
// crowded out, whatever the others do.
const PER_RUNTIME = Number(process.env.RUNTIME_PER ?? 15);
// A session with a parent is a real session (a subsession), not a synthetic process row.
const weight = (s) => (s.objective || s.parent || (s.files?.length ?? 0) || (s.todos?.length ?? 0) ? 0 : 1);
const byRuntime = new Map();
for (const s of out.sessions) {
  const key = s.runtime ?? 'unknown';
  if (!byRuntime.has(key)) byRuntime.set(key, []);
  byRuntime.get(key).push(s);
}
const picked = [];
for (const list of byRuntime.values()) {
  // Within one runtime: strictly newest first. Weighting here let a parent session
  // without a goal be replaced by its own older subsessions and the watchdog then
  // reported the store as unread (measured: lag 1547 s with the data right there).
  list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  picked.push(...list.slice(0, PER_RUNTIME));
}
picked.sort((a, b) => weight(a) - weight(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
out.sessions = picked.slice(0, LIMIT);
out.perRuntime = [...byRuntime.entries()].map(([id, l]) => ({ id, total: l.length, shown: Math.min(l.length, PER_RUNTIME) }));
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
out.watch = watchDetection(out.sessions);
out.tookMs = Date.now() - out.at;
process.stdout.write(JSON.stringify(out));
