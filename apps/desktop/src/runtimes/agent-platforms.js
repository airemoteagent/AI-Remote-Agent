/**
 * agent-platforms — runtime adapter for the workflow/agent platforms that can be
 * installed on this Mac: n8n, Dify, Flowise, LangFlow, Activepieces.
 *
 * One session per WORKFLOW (with its last run), plus one session for a platform whose
 * service is running — so the dashboard shows "n8n is up" AND what it last did.
 *
 * Read-only, stdlib + native tools only (fs/os/path/child_process + /usr/bin/sqlite3),
 * total (never throws): no platform, no DB, no process ⇒ [] and zeros.
 *
 * EVIDENCE — measured on this box (macOS, user mona) before writing:
 *
 *   $ for d in ~/.n8n ~/.dify ~/.flowise ~/.cache/langflow ~/.langflow ~/.activepieces \
 *              ~/Library/Application\ Support/n8n ~/Library/Application\ Support/dify \
 *              ~/Library/Application\ Support/flowise; do [ -e "$d" ] && echo "EXISTS $d"; done
 *   (no output — not one of the five platforms is installed on this Mac)
 *
 *   $ ps -Ao pid,args | grep -iE 'n8n|dify|flowise|langflow|activepieces' | grep -v grep
 *   (no output)
 *
 *   $ find ~ -maxdepth 3 \( -name 'docker-compose*.y*ml' -o -name 'compose.y*ml' \) | wc -l
 *   17
 *   $ …same list… | xargs grep -liE 'n8n|dify|flowise|langflow|activepieces'
 *   (no output — the 17 compose files on this Mac are unrelated projects)
 *
 *   $ which sqlite3 && ls -la /usr/bin/sqlite3
 *   /usr/bin/sqlite3
 *   -rwxr-xr-x  1 root  wheel  4328176  4 Aug 09:59 /usr/bin/sqlite3
 *   $ which docker; docker ps
 *   /usr/local/bin/docker
 *   failed to connect to the docker API at unix:///Users/mona/.docker/run/docker.sock:
 *   check if the path is correct and if the daemon is running
 *
 *   => on THIS Mac verified = false and sessions() = []. The honest answer, not a bug.
 *
 * Schemas — never assumed, always probed at read time. A SQLite file is opened
 * `/usr/bin/sqlite3 -readonly`; `.tables` (the evidence command) is read via
 * sqlite_master, then PRAGMA table_info on the candidate table, and the SELECT is built
 * from the columns that actually exist. A vendor renaming a column degrades to fewer
 * fields instead of throwing:
 *
 *   n8n          workflow_entity(id,name,active,createdAt,updatedAt) ·
 *                execution_entity(id,workflowId,status,startedAt,stoppedAt,finished)
 *                  status ∈ running|success|error|crashed|canceled|waiting|new
 *   Flowise      chat_flow(id,name,updatedDate,…) — no execution table; last run is not
 *                recorded, so its workflows report status 'configured'
 *   LangFlow     flow(id,name,updated_at,…) · vertex_builds(...) for build history
 *   Activepieces flow(id,name,…) · execution(id,flowId,status,startedAt)
 *   Dify         no local SQLite at all (PostgreSQL via Docker) — reported from the
 *                process list / compose file, never invented from a missing DB
 *
 *   Real truncated sample — the temporary fixture used to verify this reader (created in
 *   /tmp/aptest, NOT this Mac's data; see the gate run):
 *     $ /usr/bin/sqlite3 -readonly -batch -noheader -separator $'\x1f' /tmp/…/database.sqlite \
 *         "SELECT name FROM sqlite_master WHERE type='table'"
 *     execution_entity
 *     migrations
 *     workflow_entity
 *     $ … "SELECT w.name,(SELECT e.status FROM execution_entity e WHERE e.workflowId=w.id …)"
 *     Nightly sync␟success␟2026-10-06 09:12:00.000
 *
 * ponytail: a Docker-hosted platform is detected from its compose file (status
 * 'configured') — macOS keeps container PIDs inside the VM, so `ps` cannot see them.
 * Upgrade path: one `docker ps --format` pass if the daemon is up.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const id = 'agent-platforms';
export const label = 'Agent platforms';

const HOME = os.homedir();
const APPS = path.join(HOME, 'Library/Application Support');
const SQLITE = '/usr/bin/sqlite3';
const SEP = '\u001f';

const MAX_SESSIONS = 200; // hard cap on rows returned
const MAX_ROWS = 200; // LIMIT on every workflow query
const MAX_BYTES = 20 * 1024 * 1024; // never slurp a text file bigger than this
const MAX_COMPOSE = 120; // compose files read
const MAX_DIRS = 600; // directories visited in the ~ walk
const WALK_DEPTH = 3; // docker-compose files "under ~, bounded depth 3"
const TTL_MS = 3000; // memo window so sessions() + summary() share one scan
const SQL_TIMEOUT_MS = 4000;

// dbs are queried, never slurped — SQLite is random-access, so the 20 MB text rule does
// not apply; every query carries LIMIT. `images` match either an `image:` line or a
// top-level service name in a compose file.
const PLATFORMS = [
  {
    tag: 'n8n',
    label: 'n8n',
    re: /\bn8n\b/i,
    dirs: [path.join(HOME, '.n8n'), path.join(APPS, 'n8n')],
    dbs: [
      {
        file: path.join(HOME, '.n8n/database.sqlite'),
        workflows: ['workflow_entity', 'workflow'],
        executions: ['execution_entity', 'execution'],
      },
    ],
    images: ['n8nio/n8n', 'n8n'],
  },
  {
    tag: 'dify',
    label: 'Dify',
    re: /\bdify\b/i,
    dirs: [path.join(HOME, '.dify'), path.join(APPS, 'dify')],
    dbs: [],
    images: ['langgenius/dify', 'dify-api', 'dify-web', 'dify-sandbox', 'dify'],
  },
  {
    tag: 'flowise',
    label: 'Flowise',
    re: /\bflowise\b/i,
    dirs: [path.join(HOME, '.flowise'), path.join(APPS, 'flowise')],
    dbs: [
      { file: path.join(HOME, '.flowise/database.sqlite'), workflows: ['chat_flow'], executions: [] },
      { file: path.join(APPS, 'flowise/database.sqlite'), workflows: ['chat_flow'], executions: [] },
    ],
    images: ['flowiseai/flowise', 'flowise'],
  },
  {
    tag: 'langflow',
    label: 'LangFlow',
    re: /\blangflow\b/i,
    dirs: [path.join(HOME, '.langflow'), path.join(HOME, '.cache/langflow')],
    dbs: [
      { file: path.join(HOME, '.cache/langflow/langflow.db'), workflows: ['flow'], executions: ['vertex_builds', 'build'] },
      { file: path.join(HOME, '.langflow/langflow.db'), workflows: ['flow'], executions: ['vertex_builds', 'build'] },
    ],
    images: ['langflowai/langflow', 'langflow'],
  },
  {
    tag: 'activepieces',
    label: 'Activepieces',
    re: /\bactivepieces\b/i,
    dirs: [path.join(HOME, '.activepieces'), path.join(APPS, 'activepieces')],
    dbs: [
      { file: path.join(HOME, '.activepieces/database.sqlite'), workflows: ['flow', 'workflow'], executions: ['execution'] },
    ],
    images: ['activepieces/activepieces', 'activepieces'],
  },
];

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'unnamed';

export const verified = (() => {
  try {
    return PLATFORMS.some((p) => p.dirs.some((d) => fs.existsSync(d)) || p.dbs.some((d) => fs.existsSync(d.file)));
  } catch {
    return false;
  }
})();

/** Read-only SQLite query. -readonly guarantees the file cannot be written; null on any failure. */
function sqlite(db, sql) {
  try {
    return execFileSync(SQLITE, ['-readonly', '-batch', '-noheader', '-separator', SEP, db, sql], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: SQL_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function rows(db, sql) {
  const out = sqlite(db, sql);
  if (out == null) return [];
  return out
    .split('\n')
    .filter((l) => l.length > 0)
    .slice(0, MAX_ROWS)
    .map((l) => l.split(SEP));
}

function tables(db) {
  const list = rows(db, "SELECT name FROM sqlite_master WHERE type='table'");
  return list.length ? new Set(list.map((r) => r[0])) : null;
}

function columns(db, table) {
  // table comes from our own candidate list, never from user input.
  return new Set(rows(db, `PRAGMA table_info(${table})`).map((r) => r[1]));
}

const firstCol = (cols, names) => names.find((n) => cols.has(n)) ?? null;

/** SQLite datetime → epoch ms. Handles ms, s, ISO and 'YYYY-MM-DD HH:MM:SS'. */
function toMs(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return null;
  }
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

const RUN_STATUS = {
  success: 'success',
  error: 'error',
  failed: 'error',
  failure: 'error',
  crashed: 'error',
  running: 'running',
  started: 'running',
  new: 'waiting',
  waiting: 'waiting',
  canceled: 'canceled',
  cancelled: 'canceled',
};

function mapStatus(s) {
  if (s == null || s === '') return 'configured';
  return RUN_STATUS[String(s).toLowerCase()] ?? 'configured';
}

/**
 * Workflows from one SQLite file, newest first.
 * One SELECT, correlated on the execution table when that platform keeps one.
 */
function workflowRows(db, spec) {
  const tset = tables(db);
  if (!tset) return [];
  const wf = spec.workflows.find((t) => tset.has(t));
  if (!wf) return [];
  const wcols = columns(db, wf);
  const nameCol = firstCol(wcols, ['name', 'title', 'flowName']);
  const idCol = firstCol(wcols, ['id']);
  if (!nameCol) return [];
  const updCol = firstCol(wcols, ['updatedAt', 'updated_at', 'updatedDate', 'createdAt', 'created_at']);

  const ex = spec.executions.find((t) => tset.has(t)) ?? null;
  let link = null;
  let statusCol = null;
  let timeCol = null;
  if (ex && idCol) {
    const ecols = columns(db, ex);
    link = firstCol(ecols, ['workflowId', 'workflow_id', 'flowId', 'flow_id']);
    statusCol = firstCol(ecols, ['status', 'state']);
    timeCol = firstCol(ecols, ['startedAt', 'started_at', 'createdAt', 'created_at', 'createdDate']);
  }
  const linked = Boolean(ex && link && idCol);
  const order = timeCol ? `e.${timeCol} DESC` : 'e.rowid DESC';
  const sub = (col, ord) => `(SELECT e.${col} FROM ${ex} e WHERE e.${link} = w.${idCol} ORDER BY ${ord} LIMIT 1)`;
  const sel = [
    `w.${nameCol}`,
    linked && statusCol ? sub(statusCol, order) : 'NULL',
    linked ? sub(timeCol ?? updCol ?? idCol, timeCol ? order : 'e.rowid DESC') : updCol ? `w.${updCol}` : 'NULL',
  ];
  return rows(db, `SELECT ${sel.join(', ')} FROM ${wf} w LIMIT ${MAX_ROWS}`);
}

function workflowSessions(spec, db) {
  const out = [];
  for (const [name, rawStatus, rawAt] of workflowRows(db, spec)) {
    if (!name) continue;
    const status = mapStatus(rawStatus);
    out.push({
      id: `platform:${spec.tag}:${slug(name)}`,
      agent: spec.tag,
      title: String(name),
      objective: `${spec.label} workflow "${name}" in ${db} — run status ${status}`,
      status,
      cwd: null,
      updatedAt: toMs(rawAt),
      todos: [],
      action: `workflow "${name}" last run ${status}`,
      files: [],
      source: db,
    });
  }
  return out;
}

/** One ps pass → [{pid, args}]. Never throws. */
function processes() {
  try {
    return execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((l) => /^(\d+)\s+(.*)$/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), args: m[2] }))
      .filter((p) => p.pid !== process.pid);
  } catch {
    return [];
  }
}

/** compose file path → service text, bounded depth 3 under ~. Never throws. */
function composeFiles() {
  const hits = [];
  let dirs = 0;
  const walk = (dir, depth) => {
    if (depth > WALK_DEPTH || dirs >= MAX_DIRS || hits.length >= MAX_COMPOSE) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirs += 1;
    for (const e of entries) {
      if (dirs >= MAX_DIRS || hits.length >= MAX_COMPOSE) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'Library') walk(p, depth + 1);
      } else if (/^(docker-)?compose\.ya?ml$/.test(e.name)) {
        hits.push(p);
      }
    }
  };
  walk(HOME, 0);
  return hits;
}

function composeText(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

let memo = { at: 0, val: null };

/** { sessions, running, todos, lastAt } — zeros when nothing is found. */
function scan() {
  const procs = processes();
  const compose = composeFiles();
  const texts = new Map();
  const sessions = [];
  const seen = new Set();
  let running = 0;
  let lastAt = 0;

  const push = (s) => {
    if (sessions.length >= MAX_SESSIONS || seen.has(s.id)) return;
    seen.add(s.id);
    sessions.push(s);
    if (s.status === 'running') running += 1;
    if (s.updatedAt) lastAt = Math.max(lastAt, s.updatedAt);
  };

  for (const spec of PLATFORMS) {
    const dir = spec.dirs.find((d) => fs.existsSync(d)) ?? null;
    const hit = procs.find((p) => spec.re.test(p.args)) ?? null;
    let evidence = dir;
    if (!evidence) {
      for (const f of compose) {
        if (!texts.has(f)) texts.set(f, composeText(f));
        const text = texts.get(f);
        if (!text) continue;
        if (spec.images.some((i) => text.toLowerCase().includes(i)) || new RegExp(`^\\s{0,6}${spec.tag}:`, 'im').test(text)) {
          evidence = f;
          break;
        }
      }
    }

    let found = 0;
    for (const db of spec.dbs) {
      try {
        if (!fs.statSync(db.file).isFile()) continue;
      } catch {
        continue;
      }
      for (const s of workflowSessions(spec, db.file)) {
        push(s);
        found += 1;
      }
    }

    // A running service, or a platform with no readable workflows yet, still deserves a row.
    if (hit || (evidence && found === 0)) {
      const status = hit ? 'running' : 'configured';
      push({
        id: `platform:${spec.tag}`,
        agent: spec.tag,
        title: spec.label,
        objective: hit
          ? `${spec.label} service is running (pid ${hit.pid})${dir ? ` · ${dir}` : ''}`
          : `${spec.label} is configured${evidence ? ` via ${evidence}` : ''}`,
        status,
        cwd: dir,
        updatedAt: hit ? Date.now() : mtimeOf(evidence),
        todos: [],
        action: hit ? `${spec.label} service running (pid ${hit.pid})` : `${spec.label} configured (${evidence})`,
        files: evidence ? [evidence] : [],
        source: evidence ?? (dir || 'compose'),
      });
    }
  }

  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || Number(b.status === 'running') - Number(a.status === 'running'));
  return { sessions, running, todos: 0, lastAt: lastAt || null };
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs || null;
  } catch {
    return null;
  }
}

/**
 * Newest-first sessions for n8n / Dify / Flowise / LangFlow / Activepieces.
 * status: 'running' (service live) | a run status ('success'|'error'|'canceled'|'waiting')
 * | 'configured' (installed or declared, never run).
 */
export function sessions({ limit = 20 } = {}) {
  const cap = Math.max(0, Math.min(Number(limit) || 0, MAX_SESSIONS));
  try {
    if (!memo.val || Date.now() - memo.at >= TTL_MS) memo = { at: Date.now(), val: scan() };
    return memo.val.sessions.slice(0, cap);
  } catch {
    return [];
  }
}

/** { sessions, running, todos, lastAt } — zeros when nothing is found. */
export function summary() {
  try {
    if (!memo.val || Date.now() - memo.at >= TTL_MS) memo = { at: Date.now(), val: scan() };
    const { sessions: list, running, todos, lastAt } = memo.val;
    return { sessions: list.length, running, todos, lastAt };
  } catch {
    return { sessions: 0, running: 0, todos: 0, lastAt: null };
  }
}
