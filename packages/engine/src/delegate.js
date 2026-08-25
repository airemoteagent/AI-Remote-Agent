// Subagent orchestration — fan out one task into focused sub-tasks.
//
// The parent brain can delegate independent sub-problems to fresh subagents
// that run CONCURRENTLY as bounded TaskLoops with their own message context,
// sharing the same policy + budget. Each sub-task returns { status, answer,
// steps, usage, trace } so the parent can inspect every result before
// answering. Depth control (no runaway nesting) is the caller's job.
//
// Zero runtime dependencies; fully testable offline with fake think().

import { TaskLoop } from './loop.js';

export const MAX_SUBTASKS = 6;
export const MAX_SUB_PROMPT = 4000;
export const MAX_SUB_STEPS = 8;

/** Build the system prompt a subagent sees (role + tool list + protocol). */
export function buildSubSystemPrompt(tools = [], role = '') {
  const rows = (tools || [])
    .map((t) => `- ${t.name}: ${t.description}${t.args ? ` (args: ${JSON.stringify(t.args)})` : ''}`)
    .join('\n');
  return [
    `You are a focused subagent${role ? ` (${role})` : ''} working on ONE part of a larger task. Work independently and return a concise final answer only when your sub-goal is met.`,
    'Reply ONLY with one JSON object: {"reasoning":"...","tool":"<name>","args":{...}} to use a tool, or {"reasoning":"...","answer":"..."} when done. Plain text is accepted as a final answer.',
    `Available tools:\n${rows || '(none)'}`,
    'Never invent tool results. If you cannot complete the sub-goal, answer with a clear statement of what is missing.',
  ].join('\n\n');
}

/**
 * Run several sub-tasks concurrently through fresh TaskLoops.
 *
 * @param {object} opts
 * @param {Array<{id?:string, prompt:string, role?:string}>} opts.tasks 1..6
 * @param {Function} opts.think  (messages, prof) => { text, usage } — brain call
 * @param {Function} opts.runTool (name, args) => result — sandboxed tools
 * @param {object} opts.policy    shared Policy (never widened)
 * @param {object} opts.budget    shared Budget governor
 * @param {number} [opts.maxSteps=6] per-sub step budget (clamped to 8)
 * @param {number} [opts.temperature=0.4]
 * @param {number} [opts.maxChars=30000] per-sub context budget (compaction)
 * @param {number} [opts.concurrency=2] max concurrent sub-loops (1..6)
 * @param {Array}  [opts.tools] tool descriptors for the sub system prompt
 * @param {Function} [opts.onEvent] (subId, kind, payload) — transparency hook
 * @returns {Promise<Array>} results: {id, status, answer, steps, usage, trace, blocked, error}
 */
export async function runSubtasks({
  tasks, think, runTool, policy, budget,
  maxSteps = 6, temperature = 0.4, maxChars = 30000,
  concurrency = 2, tools = [], onEvent = null,
} = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new TypeError('runSubtasks: a non-empty tasks array is required');
  }
  if (tasks.length > MAX_SUBTASKS) {
    throw new RangeError(`runSubtasks: at most ${MAX_SUBTASKS} sub-tasks per delegation`);
  }
  if (typeof think !== 'function') throw new TypeError('runSubtasks: think() is required');
  if (typeof runTool !== 'function') throw new TypeError('runSubtasks: runTool() is required');

  const pool = Math.min(Math.max(Number(concurrency) || 1, 1), MAX_SUBTASKS);
  const cap = Math.min(Math.max(Number(maxSteps) || 4, 1), MAX_SUB_STEPS);
  const systemBase = buildSubSystemPrompt(tools);

  const emit = (id, kind, payload) => {
    if (onEvent) {
      try { onEvent(id, kind, payload || {}); } catch { /* tracing never breaks the run */ }
    }
  };

  const runOne = async (t, idx) => {
    const id = String(t.id ?? `sub-${idx + 1}`);
    const prompt = String(t.prompt ?? '').trim().slice(0, MAX_SUB_PROMPT);
    const empty = {
      id, status: 'error', error: 'empty sub-task prompt', answer: '',
      steps: 0, usage: { input: 0, output: 0, total: 0, costUsd: 0 }, trace: [],
    };
    if (!prompt) return empty;

    const system = `${systemBase}\n\nSub-goal: ${prompt.slice(0, 400)}`;
    emit(id, 'start', { prompt: prompt.slice(0, 200) });

    const subThink = async (messages, prof) => {
      const res = await think(messages, { ...prof, temperature: prof?.temperature ?? temperature });
      return {
        text: res?.text ?? '',
        usage: res?.usage ? {
          input: +res.usage.input || 0,
          output: +res.usage.output || 0,
          total: +res.usage.total || 0,
          costUsd: +res.usage.costUsd || 0,
        } : null,
      };
    };

    const loop = new TaskLoop({
      think: subThink,
      runTool,
      policy,
      budget,
      maxSteps: cap,
      temperature,
    });
    loop.on('tool', (name) => emit(id, 'tool', { tool: name }));
    loop.on('tool:denied', (name, verdict) => emit(id, 'denied', { tool: name, reason: verdict.reason }));
    loop.on('compact', (info) => emit(id, 'compact', info));
    loop.on('error', (err) => emit(id, 'error', { message: err.message }));
    loop.on('blocked', (kind, s) => emit(id, 'blocked', { kind, ...(s || {}) }));

    try {
      const res = await loop.run(prompt, { system, profile: 'standard', maxChars });
      emit(id, 'answer', { answer: String(res.answer || '').slice(0, 300) });
      const isError = res.blocked === 'error';
      return {
        id,
        status: isError ? 'error' : (res.blocked ? 'blocked' : 'done'),
        blocked: res.blocked || null,
        error: isError ? res.answer : null,
        answer: res.answer,
        steps: res.steps,
        usage: res.usage || { input: 0, output: 0, total: 0, costUsd: 0 },
        trace: res.trace || [],
      };
    } catch (err) {
      emit(id, 'error', { message: err.message });
      return {
        id, status: 'error', error: err.message, answer: '',
        steps: 0, usage: { input: 0, output: 0, total: 0, costUsd: 0 }, trace: [],
      };
    }
  };

  // Bounded worker pool — at most `pool` sub-loops in flight at once.
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: pool }, async () => {
      while (next < tasks.length) {
        const idx = next++;
        results[idx] = await runOne(tasks[idx], idx);
      }
    })
  );
  return results;
}
