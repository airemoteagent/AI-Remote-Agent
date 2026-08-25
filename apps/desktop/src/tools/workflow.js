// Workflow tool — multi-phase, multi-agent orchestration.
//
// The brain coordinates complex jobs as an ordered pipeline of phases:
//   workflow { phases: [{ name, tasks: [{id, prompt}], context?, concurrency? }] }
// Each phase fans out to concurrent sub-agents (the same sandboxed sub-loop
// machinery as `delegate`); there is a BARRIER between phases — a phase
// starts only after the previous one's results exist. A phase can declare
// `context: ["phaseA"]` to get those results injected into every sub-agent.
//
// The runner is injected by the daemon (configureWorkflowRunner()); the tool
// validates and dispatches, and returns structured results per phase.

import { MAX_PHASES } from '@remote-agent/engine';

let runner = null; // async ({ phases }) => { status, phases, results }

export function configureWorkflowRunner(fn) {
  runner = typeof fn === 'function' ? fn : null;
}

export const workflow = {
  name: 'workflow',
  description: 'Coordinate a complex job as an ordered multi-phase pipeline. Each phase runs several sub-agents CONCURRENTLY ({name, tasks:[{id,prompt}], concurrency?}), with a barrier between phases — later phases can declare context:["phaseName"] to receive earlier results injected into their prompts. Use it for multi-stage work: research → synthesize → verify. Results are structured per phase and per task; failed sub-agents are reported, never hidden. Max 8 phases, 6 tasks per phase.',
  args: {
    phases: 'array — [{name, tasks:[{id, prompt}], context?: [phaseName], concurrency?: number}]',
  },
  timeoutMs: 600_000, // multi-phase fan-out may legitimately take minutes

  async run(args) {
    const phases = Array.isArray(args.phases) ? args.phases : null;
    if (!phases || phases.length === 0) {
      return { error: 'workflow requires phases: [{name, tasks, context?, concurrency?}]' };
    }
    if (phases.length > MAX_PHASES) {
      return { error: `workflow supports at most ${MAX_PHASES} phases` };
    }
    const names = new Set();
    for (let i = 0; i < phases.length; i++) {
      const ph = phases[i];
      if (!ph || typeof ph !== 'object' || !ph.name) return { error: `phase[${i}] needs a name` };
      if (names.has(ph.name)) return { error: `duplicate phase name: ${ph.name}` };
      names.add(ph.name);
      if (!Array.isArray(ph.tasks) || ph.tasks.length === 0) return { error: `phase "${ph.name}" needs tasks: [{id, prompt}]` };
      if (ph.tasks.length > 6) return { error: `phase "${ph.name}" supports at most 6 tasks` };
      for (const t of ph.tasks) {
        if (!t || typeof t !== 'object' || typeof t.prompt !== 'string' || !t.prompt.trim()) {
          return { error: `phase "${ph.name}" has a task without {id, prompt}` };
        }
      }
      if (ph.context) {
        for (const ref of ph.context) {
          if (!names.has(String(ref))) {
            return { error: `phase "${ph.name}" references "${ref}" which is not an earlier phase` };
          }
        }
      }
    }
    if (!runner) {
      return { error: 'workflow is only available inside a running agent task on the device daemon' };
    }
    try {
      const result = await runner({ phases });
      const done = (result.results ? Object.values(result.results).flat() : [])
        .filter((r) => r && r.status === 'done').length;
      const total = result.results ? Object.values(result.results).flat().length : 0;
      return {
        status: result.status,
        phases: result.phases || [],
        done,
        total,
        results: result.results || {},
        note: 'Inspect every phase\'s results before answering. A "partial" status means some sub-tasks failed — say so and react.',
      };
    } catch (err) {
      return { error: `workflow failed: ${err.message}` };
    }
  },
};
