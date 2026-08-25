// Delegate tool — subagent fan-out for the cloud brain.
//
// Splits one task into several independent sub-tasks that run CONCURRENTLY
// as fresh, bounded sub-agents on this device (same policy, same budget,
// same tool sandbox), then hands every sub-result back to the parent so it
// can verify each piece before answering.
//
//   delegate { tasks: [{id, prompt}, ...], concurrency: 2 }
//
// The actual sub-runner is injected by the daemon (agent.js) via
// configureDelegateRunner() — the tool itself stays a thin validation +
// dispatch layer so CLI/embedded contexts get a clear error instead of a
// half-working path. Depth limiting lives in the runner (a sub-agent may
// never spawn sub-agents of its own beyond the configured depth).

let runner = null;

/** Inject the daemon's sub-task runner (idempotent; overwrites on hot swap). */
export function configureDelegateRunner(fn) {
  runner = typeof fn === 'function' ? fn : null;
}

export const delegate = {
  name: 'delegate',
  description: 'Split your task into independent sub-tasks and run them concurrently as fresh sub-agents on this device. Each sub-agent has its own context, obeys the same policy and budget, and returns {status, answer, steps, usage}. Use it for parallelizable work — research several files, test several approaches, compare options. Actions: pass tasks=[{id, prompt}] (max 6) and concurrency (1-4, default all). Inspect every result.status before answering; a failed sub-task is reported, not hidden.',
  args: {
    tasks: 'array — [{id, prompt}] sub-tasks to run (max 6)',
    concurrency: 'number — optional, how many sub-agents to run at once (1-4)',
  },
  timeoutMs: 240_000, // fan-out may legitimately take minutes

  async run(args) {
    const tasks = Array.isArray(args.tasks) ? args.tasks : null;
    if (!tasks || tasks.length === 0) {
      return { error: 'delegate requires tasks: [{id, prompt}]' };
    }
    if (tasks.length > 6) {
      return { error: 'delegate supports at most 6 sub-tasks at once' };
    }
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (!t || typeof t !== 'object' || typeof t.prompt !== 'string' || !t.prompt.trim()) {
        return { error: `task[${i}] needs {id, prompt}` };
      }
    }
    if (!runner) {
      return { error: 'delegate is only available inside a running agent task on the device daemon' };
    }
    const concurrency = Math.min(Math.max(Number(args.concurrency) || tasks.length, 1), 4);
    try {
      const results = await runner({ tasks, concurrency });
      const ok = results.filter((r) => r && r.status === 'done').length;
      return {
        delegated: results.length,
        done: ok,
        failed: results.length - ok,
        results,
        note: 'Inspect every result — statuses, answers and usage — before you answer. Never claim a sub-result you did not read.',
      };
    } catch (err) {
      return { error: `delegate failed: ${err.message}` };
    }
  },
};
