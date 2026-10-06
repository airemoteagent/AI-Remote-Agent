/**
 * mcp-servers — runtime adapter for every Model Context Protocol (MCP) server that is
 * CONFIGURED on this Mac or RUNNING right now.
 *
 * Read-only, stdlib only (fs/os/path/child_process), total (never throws):
 * no config and no process ⇒ [] and zeros.
 *
 * EVIDENCE — measured on this box (macOS, user mona) before writing:
 *
 *   $ for f in ~/.claude.json "~/Library/Application Support/Claude/claude_desktop_config.json" \
 *              ~/.cursor/mcp.json ~/.codex/config.toml ~/.config/openclaw/openclaw.json \
 *              ~/.openclaw/openclaw.json ~/.continue/config.json \
 *              "~/Library/Application Support/Code/User/settings.json"; do
 *       [ -f "$f" ] && echo "EXISTS $f" || echo "MISSING $f"; done
 *   MISSING /Users/mona/.claude.json
 *   MISSING /Users/mona/Library/Application Support/Claude/claude_desktop_config.json
 *   MISSING /Users/mona/.cursor/mcp.json
 *   MISSING /Users/mona/.codex/config.toml
 *   MISSING /Users/mona/.config/openclaw/openclaw.json
 *   EXISTS  /Users/mona/.openclaw/openclaw.json              (6031 bytes)
 *   MISSING /Users/mona/.continue/config.json
 *   MISSING /Users/mona/Library/Application Support/Code/User/settings.json
 *
 *   $ grep -c mcpServers ~/.openclaw/openclaw.json
 *   0
 *   $ ps -Ao pid,args | grep -i mcp | grep -v grep
 *   (no output — no MCP server process runs on this Mac)
 *   $ find ~/.dsh -maxdepth 2 -name '*.json' -size -2M | xargs grep -l mcpServers
 *   (no output)
 *
 *   Real truncated sample — the only MCP-capable config on this Mac is OpenClaw's, and it
 *   declares no servers (its sole 'mcp' substring is the plugin name "mcporter"):
 *     $ node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync(
 *         process.env.HOME+'/.openclaw/openclaw.json','utf8'))).join(' '))"
 *     agents gateway meta wizard plugins models auth skills
 *
 *   => on THIS Mac verified = true (an MCP config path exists) and sessions() = []
 *      (nothing is declared). That is the honest answer, not a bug.
 *
 * Config schemas handled — each keyed exactly as its own client documents it:
 *   ~/.claude.json                        {"mcpServers":{"<name>":{"command":"npx","args":[…],"env":{…}}},
 *                                          "projects":{"<dir>":{"mcpServers":{…}}}}   (per-project scope too)
 *   …/Claude/claude_desktop_config.json   {"mcpServers":{…}}          http: {"type":"http","url":"…"}
 *   ~/.cursor/mcp.json                    {"mcpServers":{…}}
 *   ~/.codex/config.toml                  [mcp_servers.<name>] command/args/url — TOML, not JSON
 *   ~/.openclaw/openclaw.json             {"mcpServers":{…}}
 *   ~/.continue/config.json               {"mcpServers":{…}} or
 *                                         {"experimental":{"modelContextProtocolServers":
 *                                            [{"transport":{"type":"stdio","command":…,"args":[…]}}]}}
 *   …/Code/User/settings.json             {"mcp":{"servers":{"<name>":{…}}}}   (VS Code ≥1.102)
 *   ~/.dsh/**  (depth ≤2, *.json)         any file containing "mcpServers"
 *
 * running: ONE `ps -Ao pid=,args=` pass. A stdio server is running when a live process
 * carries its command basename AND one of its non-flag args — so `npx -y
 * @modelcontextprotocol/server-filesystem /tmp` matches on both tokens, while a bare
 * `node` does not match every node on the box. An http/sse server is running when
 * something LISTENs on its URL port (one `lsof -nP -iTCP -sTCP:LISTEN`, only spawned
 * when an http server is actually declared). `pid` is that process, else null.
 *
 * http transport: `command` carries the URL and `args` is [] — the contracted record
 * shape {id,name,command,args,transport,source,running,pid} stays exact. `sse` and
 * `streamable-http` are reported as transport 'http' (both are URL transports).
 *
 * verified = "an MCP config file is present on this Mac", checked once at import with
 * existsSync only (no read, no spawn, no network). A host that is present with zero
 * declared servers is verified-but-empty — the same semantic local-llm.js uses for an
 * installed-but-stopped runtime, and it keeps sessions() live so a server added after
 * import still shows up.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const id = 'mcp-servers';
export const label = 'MCP servers';

const HOME = os.homedir();
const APPS = path.join(HOME, 'Library/Application Support');

const MAX_SERVERS = 200; // hard cap on servers returned
const MAX_BYTES = 20 * 1024 * 1024; // never read a config bigger than this
const MAX_SCAN = 200; // files visited in the ~/.dsh walk
const WALK_DEPTH = 2; // ~/.dsh/** per the adapter contract
const TTL_MS = 3000; // memo window so sessions() + summary() share one ps pass
const PS_MAX = 32 * 1024 * 1024;
const LSOF_MAX = 4 * 1024 * 1024;

// tag = the client the config belongs to (part of every session id).
const JSON_SOURCES = [
  { tag: 'claude', file: path.join(HOME, '.claude.json'), key: ['mcpServers'], projects: true },
  { tag: 'claude-desktop', file: path.join(APPS, 'Claude/claude_desktop_config.json'), key: ['mcpServers'] },
  { tag: 'cursor', file: path.join(HOME, '.cursor/mcp.json'), key: ['mcpServers'] },
  { tag: 'openclaw', file: path.join(HOME, '.openclaw/openclaw.json'), key: ['mcpServers'] },
  { tag: 'openclaw', file: path.join(HOME, '.config/openclaw/openclaw.json'), key: ['mcpServers'] },
  { tag: 'continue', file: path.join(HOME, '.continue/config.json'), key: ['mcpServers'], cont: true },
  { tag: 'vscode', file: path.join(APPS, 'Code/User/settings.json'), key: ['mcp', 'servers'] },
  { tag: 'vscode', file: path.join(APPS, 'Code - Insiders/User/settings.json'), key: ['mcp', 'servers'] },
  { tag: 'cursor', file: path.join(APPS, 'Cursor/User/settings.json'), key: ['mcp', 'servers'] },
  { tag: 'windsurf', file: path.join(APPS, 'Windsurf/User/settings.json'), key: ['mcp', 'servers'] },
  { tag: 'vscode', file: path.join(HOME, '.config/Code/User/settings.json'), key: ['mcp', 'servers'] },
];
const TOML_SOURCES = [{ tag: 'codex', file: path.join(HOME, '.codex/config.toml') }];
const DSH_DIR = path.join(HOME, '.dsh');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'unnamed';
const at = (o, keys) => keys.reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o);

export const verified = (() => {
  try {
    return [...JSON_SOURCES.map((s) => s.file), ...TOML_SOURCES.map((s) => s.file)].some((f) => fs.existsSync(f));
  } catch {
    return false;
  }
})();

/** Read a JSON config, or null. Bounded by size, key-presence checked before parsing. */
function readJson(file, needle) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const text = fs.readFileSync(file, 'utf8');
    if (needle && !text.includes(needle)) return null;
    const j = JSON.parse(text);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function unquote(v) {
  const s = String(v).trim();
  const q = s[0];
  if ((q === '"' || q === "'") && s.endsWith(q) && s.length > 1) return s.slice(1, -1);
  return s;
}

/** Quoted strings inside a TOML array literal. */
function tomlArray(v) {
  const inner = /\[([\s\S]*)\]/.exec(v);
  if (!inner) return [];
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m;
  while ((m = re.exec(inner[1]))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  return out;
}

/** Codex [mcp_servers.<name>] blocks — a targeted scan, not a general TOML parser. */
export function parseCodexToml(text) {
  const out = [];
  let cur = null;
  let depth = 0;
  let pendingKey = null;
  let pending = '';
  const flush = () => {
    if (cur && (cur.command || cur.url)) out.push(cur);
    cur = null;
    depth = 0;
    pendingKey = null;
    pending = '';
  };
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (pendingKey) {
      pending += ' ' + s;
      if (!s.includes(']')) continue;
      cur.args = tomlArray(pending);
      pendingKey = null;
      pending = '';
      continue;
    }
    if (!s || s.startsWith('#')) continue;
    const sec = /^\[([^\]]+)\]$/.exec(s);
    if (sec) {
      flush();
      const parts = sec[1].split('.').map((x) => unquote(x));
      // [mcp_servers.x] and [mcp_servers."x"]; deeper sections (…x.env) keep the server.
      if (parts[0] === 'mcp_servers' && parts.length >= 2) {
        cur = { name: parts[1], command: null, args: [], url: null, type: null };
        depth = parts.length;
      }
      continue;
    }
    if (!cur || depth !== 2) continue;
    const kv = /^([A-Za-z_][\w-]*)\s*=\s*(.+)$/.exec(s);
    if (!kv) continue;
    const [, k, raw] = kv;
    if (k === 'command') cur.command = unquote(raw);
    else if (k === 'url' || k === 'serverUrl') cur.url = unquote(raw);
    else if (k === 'type' || k === 'transport') cur.type = unquote(raw);
    else if (k === 'args') {
      if (raw.includes(']')) cur.args = tomlArray(raw);
      else {
        pendingKey = k;
        pending = raw;
      }
    }
  }
  flush();
  return out;
}

const HTTP_TYPES = new Set(['http', 'sse', 'streamable-http', 'streamablehttp', 'streamable_http']);

/** One config entry → the contracted record, or null when it declares nothing runnable. */
function normalize(name, raw, src, source, scope) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!name) return null;
  const url = typeof raw.url === 'string' && raw.url ? raw.url : typeof raw.serverUrl === 'string' && raw.serverUrl ? raw.serverUrl : null;
  const type = String(raw.type ?? raw.transport ?? '').toLowerCase();
  const command = typeof raw.command === 'string' && raw.command ? raw.command : null;
  const args = Array.isArray(raw.args) ? raw.args.map(String).slice(0, 64) : [];
  const label = scope ? `${name} (${scope})` : name;
  if (url && (!command || HTTP_TYPES.has(type))) {
    return { tag: src.tag, name: label, command: url, args: [], transport: 'http', source };
  }
  if (!command) return null;
  return { tag: src.tag, name: label, command, args, transport: 'stdio', source };
}

function collectMap(map, src, source, out, scope) {
  if (!map || typeof map !== 'object') return;
  for (const [name, raw] of Object.entries(map).slice(0, MAX_SERVERS)) {
    const rec = normalize(name, raw, src, source, scope);
    if (rec) out.push(rec);
  }
}

/** Continue's experimental.modelContextProtocolServers array: transport-wrapped entries. */
function collectContinue(j, src, source, out) {
  const arr = at(j, ['experimental', 'modelContextProtocolServers']);
  if (!Array.isArray(arr)) return;
  for (const item of arr.slice(0, MAX_SERVERS)) {
    const t = item?.transport && typeof item.transport === 'object' ? item.transport : item;
    const rec = normalize(item?.name ?? t?.name, t, src, source, null);
    if (rec) out.push(rec);
  }
}

/** ~/.dsh/** (depth ≤2): any *.json declaring mcpServers. */
function collectDsh(out) {
  const src = { tag: 'dsh' };
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > WALK_DEPTH || seen >= MAX_SCAN) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen >= MAX_SCAN) return;
      if (e.isDirectory()) {
        if (e.name !== 'archive' && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), depth + 1);
      } else if (e.name.endsWith('.json')) {
        seen += 1;
        const file = path.join(dir, e.name);
        const j = readJson(file, '"mcpServers"');
        if (j) collectMap(j.mcpServers, src, file, out, null);
      }
    }
  };
  walk(DSH_DIR, 0);
}

function discover() {
  const out = [];
  for (const src of JSON_SOURCES) {
    const j = readJson(src.file, src.cont ? 'modelContextProtocolServers' : '"mcpServers"');
    if (!j) continue;
    collectMap(at(j, src.key), src, src.file, out, null);
    if (src.cont) collectContinue(j, src, src.file, out);
    if (src.projects && j.projects && typeof j.projects === 'object') {
      for (const [dirName, p] of Object.entries(j.projects).slice(0, MAX_SERVERS)) {
        // ~/.claude.json keeps a per-project mcpServers block; same server, scoped config.
        collectMap(p?.mcpServers, src, src.file, out, dirName);
      }
    }
  }
  for (const src of TOML_SOURCES) {
    let text;
    try {
      const st = fs.statSync(src.file);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      text = fs.readFileSync(src.file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('mcp_servers')) continue;
    for (const s of parseCodexToml(text).slice(0, MAX_SERVERS)) {
      const rec = normalize(s.name, s, src, src.file, null);
      if (rec) out.push(rec);
    }
  }
  collectDsh(out);

  const seen = new Set();
  return out.slice(0, MAX_SERVERS).filter((s) => {
    const key = `${s.tag}:${s.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One ps pass → [{pid, args}]. Never throws. */
function processes() {
  try {
    return execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', maxBuffer: PS_MAX, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((l) => /^(\d+)\s+(.*)$/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), args: m[2] }));
  } catch {
    return [];
  }
}

/** Listening TCP ports → pid, from one lsof pass. Never throws. */
function listeners() {
  const ports = new Map();
  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], {
      encoding: 'utf8',
      maxBuffer: LSOF_MAX,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let pid = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1)) || null;
      else if (line.startsWith('n') && pid) {
        const m = /:(\d+)$/.exec(line.slice(1));
        if (m && !ports.has(Number(m[1]))) ports.set(Number(m[1]), pid);
      }
    }
  } catch {
    /* lsof absent, or nothing listening (exit 1) */
  }
  return ports;
}

function portOf(url) {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80;
  } catch {
    return null;
  }
}

/** The live process behind a stdio server, or null. */
function matchProc(server, procs) {
  const base = path.basename(server.command);
  if (!base) return null;
  const extras = server.args.filter((a) => a && !a.startsWith('-'));
  for (const p of procs) {
    const toks = p.args.split(/\s+/);
    if (!toks.some((t) => t === base || t.endsWith('/' + base))) continue;
    if (extras.length && !extras.some((e) => p.args.includes(e))) continue;
    return p;
  }
  return null;
}

let memo = { at: 0, val: null };

/** Every configured/run MCP server on this Mac. Never throws. */
export function servers() {
  if (memo.val && Date.now() - memo.at < TTL_MS) return memo.val;
  let out = [];
  try {
    const found = discover();
    const procs = found.some((s) => s.transport === 'stdio') ? processes() : [];
    const ports = found.some((s) => s.transport === 'http') ? listeners() : new Map();
    out = found.map((s) => {
      const hit = s.transport === 'stdio' ? matchProc(s, procs) : null;
      const port = s.transport === 'http' ? portOf(s.command) : null;
      const pid = hit?.pid ?? (port != null ? ports.get(port) ?? null : null);
      return {
        id: `mcp:${s.tag}:${slug(s.name)}`,
        name: s.name,
        command: s.command,
        args: s.args,
        transport: s.transport,
        source: s.source,
        running: pid != null,
        pid: pid ?? null,
      };
    });
  } catch {
    out = [];
  }
  memo = { at: Date.now(), val: out };
  return out;
}

/** Config mtime — the only honest "when" for a server that has never run. */
function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs || null;
  } catch {
    return null;
  }
}

/** Server → session record. status: 'running' (live pid) | 'configured' (declared only). */
export function sessions({ limit = 20 } = {}) {
  const cap = Math.max(0, Math.min(Number(limit) || 0, MAX_SERVERS));
  try {
    const when = new Map();
    return servers()
      .slice()
      .sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name))
      .slice(0, cap)
      .map((s) => {
        const status = s.running ? 'running' : 'configured';
        if (!when.has(s.source)) when.set(s.source, mtimeOf(s.source));
        const where = s.transport === 'stdio' ? `${s.command}${s.args.length ? ' ' + s.args.join(' ') : ''}` : s.command;
        return {
          id: s.id,
          agent: 'mcp',
          title: s.name,
          objective: `${s.transport} MCP server "${s.name}" is ${status} — ${where}`,
          status,
          cwd: null,
          updatedAt: s.running ? Date.now() : when.get(s.source),
          todos: [],
          action: s.command,
          files: [],
          source: s.source,
        };
      });
  } catch {
    return [];
  }
}

/** { sessions, running, todos, lastAt } — zeros when nothing is found. */
export function summary() {
  try {
    const list = sessions();
    const lastAt = list.reduce((n, s) => Math.max(n, s.updatedAt || 0), 0);
    return {
      sessions: list.length,
      running: list.filter((s) => s.status === 'running').length,
      todos: 0,
      lastAt: lastAt || null,
    };
  } catch {
    return { sessions: 0, running: 0, todos: 0, lastAt: null };
  }
}
