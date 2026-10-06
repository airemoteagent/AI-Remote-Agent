// DSH runtime adapter — the sessions and SUBSESSIONS of the DeepSeek harness.
//
// This adapter was missing entirely, so the remoteagent console could not see the
// agent the user was actually typing into. Everything below was observed on this Mac:
//
//   ~/.dsh/storages/session_projcache/sessions/session-<uuid>.json
//     { record: { identity: { cwd }, rows: { <key>: { val: … } } } }
//     rows used here: title, goal{current:{id,objective,phase,roundsStarted,revision}},
//     sessionStats{turns,steps,lastTurn}, todos[{content,status}], plan{active},
//     contextPressure{pressureTokens,contextWindow}, agentPreset,
//     subagentCatalog{head:{values:[{childId,label,childCreatedAt,mode,version}]}}
//     → `subagentCatalog.head.values` IS the subsession list: one entry per child
//     session this one spawned. Measured on this box: 1685 projection files, so the
//     scan is bounded to the newest PROJECT_MAX by mtime.
//
//   ~/.dsh/sessions/<workspace>/session-<uuid>/session.v3.jsonl.zstd
//     the transcript (834 MB / 1710 files here). Deliberately NOT read here: one
//     decompression costs ~235 ms and the store is huge — the 3099 dashboard reads
//     the newest transcript tails for the step feed, this adapter stays metadata-only
//     so the roster stays cheap and never becomes the reason the console is slow.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const id = 'dsh';
export const label = 'DSH (DeepSeek harness)';
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROJ = process.env.DSH_PROJ || join(HOME, 'storages', 'session_projcache', 'sessions');
const PROJECT_MAX = Number(process.env.DSH_PROJECT_MAX ?? 60);
const ACTIVE_MS = 15 * 60 * 1000;

export const verified = (() => { try { return readdirSync(PROJ).length > 0; } catch { return false; } })();

// Measured: the store holds 1687 projections and the big ones carry whole prompts.
// Reading all of them cost more than the collector's per-adapter budget (4 s), so the
// adapter contributed nothing and the watchdog flagged the store as a MISS — the
// first real catch of the watchdog. Two bounds fix it: only files touched in the last
// FRESH_MS are read, and parsed projections are cached by mtime.
const FRESH_MS = Number(process.env.DSH_FRESH_MS ?? 7 * 24 * 60 * 60 * 1000);
const projCache = new Map(); // file -> { mtime, parsed }

function newestProjections() {
  let files = [];
  try { files = readdirSync(PROJ).filter((f) => f.endsWith('.json')); } catch { return []; }
  const since = Date.now() - FRESH_MS;
  const withTime = [];
  for (const f of files) {
    try {
      const st = statSync(join(PROJ, f));
      if (st.mtimeMs >= since) withTime.push({ f, mtime: st.mtimeMs });
    } catch { /* gone */ }
  }
  return withTime.sort((a, b) => b.mtime - a.mtime).slice(0, PROJECT_MAX);
}

function readProjection(file, mtime) {
  const hit = projCache.get(file);
  if (hit && hit.mtime === mtime) return hit.parsed;
  try {
    const rec = JSON.parse(readFileSync(join(PROJ, file), 'utf8')).record ?? {};
    const rows = rec.rows ?? {};
    const parsed = { rec, v: (k) => rows[k]?.val ?? null };
    if (projCache.size > 400) projCache.clear();
    projCache.set(file, { mtime, parsed });
    return parsed;
  } catch { return null; }
}

export function sessions({ limit = 40 } = {}) {
  const out = [];
  for (const { f, mtime } of newestProjections()) {
    const p = readProjection(f, mtime);
    if (!p) continue;
    const { v } = p;
    const id = f.replace(/^session-/, '').replace(/\.json$/, '');
    const goal = v('goal')?.current ?? null;
    const stats = v('sessionStats') ?? {};
    const todos = Array.isArray(v('todos')) ? v('todos') : [];
    const catalog = v('subagentCatalog')?.head?.values ?? [];
    const blank = v('sessionListMetadata')?.blank === true;
    if (blank && !stats.turns) continue; // an empty GUI tab is not a session
    const active = Date.now() - mtime < ACTIVE_MS;
    out.push({
      id, agent: 'dsh', runtime: id.startsWith('dsh') ? 'dsh' : 'dsh',
      title: v('title') || `session ${id.slice(0, 8)}`,
      objective: goal?.objective ?? null,
      status: active ? (Date.now() - mtime < 60_000 ? 'running' : 'quiet') : 'idle',
      cwd: p.rec.identity?.cwd ?? null,
      model: v('agentPreset') ?? null,
      updatedAt: mtime,
      todos: todos.map((t) => ({ content: t.content ?? t.text ?? '', status: t.status ?? '' })),
      planMode: v('plan')?.active === true,
      goalPhase: goal?.phase ?? null,
      rounds: goal?.roundsStarted ?? null,
      turns: stats.turns ?? null,
      steps: stats.steps ?? null,
      contextPct: v('contextPressure')?.contextWindow
        ? Math.round((v('contextPressure').pressureTokens / v('contextPressure').contextWindow) * 100) : null,
      subsessions: catalog.map((c) => ({ id: c.childId, label: c.label ?? null, at: c.childCreatedAt ?? null, mode: c.mode ?? null })),
      action: null, // the step feed lives in the transcript, read by the 3099 dashboard
      files: [],
      source: join(PROJ, f),
    });
    // Subsessions are sessions of their own: emit them so nothing hides behind a parent.
    for (const c of catalog) {
      out.push({
        id: `sub:${c.childId}`, agent: 'dsh-subagent', runtime: 'dsh',
        title: c.label || `subsession ${String(c.childId).slice(0, 8)}`,
        objective: v('title') ?? null, status: active ? 'running' : 'idle', cwd: p.rec.identity?.cwd ?? null,
        model: null, updatedAt: c.childCreatedAt ?? mtime, todos: [], planMode: false,
        parent: id, subsessions: [], action: null, files: [], source: join(PROJ, f),
      });
    }
  }
  // Newest first, but a parent renders before its children at the same timestamp.
  return out
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, limit);
}

export function summary() {
  const s = sessions({ limit: 200 });
  return {
    sessions: s.filter((x) => x.agent === 'dsh').length,
    subsessions: s.filter((x) => x.agent === 'dsh-subagent').length,
    running: s.filter((x) => x.status === 'running').length,
    todos: s.reduce((n, x) => n + x.todos.length, 0),
    lastAt: s.reduce((m, x) => Math.max(m, x.updatedAt ?? 0), 0) || null,
  };
}
