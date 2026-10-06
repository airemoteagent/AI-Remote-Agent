// Cursor Agent runtime adapter — `cursor-agent` / Cursor's Agents Window sessions,
// read from Cursor's own on-disk store. Never writes; never throws.
//
// EVIDENCE ON THIS MAC (2026-10-06, macOS, user `mona`) — Cursor is NOT installed:
//
//   $ ls -la ~/.cursor ~/.local/share/cursor-agent ~/Library/Application\ Support/Cursor
//   ls: /Users/mona/.cursor: No such file or directory
//   ls: /Users/mona/.local/share/cursor-agent: No such file or directory
//   ls: /Users/mona/Library/Application Support/Cursor: No such file or directory
//   $ which cursor-agent cursor ; ls -d /Applications/*Cursor*
//   (nothing; the only 'Cursor' hit on the box is Apple's own
//    /System/Library/…/CursorUIViewService — input-method UI, unrelated)
//   $ ls ~/.config | grep -i cursor
//   cagent            ← 4 KB, only .cagent_first_run + user-uuid: not a session store
//
// So `verified = false` here and sessions() is an empty list. Every shape below is
// documented, not observed on this host; an unreadable record is skipped, never guessed.
//
// SCHEMA — documented, NOT observed here. Sources:
//   https://jazzyalex.github.io/agent-sessions/guides/cursor-agent-local-history.html
//   https://github.com/jazzyalex/agent-sessions/blob/main/AgentSessions/Services/CursorSessionParser.swift
//   https://github.com/lpalbou/CursorDump/blob/main/docs/knowledge-base.md
//
//   ~/.cursor/projects/<project>/agent-transcripts/<session-uuid>/<session-uuid>.jsonl
//     JSONL, `role` at top level, Anthropic-style content blocks, no per-line timestamps:
//     {"role":"user","message":{"content":[{"type":"text","text":"<user_query>…</user_query>"}]}}
//     {"role":"assistant","message":{"content":[
//        {"type":"thinking","thinking":"…"} |
//        {"type":"text","text":"…"} |
//        {"type":"tool_use","name":"…","input":{…}} |
//        {"type":"tool_result","content":…}]}}
//     {"type":"turn_ended","status":"error","error":"…"}
//     <project> is the absolute cwd with '/' → '-' (/Users/mona/Repo/Codex-History →
//     Users-mona-Repo-Codex-History), so the cwd is decoded with a filesystem walk.
//     Subagent transcripts live one level deeper (<uuid>/subagents/<uuid>.jsonl) and are
//     deliberately not listed as top-level sessions.
//
//   ~/.cursor/chats/<workspace-hash>/<session-uuid>/store.db   (SQLite, metadata only)
//     meta(key TEXT, value TEXT) + blobs(id TEXT, data BLOB). Row meta.key='0' is a
//     hex-encoded JSON root record; conversation bodies are protobuf in `blobs` and are
//     NOT decoded here. Read with `sqlite3 -readonly` (no WAL/-shm side files written).
//
// Cursor keeps no todo store in either file: `todos` stays [] rather than inventing one.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const id = 'cursor-agent';
export const label = 'Cursor Agent';
const ROOT = process.env.CURSOR_HOME || join(homedir(), '.cursor');
/** Transcript + chat roots are the whole claim: without them this adapter reads nothing. */
export const verified = existsSync(join(ROOT, 'projects')) || existsSync(join(ROOT, 'chats'));

const MAX_FILE = 20 * 1048576;
const KEEP = 262144; // head+tail window for big transcripts; partial lines fail JSON.parse and drop
const IDLE_MS = 90_000;

/** First+last KEEP bytes of a bounded file, or '' when it is too big / unreadable. */
function headTail(file) {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return '';
    const buf = readFileSync(file);
    if (buf.length <= KEEP * 2) return buf.toString('utf8');
    return `${buf.subarray(0, KEEP).toString('utf8')}\n${buf.subarray(buf.length - KEEP).toString('utf8')}`;
  } catch { return ''; }
}

const lines = (file) => headTail(file).split('\n').filter((l) => l.trim());

const blocksOf = (e) => (Array.isArray(e?.message?.content) ? e.message.content : []);
const textOf = (e) => blocksOf(e).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
const clean = (t) => String(t ?? '').replace(/<\/?user_query>/g, '').replace(/\s+/g, ' ').trim();

const ABS = (v) => (typeof v === 'string' && v.startsWith('/') ? v : null);

/** <project> dir name → absolute cwd: split on '-', keep a hyphen literal when the prefix is not a dir. */
function cwdOf(project) {
  if (!project || project === 'empty-window') return null;
  const seg = project.split('-');
  let prefix = '';
  let cur = seg[0];
  for (let i = 1; i < seg.length; i++) {
    const candidate = `${prefix}/${cur}`;
    if (existsSync(candidate)) { prefix = candidate; cur = seg[i]; } else { cur = `${cur}-${seg[i]}`; }
  }
  const guess = `${prefix}/${cur}`;
  return existsSync(guess) ? guess : null;
}

/** Enrichment from the session's SQLite meta row — best effort, absent is fine. */
function meta(sessionId) {
  try {
    let dirs = [];
    try { dirs = readdirSync(join(ROOT, 'chats'), { withFileTypes: true }); } catch { return null; }
    for (const d of dirs.slice(0, 200)) {
      const db = join(ROOT, 'chats', d.name, sessionId, 'store.db');
      if (!existsSync(db)) continue;
      const hex = execFileSync('sqlite3', ['-readonly', db, "SELECT value FROM meta WHERE key='0'"], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
      return JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
    }
    return null;
  } catch { return null; } // locked, corrupt, or no sqlite3 — the transcript stands alone
}

/** Last plausible string among shallow keys — used only for optional metadata fields. */
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** ~/.cursor/projects/<project>/agent-transcripts/<uuid>/<uuid>.jsonl, newest first. */
function files() {
  const out = [];
  let projects = [];
  try { projects = readdirSync(join(ROOT, 'projects'), { withFileTypes: true }); } catch { return out; }
  for (const p of projects.slice(0, 200)) {
    if (!p.isDirectory()) continue;
    const base = join(ROOT, 'projects', p.name, 'agent-transcripts');
    let sessions = [];
    try { sessions = readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const s of sessions.slice(0, 200)) {
      if (!s.isDirectory()) continue;
      const file = join(base, s.name, `${s.name}.jsonl`);
      try { out.push({ file, id: s.name, project: p.name, mtime: statSync(file).mtimeMs }); } catch { /* no transcript for this dir */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 60);
}

/** Every Cursor Agent session found on this Mac, newest first. */
export function sessions({ limit = 20 } = {}) {
  return files()
    .map((f) => {
      try {
        const evs = [];
        for (const line of lines(f.file)) {
          try { evs.push(JSON.parse(line)); } catch { /* partial or non-JSON line */ }
        }
        const turns = evs.filter((e) => /^(user|human|assistant|model)$/i.test(e?.role ?? ''));
        if (!turns.length) return null; // not a Cursor transcript — do not report it as one
        const first = turns.filter((e) => /^(user|human)$/i.test(e.role)).map(textOf).map(clean).find(Boolean);
        const lastText = turns.filter((e) => /^(assistant|model)$/i.test(e.role)).map(textOf).map(clean).filter(Boolean).at(-1);
        const calls = turns.flatMap((e) => blocksOf(e).filter((b) => /^tool[-_]?(use|call)$/i.test(b?.type ?? '')));
        const lastCall = calls.at(-1);
        const lastArgs = lastCall?.input ?? {};
        const err = evs.filter((e) => e?.type === 'turn_ended' && e?.status === 'error').at(-1);
        const m = meta(f.id) ?? {};
        const path = `cursor-agent:${f.project.slice(0, 40)}/${f.id.slice(0, 8)}`;
        return {
          id: f.id,
          agent: path,
          title: (first || pick(m, ['name', 'title', 'summary']) || path).slice(0, 120),
          objective: first ? first.slice(0, 300) : null,
          status: err ? 'error' : (Date.now() - f.mtime < IDLE_MS ? 'running' : 'idle'),
          cwd: ABS(pick(m, ['cwd', 'workspacePath', 'workspace'])) ?? cwdOf(f.project),
          updatedAt: Math.round(f.mtime), // the JSONL carries no timestamps: mtime is the only honest clock
          todos: [], // no todo store in Cursor agent transcripts — do not invent one
          action: (err?.error ? `error: ${err.error}`
            : lastCall ? `${lastCall.name ?? lastCall.tool ?? 'tool'} ${lastArgs.path ?? lastArgs.file_path ?? lastArgs.target_file ?? lastArgs.command ?? ''}`
              : lastText ?? null)?.replace(/\s+/g, ' ').trim().slice(0, 160) || null,
          files: [...new Set(calls.map((c) => ABS(c?.input?.path) ?? ABS(c?.input?.file_path) ?? ABS(c?.input?.target_file) ?? ABS(c?.input?.absolute_path)).filter(Boolean))].slice(0, 40),
          source: `cursor-agent:${f.file}`,
          model: pick(m, ['model', 'modelName', 'modelId']),
        };
      } catch { return null; } // one bad transcript never sinks the roster
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, limit);
}

export function summary() {
  const s = sessions({ limit: 100 });
  return {
    sessions: s.length,
    running: s.filter((x) => x.status === 'running').length,
    todos: 0,
    lastAt: s.reduce((m, x) => Math.max(m, x.updatedAt ?? 0), 0) || null,
  };
}
