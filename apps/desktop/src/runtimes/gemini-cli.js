// Gemini CLI runtime adapter — sessions read from Google's own chat store.
//
// EVIDENCE ON THIS MAC (2026-10-06, macOS, user `mona`) — the runtime is NOT installed:
//
//   $ ls -la ~/.gemini ~/.config/gemini
//   ls: /Users/mona/.gemini: No such file or directory
//   ls: /Users/mona/.config/gemini: No such file or directory
//   $ find ~ -maxdepth 4 -iname '*gemini*' -not -path '*/node_modules/*'
//   /Users/mona/.gemini.json            ← 69 bytes, the legacy API-key file only:
//   $ head -c 2000 ~/.gemini.json
//   {"api_key": "<redacted-locally-20261006>"}
//   $ npm ls -g --depth=0 | grep -i gemini ; ls /usr/local/bin /opt/homebrew/bin | grep -i gemini
//   (nothing — no `gemini` binary on PATH, no process in `ps -Ao comm,args`)
//
// So `verified = false` here and sessions() is an empty list. Nothing below invents
// data: an unreadable or unrecognised record is skipped, never guessed.
//
// SCHEMA — documented, NOT observed on this host (no store to read). Sources:
//   https://github.com/google-gemini/gemini-cli (chat recording service)
//   https://raw.githubusercontent.com/rajbos/ai-engineering-fluency/refs/heads/main/docs/logFilesSchema/gemini-cli-session-format.md
//   (~/.gemini/tmp/<bucket>/chats/session-<ISO>-<short-id>.jsonl, observed on Windows):
//
//     {"sessionId":"ee37b453-…","projectHash":"…","startTime":"2026-05-03T15:01:21.339Z",
//      "lastUpdated":"2026-05-03T15:01:21.339Z","kind":"main"}                 ← header line
//     {"id":"…","timestamp":"…","type":"user","content":[{"text":"<prompt>"}]}
//     {"id":"…","timestamp":"…","type":"gemini","content":"","thoughts":[],
//      "tokens":{"input":11410,"output":105,"cached":0,"thoughts":65,"tool":0,"total":11580},
//      "model":"gemini-3-flash-preview",
//      "toolCalls":[{"id":"…","name":"read_file","args":{"file_path":"…"},
//                    "status":"success","timestamp":"…","description":"…"}]}
//     {"$set":{"lastUpdated":"2026-05-03T15:01:31.512Z"}}                       ← patch record
//
//   Older builds wrote ONE JSON document per session instead of JSONL:
//     ~/.gemini/tmp/<bucket>/chats/session-*.json  →  {sessionId, startTime, lastUpdated,
//     messages:[ <same user/gemini records> ]}
//   Sibling files: ~/.gemini/projects.json (bucket ↔ workspace path), ~/.gemini/logs.json
//   (message index), ~/.gemini/settings.json, ~/.gemini/state.json.
//
// Gemini CLI has no todo store in these files: `todos` stays [] rather than inventing one.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const id = 'gemini-cli';
export const label = 'Gemini CLI';
const ROOT = process.env.GEMINI_HOME || join(homedir(), '.gemini');
/** The state dir is the whole claim: without it this adapter has nothing to read. */
export const verified = existsSync(ROOT);

const MAX_FILE = 20 * 1048576; // a 20 MB+ session log is not worth the tick
const KEEP = 262144; // head+tail window for big files; partial lines are skipped by JSON.parse
const IDLE_MS = 90_000;

/** First+last KEEP bytes of a bounded file, or '' when it is too big / unreadable. */
function headTail(file) {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return '';
    if (st.size <= KEEP * 2) return readFileSync(file, 'utf8');
    const fd = openSync(file, 'r');
    try {
      const a = Buffer.alloc(KEEP);
      const b = Buffer.alloc(KEEP);
      readSync(fd, a, 0, KEEP, 0);
      readSync(fd, b, 0, KEEP, st.size - KEEP);
      return `${a.toString('utf8')}\n${b.toString('utf8')}`;
    } finally { closeSync(fd); }
  } catch { return ''; }
}

const lines = (file) => headTail(file).split('\n').filter((l) => l.trim());

/** Every message record of one session file — JSONL records, or the messages[] of an old doc. */
function records(file) {
  const text = headTail(file);
  if (text.trimStart().startsWith('{') && text.trimEnd().endsWith('}')) {
    try {
      const doc = JSON.parse(text);
      if (Array.isArray(doc?.messages)) return { header: doc, msgs: doc.messages };
    } catch { /* not a single document — fall through to JSONL */ }
  }
  const out = [];
  let header = null;
  for (const line of lines(file)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.$set?.lastUpdated) { header = { ...(header ?? {}), lastUpdated: e.$set.lastUpdated }; continue; }
    if (!header && e?.sessionId) { header = e; continue; }
    if (e?.type || e?.content) out.push(e);
  }
  return { header, msgs: out };
}

/** bucket → workspace path, when projects.json is readable; shapes vary, so nothing is assumed. */
function projects() {
  try {
    const doc = JSON.parse(readFileSync(join(ROOT, 'projects.json'), 'utf8'));
    const map = {};
    for (const [k, v] of Object.entries(doc?.projects ?? doc ?? {})) {
      if (typeof v === 'string' && v.startsWith('/')) map[k] = v;
      else if (k.startsWith('/') && typeof v === 'string') map[v] = k;
    }
    return map;
  } catch { return {}; }
}

const textOf = (m) => {
  const c = m?.content ?? m?.parts;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => p?.text ?? '').join('');
  return '';
};

const ABS = (v) => (typeof v === 'string' && v.startsWith('/') ? v : null);

/** ~/.gemini/tmp/<bucket>/chats/session-*.{jsonl,json}, newest file first. */
function files() {
  const out = [];
  let buckets = [];
  try { buckets = readdirSync(join(ROOT, 'tmp'), { withFileTypes: true }); } catch { return out; }
  for (const b of buckets.slice(0, 200)) {
    if (!b.isDirectory()) continue;
    const chats = join(ROOT, 'tmp', b.name, 'chats');
    let entries = [];
    try { entries = readdirSync(chats, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !/^session-.*\.(jsonl|json)$/.test(e.name)) continue;
      const file = join(chats, e.name);
      try { out.push({ file, bucket: b.name, mtime: statSync(file).mtimeMs }); } catch { /* raced away */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 60);
}

/** Every Gemini CLI session found on this Mac, newest first. */
export function sessions({ limit = 20 } = {}) {
  const pmap = projects();
  return files()
    .map((f) => {
      try {
        const { header, msgs } = records(f.file);
        // A corrupt, empty, symlinked or foreign file must never become a fake session.
        if (!msgs.length) return null;
        const users = msgs.filter((m) => m?.type === 'user');
        const first = users.map(textOf).find((t) => t.trim());
        const last = msgs.at(-1);
        const calls = msgs.flatMap((m) => (Array.isArray(m?.toolCalls) ? m.toolCalls : []));
        const lastCall = calls.at(-1);
        const path = `gemini-cli:${f.bucket}/${(header?.sessionId ?? f.file.split('/').pop()).slice(0, 8)}`;
        const lastUpdated = Math.round(Date.parse(header?.lastUpdated ?? header?.startTime ?? '') || f.mtime);
        return {
          id: header?.sessionId ?? path,
          agent: path,
          title: (first || path).replace(/\s+/g, ' ').trim().slice(0, 120),
          objective: first ? first.replace(/\s+/g, ' ').trim().slice(0, 300) : null,
          // Gemini rewrites assistant turns; `$set` keeps lastUpdated honest, mtime as backstop.
          status: Date.now() - f.mtime < IDLE_MS ? 'running' : 'idle',
          cwd: ABS(header?.cwd) ?? pmap[f.bucket] ?? null,
          updatedAt: lastUpdated,
          todos: [], // no todo store in the Gemini session files — do not invent one
          action: (lastCall
            ? `${lastCall.name ?? 'tool'} ${lastCall.description ?? lastCall.args?.file_path ?? lastCall.args?.command ?? ''}`
            : textOf(last ?? {}) || null)?.replace(/\s+/g, ' ').trim().slice(0, 160) || null,
          files: [...new Set(calls.map((c) => ABS(c?.args?.file_path) ?? ABS(c?.args?.path) ?? ABS(c?.args?.absolute_path)).filter(Boolean))].slice(0, 40),
          source: `gemini-cli:${f.file}`,
          model: last?.model ?? null,
        };
      } catch { return null; } // one bad file never sinks the roster
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
