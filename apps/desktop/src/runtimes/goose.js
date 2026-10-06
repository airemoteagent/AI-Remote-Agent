// Goose (Block) runtime adapter — sessions read straight out of Goose's own SQLite store.
//
// ===========================================================================
// EVIDENCE
// ===========================================================================
// NOT INSTALLED ON THIS MAC. Verified absent, 2026-10-06, user `mona`:
//
//   $ ls -d ~/.config/goose ~/Library/Application\ Support/Block/goose \
//           ~/Library/Application\ Support/goose ~/.local/share/goose
//   ls: /Users/mona/.config/goose: No such file or directory
//   ls: /Users/mona/.local/share/goose: No such file or directory
//   ls: /Users/mona/Library/Application Support/Block/goose: No such file or directory
//   ls: /Users/mona/Library/Application Support/goose: No such file or directory
//   $ which goose                                        # no output, exit 1
//   $ find ~ -maxdepth 4 \( -iname '*goose*' -o -iname '*opencode*' \) \
//         -not -path '*/node_modules/*' 2>/dev/null | head -20
//                                                        # no output
//
// So `verified` is false here and no row from a user store can be pasted. Nothing
// below is guessed: paths and DDL come from block/goose `main`, and the sample at
// the bottom is real `sqlite3 -json` output from a fixture built with that exact DDL.
//
// PATH RESOLUTION — crates/goose/src/config/paths.rs
//   data_dir() = $GOOSE_PATH_ROOT/data when that env var is an ABSOLUTE path,
//                else etcetera AppStrategy{ top_level_domain: "Block", author:
//                "Block", app_name: "goose" } — whose own source comment names
//                "~/Library/Application Support/Block/goose/" for back-compat.
//     macOS : data ~/Library/Application Support/Block/goose/data
//             config ~/Library/Application Support/Block/goose/config
//     Linux : data ~/.local/share/goose          config ~/.config/goose
//   (config.yaml lives in the config dir and carries no session state — not read here.)
//
// DB PATH — crates/goose/src/session/session_manager.rs
//   SESSIONS_FOLDER = "sessions"; DB_NAME = "sessions.db"
//   let session_dir = data_dir.join(SESSIONS_FOLDER);
//   let db_path     = session_dir.join(DB_NAME);
//     macOS : ~/Library/Application Support/Block/goose/data/sessions/sessions.db
//     Linux : ~/.local/share/goose/sessions/sessions.db
//   CURRENT_SCHEMA_VERSION = 16. A pre-v16 build kept one JSON blob per session
//   (sessions.session_json, imported by SessionStorage::import_legacy) — both layouts
//   are read here, chosen by PRAGMA table_info rather than by a version guess.
//
// SCHEMA — verbatim from session_manager.rs `init` (schema v16):
//   CREATE TABLE IF NOT EXISTS sessions (
//       id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
//       description TEXT NOT NULL DEFAULT '', user_set_name BOOLEAN DEFAULT FALSE,
//       session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL,
//       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//       updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//       extension_data TEXT DEFAULT '{}',
//       total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
//       cache_read_tokens INTEGER, cache_write_tokens INTEGER,
//       accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER,
//       accumulated_output_tokens INTEGER, accumulated_cache_read_tokens INTEGER,
//       accumulated_cache_write_tokens INTEGER, accumulated_cost REAL,
//       schedule_id TEXT, recipe_json TEXT, user_recipe_values_json TEXT,
//       provider_name TEXT, model_config_json TEXT,
//       goose_mode TEXT NOT NULL DEFAULT 'auto',
//       archived_at TIMESTAMP, project_id TEXT, parent_session_id TEXT )
//   CREATE TABLE IF NOT EXISTS messages (
//       id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT,
//       session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL,
//       content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL,
//       timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, tokens INTEGER,
//       metadata_json TEXT )
//   There is NO todo table — `todos` stays empty rather than inventing one.
//   updated_at is rewritten on every add_message (session_manager.rs), so it is the
//   honest recency key. created_at/updated_at are TEXT 'YYYY-MM-DD HH:MM:SS' in UTC;
//   messages.created_timestamp is unix SECONDS.
//
// REAL SAMPLE — `sqlite3 -readonly -json <fixture>.db "SELECT ... FROM sessions s
// ORDER BY s.updated_at DESC LIMIT 1"`, fixture DDL copied from the block above,
// output truncated to 300 chars as the gate does:
//   {"id":"20260101_1","name":"refactor policy engine","description":"",
//    "working_dir":"/Users/mona/Documents/fullremoteagent","created_at":"2026-01-01 10:00:00",
//    "updated_at":"2026-01-01 10:05:00","provider_name":"anthropic","session_type":"user",
//    "archived_at":null,"session_json":null,"model_config_json":"{\"model_name\":\"claude-sonnet-4\"}"}
// and one messages row from the same fixture:
//   {"role":"user","content_json":"[{\"type\":\"text\",\"text\":\"add a goose adapter\"}]",
//    "created_timestamp":1767261600}
//
// ponytail: the DB is NOT subject to the 20 MB whole-file cap — every read is a
// row-limited SQL query, so sqlite3 touches only the pages it needs. The cap applies
// to the pre-v16 per-session JSON files, which must be slurped whole. Upgrade path
// if a store ever outgrows this: query the `messages` table for the tail window in
// SQL instead of per-session round-trips.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const id = 'goose';
export const label = 'Goose';

const HOME = homedir();
const SQLITE = existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_STDOUT = 16 * 1024 * 1024;
const IDLE_MS = 90_000;
const TAIL_MESSAGES = 12;

// ---------------------------------------------------------------- discovery

/** Data dirs goose may use, current layout first. See paths.rs note in the header. */
function dataDirs() {
  const out = [];
  const root = process.env.GOOSE_PATH_ROOT;
  if (root && root.startsWith('/')) out.push(join(root, 'data'));
  out.push(join(HOME, 'Library', 'Application Support', 'Block', 'goose', 'data'));
  out.push(join(HOME, '.local', 'share', 'goose'));
  out.push(join(HOME, 'Library', 'Application Support', 'Block', 'goose'));
  out.push(join(HOME, 'Library', 'Application Support', 'goose', 'data'));
  return [...new Set(out)];
}

function safeReaddir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

const dbCandidates = () => dataDirs().flatMap((d) => [join(d, 'sessions', 'sessions.db'), join(d, 'sessions.db')]);

function findDb() {
  return dbCandidates().find((p) => existsSync(p)) ?? null;
}

/** Pre-v16 layout: one <uuid>.json per session inside the sessions folder. */
function findLegacyDir() {
  for (const d of dataDirs()) {
    const dir = join(d, 'sessions');
    if (safeReaddir(dir).some((e) => e.isFile() && e.name.endsWith('.json'))) return dir;
  }
  return null;
}

const findStore = () => findDb() ?? findLegacyDir();

export const verified = findStore() !== null;

// ------------------------------------------------------------------ sqlite

const qlit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Query a SQLite file read-only; never throws.
 * A WAL held open by a running goose makes `-readonly` fail (SQLITE_BUSY, exit 5),
 * so fall back to querying a snapshot copy — db plus its -wal/-shm siblings, which
 * is the same committed state without fighting the live writer.
 */
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
    dir = mkdtempSync(join(tmpdir(), 'goose-ro-'));
    const copy = join(dir, 'sessions.db');
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

/** Seconds, milliseconds and RFC3339 all turn up in these files — normalise to ms epoch. */
function ms(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v > 1e10 ? v : v * 1000) : null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^-?\d+$/.test(s)) return ms(Number(s));
  const t = Date.parse(/[TZ]/.test(s) ? s : `${s.replace(' ', 'T')}Z`); // sqlite CURRENT_TIMESTAMP is UTC
  return Number.isFinite(t) ? t : null;
}

const blocks = (json) => {
  const v = parseJson(json);
  return Array.isArray(v) ? v : [];
};

const FILE_KEYS = new Set(['path', 'file_path', 'filepath', 'filePath', 'filename', 'notebook_path', 'target_file']);

/** Depth-bounded hunt for absolute paths in a tool call — goose nests them under
 *  toolCall.value.arguments and the key spelling drifts between tools. */
function pickFiles(v, out, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 6 || out.length > 40) return;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string' && FILE_KEYS.has(k) && val.startsWith('/')) out.push(val);
    else if (val && typeof val === 'object') pickFiles(val, out, depth + 1);
  }
}

/** objective / last action / touched files out of goose message content blocks.
 *  Block `type` is goose's serde tag: text | toolRequest | toolResponse | thinking. */
function describe(messages) {
  let objective = null;
  let action = null;
  const files = [];
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === 'text' && b.text) {
        if (m.role === 'user' && objective === null) objective = clamp(b.text, 120);
        action = clamp(b.text, 160);
      } else if (b.type === 'toolRequest') {
        const call = b.toolCall?.value ?? b.toolCall ?? {};
        const args = call.arguments ?? {};
        const name = call.name ?? b.toolCall?.name ?? 'tool';
        action = clamp(`${name} ${args.command ?? args.path ?? args.query ?? ''}`, 160);
        pickFiles(args, files);
      }
    }
  }
  return { objective, action, files: [...new Set(files)].slice(0, 40) };
}

const blobMessage = (m) => ({
  role: m?.role ?? null,
  at: ms(m?.created),
  blocks: Array.isArray(m?.content) ? m.content : [],
});

// ------------------------------------------------------------------- readers

function tailMessages(db, sessionId) {
  const rows = sql(db, `SELECT role, content_json, created_timestamp FROM messages WHERE session_id = ${qlit(sessionId)} ORDER BY created_timestamp DESC, id DESC LIMIT ${TAIL_MESSAGES}`);
  return rows.reverse().map((m) => ({ role: m.role, at: ms(m.created_timestamp), blocks: blocks(m.content_json) }));
}

function sessionRow(r, tables, cols, now, source) {
  // Pre-v16: one JSON blob holds name/working_dir/conversation. v16+: real columns.
  const blob = (cols.has('session_json') && parseJson(r.session_json)) || {};
  const conv = blob.conversation && typeof blob.conversation === 'object' ? blob.conversation : null;
  const messages = conv && Array.isArray(conv.messages) && conv.messages.length
    ? conv.messages.slice(-TAIL_MESSAGES).map(blobMessage)
    : (tables.has('messages') ? tailMessages(r.id) : []);
  const d = describe(messages);
  const model = parseJson(r.model_config_json) ?? parseJson(blob.model_config_json) ?? {};
  const provider = r.provider_name ?? blob.provider_name ?? null;
  const updatedAt = Math.max(ms(r.updated_at) ?? 0, ms(blob.updated_at) ?? 0, messages.at(-1)?.at ?? 0) || null;
  const archived = Boolean(r.archived_at ?? blob.archived_at);
  return {
    id: String(r.id),
    agent: `${id}:${r.session_type ?? blob.session_type ?? 'user'}`,
    title: clamp(r.name || r.description || blob.name || blob.description || d.objective || r.id, 120),
    objective: d.objective,
    status: archived ? 'archived' : (now - (updatedAt ?? 0) < IDLE_MS ? 'running' : 'idle'),
    cwd: r.working_dir ?? blob.working_dir ?? null,
    updatedAt,
    todos: [], // goose has no todo table in sessions.db — empty is the honest answer
    action: d.action,
    files: d.files,
    provider,
    model: model.model_name ?? null,
    kind: r.session_type ?? blob.session_type ?? null,
    source,
  };
}

function fromDb(db, limit, now) {
  const tables = new Set(sql(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
  if (!tables.has('sessions')) return [];
  const cols = new Set(sql(db, "SELECT name FROM pragma_table_info('sessions')").map((r) => r.name));
  if (!cols.has('id')) return [];
  const c = (n) => (cols.has(n) ? `s.${n}` : `NULL AS ${n}`);
  const select = [
    's.id AS id', c('name'), c('description'), c('working_dir'), c('created_at'), c('updated_at'),
    c('provider_name'), c('model_config_json'), c('session_type'), c('archived_at'), c('session_json'),
  ].join(', ');
  const order = cols.has('updated_at') ? 'ORDER BY s.updated_at DESC' : '';
  const rows = sql(db, `SELECT ${select} FROM sessions s ${order} LIMIT ${limit}`);
  return rows.map((r) => sessionRow(r, tables, cols, now, db));
}

function fromLegacyDir(dir, limit, now) {
  const files = safeReaddir(dir)
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => {
      const file = join(dir, e.name);
      try {
        const st = statSync(file);
        if (st.size > MAX_BYTES) return null; // runaway export — not worth the tick
        return { file, at: st.mtimeMs, blob: parseJson(readFileSync(file, 'utf8')) };
      } catch { return null; }
    })
    .filter((x) => x?.blob && typeof x.blob === 'object')
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);

  return files.map(({ file, at, blob }) => {
    const conv = blob.conversation && typeof blob.conversation === 'object' ? blob.conversation : {};
    const messages = (Array.isArray(conv.messages) ? conv.messages : []).slice(-TAIL_MESSAGES).map(blobMessage);
    const d = describe(messages);
    const sid = String(blob.id ?? file.split('/').pop().replace(/\.json$/, ''));
    const updatedAt = Math.max(ms(blob.updated_at) ?? 0, at, messages.at(-1)?.at ?? 0) || null;
    return {
      id: sid,
      agent: `${id}:${blob.session_type ?? 'user'}`,
      title: clamp(blob.name || blob.description || d.objective || sid, 120),
      objective: d.objective,
      status: now - (updatedAt ?? 0) < IDLE_MS ? 'running' : 'idle',
      cwd: blob.working_dir ?? null,
      updatedAt,
      todos: [],
      action: d.action,
      files: d.files,
      provider: blob.provider_name ?? null,
      model: blob.model_config?.model_name ?? null,
      kind: blob.session_type ?? null,
      source: file,
    };
  });
}

// ------------------------------------------------------------------- public

/** Every Goose session, newest first. Missing or unreadable store → []. Never throws. */
export function sessions({ limit = 20 } = {}) {
  try {
    const n = Math.max(1, Math.min(500, Number(limit) || 20));
    const now = Date.now();
    const db = findDb();
    const legacy = db ? null : findLegacyDir();
    const list = db ? fromDb(db, n, now) : (legacy ? fromLegacyDir(legacy, n, now) : []);
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
