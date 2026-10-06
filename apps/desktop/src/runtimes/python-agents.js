// Python-agent runtime adapter — LangGraph/LangServe, CrewAI, AutoGen, Letta/MemGPT,
// Eliza, smolagents, Pydantic-AI, plus any long-running python process that looks like
// an agent.
//
// ── EVIDENCE: read-only recon on this Mac (user `mona`), 2026-10-06 ──────────────
//
// Commands run, and exactly what they returned:
//
//   ps -Ao pid,etime,rss,args | grep -iE 'python|uvicorn|langgraph|crewai|autogen|letta|eliza|smolagents' | grep -v grep
//     → no agent runtime alive. The only hit was a transient probe of my own:
//       44990 00:01 916 /Library/Developer/CommandLineTools/.../MacOS/Python .../pip3 show aider-chat
//     A re-check two minutes later: no python process at all.
//
//   for d in ~/.langgraph ~/.crewai ~/.letta ~/.cache/langgraph ~/.local/share/letta ~/.eliza; do ls -la $d; done
//     → every one of these printed nothing: none exist.
//
//   find ~ -maxdepth 3 \( -name '.langgraph_api' -o -name 'langgraph.json' -o -name '.letta' \
//        -o -name '.crewai' -o -name '.eliza' \) -not -path '*/node_modules/*' -not -path '*/.git/*'
//   find ~ -maxdepth 3 -type d \( -iname '*langgraph*' -o -iname '*crewai*' -o -iname '*letta*' \
//        -o -iname '*memgpt*' -o -iname '*autogen*' -o -iname '*eliza*' -o -iname '*smolagents*' \)
//     → (no output) — no python-agent project or store anywhere in depth 3 of ~.
//
//   find ~ -maxdepth 3 -name '*.sqlite' -path '*agent*' 2>/dev/null | head
//     → (no output)
//
//   ls /Users/mona/Library/Python/3.9/lib/python/site-packages | grep -iE 'langchain|langgraph|crewai|autogen|letta|memgpt|eliza|smolagents|openai|anthropic|uvicorn|fastapi'
//     → no agent framework installed. Only hits: torch, torch-2.2.2.dist-info, torchvision,
//       functorch, torchgen (ML libraries, not agent frameworks).
//
//   /usr/bin/sqlite3 --version → 3.43.2 2023-10-10 ; /usr/sbin/lsof → present ; /bin/ps → present
//   /usr/sbin/lsof -a -p 525 -d cwd -Fn → "p525\nfcwd\nn/Users/mona/.openclaw"   (cwd probe works)
//
// SQLite schemas confirmed: NONE. No python-agent SQLite store exists on this machine,
// so `sqlite3 -readonly <db> '.tables'` had nothing to confirm. The only DBs under ~
// (depth 3) belong to OTHER runtimes and are deliberately NOT read here:
//   ~/Library/Passes/passes23.sqlite · ~/Library/com.apple.iTunesCloud/play_activity.sqlitedb
//   ~/.codex/logs_2.sqlite · ~/.codex/memories_1.sqlite
// Because no schema could be confirmed, this adapter hardcodes none: it reads
// `sqlite_master` and `pragma_table_info` at runtime and maps only columns that
// actually exist. An unconfirmed schema is discovered, never assumed.
//
// Consequence on this Mac: `verified` is false (probed at import), sessions() → [].
// That is the honest empty answer, not a stub — install CrewAI, or run a LangGraph
// app, and this same file starts reporting without an edit.
//
// ponytail: `verified` is read once at import, and runtimes/index.js skips an adapter
// whose verified is false. A long-lived daemon that imported this before a framework
// was installed would keep skipping it. Upgrade path: index.js re-probes on a timer,
// or reads sessions() regardless of verified. Ceiling: restart the daemon after
// installing a python agent stack.
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const id = 'python-agents';
export const label = 'Python agents (LangGraph · CrewAI · AutoGen · Letta · Eliza · smolagents · Pydantic-AI)';

const HOME = homedir();
const PS = '/bin/ps';
const LSOF = '/usr/sbin/lsof';
const SQLITE = '/usr/bin/sqlite3';

const MAX_DEPTH = 3;          // bounded walk of ~, per the spec
const MAX_FILE_BYTES = 20 * 1024 * 1024;  // never read a file larger than this
const TAIL_BYTES = 32 * 1024;
const WALK_BUDGET_MS = 1500;
const CAP_PROC = 40;
const CAP_STORES = 25;
const CAP_DBS = 3;            // sqlite3 spawns, bounded
const CAP_LSOF = 20;
const CAP_TODOS = 20;
const CAP_FILES = 40;

// Directories never descended into (the spec's list, plus two huge macOS trees).
const SKIP = new Set(['node_modules', '.git', 'venv', '.venv', 'Library', '.Trash', 'Applications']);

// A directory whose presence means a python agent runtime lives here.
const MARKER_DIRS = new Map([
  ['.langgraph_api', 'LangGraph'],
  ['.langgraph', 'LangGraph'],
  ['.crewai', 'CrewAI'],
  ['.letta', 'Letta/MemGPT'],
  ['.memgpt', 'Letta/MemGPT'],
  ['.autogen', 'AutoGen'],
  ['.eliza', 'Eliza'],
  ['.smolagents', 'smolagents'],
]);

// A file whose presence means the same, inside a project dir.
const MARKER_FILES = [
  [/^langgraph\.json$/, 'LangGraph'],
  [/^langgraph\.json\./i, 'LangGraph'],
  [/^crewai.*\.(toml|yaml|yml|json)$/i, 'CrewAI'],
  [/^letta.*\.(toml|yaml|yml|json)$/i, 'Letta/MemGPT'],
  [/^eliza\.json$/i, 'Eliza'],
  [/^\.env\.langgraph$/i, 'LangGraph'],
];

// Framework identification, strongest signal first — matched against a process cmdline
// or an install/store path.
const FRAMEWORKS = [
  [/langgraph|langserve|langchain/i, 'LangGraph/LangServe'],
  [/crewai/i, 'CrewAI'],
  [/autogen|(^|\W)ag2(\W|$)/i, 'AutoGen'],
  [/letta|memgpt/i, 'Letta/MemGPT'],
  [/smolagents?/i, 'smolagents'],
  [/pydantic[-_]?ai/i, 'Pydantic-AI'],
  [/eliza/i, 'Eliza'],
];

// A python process only counts as an agent when its cmdline actually says so. Good
// enough to catch a hand-rolled loop (`python my_agent.py`, `-m my_llm_bot`); a bare
// `uvicorn myapp:app` is a web app and is ignored.
const AGENT_MARKERS = /(agent|_ai\b|llm|openai|anthropic|langchain|langgraph|crewai|autogen|letta|memgpt|eliza|smolagents|tool_?call|chat_loop|react_loop|assistant)/i;
const PY_RUNTIME = /(^|\/)(python[0-9.]*|uvicorn|gunicorn|hypercorn)$|python[0-9.]*\s+-m|\.py(\s|$)/i;

const STATUS_MAP = new Map(Object.entries({
  running: 'running', active: 'running', in_progress: 'running', 'in-progress': 'running', started: 'running', executing: 'running',
  pending: 'pending', queued: 'pending', waiting: 'pending', paused: 'pending', interrupted: 'pending',
  success: 'done', succeeded: 'done', completed: 'done', complete: 'done', done: 'done', finished: 'done',
  error: 'failed', failed: 'failed', aborted: 'aborted', cancelled: 'aborted', canceled: 'aborted',
}));

/** Run a native tool; any failure (missing binary, timeout, non-zero) yields ''. */
function run(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', maxBuffer: 4 << 20, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
}

function frameworkOf(text) {
  for (const [re, name] of FRAMEWORKS) if (re.test(text)) return name;
  return null;
}

/** `ps` etime (`MM:SS`, `HH:MM:SS`, `D-HH:MM:SS`) → milliseconds. */
function etimeToMs(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s ?? '').trim());
  if (!m) return null;
  return (((+m[1] || 0) * 86400) + ((+m[2] || 0) * 3600) + (+m[3] * 60) + (+m[4])) * 1000;
}

/** Last `maxBytes` of a file, or '' — never reads a file bigger than MAX_FILE_BYTES. */
function tail(file, maxBytes = TAIL_BYTES) {
  let fd;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size === 0) return '';
    if (st.size > MAX_FILE_BYTES) return '';
    const len = Math.min(maxBytes, st.size);
    const buf = Buffer.alloc(len);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, len, st.size - len);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } } }
}

function mtimeMs(file) {
  try { return Math.round(statSync(file).mtimeMs); } catch { return null; }
}

/** Absolute cwd of each pid, in ONE lsof call. */
function cwdsOf(pids) {
  const map = new Map();
  if (!pids.length) return map;
  const args = ['-a', '-d', 'cwd'];
  for (const p of pids.slice(0, CAP_LSOF)) args.push('-p', String(p));
  args.push('-Fn');
  let cur = null;
  for (const line of run(LSOF, args).split('\n')) {
    if (line.startsWith('p')) cur = line.slice(1);
    else if (line.startsWith('n') && cur) { map.set(cur, line.slice(1)); cur = null; }
  }
  return map;
}

/** The script a python cmdline is actually running, as an absolute path. */
function scriptOf(argv, cwd) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m' && argv[i + 1]) return `${argv[i + 1]} (module)`;
    if (a.endsWith('.py')) return isAbsolute(a) ? a : (cwd ? resolve(cwd, a) : a);
  }
  return null;
}

/** Every live python process that looks like an agent. */
function processSessions() {
  const out = [];
  let cwds = new Map();
  try {
    const lines = run(PS, ['-Ao', 'pid=,etime=,rss=,args=']).split('\n');
    const cand = [];
    for (const line of lines) {
      const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const [, pid, etime, rss, args] = m;
      if (!PY_RUNTIME.test(args)) continue;
      if (!frameworkOf(args) && !AGENT_MARKERS.test(args)) continue;
      cand.push({ pid, etime, rss: +rss, args, argv: args.split(/\s+/) });
      if (cand.length >= CAP_PROC) break;
    }
    if (!cand.length) return out;
    cwds = cwdsOf(cand.map((c) => c.pid));
    for (const c of cand) {
      const cwd = cwds.get(c.pid) ?? null;
      const started = etimeToMs(c.etime);
      const script = scriptOf(c.argv, cwd);
      const fw = frameworkOf(c.args);
      const cmdline = c.args.replace(/\s+/g, ' ');
      out.push({
        id: `py:pid-${c.pid}`,
        agent: fw ?? (script ? basename(script.replace(/ \(module\)$/, '')) : 'python'),
        title: (script ? basename(script.replace(/ \(module\)$/, '')) : cmdline).slice(0, 120),
        objective: null,               // a cmdline is not an objective; do not invent one
        status: 'running',             // observed in the process table, not inferred
        cwd,
        updatedAt: started === null ? null : Date.now() - started,
        todos: [],                     // no todo store is readable from a bare process
        action: cmdline.slice(0, 160),
        files: [script].filter((p) => p && isAbsolute(p) && !p.endsWith(' (module)')).slice(0, CAP_FILES),
        source: 'ps',
        pid: +c.pid,
        framework: fw,
        rssKb: c.rss,
      });
    }
  } catch { /* a process census must never break the tick */ }
  return out;
}

/**
 * Bounded walk of ~ (depth ≤ 3) collecting directories that look like a python-agent
 * home: a known marker dir, or a project dir holding a known marker file.
 */
function storeDirs() {
  const found = new Map(); // abs path → framework label
  const deadline = Date.now() + WALK_BUDGET_MS;
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || Date.now() > deadline || found.size >= CAP_STORES) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.size >= CAP_STORES) return;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        const marker = MARKER_DIRS.get(e.name) ?? frameworkOf(abs);
        if (marker) { found.set(abs, marker); continue; }
        walk(abs, depth + 1);
      } else {
        for (const [re, fw] of MARKER_FILES) if (re.test(e.name)) { found.set(dir, fw); break; }
      }
    }
  };
  walk(HOME, 1);
  return found;
}

/** SQLite files directly inside a store dir, or one level down (`checkpoints/`, `data/`). */
function dbsIn(dir) {
  const out = [];
  const scan = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 8) return;
      if (e.isFile() && /\.(sqlite3?|db)$/i.test(e.name)) out.push(join(d, e.name));
    }
  };
  scan(dir);
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= 8) break;
      if (e.isDirectory() && /checkpoint|store|data|db|state|logs?/i.test(e.name)) scan(join(dir, e.name));
    }
  } catch { /* unreadable store */ }
  return out;
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

// Column roles, resolved against columns that ACTUALLY exist (never a fixed schema).
const COL_ID = /(^|_)id$|^uuid$|^key$|^(thread|run|session|conversation)_id$/i;
const COL_TITLE = /title|^name$|subject|summary|^label$/i;
const COL_OBJECTIVE = /objective|^goal$|description|^input$|prompt|instruction|^question$/i;
const COL_STATUS = /status|^state$|^stage$|^phase$/i;
const COL_UPDATED = /updated|modified|^mtime$|last_?(seen|active|run|update)|^created(_at)?$|^timestamp$|^time$|^ts$/i;
const COL_CONTENT = /^content$|^text$|^message$|^value$|^body$|^output$|^result$/i;
const TABLE_RE = /sess|thread|conversation|(^|_)run|task|todo|checkpoint|message|agent|state/i;

const pick = (cols, re) => cols.find((c) => re.test(c)) ?? null;

function msOf(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : (v > 1e9 ? v * 1000 : null);
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== '') return n > 1e12 ? n : (n > 1e9 ? n * 1000 : null);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Read a store with NO assumed schema: ask sqlite3 for its tables, then for the columns
 * those tables really have, and map only the roles that exist.
 */
function sqliteSession(db, dir, fw, procs) {
  const tables = run(SQLITE, ['-readonly', '-separator', '\u0001', db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"])
    .split('\n').map((s) => s.trim()).filter(Boolean);
  if (!tables.length) return null;
  const cand = tables.filter((t) => TABLE_RE.test(t)).slice(0, 8);
  if (!cand.length) return null;

  // One spawn for every candidate table's columns.
  const schemaOut = run(SQLITE, ['-readonly', '-separator', '\u0001', db,
    `${cand.map((t) => `SELECT ${quote(t)} AS tbl, name AS col FROM pragma_table_info(${quote(t)})`).join(' UNION ALL ')};`]);
  const cols = new Map();
  for (const line of schemaOut.split('\n')) {
    const [t, c] = line.split('\u0001');
    if (!t || !c) continue;
    if (!cols.has(t)) cols.set(t, []);
    cols.get(t).push(c.trim());
  }

  const todos = [];
  let best = null;
  let bestRank = 99;
  for (const [t, cs] of cols) {
    const rank = /todo|task/i.test(t) ? 0 : (/sess|thread|conversation|(^|_)run|checkpoint|agent|state/i.test(t) ? 1 : 2);
    const content = pick(cs, COL_CONTENT);
    if (rank === 0 && content) {
      const st = pick(cs, COL_STATUS);
      const rows = run(SQLITE, ['-readonly', '-separator', '\u0001', db,
        `SELECT ${[content, st].filter(Boolean).map(ident).join(', ')} FROM ${ident(t)} LIMIT ${CAP_TODOS};`]);
      for (const line of rows.split('\n')) {
        if (!line.trim()) continue;
        const [text, status] = line.split('\u0001');
        if (text) todos.push({ content: String(text).slice(0, 200), status: STATUS_MAP.get(String(status ?? '').toLowerCase()) ?? 'unknown' });
      }
    }
    if (rank < bestRank && pick(cs, COL_ID)) { best = { t, cs }; bestRank = rank; }
  }
  if (!best) return null;

  const cs = best.cs;
  const role = {
    id: pick(cs, COL_ID), title: pick(cs, COL_TITLE), objective: pick(cs, COL_OBJECTIVE),
    status: pick(cs, COL_STATUS), updated: pick(cs, COL_UPDATED), content: pick(cs, COL_CONTENT),
  };
  const sel = Object.entries(role).filter(([, c]) => c).map(([k, c]) => `${ident(c)} AS ${k}`);
  const order = role.updated ? ` ORDER BY ${ident(role.updated)} DESC` : '';
  const csv = run(SQLITE, ['-readonly', '-separator', '\u0001', db, `SELECT ${sel.join(', ')} FROM ${ident(best.t)}${order} LIMIT 1;`]);
  const first = csv.split('\n').find((l) => l.trim());
  if (!first) return null;
  const keys = Object.keys(role).filter((k) => role[k]);
  const row = Object.fromEntries(first.split('\u0001').map((v, i) => [keys[i], v]));

  const live = procs.some((s) => s.cwd && (s.cwd === dir || s.cwd.startsWith(`${dir}/`)));
  const raw = String(row.status ?? '').toLowerCase();
  return {
    id: `pydb:${db}`,
    agent: fw ?? frameworkOf(dir) ?? 'python',
    title: (row.title || row.objective || basename(dir)).slice(0, 120),
    objective: row.objective ? String(row.objective).slice(0, 300) : null,
    status: live ? 'running' : (STATUS_MAP.get(raw) ?? 'idle'),
    cwd: dir,
    updatedAt: msOf(row.updated) ?? mtimeMs(db) ?? mtimeMs(dir),
    todos,
    action: row.content ? String(row.content).replace(/\s+/g, ' ').slice(0, 160) : null,
    files: [db].slice(0, CAP_FILES),
    source: db,
  };
}

/** The project's own name, read from a config file it really ships (never guessed). */
function configTitle(files) {
  for (const f of files) {
    if (!/\.json$/i.test(f)) continue;
    try {
      const cfg = JSON.parse(tail(f));
      const name = cfg.name ?? Object.keys(cfg.graphs ?? cfg.agents ?? {})[0];
      if (name) return String(name).slice(0, 120);
    } catch { /* empty, oversized, or not a config we understand */ }
  }
  return null;
}

/** Store dirs with no readable SQLite: reported from disk, status never invented. */function dirSession(dir, fw, procs) {
  const live = procs.some((s) => s.cwd && (s.cwd === dir || s.cwd.startsWith(`${dir}/`)));
  if (live) return null; // the running process session already represents it
  const files = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      for (const [re] of MARKER_FILES) if (re.test(e.name)) { files.push(join(dir, e.name)); break; }
    }
  } catch { /* unreadable store */ }
  return {
    id: `pydir:${dir}`,
    agent: fw,
    title: configTitle(files) ?? basename(dir),
    objective: null,
    status: 'idle',          // no live process was matched to this store — observed, not guessed
    cwd: dir,
    updatedAt: mtimeMs(dir),
    todos: [],
    action: null,
    files: files.slice(0, CAP_FILES),
    source: dir,
  };
}

function diskSessions(procs) {
  const out = [];
  const dirs = storeDirs();
  let dbsRead = 0;
  for (const [dir, fw] of dirs) {
    try {
      let made = null;
      for (const db of dbsIn(dir)) {
        if (dbsRead >= CAP_DBS) break;
        dbsRead++;
        made = sqliteSession(db, dir, fw, procs);   // schema discovered, never assumed
        if (made) break;
      }
      out.push(made ?? dirSession(dir, fw, procs));
    } catch { /* one bad store must not hide the others */ }
  }
  return out.filter(Boolean);
}

/** Newest-first sessions from every python agent on this device. Never throws. */
export function sessions({ limit = 20 } = {}) {
  let all = [];
  try {
    const procs = processSessions();
    all = [...procs, ...diskSessions(procs)];
  } catch { return []; }
  const seen = new Set();
  return all
    .filter((s) => s && s.id && !seen.has(s.id) && seen.add(s.id))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, Math.max(0, limit));
}

export function summary() {
  try {
    const s = sessions({ limit: 100 });
    return {
      sessions: s.length,
      running: s.filter((x) => x.status === 'running').length,
      todos: s.reduce((n, x) => n + (x.todos?.length ?? 0), 0),
      lastAt: s.reduce((m, x) => Math.max(m, x.updatedAt ?? 0), 0) || null,
    };
  } catch {
    return { sessions: 0, running: 0, todos: 0, lastAt: null };
  }
}

/** Is any python agent runtime present at all? Probed once, at import. */
function probe() {
  try {
    if (processSessions().length) return true;
    for (const dir of storeDirs().keys()) if (dir) return true;
    return ['langgraph', 'crewai', 'autogen', 'letta', 'smolagents', 'pydantic_ai', 'eliza'].some(hasModule);
  } catch { return false; }
}

/** Does `python3` have this module? Exit status is the only reliable signal. */
function hasModule(name) {
  try {
    execFileSync('/usr/bin/python3', ['-c', `import ${name}`], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch { return false; }
}

export const verified = probe();
