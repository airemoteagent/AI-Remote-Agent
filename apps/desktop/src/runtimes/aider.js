/**
 * aider — runtime adapter for the Aider CLI, plus AiderDesk when it is installed.
 *
 * Evidence > inference. Every session here comes from a file that exists on this Mac.
 * Read-only, stdlib + native macOS tools only (ps, lsof), total (never throws):
 * no aider, no transcript ⇒ [].
 *
 * EVIDENCE — what THIS box actually has (macOS, user mona, Node v24.18.0), read-only:
 *
 *   $ find ~ -maxdepth 4 -name '.aider*' 2>/dev/null | head -20
 *   (no output)
 *   $ ls -la ~/.aider* ; ls -laR ~/.config/aider/ ; ls -la ~/Library/Application\ Support/aider/
 *   (no output — all three absent)
 *   $ find ~/Documents ~/Desktop ~/Downloads ~/Library/Application\ Support -maxdepth 6 \
 *       -name '.aider*' 2>/dev/null | head -30   # same command, also with a node_modules
 *                                                # exclusion (-not -path '<star>/node_modules/…')
 *   (no output)
 *   $ mdfind 'kMDItemFSName == ".aider*"' | head -10          # Spotlight, whole disk
 *   (no output)
 *   $ which aider aider-desk ; pip3 show aider-chat ; uv tool list ; python3 -c "import aider"
 *   (no output) / ModuleNotFoundError: No module named 'aider'
 *   $ ps aux | grep '[a]ider'                                  # no live aider process
 *   (no output)
 *   => aider is NOT installed on this Mac: no transcript, no config, no process.
 *      verified=false and sessions() is honestly [] — the parser below is exercised
 *      only by the fixtures in its own comments.
 *
 * WIRE/DISK FORMAT — confirmed against upstream source, not guessed (aider `main`,
 * fetched read-only; line numbers as observed at fetch time):
 *
 *   aider/io.py:336   session header written on every start, append mode:
 *                       self.append_chat_history(f"\n# aider chat started at {current_time}\n\n")
 *                     current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
 *   aider/io.py:775-790  user_input() → prefix = "####"; lines joined by "  \n#### ",
 *                        written as "\n#### <text>  \n"            (linebreak=True)
 *   aider/io.py:793   ai_output()    → "\n" + content.strip() + "\n\n"   (no prefix)
 *   aider/io.py:905-999 tool/notice output uses blockquote=True → every line prefixed "> "
 *   aider/args.py:271-277  defaults: "<git_root>/.aider.input.history",
 *                          "<git_root>/.aider.chat.history.md"  (cwd when not in a repo)
 *   aider/repomap.py:35-43 CACHE_VERSION = 3, 4 with the tree-sitter pack
 *                          TAGS_CACHE_DIR = ".aider.tags.cache.v3|v4" — a diskcache
 *                          Cache(dir) (SQLite cache.db inside), repo-map only, no session data
 *   aider/main.py:370     ~/.aider/oauth-keys.env
 *   aider/main.py:1185    ~/.aider/installs.json
 *   prompt_toolkit/history.py:298-307 FileHistory.store_string → per prompt:
 *                          "\n# <datetime.datetime.now()>\n" then "+<line>\n" for each line;
 *                          load_history_strings() only accepts "+"-prefixed lines.
 *
 *   Real transcript shape (template reconstructed from the writer code above — no
 *   on-disk sample exists on this Mac; "<…>" = the variable parts):
 *
 *     \n# aider chat started at 2024-05-01 12:00:00\n\n
 *     \n#### add a retry to fetch_users  \n
 *     \nSure — editing users.py.\n\n
 *     > Added src/users.py to the chat
 *     > Applied edit to src/users.py
 *     \n#### also cover the 429 case  \n
 *
 *   .aider.input.history for the same project:
 *     \n# 2024-05-01 12:00:00.123456\n+add a retry to fetch_users\n
 *     \n# 2024-05-01 12:03:11.900001\n+also cover the 429 case\n
 *
 *   AiderDesk (hotovo/aider-desk, package.json version 0.87.0-dev) — its own store:
 *   src/main/constants.ts  DB_FILE_PATH = <userData>/aider-desk.db,
 *                          AIDER_DESK_DIR = ".aider-desk", TASKS_DIR = ".aider-desk/tasks",
 *                          TODOS_FILE = "todos.json", AIDER_DESK_HOME_DIR = ~/.aider-desk
 *   src/main/paths.ts      getDataDir() = Electron userData →
 *                          ~/Library/Application Support/aider-desk (dev: "-dev" suffix)
 *   src/main/task/task.ts:233   taskDataPath = <project>/.aider-desk/tasks/<taskId>/settings.json
 *   src/main/task/task.ts:3967  todos path  = <project>/.aider-desk/tasks/<taskId>/todos.json
 *   src/main/task/context-manager.ts:52  <project>/.aider-desk/tasks/<taskId>/context.json
 *   packages/common/src/types/common.ts:1038 TaskDataSchema {id, baseDir, name, state,
 *     createdAt, updatedAt, completedAt, workingMode, mainModel, …}; :1121 TodoItem
 *     {name: string, completed: boolean}; :1013 TaskStateData {messages, files, todoItems};
 *     :1098 DefaultTaskState {TODO, READY_FOR_IMPLEMENTATION, IN_PROGRESS, INTERRUPTED,
 *     DELEGATED, MORE_INFO_NEEDED, READY_FOR_REVIEW, DONE}
 *   todos.json = { initialUserPrompt: string, items: TodoItem[] } (task.ts readTodoFile)
 *   The SQLite aider-desk.db is deliberately NOT read: its schema could not be confirmed
 *   on this box, and guessing column names is exactly the invention this file refuses.
 *
 * `verified` = "this Mac has an aider install or at least one aider artifact on disk"
 * (checked once at import: global paths, then one bounded scan). It does not mean a
 * process is live; sessions() still reports a run that starts after import.
 *
 * ponytail: sessions are parsed from at most the last 512 KB of each transcript (aider
 * appends, so the tail holds the newest runs); older runs in a very long transcript are
 * not reported. Upgrade path: seek backwards for the Nth "# aider chat started at".
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const id = 'aider';
export const label = 'Aider';

const HOME = os.homedir();
const SEP = path.sep;

const ROOTS = ['Documents', 'Desktop', 'Projects', 'code'].map((d) => path.join(HOME, d));
// Global aider / AiderDesk state (real paths from the sources cited above).
const GLOBAL_PATHS = [
  path.join(HOME, '.aider'),
  path.join(HOME, '.aider.conf.yml'),
  path.join(HOME, '.aider.model.settings.yml'),
  path.join(HOME, '.aider.model.metadata.json'),
  path.join(HOME, '.aiderignore'),
  path.join(HOME, '.aider-desk'),
  path.join(HOME, 'Library/Application Support/aider-desk'),
  path.join(HOME, 'Library/Application Support/aider-desk-dev'),
];

const MAX_FILE_BYTES = 20 * 1024 * 1024; // never open anything bigger
const TAIL_BYTES = 512 * 1024; // aider appends ⇒ the tail is the newest runs
const MAX_JSON_BYTES = 4 * 1024 * 1024; // context.json can be huge; skip, don't choke
const MAX_DEPTH = 3; // levels below each root (≈ the -maxdepth 4 search that found nothing)
const MAX_DIRS = 4000; // hard ceiling on the walk
const MAX_SESSION_SCAN = 60; // transcripts parsed per call after the newest-first sort
const MAX_FILE_PROBES = 40; // existsSync() calls per session when collecting files
const MAX_ACTION = 160;
const IDLE_MS = 120000; // transcript untouched this long ⇒ not running
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache']);

const CHAT_FILE = '.aider.chat.history.md';
const INPUT_FILE = '.aider.input.history';
const TAGS_RE = /^\.aider\.tags\.cache\.v\d+$/;
const HEADER_RE = /^#\s*aider chat started at\s*(.+?)\s*$/;
const CHECKBOX_RE = /^\s*[-*+]\s*\[( |x|X)\]\s*(.+?)\s*$/;
// A path-looking token with an extension; existence is checked before it is reported.
const PATH_RE = /(?:^|[\s"'`([>])((?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z]\w{0,5}|[\w@+-]+\.[A-Za-z]\w{0,5})/g;
// Never mistake the RemoteAgent dashboard's own adapter / node one-liner for an aider process.
const PROC_RE = /(^|[/\s])aider([\s.]|$)/;
const PROC_SKIP_RE = /aider-desk|aider\.js|fullremoteagent/;

const DESK_STATE = {
  IN_PROGRESS: 'running',
  DELEGATED: 'running',
  TODO: 'pending',
  READY_FOR_IMPLEMENTATION: 'pending',
  MORE_INFO_NEEDED: 'pending',
  INTERRUPTED: 'idle',
  READY_FOR_REVIEW: 'idle',
  DONE: 'idle',
};

// ---------------------------------------------------------------- safe primitives

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const clip = (v, n) => {
  const s = str(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, n) : null;
};

function ls(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function statOf(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeJSON(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_JSON_BYTES) return null;
    const txt = fs.readFileSync(p, 'utf8');
    const v = JSON.parse(txt);
    return v && typeof v === 'object' ? { value: v, mtime: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** Last `maxBytes` of a file (dropping the leading partial line), or null. */
function readTail(file, maxBytes = TAIL_BYTES) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  const buf = Buffer.allocUnsafe(len);
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    if (len > 0) fs.readSync(fd, buf, 0, len, start);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  let text = buf.toString('utf8');
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  return { text, mtime: Math.round(st.mtimeMs) };
}

/** "2024-05-01 12:00:00.123456" (local) → ms epoch. Same parser for both writers. */
function parseStamp(s) {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/.exec(str(s));
  if (!m) return null;
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Every aider process on this box and the cwd it runs in (ps + lsof, native, bounded). */
function liveAiderCwds() {
  const cwds = new Set();
  const pids = [];
  let ps = '';
  try {
    ps = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', timeout: 2500, maxBuffer: 8 << 20 });
  } catch {
    return cwds;
  }
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !PROC_RE.test(m[2]) || PROC_SKIP_RE.test(m[2])) continue;
    pids.push(m[1]);
    if (pids.length >= 8) break;
  }
  if (!pids.length) return cwds;
  try {
    const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fn', ...pids.flatMap((p) => ['-p', p])], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 8 << 20,
    });
    for (const l of out.split('\n')) if (l.startsWith('n/')) cwds.add(path.resolve(l.slice(1)));
  } catch { /* lsof missing or denied: mtime heuristic alone decides */ }
  return cwds;
}

// ---------------------------------------------------------------- discovery

/** Bounded walk of the candidate roots for aider artifacts and AiderDesk task dirs. */
function findProjects() {
  const found = [];
  let visited = 0;
  const walk = (dir, depth) => {
    if (visited++ > MAX_DIRS) return;
    const entries = ls(dir);
    const p = { dir, chat: null, input: null, tags: false, desk: null };
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile()) {
        if (e.name === CHAT_FILE) p.chat = full;
        else if (e.name === INPUT_FILE) p.input = full;
        else if (TAGS_RE.test(e.name)) p.tags = true;
      } else if (e.isDirectory() && e.name === '.aider-desk') {
        p.desk = path.join(full, 'tasks');
      }
    }
    if (p.chat || p.input || p.tags || p.desk) found.push(p);
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') && e.name !== '.aider-desk') continue;
      if (e.isSymbolicLink?.() || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const root of ROOTS) {
    try {
      if (fs.statSync(root).isDirectory()) walk(root, 0);
    } catch { /* root absent */ }
  }
  return found;
}

export const verified = (() => {
  try {
    if (GLOBAL_PATHS.some((p) => fs.existsSync(p))) return true;
    return findProjects().some((p) => p.chat || p.input || p.tags || p.desk);
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------- parsing

/** Split a chat transcript into runs on the "# aider chat started at …" header. */
function splitRuns(text) {
  const runs = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = HEADER_RE.exec(line);
    if (h) {
      cur = { startedAt: parseStamp(h[1]), label: h[1].trim(), lines: [] };
      runs.push(cur);
    } else if (cur) cur.lines.push(line);
  }
  return runs;
}

/** Todos are not stored by aider; the only honest source is checkbox lines it printed. */
function todosFrom(lines) {
  const out = [];
  for (const line of lines) {
    const m = CHECKBOX_RE.exec(line);
    if (!m) continue;
    const content = clip(m[2], MAX_ACTION);
    if (!content) continue;
    out.push({ content, status: m[1].toLowerCase() === 'x' ? 'done' : 'pending' });
    if (out.length >= 50) break;
  }
  return out;
}

/** Absolute paths that the transcript names and that exist on disk under `cwd`. */
function filesFrom(lines, cwd) {
  const out = new Set();
  let probes = 0;
  for (let i = lines.length - 1; i >= 0 && probes < MAX_FILE_PROBES; i--) {
    const line = lines[i];
    if (!line || (!line.startsWith('> ') && !line.startsWith('#### ') && !/\b(Added|Removed|Applied|Editing|created|wrote)\b/i.test(line))) continue;
    PATH_RE.lastIndex = 0;
    let m;
    while ((m = PATH_RE.exec(line))) {
      probes++;
      const abs = path.resolve(cwd, m[1]);
      if (!abs.startsWith(cwd + SEP)) continue;
      if (!isFile(abs)) continue;
      out.add(abs);
      if (out.size >= MAX_FILE_PROBES) return [...out];
    }
  }
  return [...out];
}

/** Last message/tool line of a run, prefix stripped, ≤160 chars. */
function actionFrom(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw || raw === '<blank>') continue;
    if (CHECKBOX_RE.test(raw)) continue; // a todo already; not the last thing that happened
    const text = raw.replace(/^>\s?/, '').replace(/^#+\s?/, '').trim();
    if (!text) continue;
    const c = clip(text, MAX_ACTION);
    if (c) return c;
  }
  return null;
}

function mkSession(o) {
  return {
    id: o.id,
    agent: 'aider',
    title: o.title ?? null,
    objective: o.objective ?? null,
    status: o.status,
    cwd: o.cwd ?? null,
    updatedAt: Number.isFinite(o.updatedAt) ? o.updatedAt : null,
    todos: Array.isArray(o.todos) ? o.todos : [],
    action: o.action ?? null,
    files: Array.isArray(o.files) ? o.files : [],
    source: o.source ?? null,
  };
}

function chatSession(run, ctx) {
  const users = run.lines.filter((l) => l.startsWith('#### '));
  const firstUser = clip(users[0]?.slice(5), 240);
  const updatedAt = ctx.isNewest ? ctx.mtime : (ctx.nextStart ?? ctx.mtime);
  const running = ctx.liveCwds.has(path.resolve(ctx.dir)) || (ctx.isNewest && Date.now() - ctx.mtime < IDLE_MS);
  const files = ctx.deep ? filesFrom(run.lines, ctx.dir) : [];
  return mkSession({
    id: `aider:${path.basename(ctx.dir)}:${run.startedAt ?? `t${Math.round(ctx.mtime)}`}`,
    title: clip(firstUser, 80) ?? clip(`Aider session ${run.label}`, 80),
    objective: firstUser ?? clip(`Aider session started ${run.label}`, 240),
    status: running ? 'running' : 'idle',
    cwd: ctx.dir,
    updatedAt,
    todos: todosFrom(run.lines),
    action: actionFrom(run.lines),
    files,
    source: ctx.chatFile,
  });
}

/** prompt_toolkit FileHistory: "# <datetime>" then one "+line" per prompt line. */
function parseInputHistory(text) {
  const entries = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) {
      cur = { at: parseStamp(line), lines: [] };
      entries.push(cur);
    } else if (line.startsWith('+')) {
      if (!cur) {
        cur = { at: null, lines: [] };
        entries.push(cur);
      }
      cur.lines.push(line.slice(1));
    } else {
      cur = null; // blank line closes the entry
    }
  }
  return entries
    .map((e) => ({ at: e.at, text: e.lines.join('\n').trim() }))
    .filter((e) => e.text);
}

/** Only used when a project has input history but no chat transcript. */
function inputSession(p, liveCwds) {
  const t = readTail(p.input);
  if (!t) return null;
  const entries = parseInputHistory(t.text);
  if (!entries.length) return null;
  const last = entries[entries.length - 1];
  const lines = entries.flatMap((e) => e.text.split('\n'));
  const first = clip(entries[0].text, 240);
  const running = liveCwds.has(path.resolve(p.dir)) || Date.now() - t.mtime < IDLE_MS;
  return mkSession({
    id: `aider-input:${path.basename(p.dir)}:${last.at ?? Math.round(t.mtime)}`,
    title: clip(first, 80) ?? 'Aider prompts (no transcript)',
    objective: first,
    status: running ? 'running' : 'idle',
    cwd: p.dir,
    updatedAt: last.at ?? t.mtime,
    todos: todosFrom(lines),
    action: clip(last.text, MAX_ACTION),
    files: filesFrom(entries.map((e) => `#### ${e.text}`), p.dir),
    source: p.input,
  });
}

// ---------------------------------------------------------------- AiderDesk

function deskSessions(projects) {
  const out = [];
  for (const p of projects) {
    if (!p.desk) continue;
    for (const e of ls(p.desk)) {
      if (!e.isDirectory()) continue;
      const taskId = e.name;
      const dir = path.join(p.desk, taskId);
      const settings = safeJSON(path.join(dir, 'settings.json'));
      const data = settings?.value ?? {};
      const todosRaw = safeJSON(path.join(dir, 'todos.json'))?.value ?? null;
      const ctxRaw = safeJSON(path.join(dir, 'context.json'))?.value ?? null;

      const todos = Array.isArray(todosRaw?.items)
        ? todosRaw.items
            .map((t) => ({ content: clip(t?.name, MAX_ACTION), status: t?.completed ? 'done' : 'pending' }))
            .filter((t) => t.content)
        : [];

      const state = str(data.state || '').toUpperCase();
      const msgs = Array.isArray(ctxRaw?.contextMessages) ? ctxRaw.contextMessages : [];
      const lastMsg = msgs.length ? lastTextOf(msgs[msgs.length - 1]) : null;

      const files = Array.isArray(ctxRaw?.contextFiles)
        ? [...new Set(
            ctxRaw.contextFiles
              .map((f) => clip(f?.path, 400))
              .filter(Boolean)
              .map((rel) => path.resolve(dir, rel))
              .filter((abs) => isFile(abs) || fs.existsSync(abs))
          )].slice(0, MAX_FILE_PROBES)
        : [];

      const updatedAt = parseStamp(data.updatedAt) ?? parseStamp(data.completedAt)
        ?? parseStamp(data.createdAt) ?? settings?.mtime ?? null;
      const objective = clip(todosRaw?.initialUserPrompt ?? data.name, 240);

      out.push(mkSession({
        id: `aider-desk:${taskId}`,
        title: clip(data.name, 80) ?? clip(objective, 80) ?? `AiderDesk task ${taskId}`,
        objective,
        status: DESK_STATE[state] ?? 'idle',
        cwd: clip(data.baseDir, 400) ?? p.dir,
        updatedAt,
        todos,
        action: clip(lastMsg, MAX_ACTION),
        files,
        source: path.join(dir, 'settings.json'),
      }));
    }
  }
  return out;
}

/** Best-effort text of a context message (shape varies across aider-desk versions). */
function lastTextOf(msg) {
  try {
    if (typeof msg === 'string') return msg;
    for (const k of ['content', 'text', 'message', 'prompt', 'value']) {
      const v = msg?.[k];
      if (typeof v === 'string' && v.trim()) return v;
      if (Array.isArray(v)) {
        const s = v.map((x) => (typeof x === 'string' ? x : x?.text ?? x?.content ?? '')).filter(Boolean).join(' ');
        if (s.trim()) return s;
      }
    }
    if (typeof msg?.name === 'string') return msg.name;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- public API

const byNewest = (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);

function collect() {
  const liveCwds = liveAiderCwds();
  const projects = findProjects();
  const out = [];

  const chats = projects.filter((p) => p.chat).slice(0, MAX_SESSION_SCAN);
  for (const p of chats) {
    const t = readTail(p.chat);
    if (!t) continue;
    const runs = splitRuns(t.text).filter((r) => r.lines.length);
    runs.forEach((run, i) => {
      out.push(chatSession(run, {
        dir: p.dir,
        chatFile: p.chat,
        mtime: t.mtime,
        isNewest: i === runs.length - 1,
        nextStart: runs[i + 1]?.startedAt ?? null,
        liveCwds,
        deep: runs.length - 1 - i < 5, // only the 5 newest runs pay for file probes
      }));
    });
  }

  // A project with no transcript still tells us what was asked (real timestamps).
  for (const p of projects) {
    if (p.chat || !p.input) continue;
    const s = inputSession(p, liveCwds);
    if (s) out.push(s);
  }

  out.push(...deskSessions(projects));
  return out.filter(Boolean).sort(byNewest);
}

export function sessions({ limit = 20 } = {}) {
  try {
    const all = collect();
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
    return all.slice(0, n);
  } catch {
    return [];
  }
}

/** { sessions, running, todos, lastAt } — zeros when aider left nothing behind. */
export function summary() {
  try {
    const all = collect();
    return {
      sessions: all.length,
      running: all.filter((s) => s.status === 'running').length,
      todos: all.reduce((n, s) => n + s.todos.length, 0),
      lastAt: all.length ? all[0].updatedAt ?? null : null,
    };
  } catch {
    return { sessions: 0, running: 0, todos: 0, lastAt: null };
  }
}
