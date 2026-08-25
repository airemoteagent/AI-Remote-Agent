// Workflow orchestration — multi-phase, multi-agent pipelines.
//
// A workflow is an ordered list of phases; each phase fans out to several
// concurrent sub-agents (same machinery as `delegate`), and there is a
// BARRIER between phases: a phase starts only after the previous phase's
// results are available. Later phases can declare `context: ["phaseA", ...]`
// and get those results injected into every sub-agent's prompt — so a
// research phase feeds a synthesis phase, which feeds a verify phase.
//
//   runWorkflow({
//     phases: [
//       { name: 'research', tasks: [{id, prompt}], concurrency: 3 },
//       { name: 'synthesize', tasks: [{id, prompt}], context: ['research'] },
//     ],
//     think, runTool, policy, budget, ...
//   })
//
// Results are structured and per-item: every phase returns
// { name, status, results: [{id, status, answer, usage, trace}] } and the
// top level returns { status, phases, results: { phaseName: results } }.
// A failing sub-task never aborts the workflow — it is reported in place,
// and later phases still run (they can read the failure and react).
//
// Built directly on runSubtasks() — one source of truth for sub-loop
// execution, shared policy/budget/tool sandbox, depth-safe by construction.

import { runSubtasks, MAX_SUBTASKS, MAX_SUB_PROMPT } from './delegate.js';

export const MAX_PHASES = 8;
export const MAX_PHASE_NAME = 64;
const MAX_CONTEXT_BLOCK = 6000;

/** Validate the phases list; throws TypeError/RangeError on bad input. */
export function validatePhases(phases) {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new TypeError('runWorkflow: a non-empty phases array is required');
  }
  if (phases.length > MAX_PHASES) {
    throw new RangeError(`runWorkflow: at most ${MAX_PHASES} phases per workflow`);
  }
  const names = new Set();
  for (const ph of phases) {
    if (!ph || typeof ph !== 'object') throw new TypeError('runWorkflow: every phase must be an object');
    const name = String(ph.name || '').trim();
    if (!name) throw new TypeError('runWorkflow: every phase needs a name');
    if (name.length > MAX_PHASE_NAME) throw new RangeError(`phase name too long (max ${MAX_PHASE_NAME})`);
    if (names.has(name)) throw new TypeError(`duplicate phase name: ${name}`);
    names.add(name);
    if (!Array.isArray(ph.tasks) || ph.tasks.length === 0) throw new TypeError(`phase "${name}" needs a tasks array`);
    if (ph.tasks.length > MAX_SUBTASKS) throw new RangeError(`phase "${name}" has more than ${MAX_SUBTASKS} tasks`);
    for (const t of ph.tasks) {
      if (!t || typeof t !== 'object' || typeof t.prompt !== 'string' || !t.prompt.trim()) {
        throw new TypeError(`phase "${name}" task needs {id, prompt}`);
      }
    }
  }
  // context references must point at earlier phases (sequential barrier).
  const seen = new Set();
  for (const ph of phases) {
    for (const ref of ph.context || []) {
      if (!seen.has(String(ref))) {
        throw new TypeError(`phase "${ph.name}" references "${ref}" which is not an earlier phase`);
      }
    }
    seen.add(ph.name);
  }
  return true;
}

/** Build the context block a phase's sub-agents see from prior phases. */
export function buildPhaseContext(results, context) {
  if (!Array.isArray(context) || context.length === 0) return '';
  const blocks = [];
  for (const name of context) {
    const res = results[name];
    if (!Array.isArray(res)) continue;
    const items = res.map((r) => {
      const head = r.status === 'error' ? `[error] ${r.error || r.answer || 'failed'}` : (r.answer || '');
      return `- ${r.id}: ${String(head).slice(0, 700)}`;
    }).join('\n');
    blocks.push(`### ${name}\n${items || '(no results)'}`);
  }
  const joined = blocks.join('\n\n').slice(0, MAX_CONTEXT_BLOCK);
  return joined ? `\n\n## Results from earlier phases (use these as input)\n${joined}` : '';
}

/**
 * Run a multi-phase workflow.
 *
 * @param {object} opts
 * @param {Array} opts.phases — [{name, tasks, context?, concurrency?}]
 * @param {Function} opts.think  (messages, prof) => { text, usage }
 * @param {Function} opts.runTool (name, args) => result
 * @param {object} opts.policy / opts.budget — shared, never widened
 * @param {object} [opts.opts] maxSteps / temperature / maxChars for sub-agents
 * @param {Array} [opts.tools] tool descriptors for sub system prompts
 * @param {Function} [opts.onEvent] (phase, subId, kind, payload)
 * @returns {Promise<{status, phases, results}>}
 */
export async function runWorkflow({
  phases, think, runTool, policy, budget,
  maxSteps = 6, temperature = 0.4, maxChars = 30000,
  tools = [], onEvent = null,
} = {}) {
  validatePhases(phases);
  if (typeof think !== 'function') throw new TypeError('runWorkflow: think() is required');
  if (typeof runTool !== 'function') throw new TypeError('runWorkflow: runTool() is required');

  const results = {};
  const phaseOut = [];
  const emit = (phase, subId, kind, payload) => {
    if (onEvent) {
      try { onEvent(phase, subId, kind, payload || {}); } catch { /* tracing never breaks the run */ }
    }
  };

  for (const ph of phases) {
    const name = String(ph.name).trim();
    const contextBlock = buildPhaseContext(results, ph.context);
    const tasks = ph.tasks.map((t) => ({
      id: t.id,
      role: t.role,
      prompt: contextBlock ? `${String(t.prompt).slice(0, MAX_SUB_PROMPT)}${contextBlock}` : String(t.prompt),
    }));
    emit(name, null, 'phase.start', { tasks: tasks.length });
    let out;
    try {
      out = await runSubtasks({
        tasks,
        think,
        runTool,
        policy,
        budget,
        maxSteps,
        temperature,
        maxChars,
        concurrency: ph.concurrency,
        tools,
        onEvent: (subId, kind, payload) => emit(name, subId, kind, payload),
      });
    } catch (err) {
      out = [{ id: 'phase', status: 'error', error: err.message, answer: '', steps: 0, usage: {}, trace: [] }];
    }
    results[name] = out;
    const failed = out.filter((r) => r.status !== 'done').length;
    phaseOut.push({ name, status: failed ? 'partial' : 'done', failed, results: out });
    emit(name, null, 'phase.done', { failed });
  }

  const totalFailed = phaseOut.reduce((n, p) => n + p.failed, 0);
  return {
    status: totalFailed ? 'partial' : 'done',
    phases: phaseOut.map((p) => ({ name: p.name, status: p.status, failed: p.failed })),
    results,
  };
}
