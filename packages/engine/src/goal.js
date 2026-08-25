// Persistent multi-round goals — the agent's "goal rounds".
//
// A goal is a long-running objective that the agent pursues across several
// autonomous rounds: each round runs a fresh task seeded with the objective
// and every previous round's summary (durable state), and ends by declaring
// GOAL_COMPLETE: true|false. The daemon keeps enqueueing rounds until the
// objective is complete or the round cap is reached. Goals persist to disk
// (0600) so they survive daemon restarts — the same durable model a harness
// uses for completion objectives.
//
// This module is pure state + prompt/parsing helpers: no brain, no tools,
// no queue. Fully testable offline.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DEFAULT_STORE = process.env.REMOTE_GOALS_STORE || join(homedir(), '.remote-agent', 'goals.json');

export const MAX_GOAL_ROUNDS = 16;
export const MAX_OBJECTIVE = 1000;
const MAX_SUMMARY = 2000;

function nowIso() { return new Date().toISOString(); }
function goalId() {
  return `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Validate + normalise a goal record (throws TypeError/RangeError on bad input).
 */
export function normaliseGoal(raw) {
  const objective = String(raw?.objective ?? '').trim();
  if (!objective) throw new TypeError('goal objective is required');
  if (objective.length > MAX_OBJECTIVE) throw new RangeError(`objective too long (max ${MAX_OBJECTIVE} chars)`);
  const maxRounds = Math.min(Math.max(Number(raw?.maxRounds) || 8, 1), MAX_GOAL_ROUNDS);
  return {
    id: String(raw?.id || goalId()),
    objective,
    maxRounds,
    status: ['active', 'complete', 'aborted', 'blocked'].includes(raw?.status) ? raw.status : 'active',
    roundsCompleted: Math.max(0, Number(raw?.roundsCompleted) || 0),
    rounds: Array.isArray(raw?.rounds) ? raw.rounds.slice(-maxRounds) : [],
    lastSummary: String(raw?.lastSummary || ''),
    complete: Boolean(raw?.complete),
    reason: String(raw?.reason || ''),
    createdAt: raw?.createdAt || nowIso(),
    updatedAt: raw?.updatedAt || nowIso(),
  };
}

/**
 * Parse the completion marker the brain appends to a goal round's answer.
 * Returns { complete, reason, clean } — clean is the answer with the marker
 * lines stripped. When the marker is absent, complete defaults to false
 * (a round never completes silently).
 */
export function parseGoalMarker(answer) {
  const text = String(answer ?? '');
  const m = text.match(/GOAL_COMPLETE:\s*(true|false)/i);
  const r = text.match(/GOAL_REASON:\s*(.+)/i);
  const complete = m ? m[1].toLowerCase() === 'true' : false;
  const reason = r ? String(r[1]).trim().slice(0, 300) : '';
  const clean = text
    .replace(/GOAL_COMPLETE:\s*(true|false)/gi, '')
    .replace(/GOAL_REASON:\s*.+/gi, '')
    .trim();
  return { complete, reason, clean };
}

/**
 * System-prompt fragment seeding one goal round with the durable state of
 * every previous round.
 */
export function buildGoalRoundPrompt(goal, roundNo) {
  const g = normaliseGoal(goal);
  const past = g.rounds.length
    ? g.rounds.map((r) => `- Round ${r.round}: ${String(r.summary || '').slice(0, 400)}`).join('\n')
    : '(this is the first round)';
  return [
    `## Autonomous goal — round ${roundNo} of ${g.maxRounds}`,
    `Objective: ${g.objective}`,
    '',
    'You are continuing a long-running objective on this device. Work autonomously: use tools, verify your work, and make real progress toward the objective.',
    '',
    `What happened so far:\n${past}`,
    '',
    'At the very end of your final answer, append exactly these two lines (nothing after them):',
    'GOAL_COMPLETE: true|false',
    'GOAL_REASON: <one short sentence saying why>',
    'Set GOAL_COMPLETE to true ONLY when the objective is genuinely finished and verified — not just partially advanced.',
  ].join('\n');
}

/** Build the user-facing display text for a goal round task. */
export function goalRoundTaskText(goal, roundNo) {
  const g = normaliseGoal(goal);
  return `🎯 ${g.objective} (round ${roundNo}/${g.maxRounds})`;
}

/**
 * File-backed goal store. Atomic writes, 0600 mode. Survives restarts.
 *
 * One live instance per store path within a process (a singleton registry):
 * the `goal` tool and the daemon each construct a GoalStore, and both MUST
 * see the same in-memory state — otherwise rounds written by the daemon
 * would be invisible to the tool's status reads. Disk stays the source of
 * truth across processes/restarts.
 */
const _instances = new Map(); // storePath → GoalStore

export class GoalStore {
  constructor({ storePath = DEFAULT_STORE } = {}) {
    const existing = _instances.get(storePath);
    if (existing) return existing; // per-path singleton (same process)
    this.storePath = storePath;
    this.goals = new Map();
    this.#load();
    _instances.set(storePath, this);
  }

  #load() {
    try {
      if (existsSync(this.storePath)) {
        const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
        if (raw && typeof raw === 'object' && Array.isArray(raw.goals)) {
          for (const g of raw.goals) this.goals.set(g.id, normaliseGoal(g));
        }
      }
    } catch { /* unreadable store → start empty */ }
  }

  #save() {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      const tmp = `${this.storePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ goals: [...this.goals.values()] }, null, 2), { mode: 0o600 });
      renameSync(tmp, this.storePath);
    } catch { /* best-effort persistence */ }
  }

  create({ objective, maxRounds = 8 }) {
    const goal = normaliseGoal({ objective, maxRounds });
    this.goals.set(goal.id, goal);
    this.#save();
    return goal;
  }

  get(id) {
    const g = this.goals.get(String(id));
    return g ? normaliseGoal(g) : null;
  }

  list() {
    return [...this.goals.values()]
      .sort((a, b) =>
        String(b.updatedAt).localeCompare(String(a.updatedAt)) ||
        String(b.createdAt).localeCompare(String(a.createdAt)) ||
        String(b.id).localeCompare(String(a.id)))
      .map((g) => ({
        id: g.id, objective: g.objective, status: g.status,
        roundsCompleted: g.roundsCompleted, maxRounds: g.maxRounds,
        complete: g.complete, lastSummary: g.lastSummary,
        createdAt: g.createdAt, updatedAt: g.updatedAt,
      }));
  }

  /** Append one round's outcome; returns the fresh goal. */
  recordRound(id, { round, summary = '', tokens = 0 } = {}) {
    const goal = this.get(id);
    if (!goal) return null;
    goal.rounds.push({
      round: Number(round) || goal.roundsCompleted + 1,
      summary: String(summary).slice(0, MAX_SUMMARY),
      tokens: Math.max(0, Number(tokens) || 0),
      ts: nowIso(),
    });
    goal.roundsCompleted = goal.rounds.length;
    goal.lastSummary = goal.rounds[goal.rounds.length - 1].summary;
    goal.updatedAt = nowIso();
    this.goals.set(id, normaliseGoal(goal));
    this.#save();
    return this.get(id);
  }

  /** Mark completion or a blocking condition; returns the fresh goal. */
  setStatus(id, { complete = false, reason = '', status = null } = {}) {
    const goal = this.get(id);
    if (!goal) return null;
    if (complete) {
      goal.status = 'complete';
      goal.complete = true;
      goal.reason = String(reason).slice(0, 300);
    } else if (status && ['active', 'aborted', 'blocked'].includes(status)) {
      goal.status = status;
      goal.reason = String(reason).slice(0, 300);
    }
    goal.updatedAt = nowIso();
    this.goals.set(id, normaliseGoal(goal));
    this.#save();
    return this.get(id);
  }

  abort(id) { return this.setStatus(id, { status: 'aborted' }); }
  block(id, reason = '') { return this.setStatus(id, { status: 'blocked', reason }); }

  remove(id) {
    const existed = this.goals.delete(String(id));
    if (existed) this.#save();
    return existed;
  }
}
