// Claude Code (Anthropic CLI) runtime adapter — sessions, todos and files, read from its own store.
//
// ── EVIDENCE ────────────────────────────────────────────────────────────────────
// NOT FOUND ON THIS MACHINE (2026-10-06). `verified` is therefore false, and the
// adapter returns [] / zeros rather than inventing data. Exact commands run:
//
//   ls -la ~/.claude/ ~/.config/claude/ ~/Library/Application\ Support/Claude/ ~/.claude.json
//     → "No such file or directory" for all four
//   find / -maxdepth 5 -name ".claude.json" 2>/dev/null   → (no results)
//   find / -maxdepth 5 -name ".claude" -type d 2>/dev/null
//     → /usr/local/Homebrew/.claude   (settings.json only — Homebrew's, not a store)
//     → /Users/mona/deepseek-harness/.claude   (skills symlink only — project config)
//   ps -Ao pid,command | grep -i "claud[e]"   → no claude process running
//
// Because nothing could be observed locally, the schema below is taken from two
// independent reverse-engineered observations of REAL 2.1.x files — not from
// Anthropic documentation, and not invented here:
//   [1] neilberkman/ccrider research/schema.md   (sample transcript lines, verbatim)
//   [2] repowise-dev/skiplevel docs/schema-notes.md (layout + event census, 2.1.x)
//
// PATHS (CLAUDE_CONFIG_DIR overrides ~/.claude, as the CLI itself does):
//   ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl   one session, one file
//   ~/.claude/projects/<sanitized-cwd>/agent-<shortId>.jsonl   subagent transcript
//   ~/.claude/todos/<sessionId>-agent-<agentId>.json       todo state for that session
//   ~/.claude.json                                         install marker + project history
//
// The <sanitized-cwd> directory name is LOSSY and NOT injective ([2] and issue
// anthropics/claude-code#9221/#93960): `/Users/a/b` and `/Users-a-b` collide. It is
// therefore never decoded — `cwd` is read from the `cwd` field inside the transcript,
// which is authoritative.
//
// TRANSCRIPT — one JSON object per line, `type` from this census ([2]):
//   user | assistant | system | attachment | file-history-snapshot | summary |
//   ai-title | last-prompt | pr-link | queue-operation | permission-mode | mode
//
//   Summary entry (FIRST line of a session file) — the human-readable title:
//     {"type":"summary","summary":"Human-readable session title","leafUuid":"…"}
//
//   User entry — `message.content` is EITHER a string (a real typed prompt) OR a
//   list of blocks (almost always tool_result). Human prompts must exclude
//   isSidechain, isMeta, isCompactSummary, text starting with "<", and the
//   interrupt markers "[Request interrupted by user…]":
//     {"type":"user","parentUuid":null,"isSidechain":false,"userType":"external",
//      "cwd":"/Users/neil/path/to/project","sessionId":"session-uuid","version":"2.0.29",
//      "gitBranch":"main","uuid":"message-uuid","timestamp":"2025-11-01T01:23:44.615Z",
//      "message":{"role":"user","content":"The actual user message text"}}
//
//   Assistant entry — content is a list of blocks. CRITICAL: one API message is split
//   across several lines sharing `message.id` ([2]: 7166 lines → 2708 ids).
//     {"type":"assistant","timestamp":"2025-11-01T01:25:48.367Z","cwd":"…",
//      "message":{"id":"msg_01…","model":"claude-sonnet-4-5-20250929","role":"assistant",
//        "content":[{"type":"text","text":"Response text here"},
//                   {"type":"tool_use","id":"toolu_01…","name":"Bash",
//                    "input":{"command":"ls -la","description":"List files"}}]}}
//
//   Real truncated sample, verbatim from [1] (data is the original author's, structure is real):
//     {"type":"user","parentUuid":"19f2…","isSidechain":false,"userType":"external",
//      "cwd":"/Users/neil/path/to/project","sessionId":"a1b2…","version":"2.0.29",
//      "gitBranch":"main","uuid":"7c3d…","timestamp":"2025-11-01T01:23:44.615Z",
//      "message":{"role":"user","content":"Refactor this function"}, …}
//
// TodoWrite — the only todo source inside a transcript ([1], toolUseResult section):
//     {"type":"tool_use","name":"TodoWrite",
//      "input":{"todos":[{"content":"…","status":"pending|in_progress|completed",
//                         "activeForm":"…"}]}}
//     tool results carry a sibling {"toolUseResult":{"oldTodos":[…],"newTodos":[…]}}.
//
// ⊘ NOT VERIFIED: the on-disk ~/.claude/todos/<id>-agent-<agentId>.json shape was not
//   observable anywhere on this box, and neither reference documents it. It is read
//   defensively (array, or {todos:[…]}) and the transcript's TodoWrite is the
//   fallback, so a wrong guess degrades to fewer todos, never to a crash.
// ⊘ NOT VERIFIED: the exact key inside `ai-title` / `last-prompt` events. Several
//   plausible keys are tried in one pass; a miss costs nothing (the summary line is
//   the documented primary title).
// ────────────────────────────────────────────────────────────────────────────────
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const id = 'claude-code';
export const label = 'Claude Code';

const ROOT = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const PROJECTS = join(ROOT, 'projects');
const TODOS = join(ROOT, 'todos');

// Two independent markers of a real install; either one means we found something.
export const verified = existsSync(PROJECTS) || existsSync(join(homedir(), '.claude.json'));

const MAX_BYTES = 20 * 1048576; // skip >20MB entirely (row still shows, from its mtime)
const HEAD_BYTES = 32 * 1024; // summary line + first prompt live at the top
const TAIL_BYTES = 192 * 1024; // last action, last cwd, last TodoWrite live at the bottom
const RUNNING_MS = 120_000; // Claude Code appends to the transcript continuously while running
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead']);
const TOOL_KIND = {
  Bash: 'run', BashOutput: 'run', KillShell: 'run', PowerShell: 'run',
  Read: 'read', NotebookRead: 'read', Grep: 'read', Glob: 'read',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  WebFetch: 'look', WebSearch: 'look', Task: 'tool', TodoWrite: 'tool',
};
const TOOL_ICON = { think: '🧠', read: '👁', edit: '✏️', run: '▶', look: '🌐', say: '💬', tool: '⚙' };

const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const clip = (v, n = 160) => {
  const s = clean(v);
  return s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;
};

/** Bytes of one file, never throwing: '' for missing, empty or oversized. */
function window(file, { head = HEAD_BYTES, tail = TAIL_BYTES } = {}) {
  let st;
  try { st = statSync(file); } catch { return ''; }
  if (!st.isFile() || st.size === 0) return '';
  if (st.size > MAX_BYTES) return ''; // bounded: a runaway transcript is not worth the tick
  try {
    if (st.size <= head + tail) return readFileSync(file, 'utf8');
    // Head and tail joined: the parser sees whole lines only, a torn edge is dropped.
    const whole = readFileSync(file, 'utf8');
    const top = whole.slice(0, head);
    return `${top.slice(0, top.lastIndexOf('\n') + 1)}${whole.slice(whole.length - tail).replace(/^[^\n]*\n?/, '')}`;
  } catch { return ''; }
}

function events(file, opts) {
  const out = [];
  for (const line of window(file, opts).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn or partial line — skip, as the CLI does */ }
  }
  return out;
}

/** The text of a user event, or '' when it is not a real human prompt. */
function human(ev) {
  if (ev?.type !== 'user' || ev.isSidechain || ev.isMeta || ev.isCompactSummary) return '';
  const c = ev.message?.content;
  const t = clean(typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : '');
  if (!t || t.startsWith('<') || t.startsWith('[Request interrupted')) return '';
  return t;
}

/** The text of an assistant event; '' when it carries only thinking or tool calls. */
function reply(ev) {
  if (ev?.type !== 'assistant') return '';
  const c = ev.message?.content;
  if (typeof c === 'string') return clean(c);
  if (!Array.isArray(c)) return '';
  return clean(c.filter((b) => b?.type === 'text').map((b) => b.text).join(' '));
}

const tools = (ev) => (ev?.type === 'assistant' && Array.isArray(ev.message?.content) ? ev.message.content.filter((b) => b?.type === 'tool_use') : []);
const toolArg = (b) => {
  const i = b?.input ?? {};
  return clean(i.command || i.file_path || i.path || i.pattern || i.description || i.prompt || i.url || '');
};

/** The literal last human/assistant/tool line of a session, ≤160 chars. */
function lastLine(evs) {
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    const ev = evs[i];
    const t = human(ev) || reply(ev);
    if (t) return clip(t);
    const b = tools(ev)[0];
    if (b) return clip(`${b.name}${toolArg(b) ? ` ${toolArg(b)}` : ''}`);
  }
  return null;
}

function titleOf(evs) {
  for (const ev of evs) {
    const t = clean(ev?.summary || ev?.title || ev?.aiTitle);
    if (t) return t;
  }
  return null;
}

const cwdOf = (evs) => {
  for (let i = evs.length - 1; i >= 0; i -= 1) if (clean(evs[i]?.cwd)) return clean(evs[i].cwd);
  return null;
};

function updatedOf(evs, fallback) {
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    const t = Date.parse(evs[i]?.timestamp ?? '');
    if (Number.isFinite(t)) return t;
  }
  // mtimeMs is fractional on APFS; the dashboard wants an integer ms epoch.
  return Number.isFinite(fallback) ? Math.round(fallback) : null;
}

/** Absolute paths the session touched, from tool_use inputs and tool-result echoes. */
function filesOf(evs, cwd) {
  const out = new Set();
  const add = (p) => {
    const s = clean(p);
    if (!s || s.length > 4096) return;
    out.add(isAbsolute(s) ? s : resolve(cwd || homedir(), s));
  };
  for (const ev of evs) {
    for (const b of tools(ev)) {
      if (!FILE_TOOLS.has(b.name)) continue;
      add(b.input?.file_path || b.input?.notebook_path || b.input?.path);
    }
    add(ev?.toolUseResult?.filePath);
  }
  return [...out].slice(0, 50);
}

function normalizeTodos(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((t) => ({ content: clip(t?.content ?? t?.subject ?? t?.activeForm, 200), status: clean(t?.status) || 'pending' }))
    .filter((t) => t.content);
}

/** Todo state: the on-disk todo file first, else the transcript's last TodoWrite. */
function todosOf(todoNames, sessionId, evs) {
  for (const n of todoNames) {
    if (n !== `${sessionId}.json` && !n.startsWith(`${sessionId}-`)) continue;
    try {
      const j = JSON.parse(readFileSync(join(TODOS, n), 'utf8'));
      const arr = Array.isArray(j) ? j : j?.todos;
      const done = normalizeTodos(arr);
      if (done.length) return done;
    } catch { /* unreadable or half-written todo file */ }
  }
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    const ev = evs[i];
    for (const b of tools(ev)) if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) return normalizeTodos(b.input.todos);
    const next = normalizeTodos(ev?.toolUseResult?.newTodos);
    if (next.length) return next;
  }
  return [];
}

/** cwd of every live `claude` process, so "running" is measured, not guessed. */
function liveCwds() {
  const set = new Set();
  let ps = '';
  try { ps = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', timeout: 2000, maxBuffer: 4194304 }); } catch { return set; }
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    // `node /usr/local/bin/claude --resume` matches; `…/claude-code.js` and a
    // bracketed `claud[e]` grep do not. grep/ps are excluded so a search is not a session.
    if (!/(?:^|[\s/])claude(?:\s|$)/.test(m[2])) continue;
    if (/^\S*(?:grep|rg|ps|lsof)\b/.test(m[2])) continue;
    try {
      const out = execFileSync('lsof', ['-a', '-p', m[1], '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 1500, maxBuffer: 1048576 });
      const cwd = out.split('\n').find((l) => l.startsWith('n'));
      if (cwd) set.add(cwd.slice(1).trim());
    } catch { /* lsof denied or the process exited */ }
  }
  return set;
}

/** Every transcript on disk with its size and mtime — the cheap part of the scan. */
function transcripts() {
  const out = [];
  const add = (file) => {
    try {
      const st = statSync(file);
      if (st.isFile()) out.push({ file, base: file.slice(file.lastIndexOf('/') + 1), size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* vanished mid-scan */ }
  };
  let dirs = [];
  try { dirs = readdirSync(PROJECTS, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const base = join(PROJECTS, d.name);
    let entries = [];
    try { entries = readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) add(join(base, e.name));
      // Older builds nested the logs one level deeper; support both layouts.
      else if (e.isDirectory() && e.name === 'sessions') {
        try {
          for (const s of readdirSync(join(base, 'sessions'), { withFileTypes: true })) if (s.isFile() && s.name.endsWith('.jsonl')) add(join(base, 'sessions', s.name));
        } catch { /* unreadable */ }
      }
    }
  }
  return out;
}

/** Every session Claude Code knows, newest first. Never throws; missing store → []. */
export function sessions({ limit = 20 } = {}) {
  try {
    let todoNames = [];
    try { todoNames = readdirSync(TODOS); } catch { /* no todo store on this install */ }
    const live = liveCwds();
    const now = Date.now();
    return transcripts()
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(0, Number(limit) || 0))
      .map((t) => {
        const evs = events(t.file);
        const sid = t.base.replace(/\.jsonl$/, '');
        const cwd = cwdOf(evs);
        const prompt = evs.map(human).find(Boolean) ?? null;
        const summary = titleOf(evs);
        return {
          id: sid,
          agent: 'claude-code',
          title: clip(summary || prompt || (cwd ? cwd.slice(cwd.lastIndexOf('/') + 1) : '') || sid, 120),
          objective: clip(prompt || summary, 200),
          // Measured where possible: a live claude process in this cwd, or a transcript
          // appended to seconds ago (the CLI writes continuously during a turn).
          status: live.has(cwd) || now - t.mtimeMs < RUNNING_MS ? 'running' : 'idle',
          cwd,
          updatedAt: updatedOf(evs, t.mtimeMs),
          todos: todosOf(todoNames, sid, evs),
          action: lastLine(evs),
          files: filesOf(evs, cwd),
          events: evs.length,
          source: t.file,
        };
      });
  } catch { return []; }
}

export function summary() {
  try {
    const s = sessions({ limit: 100 });
    return {
      sessions: s.length,
      running: s.filter((x) => x.status === 'running').length,
      todos: s.reduce((n, x) => n + x.todos.length, 0),
      lastAt: s.reduce((m, x) => Math.max(m, x.updatedAt ?? 0), 0) || null,
    };
  } catch { return { sessions: 0, running: 0, todos: 0, lastAt: null }; }
}

/** The readable steps of one transcript: thinking, replies, prompts, tool calls. */
export function stepsOf(file, { limit = 200 } = {}) {
  const out = [];
  for (const ev of events(file)) {
    const at = Date.parse(ev?.timestamp ?? '') || null;
    const say = human(ev) || reply(ev);
    const thinking = Array.isArray(ev?.message?.content) ? ev.message.content.filter((b) => b?.type === 'thinking' && b.thinking).map((b) => b.thinking).join(' ') : '';
    if (thinking) out.push({ at, kind: 'think', icon: TOOL_ICON.think, name: 'thinking', detail: clip(thinking), ok: null, file: null });
    if (say) out.push({ at, kind: 'say', icon: TOOL_ICON.say, name: human(ev) ? 'prompt' : 'reply', detail: clip(say), ok: null, file: null });
    for (const b of tools(ev)) {
      const kind = TOOL_KIND[b.name] ?? 'tool';
      out.push({ at, kind, icon: TOOL_ICON[kind] ?? TOOL_ICON.tool, name: b.name, detail: clip(toolArg(b) || JSON.stringify(b.input ?? {}).slice(0, 140)), ok: null, file: clean(b.input?.file_path || b.input?.notebook_path) || null });
    }
    // A user event carrying tool_result blocks answers the call above it.
    const blocks = Array.isArray(ev?.message?.content) ? ev.message.content.filter((b) => b?.type === 'tool_result') : [];
    if (blocks.length) {
      const prev = out.at(-1);
      if (prev && prev.ok === null) prev.ok = blocks.every((b) => b.is_error !== true);
    }
  }
  return out.slice(-limit);
}

/** The last steps of every recent session, newest first — the live activity feed. */
export function activity({ limit = 40, sessionsMax = 4 } = {}) {
  const out = [];
  try {
    for (const s of sessions({ limit: sessionsMax })) {
      for (const st of stepsOf(s.source, { limit: 30 })) {
        out.push({ ...st, session: String(s.id).slice(0, 8), agent: id, ws: s.cwd ? s.cwd.slice(s.cwd.lastIndexOf('/') + 1) : null });
      }
    }
  } catch { /* one bad feed must not blank the panel */ }
  return out.filter((x) => x.at).sort((a, b) => b.at - a.at).slice(0, limit);
}
