// Discovered runtime adapter — the long tail. Everything here is a live, read-only
// sweep of this Mac (2026-10-06) for agent-ish state that the named adapters do NOT
// own (dsh, openclaw, claude-code, codex, aider, goose, opencode, gemini-cli,
// cursor-agent, vscode-agents, local-llm, mcp-servers, agent-platforms, python-agents).
//
// Sweep commands run (read-only, bounded), and what they actually returned:
//
//   ls -la ~
//     → .config/cagent .docker/cagent .kiln_ai .llminone .remote-agent .remoteagent
//       .dsh .openclaw .codex .gemini.json deepseek-harness agent.mona.expert
//       "Kiln Projects" backups-private mona mona.expert waarning-live
//   ls -la ~/Library/Application\ Support | head -60
//     → clawhub/ (config.json), com.apple.ContextStoreAgent, com.apple.RemoteManagementAgent,
//       Docker Desktop/, docker-secrets-engine, io.github.skylot.jadx. No Ollama / LM Studio /
//       Claude Desktop / Cursor / Windsurf / n8n / dify / letta / autogpt dirs exist here.
//   find ~ -maxdepth 3 -type d \( -iname '*agent*' -o -iname '*.agent' -o -iname '*assistant*'
//       -o -iname '*copilot*' -o -iname '*ai*' \) -not -path '*/node_modules/*'
//       -not -path '*/.git/*' -not -path '*/Library/Caches/*' | head -60
//     → the .dsh/.openclaw trees (taken), Library/Assistant, com.apple.*Agent (system),
//       Library/Application Scripts/com.apple.* (system, noise)
//   find ~/.config ~/.local/share ~/Library/Application\ Support -maxdepth 3 -newermt '-14 days' -type f
//     → only Apple system stores (tipkit, networkserviceproxy, AddressBook, CrashReporter,
//       ContextStoreAgent/screenTimeEnabled, RemoteManagementAgent/Database/*.sqlite*)
//   ls ~/Library/LaunchAgents && plutil -p ~/Library/LaunchAgents/*.plist
//     → openclaw gateway (taken), 6 × com.mona.* all exec ~/.dsh/bin/*.mjs (taken),
//       2 × com.remoteagent.* = this control plane (taken), com.waarning.refresh (web),
//       disabled/com.holystone.hs175d* (drone, not an agent)
//
//   Deeper probes that produced the inventory below:
//   ls -la ~/.docker/cagent ~/.docker/cagent/working_directories/*
//     → session-directories.json {"draft-1786227289580":"fc8adc8a-…", "draft-1786491444194":"4e3d7f15-…"}
//       and one working dir literally named
//       https-…ai-backend-service…gordon-agent…  (Docker cagent / "Gordon" sessions)
//   ls -la "~/Kiln Projects/lamabroski" ; find "~/Kiln Projects" -maxdepth 3
//     → project.kiln {"name":"lamabroski","description":"Islands for Lamabroski, designed by AI"}
//       tasks/<id> - <name>/task.kiln + tasks/<id>/runs/*/task_run.kiln (5 runs, 17 KB each)
//   cat ~/.kiln_ai/settings.yaml
//     → projects: [/Users/mona/Kiln Projects/lamabroski/project.kiln] + openai_compatible_providers
//   cat ~/Library/Application\ Support/clawhub/config.json
//     → {"registry":"https://clawhub.ai"}   (clawhub registry client; NOT ~/.openclaw)
//   ls -la ~/Library/Application\ Support/Google/'Chrome for Testing' ~/.cache/puppeteer
//     → persistent CDP Chromium profile (Default/, Local State) + puppeteer chrome/chrome-headless-shell
//   ls -la ~/Library/Assistant
//     → SiriAnalytics.db (10 MB), SiriSyncItems.db, SyncSnapshot.plist  (macOS assistantd)
//   find ~ -maxdepth 3 -type d -name '.mona-*'
//     → <project>/.mona-agents/registry.json (11 KB) and <project>/.mona-dashboard/events.jsonl
//       in mona.expert, mona.website, mona.wrapper, mona.expert.git, webMonaV3
//   stat ~/backups-private/mona-agent.bak-*.tar.gz ; head -c 300 ~/.mona-sync-state.json
//     → 1.4 MB agent-state backup; sync ledger {lastSyncTs, syncedHashes:[…]}
//
// Crossed out (owned by a taken adapter, so this sweeper skips them):
//   ~/.dsh ~/.openclaw ~/.codex ~/.claude ~/.gemini* ~/.cursor ~/.aider* ~/.goose
//   ~/.opencode ~/.ollama ~/.lmstudio ~/.continue ~/.windsurf ~/.vscode ~/.remote-agent
//   ~/.remoteagent ~/deepseek-harness ~/Downloads/session.jsonl+dsh-session-*.zip (dsh exports)
//   ~/Library/Logs/openclaw, ~/.docker/mcp, ~/.cache/chrome-devtools-mcp,
//   ~/.cache/huggingface, ~/.docker/models, ~/.llminone (local model stores)
//
// Rules honoured: stdlib + native tools only, stat-only (no file contents read at all),
// never throws ([] / zeros when nothing is found), nothing written outside the repo,
// max depth 3 (Kiln 4), node_modules / .git / Library/Caches skipped, >20 MB skipped, cap 40.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

export const id = 'discovered';
export const label = 'Discovered (long tail)';

const H = homedir();
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_STORES = 40;
const MAX_DEPTH = 3;

// [home-relative path, kind, why it looks agent-ish] — every line observed above.
const CURATED = [
  ['Kiln Projects/lamabroski/tasks/283108720196 - 271741353444', 'dir', 'Kiln AI task with 5 run dirs (runs/*/task_run.kiln) — AI-authored islands task'],
  ['Kiln Projects/lamabroski/tasks/271741353444 - island-designer', 'dir', 'Kiln AI task (task.kiln, 3.4 KB) — island-designer agent task'],
  ['Kiln Projects/lamabroski', 'dir', 'Kiln project.kiln: "Islands for Lamabroski, designed by AI"'],
  ['.kiln_ai', 'dir', 'Kiln AI config: settings.yaml lists projects + openai_compatible_providers (deepseek)'],
  ['.docker/cagent', 'dir', 'Docker cagent session store: session-directories.json draft-<ts>→UUID, working_directories/<uuid> (gordon-agent)'],
  ['.config/cagent', 'dir', 'cagent client identity: user-uuid + .cagent_first_run marker'],
  ['Library/Application Support/clawhub', 'dir', 'clawhub registry client config {"registry":"https://clawhub.ai"} (separate from ~/.openclaw)'],
  ['Documents/mona.expert/.mona-agents', 'dir', 'mona platform agent registry (registry.json 11 KB, installed/, sandbox/) — cross out if agent-platforms owns mona.*'],
  ['Documents/mona.expert/.mona-dashboard', 'dir', 'mona platform agent dashboard event stream (events.jsonl, 122 KB)'],
  ['Library/Application Support/Google/Chrome for Testing', 'dir', 'persistent CDP Chromium profile driven by agent/browser tooling (Default/, Local State)'],
  ['.cache/puppeteer', 'dir', 'puppeteer-managed chrome + chrome-headless-shell used by browser agents'],
  ['Library/Assistant', 'dir', 'macOS Siri/assistantd state (SiriAnalytics.db 10 MB, SiriSyncItems.db, SyncSnapshot.plist) — system agent, not an LLM runtime'],
  ['Library/Application Support/com.apple.RemoteManagementAgent/Database/RemoteManagement.sqlite', 'sqlite', 'macOS MDM agent database — system agent, not an LLM runtime'],
  ['backups-private/mona-agent.bak-20260829-030413.tar.gz', 'dir', '1.4 MB tar.gz backup of mona agent state'],
  ['.mona-sync-state.json', 'dir', 'mona agent-platform sync ledger {lastSyncTs, syncedHashes[…]} (305 KB)'],
];

// Names that look like agent state (same shape as the find sweep, plus runtimes seen here).
// Token-anchored on purpose: 'SSLErrorAssistant', '.zsh_sessions', 'llminone' and 'llmeu'
// are NOT agent state, and a bare substring test drowns the real stores in that noise.
const NAME = /(^|[._\- ])(agent|agents|assistant|copilot|claude|codex|gemini|opencode|goose|aider|cursor|windsurf|cline|continue|ollama|lmstudio|llm|llms|mcp|kiln|cagent|claw|clawhub|autogpt|letta|crewai|autogen|langgraph|dify|n8n|skyvern|openhands|gpt-engineer)([._\- ]|$)/i;
const STORE_EXT = /\.(sqlite|sqlite3|db|jsonl|plist)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', 'Caches', '.Trash', 'dist', 'build', 'vendor']);

// Home-relative prefixes owned by a taken adapter — sweep must not double-report them.
const TAKEN = [
  '.dsh', '.openclaw', '.codex', '.claude', '.claude.json', '.gemini', '.gemini.json', '.cursor',
  '.aider', '.aider.tags.cache', '.aider.chat.history.md', '.goose', '.ollama', '.lmstudio',
  '.continue', '.windsurf', '.opencode', '.vscode', '.remote-agent', '.remoteagent', '.llminone',
  'deepseek-harness', 'Library/Logs/openclaw', 'Library/Application Support/Code',
  'Library/Application Support/Claude', 'Library/Caches', '.docker/mcp', '.docker/models',
  '.cache/chrome-devtools-mcp', '.cache/huggingface', '.local/share/opencode', '.config/goose',
  '.config/opencode', '.n8n', '.dify', 'Documents/fullremoteagent',
  'Library/LaunchAgents/ai.openclaw.gateway.plist',
  'Library/LaunchAgents/com.remoteagent.agent.plist',
  'Library/LaunchAgents/com.remoteagent.agent.plist.bak-20260901-102308',
  'Library/LaunchAgents/com.remoteagent.fleet.plist',
];

const SCAN = [
  { root: H, depth: 1 },
  { root: join(H, '.config'), depth: 3 },
  { root: join(H, '.docker'), depth: 3 },
  { root: join(H, '.local', 'share'), depth: 3 },
  { root: join(H, 'Library', 'Application Support'), depth: 3 },
  { root: join(H, 'Library', 'LaunchAgents'), depth: 1 },
  { root: join(H, 'Documents'), depth: 2 },
  { root: join(H, 'Kiln Projects'), depth: 4 },
];

const rel = (p) => relative(H, p).split('\\').join('/');
const taken = (p) => {
  const r = rel(p);
  return TAKEN.some((t) => r === t || r.startsWith(`${t}/`));
};
const kindOf = (p) => (/\.(sqlite|db|sqlite3)$/i.test(p) ? 'sqlite' : /\.jsonl$/i.test(p) ? 'jsonl' : /\.plist$/i.test(p) ? 'plist' : 'dir');

function entry(path, hint) {
  try {
    const st = statSync(path); // stat only — never read contents
    if (st.size > MAX_BYTES) return null;
    return { path, kind: kindOf(path), bytes: st.size, updatedAt: Math.round(st.mtimeMs), hint };
  } catch { return null; }
}

/** Every unclaimed agent-ish store on this Mac, newest first. Never throws. */
export function stores({ limit = MAX_STORES } = {}) {
  const found = new Map();
  for (const [r, kind, hint] of CURATED) {
    const p = join(H, r);
    if (taken(p)) continue;
    const e = entry(p, hint);
    if (e) { e.kind = kind; found.set(p, e); }
  }
  for (const { root, depth } of SCAN) {
    for (const p of walk(root, Math.min(depth, MAX_DEPTH))) {
      if (found.has(p) || taken(p)) continue;
      const e = entry(p, `sweep hit: name matches agent-state pattern (${rel(p)})`);
      if (e) found.set(p, e);
    }
  }
  return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(0, limit));
}

// Bounded read-only walk: names only, no symlink follows, macOS system daemons skipped
// (they are loud and are listed in CURATED instead).
function walk(dir, depth) {
  const out = [];
  let items = [];
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const name = it.name;
    if (!name || name.startsWith('com.apple.') || SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    if (taken(p)) continue;
    // a store is a matching directory, or a matching file with a store extension
    if (NAME.test(name) && (it.isDirectory() || STORE_EXT.test(name))) out.push(p);
    // recurse into normal dirs, and into hidden dirs only when their own name is a hit
    if (depth > 0 && it.isDirectory() && (!name.startsWith('.') || NAME.test(name))) out.push(...walk(p, depth - 1));
  }
  return out;
}

/** One record per discovered store with recent activity — unclaimed by construction. */
export function sessions({ limit = 20 } = {}) {
  return stores({ limit: MAX_STORES })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(0, limit))
    .map((s) => ({
      id: `${id}:${s.path}`,
      agent: 'store',
      title: basename(s.path) || s.path,
      objective: null,
      status: 'unclaimed',
      cwd: dirname(s.path),
      updatedAt: s.updatedAt,
      todos: [], // nothing here exposes a todo store; do not invent one
      action: s.hint,
      files: [s.path],
      source: s.path,
    }));
}

export function summary() {
  const all = stores();
  return {
    sessions: all.length,
    running: 0, // a store cannot be running; processes are the process adapters' job
    todos: 0,
    lastAt: all.reduce((m, x) => Math.max(m, x.updatedAt || 0), 0) || null,
  };
}

export const verified = CURATED.some(([r]) => existsSync(join(H, r)));
