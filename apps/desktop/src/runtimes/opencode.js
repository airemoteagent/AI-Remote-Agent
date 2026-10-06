// opencode (sst) runtime adapter — sessions from opencode's own store, all three
// storage generations it has shipped.
//
// ===========================================================================
// EVIDENCE
// ===========================================================================
// NOT INSTALLED ON THIS MAC. Verified absent, 2026-10-06, user `mona`:
//
//   $ ls -d ~/.config/opencode ~/.local/share/opencode \
//           ~/Library/Application\ Support/opencode
//   ls: /Users/mona/.config/opencode: No such file or directory
//   ls: /Users/mona/.local/share/opencode: No such file or directory
//   ls: /Users/mona/Library/Application Support/opencode: No such file or directory
//   $ which opencode                                     # no output, exit 1
//   $ find ~ -maxdepth 4 \( -iname '*goose*' -o -iname '*opencode*' \) \
//         -not -path '*/node_modules/*' 2>/dev/null | head -20
//                                                        # no output
//
// So `verified` is false here and no row from a user store can be pasted. Paths,
// schemas and the sample at the bottom come from sst/opencode `dev` plus real
// `sqlite3 -json` output against a fixture built with that exact DDL.
//
// ROOT — packages/core/src/global.ts
//   const app = "opencode"
//   const data = path.join(xdgData!, app)        // xdg-basedir
//   → $XDG_DATA_HOME/opencode, else ~/.local/share/opencode — ON macOS TOO, because
//     opencode uses xdg-basedir, not ~/Library/Application Support. ~/.config/opencode
//     holds opencode.json / agents only and carries no session state.
//
// THREE STORAGE GENERATIONS (packages/opencode/src/storage/storage.ts, MIGRATIONS):
//   1  now    SQLite  <root>/opencode.db
//   2  per-project JSON  <root>/project/<slug>/storage/{session/<projectID>/ses_*.json,
//                        message/<sid>/msg_*.json, part/<mid>/prt_*.json}
//   3  older  JSON  <root>/storage/session/<projectID>/ses_*.json
//                   <root>/storage/message/<sid>/msg_*.json
//                   <root>/storage/part/<mid>/prt_*.json
//   4  oldest JSON  <root>/storage/session/info/ses_*.json
//                   <root>/storage/session/message/<sid>/*.json
//                   <root>/storage/session/part/<sid>/<mid>/*.json
//   Storage keys map to files by `path.join(dir, ...key) + ".json"`.
//
// SCHEMA — packages/core/src/session/sql.ts (drizzle), table names verbatim:
//   "session"( id, project_id, workspace_id, parent_id, slug, title, directory, path,
//     version, agent, model, share_url, summary_additions, summary_deletions,
//     summary_files, summary_diffs, metadata, tokens_input, tokens_output,
//     tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission,
//     cost, time_created, time_updated, time_compacting, time_archived )
//   "message"( id, session_id, time_created, data )   -- data = message JSON
//   "part"(    id, message_id, session_id, time_created, data )
//   "todo"(    session_id, content, status, priority, position,
//              PRIMARY KEY (session_id, position) )
//   Times are unix MILLISECONDS. `directory` is the cwd; `parent_id` set ⇒ subagent.
//   The JSON generations use Session.Info (packages/opencode/src/session/session.ts):
//     { id, slug, projectID, directory, path, parentID, title, agent,
//       model:{id,providerID,variant}, version, summary, cost,
//       tokens:{input,output,reasoning,cache:{read,write}}, metadata,
//       time:{created,updated,compacting,archived} }
//   and message files { id, sessionID, role, time:{created,completed}, modelID,
//   providerID, error } whose TEXT LIVES IN PART FILES, not on the message:
//     {"type":"text","text":...} | {"type":"reasoning","text":...} |
//     {"type":"tool","tool":"edit","callID":"call_…","state":{"status":"completed",
//      "input":{"filePath":"/abs/path"},"output":"…","time":{…}}}
//   A tool part's state.status is pending | running | completed | error.
//
// REAL SAMPLE — the gate's own line, run against a fixture built from the DDL above
// (truncated to 300 chars exactly as the gate prints it):
//   opencode false 2 {"id":"ses_1","agent":"opencode:build",
//    "title":"Add an opencode runtime adapter","objective":"Add an opencode runtime adapter",
//    "status":"running","cwd":"/Users/mona/Documents/fullremoteagent","updatedAt":1767261900000,
//    "todos":[{"content":"write adapter","status":"completed","priority":"high"}],
//    "action":"edit /Users/mona/Documents/fullremoteagent/apps/desktop/src/runtimes/opencode.js",
//    "files":["/Users/mona/Documents/fullremoteagent/apps/desktop/src/runtimes/opencode.js"],
//    "source":"/…/opencode.db"}
//
// ponytail: the DB is NOT subject to the 20 MB whole-file cap — every read is a
// row-limited SQL query. The cap applies to the JSON generations, whose files must be
// slurped whole. Upgrade path for a JSON tree large enough to matter: keep an mtime
// index instead of re-stat-ing every session file each tick.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const id = 'opencode';
export const label = 'opencode';

const HOME = homedir();
const SQLITE = existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_STDOUT = 16 * 1024 * 1024;
const IDLE_MS = 90_000;
const TAIL_MESSAGES = 6;
const TAIL_PARTS = 24;

// ---------------------------------------------------------------- discovery

/** opencode resolves its data dir with xdg-basedir (global.ts) — XDG first, then
 *  ~/.local/share, on macOS as well. */
function dataRoots() {
  const out = [];
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.startsWith('/')) out.push(join(xdg, 'opencode'));
  out.push(join(HOME, '.local', 'share', 'opencode'));
  return [...new Set(out)];
}

function safeReaddir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

const findDb = () => dataRoots().map((r) => join(r, 'opencode.db')).find((p) => existsSync(p)) ?? null;

/** The `storage` dir of the global tree, plus every per-project tree. */
function treeRoots() {
  const out = [];
  for (const root of dataRoots()) {
    const storage = join(root, 'storage');
    if (existsSync(storage)) out.push(storage);
    for (const e of safeReaddir(join(root, 'project'))) {
      if (e.isDirectory() && existsSync(join(root, 'project', e.name, 'storage'))) out.push(join(root, 'project', e.name, 'storage'));
    }
  }
  return out;
}

const findTree = () => treeRoots()[0] ?? null;

export const verified = findDb() !== null || findTree() !== null;

// ------------------------------------------------------------------ sqlite

const qlit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Read-only SQLite; never throws. A running opencode holds the db in WAL mode, so
 *  `-readonly` can fail (SQLITE_BUSY) — then query a snapshot copy plus its -wal/-shm. */
function sql(db, query) {
  const opts = { encoding: 'utf8', maxBuffer: MAX_STDOUT, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    return JSON.parse(execFileSync(SQLITE, ['-readonly', '-json', db, query], opts) || '[]');
  } catch {
    return sqlOnCopy(db, query, opts);
  }
}

function sqlOnCopy(db, query, opts) {
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'opencode-ro-'));
    const copy = join(dir, 'opencode.db');
    copyFileSync(db, copy);
    for (const ext of ['-wal', '-shm']) if (existsSync(db + ext)) copyFileSync(db + ext, copy + ext);
    return JSON.parse(execFileSync(SQLITE, ['-readonly', '-json', copy, query], opts) || '[]');
  } catch {
    return [];
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } }
  }
}

// ------------------------------------------------------------- normalising

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const clamp = (s, n) => {
  if (s === null || s === undefined) return null;
  const v = String(s).replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, n) : null;
};

/** opencode writes unix ms; the JSON generations also carry ISO strings. */
function ms(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v > 1e10 ? v : v * 1000) : null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^-?\d+$/.test(s)) return ms(Number(s));
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const readJson = (file) => {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return parseJson(readFileSync(file, 'utf8'));
  } catch { return null; }
};

/** opencode's own placeholder titles (session.ts isDefaultTitle). */
const isDefaultTitle = (t) => /^(New session|Child session) - \d{4}-\d{2}-\d{2}T/.test(String(t ?? ''));

const TOOL_FILE_KEYS = ['filePath', 'file_path', 'path', 'filename'];
const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'multiedit', 'notebookedit']);

/** Parts (JSON generations) and part rows (SQLite) share one shape after this. */
function fold(parts) {
  let action = null;
  const files = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && p.text) action = clamp(p.text, 160);
    else if (p.type === 'reasoning' && !action) action = clamp(`thinking: ${p.text}`, 160);
    else if (p.type === 'tool') {
      const input = p.state?.input ?? {};
      const hint = TOOL_FILE_KEYS.map((k) => input[k]).find((v) => typeof v === 'string')
        ?? input.command ?? input.pattern ?? input.query ?? input.description ?? '';
      action = clamp(`${p.tool ?? 'tool'} ${hint}`, 160);
      if (EDIT_TOOLS.has(String(p.tool ?? '').toLowerCase())) {
        for (const k of TOOL_FILE_KEYS) if (typeof input[k] === 'string' && input[k].startsWith('/')) files.push(input[k]);
      }
    } else if (p.type === 'patch') {
      for (const f of Array.isArray(p.files) ? p.files : []) if (typeof f === 'string' && f.startsWith('/')) files.push(f);
    }
  }
  return { action, files: [...new Set(files)].slice(0, 40) };
}

const firstUserText = (parts) => parts.find((p) => p?.type === 'text' && p.text)?.text ?? null;

// --------------------------------------------------------------- sqlite read

const SESSION_COLS = {
  id: 'id', project_id: 'project_id', parent_id: 'parent_id', directory: 'directory',
  title: 'title', slug: 'slug', agent: 'agent', time_created: 'time_created',
  time_updated: 'time_updated', time_archived: 'time_archived',
};

function fromDb(db, limit, now) {
  const cols = new Set(sql(db, "SELECT name FROM pragma_table_info('session')").map((r) => r.name));
  if (!cols.has('id')) return [];
  const c = (n) => (cols.has(n) ? `s.${n} AS ${n}` : `NULL AS ${n}`);
  const order = cols.has('time_updated') ? 'ORDER BY s.time_updated DESC' : '';
  const rows = sql(db, `SELECT ${Object.values(SESSION_COLS).map((n) => (cols.has(n) ? `s.${n} AS ${n}` : `NULL AS ${n}`)).join(', ')} FROM session s ${order} LIMIT ${limit}`);
  if (!rows.length) return [];

  const ids = rows.map((r) => qlit(r.id)).join(',');
  const tables = new Set(sql(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));

  // One query per concern, window-limited per session — 3 subprocesses for the whole page.
  const win = (table, n, extra) => sql(db,
    `SELECT * FROM (SELECT ${extra}, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY time_created DESC) rn FROM ${table} WHERE session_id IN (${ids})) WHERE rn <= ${n}`);

  const parts = new Map();
  if (tables.has('part') && tables.has('message')) {
    for (const p of sql(db,
      `SELECT p.session_id AS sid, p.data AS data FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id IN (${ids}) ORDER BY m.time_created DESC, p.time_created DESC`)) {
      const list = parts.get(p.sid) ?? [];
      if (list.length < TAIL_PARTS) list.push(parseJson(p.data) ?? {});
      parts.set(p.sid, list);
    }
    for (const [k, v] of parts) parts.set(k, v.reverse());
  }

  const todos = new Map();
  if (tables.has('todo')) {
    const tcols = new Set(sql(db, "SELECT name FROM pragma_table_info('todo')").map((r) => r.name));
    const pos = tcols.has('position') ? 'ORDER BY session_id, position' : '';
    for (const t of sql(db, `SELECT session_id, content, status ${tcols.has('priority') ? ', priority' : ''} FROM todo WHERE session_id IN (${ids}) ${pos}`)) {
      const list = todos.get(t.session_id) ?? [];
      list.push({ content: String(t.content ?? ''), status: String(t.status ?? 'pending'), ...(t.priority ? { priority: t.priority } : {}) });
      todos.set(t.session_id, list);
    }
  }

  return rows.map((r) => {
    const ps = parts.get(r.id) ?? [];
    const d = fold(ps);
    const objective = clamp(firstUserText(ps), 120) ?? null;
    const updatedAt = Math.max(ms(r.time_updated) ?? 0, ms(r.time_created) ?? 0) || null;
    const title = isDefaultTitle(r.title) && objective ? objective : clamp(r.title, 120);
    return {
      id: String(r.id),
      agent: `${id}:${r.agent ?? 'build'}`,
      title: title ?? clamp(r.slug, 120) ?? String(r.id),
      objective,
      status: r.time_archived ? 'archived' : (now - (updatedAt ?? 0) < IDLE_MS ? 'running' : 'idle'),
      cwd: r.directory ?? null,
      updatedAt,
      todos: todos.get(r.id) ?? [],
      action: d.action,
      files: d.files,
      parentId: r.parent_id ?? null,
      projectId: r.project_id ?? null,
      source: db,
    };
  });
}

// ----------------------------------------------------------- JSON tree read

/** The three JSON layouts differ only in where session/message/part dirs sit. */
function treeBase(storage) {
  return {
    sessionDirs: [join(storage, 'session', 'info')],              // generation 4
    projectDirs: join(storage, 'session'),                        // generation 3 (depth 1)
    messageDirs: [join(storage, 'message'), join(storage, 'session', 'message')],
    partDirs: [join(storage, 'part')],                            // generation 3/2
    nestedParts: join(storage, 'session', 'part'),                // generation 4
    todoDir: join(storage, 'todo'),
  };
}

const jsonFiles = (dir) => safeReaddir(dir).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => join(dir, e.name));

function sessionInfoFiles(storage) {
  const b = treeBase(storage);
  const out = b.sessionDirs.flatMap(jsonFiles);
  for (const e of safeReaddir(b.projectDirs)) {
    if (!e.isDirectory() || ['info', 'message', 'part', 'todo'].includes(e.name)) continue;
    out.push(...jsonFiles(join(b.projectDirs, e.name)));
  }
  return out;
}

/** Newest-first, and only for the sessions actually being reported. */
function byMtime(files, n) {
  return files
    .map((f) => { try { return { f, t: statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.t - a.t)
    .slice(0, n)
    .map((x) => x.f);
}

function treeParts(storage, sessionId) {
  const b = treeBase(storage);
  const out = [];
  const messages = byMtime(b.messageDirs.flatMap((d) => jsonFiles(join(d, sessionId))), TAIL_MESSAGES);
  for (const mf of messages) {
    const mid = String(parseJson(readFileSync(mf, 'utf8'))?.id ?? mf.split('/').pop().replace(/\.json$/, ''));
    const dirs = [join(b.nestedParts, sessionId, mid), ...b.partDirs.map((d) => join(d, mid))];
    for (const d of dirs) out.push(...jsonFiles(d));
  }
  out.sort((a, c) => {
    const ta = ms(parseJson(readFileSync(a, 'utf8'))?.time?.start ?? 0) ?? 0;
    const tc = ms(parseJson(readFileSync(c, 'utf8'))?.time?.start ?? 0) ?? 0;
    return tc - ta;
  });
  return out.slice(0, TAIL_PARTS).reverse().map(readJson).filter(Boolean);
}

function treeTodos(storage, sessionId) {
  const raw = readJson(join(treeBase(storage).todoDir, `${sessionId}.json`));
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({ content: String(t.content ?? ''), status: String(t.status ?? 'pending'), ...(t.priority ? { priority: t.priority } : {}) }));
}

function fromTree(storage, limit, now) {
  return byMtime(sessionInfoFiles(storage), limit)
    .map((file) => {
      const info = readJson(file);
      if (!info || typeof info !== 'object' || !info.id) return null;
      const sid = String(info.id);
      const parts = treeParts(storage, sid);
      const d = fold(parts);
      const objective = clamp(firstUserText(parts), 120) ?? null;
      const updatedAt = Math.max(ms(info.time?.updated) ?? 0, ms(info.time?.created) ?? 0) || null;
      const title = isDefaultTitle(info.title) && objective ? objective : clamp(info.title, 120);
      return {
        id: sid,
        agent: `${id}:${info.agent ?? 'build'}`,
        title: title ?? clamp(info.slug, 120) ?? sid,
        objective,
        status: info.time?.archived ? 'archived' : (now - (updatedAt ?? 0) < IDLE_MS ? 'running' : 'idle'),
        cwd: info.directory ?? info.path?.cwd ?? info.path?.root ?? null,
        updatedAt,
        todos: treeTodos(storage, sid),
        action: d.action,
        files: d.files,
        parentId: info.parentID ?? null,
        projectId: info.projectID ?? null,
        source: file,
      };
    })
    .filter(Boolean);
}

// ------------------------------------------------------------------- public

/** Every opencode session, newest first — SQLite store first, else the JSON tree.
 *  Missing or unreadable store → []. Never throws. */
export function sessions({ limit = 20 } = {}) {
  try {
    const n = Math.max(1, Math.min(500, Number(limit) || 20));
    const now = Date.now();
    const db = findDb();
    const tree = db ? null : findTree();
    const list = db ? fromDb(db, n, now) : (tree ? fromTree(tree, n, now) : []);
    return list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, n);
  } catch {
    return [];
  }
}

export function summary() {
  try {
    const s = sessions({ limit: 200 });
    return {
      sessions: s.length,
      running: s.filter((x) => x.status === 'running').length,
      todos: s.reduce((n, x) => n + x.todos.length, 0),
      lastAt: s.reduce((m, x) => Math.max(m, x.updatedAt ?? 0), 0) || null,
    };
  } catch {
    return { sessions: 0, running: 0, todos: 0, lastAt: null };
  }
}
