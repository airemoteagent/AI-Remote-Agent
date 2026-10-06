// OpenClaw runtime adapter — sessions, steps and files, read from its own store.
//
// Everything here was observed on this Mac (2026-10-06), no invented formats:
//
//   ~/.openclaw/agents/<agent>/sessions/sessions.json
//     { "agent:main:tui-4475b19b-…": { sessionId, sessionFile, updatedAt,
//        lastInteractionAt, sessionStartedAt, model, modelProvider, inputTokens,
//        outputTokens, totalTokens, estimatedCostUsd, abortedLastRun,
//        systemPromptReport: { workspaceDir, model, provider } } , … }
//     → the TUI session key the user sees is the map key; sessionId names the file.
//
//   ~/.openclaw/agents/<agent>/sessions/<sessionId>.jsonl      (v3 transcript)
//     {"type":"session","id":…,"timestamp":…,"cwd":"/Users/mona/.openclaw/workspaceNWEO02"}
//     {"type":"model_change","provider":"deepseek","modelId":"deepseek-v4-pro"}
//     {"type":"message","timestamp":…,"message":{"role":"assistant","content":[
//        {"type":"thinking","thinking":"…"} | {"type":"text","text":"…"} |
//        {"type":"toolCall","name":"exec","arguments":{"command":"…"}} ]}}
//     roles: user | assistant | toolResult.
//
//   ~/.openclaw/agents/<agent>/sessions/<sessionId>.trajectory.jsonl
//     trace events: session.started, prompt.submitted, model.completed,
//     context.compiled, model.fallback_step, trace.artifacts (line blobs, not needed
//     for the roster — the transcript is the readable record).
//
//   ~/.openclaw/state/openclaw.sqlite  — gateway tables (agent_databases,
//     task_runs, commitments, …); all session-plan tables measured EMPTY, so the
//     transcript + index are the source of truth. OpenClaw has no first-class todo
//     store in these sessions: `todos` stays empty and the UI shows "—" honestly.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const id = 'openclaw';
export const label = 'OpenClaw';
const ROOT = process.env.OPENCLAW_HOME || join(homedir(), '.openclaw');
export const verified = existsSync(join(ROOT, 'agents'));

const sessionsDir = (agent) => join(ROOT, 'agents', agent, 'sessions');
const tail = (file, maxBytes = 262144) => {
  try {
    const st = statSync(file);
    if (st.size > 40 * 1048576) return ''; // a runaway transcript is not worth the tick
    const buf = readFileSync(file);
    return (buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf).toString('utf8');
  } catch { return ''; }
};

function indexes() {
  const out = [];
  let agents = [];
  try { agents = readdirSync(join(ROOT, 'agents'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
  for (const agent of agents) {
    try {
      const j = JSON.parse(readFileSync(join(sessionsDir(agent), 'sessions.json'), 'utf8'));
      for (const [key, v] of Object.entries(j)) out.push({ agent, key, ...v });
    } catch { /* agent without an index */ }
  }
  return out;
}

/** Every session OpenClaw knows, newest first — active, idle or aborted. */
export function sessions({ limit = 20 } = {}) {
  const IDLE_MS = 90_000;
  return indexes()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, limit)
    .map((s) => {
      const file = s.sessionFile || join(sessionsDir(s.agent), `${s.sessionId}.jsonl`);
      const steps = stepsOf(file);
      // The first prompt is often just "hi"; the longest of the first few user
      // prompts is what the session was actually about.
      const prompts = steps.filter((x) => x.kind === 'say' && x.name === 'prompt').slice(0, 4).map((x) => x.detail);
      const firstUser = prompts.sort((a, b) => (b?.length ?? 0) - (a?.length ?? 0))[0];
      const report = s.systemPromptReport ?? {};
      return {
        id: s.key ?? s.sessionId,
        sessionId: s.sessionId ?? null,
        agent: `${id}:${s.agent}`,
        title: (firstUser || s.key || s.sessionId || 'session').slice(0, 120),
        objective: firstUser ?? null,
        status: s.abortedLastRun ? 'aborted' : (Date.now() - (s.lastInteractionAt ?? s.updatedAt ?? 0) < IDLE_MS ? 'running' : 'idle'),
        cwd: cwdOf(file) ?? report.workspaceDir ?? null,
        model: s.model ?? report.model ?? null,
        provider: s.modelProvider ?? report.provider ?? null,
        tokens: s.totalTokens ?? null,
        costUsd: s.estimatedCostUsd ?? null,
        updatedAt: s.lastInteractionAt ?? s.updatedAt ?? null,
        todos: [], // OpenClaw keeps no todo store here; do not invent one
        action: steps.at(-1)?.detail ?? null,
        files: [...new Set(steps.filter((x) => x.kind === 'edit' && x.file).map((x) => x.file))].slice(0, 40),
        stepCount: steps.length,
        source: join(sessionsDir(s.agent), 'sessions.json'),
      };
    });
}

function cwdOf(file) {
  for (const l of tail(file, 4096).split('\n')) {
    try { const e = JSON.parse(l); if (e.type === 'session' && e.cwd) return e.cwd; } catch { /* partial */ }
  }
  return null;
}

const TOOL_KIND = { exec: 'run', process: 'run', browser: 'look', read: 'read', write: 'edit', edit: 'edit', apply_patch: 'edit', memory_search: 'read', memory_get: 'read', sessions_list: 'read' };
const TOOL_ICON = { think: '🧠', read: '👁', edit: '✏️', run: '▶', look: '🌐', say: '💬', tool: '⚙' };

/** The readable steps of one transcript: thinking, text, tool calls (with args). */
export function stepsOf(file, { limit = 200 } = {}) {
  const out = [];
  for (const line of tail(file).split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const at = Date.parse(e.timestamp ?? '') || null;
    const m = e.message ?? {};
    for (const c of (m.content ?? [])) {
      if (c.type === 'thinking' && c.thinking) out.push({ at, kind: 'think', icon: TOOL_ICON.think, name: 'thinking', detail: String(c.thinking).replace(/\s+/g, ' ').slice(0, 160), ok: null, file: null });
      else if (c.type === 'text' && c.text) out.push({ at, kind: 'say', icon: TOOL_ICON.say, name: m.role === 'user' ? 'prompt' : 'reply', detail: String(c.text).replace(/\s+/g, ' ').slice(0, 160), ok: null, file: null });
      else if (c.type === 'toolCall') {
        const kind = TOOL_KIND[c.name] ?? 'tool';
        const a = c.arguments ?? c.input ?? {};
        const detail = a.command ?? a.path ?? a.url ?? a.query ?? JSON.stringify(a).slice(0, 140);
        out.push({ at, kind, icon: TOOL_ICON[kind] ?? TOOL_ICON.tool, name: c.name, detail: String(detail).replace(/\s+/g, ' ').slice(0, 160), ok: null, file: a.path ?? null });
      } else if (c.type === 'toolResult' || m.role === 'toolResult') {
        const prev = out.at(-1);
        if (prev && prev.ok === null) prev.ok = c.isError !== true;
      }
    }
  }
  return out.slice(-limit);
}

/** The last steps of every recent session, newest first — the live activity feed. */
export function activity({ limit = 40, sessionsMax = 4 } = {}) {
  const out = [];
  for (const s of sessions({ limit: sessionsMax })) {
    const file = join(sessionsDir(s.agent.split(':')[1] ?? 'main'), `${s.sessionId}.jsonl`);
    for (const st of stepsOf(file, { limit: 30 })) out.push({ ...st, session: (s.sessionId ?? s.id).slice(0, 8), agent: 'openclaw', ws: s.cwd ? s.cwd.split('/').pop() : null });
  }
  return out.filter((x) => x.at).sort((a, b) => b.at - a.at).slice(0, limit);
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
