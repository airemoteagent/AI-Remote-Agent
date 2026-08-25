// Goal tool — persistent multi-round completion objectives.
//
// The brain can start a long-running objective that keeps going across
// autonomous rounds until it is actually complete (or the round cap is hit):
//
//   goal start {objective, maxRounds?}   → goal id; round 1 runs now
//   goal status <id>                     → status, rounds done, last summary
//   goal list                            → all goals, newest first
//   goal resume <id>                     → enqueue the next round now
//   goal abort <id>                      → stop (status: aborted)
//
// Goals persist to ~/.mona-agent/goals.json (0600) — they survive daemon
// restarts. Each round runs as a normal queued task (serial — steps never
// interleave with user tasks), seeded with the objective + every previous
// round's summary, and must end with a GOAL_COMPLETE marker. Starting and
// resuming require the daemon (the round runner is injected via
// configureGoalRunner()); status/list/abort are pure store operations and
// work anywhere.

import { GoalStore } from '@mona/engine';

const MAX_ROUNDS = 16;
const MAX_OBJECTIVE_LEN = 1000;

let goalRunner = null; // { start({objective,maxRounds}), resume({id}) }

export function configureGoalRunner(runner) {
  goalRunner = runner && typeof runner.start === 'function' && typeof runner.resume === 'function'
    ? runner
    : null;
}

// One store per process; tests override the path via MONA_GOALS_STORE.
const store = new GoalStore({});

function validateObjective(objective) {
  if (typeof objective !== 'string' || !objective.trim()) {
    return { error: 'goal start requires an objective' };
  }
  if (objective.trim().length > MAX_OBJECTIVE_LEN) {
    return { error: `objective too long (max ${MAX_OBJECTIVE_LEN} chars)` };
  }
  return null;
}

export const goal = {
  name: 'goal',
  description: 'Run a long objective across multiple autonomous rounds until it is genuinely complete. Actions: start {objective, maxRounds?} (creates the goal and runs round 1 immediately), status <id>, list, resume <id> (enqueue the next round now), abort <id>. Each round is a fresh task seeded with the objective and every previous round\'s summary; rounds keep running until the brain reports GOAL_COMPLETE: true or the round cap is reached. Goals survive daemon restarts.',
  args: {
    action: 'string — start | status | list | resume | abort',
    objective: 'string — the completion objective (start only)',
    id: 'string — goal id (status / resume / abort only)',
    maxRounds: 'number — optional round cap (1-16, default 8)',
  },
  timeoutMs: 30_000, // round execution happens as queued tasks, not here

  async run(args) {
    const action = String(args.action || '').trim();
    switch (action) {
      case 'start': {
        const v = validateObjective(args.objective);
        if (v) return v;
        if (!goalRunner) {
          return { error: 'goal start is only available inside a running agent task on the device daemon' };
        }
        const maxRounds = Math.min(Math.max(Number(args.maxRounds) || 8, 1), MAX_ROUNDS);
        try {
          const created = await goalRunner.start({ objective: String(args.objective).trim(), maxRounds });
          return {
            id: created.id, status: created.status, roundsCompleted: created.roundsCompleted,
            maxRounds: created.maxRounds, objective: created.objective,
            note: 'Round 1 is running now. Poll with goal status <id>; the goal keeps going until complete or the round cap.',
          };
        } catch (err) {
          return { error: `goal start failed: ${err.message}` };
        }
      }
      case 'status': {
        const g = store.get(String(args.id || ''));
        if (!g) return { error: `No such goal: ${args.id || ''}` };
        return {
          id: g.id, status: g.status, complete: g.complete,
          roundsCompleted: g.roundsCompleted, maxRounds: g.maxRounds,
          objective: g.objective, lastSummary: g.lastSummary, reason: g.reason,
          rounds: g.rounds.map((r) => ({ round: r.round, summary: r.summary, tokens: r.tokens, ts: r.ts })),
          createdAt: g.createdAt, updatedAt: g.updatedAt,
        };
      }
      case 'list':
        return { count: store.list().length, goals: store.list() };
      case 'resume': {
        const g = store.get(String(args.id || ''));
        if (!g) return { error: `No such goal: ${args.id || ''}` };
        if (g.status !== 'active') return { error: `goal ${g.id} is ${g.status} — cannot resume` };
        if (g.roundsCompleted >= g.maxRounds) return { error: `goal ${g.id} reached its round cap (${g.maxRounds})` };
        if (!goalRunner) {
          return { error: 'goal resume is only available inside a running agent task on the device daemon' };
        }
        try {
          const next = await goalRunner.resume({ id: g.id });
          return { id: next.id, status: next.status, roundsCompleted: next.roundsCompleted, maxRounds: next.maxRounds, note: 'next round enqueued' };
        } catch (err) {
          return { error: `goal resume failed: ${err.message}` };
        }
      }
      case 'abort': {
        const g = store.abort(String(args.id || ''));
        if (!g) return { error: `No such goal: ${args.id || ''}` };
        return { id: g.id, status: g.status, note: 'goal aborted — no further rounds will run' };
      }
      default:
        return {
          error: `Unknown action "${action}" — use start, status, list, resume or abort`,
          actions: ['start', 'status', 'list', 'resume', 'abort'],
        };
    }
  },
};
