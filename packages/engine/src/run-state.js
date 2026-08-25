// Durable execution state for side-effect-aware agent runs.
//
// RunStore is deliberately independent from any provider, queue, or tool
// implementation. It persists only owned JSON data through atomic 0600 writes,
// making it safe to use for task orchestration, CLI work, or cloud requests.
// It provides a conservative retry decision: a side effect never becomes
// retryable merely because a process restarted.
//
// Recovery model:
//   - every `checkpoint` appends an immutable recovery point (history) while
//     keeping `checkpoint` as the current point for backward compatibility;
//   - `rollback` restores an earlier recovery point, records a compensation
//     event, and moves the run to the terminal `rolled_back` state;
//   - `resume` reactivates an interrupted active run without duplicating work;
//   - `cancel` terminates an active run with a reason;
//   - `startAttempt` refuses a side-effecting retry beyond a bounded attempt
//     count or without an idempotency contract.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

const DEFAULT_STORE = process.env.REMOTE_RUNS_STORE || join(homedir(), '.remote-agent', 'runs.json');
const MAX_RUNS = 500;
const MAX_TEXT = 4000;
const MAX_ATTEMPTS = 10;
const MAX_CHECKPOINTS = 100;
const MAX_ROLLBACKS = 100;
const ACTIVE = new Set(['created', 'planned', 'awaiting_approval', 'running', 'verifying', 'rollback_required']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'rolled_back']);
const TRANSITIONS = {
  created: new Set(['planned', 'awaiting_approval', 'running', 'cancelled', 'failed']),
  planned: new Set(['awaiting_approval', 'running', 'cancelled', 'failed']),
  awaiting_approval: new Set(['planned', 'running', 'cancelled', 'failed']),
  running: new Set(['verifying', 'succeeded', 'failed', 'cancelled', 'rollback_required']),
  verifying: new Set(['succeeded', 'failed', 'rollback_required']),
  rollback_required: new Set(['rolled_back', 'failed']),
  succeeded: new Set(), failed: new Set(), cancelled: new Set(), rolled_back: new Set(),
};
const _instances = new Map();

function nowIso() { return new Date().toISOString(); }
function truncate(value, n = MAX_TEXT) { return String(value ?? '').slice(0, n); }
function runId() { return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }
function eventId() { return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function approvalBinding(run) {
  return createHash('sha256').update(`${run.id}\0${run.planRevision}\0${run.policyRevision}`).digest('hex');
}
function sameBinding(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function normaliseRun(raw = {}) {
  const status = TRANSITIONS[raw.status] ? raw.status : 'created';
  const attempts = Array.isArray(raw.attempts) ? raw.attempts.slice(-200).map((a) => ({
    id: String(a?.id || eventId()),
    tool: truncate(a?.tool, 200),
    idempotencyKey: truncate(a?.idempotencyKey, 300),
    sideEffects: Boolean(a?.sideEffects),
    idempotent: Boolean(a?.idempotent),
    compensation: Boolean(a?.compensation),
    status: ['started', 'succeeded', 'failed', 'unknown', 'compensated'].includes(a?.status) ? a.status : 'unknown',
    result: a?.result && typeof a.result === 'object' ? a.result : null,
    ts: a?.ts || nowIso(),
    updatedAt: a?.updatedAt || a?.ts || nowIso(),
  })) : [];
  // Immutable recovery points: append-only history for rollback. The current
  // checkpoint is the last entry, but `checkpoint` remains authoritative for
  // backward compatibility with callers that write it directly.
  const checkpoints = Array.isArray(raw.checkpoints) ? raw.checkpoints.slice(-MAX_CHECKPOINTS).map((c, i) => ({
    index: Number.isInteger(c?.index) ? c.index : i,
    ts: c?.ts || nowIso(),
    data: c?.data && typeof c.data === 'object' ? c.data : {},
  })) : [];
  // Compensation events recorded by explicit rollback.
  const rollbacks = Array.isArray(raw.rollbacks) ? raw.rollbacks.slice(-MAX_ROLLBACKS).map((r) => ({
    ts: r?.ts || nowIso(),
    fromIndex: Number.isInteger(r?.fromIndex) ? r.fromIndex : null,
    toIndex: Number.isInteger(r?.toIndex) ? r.toIndex : null,
    reason: truncate(r?.reason, 1000),
  })) : [];
  const checkpoint = raw.checkpoint && typeof raw.checkpoint === 'object'
    ? raw.checkpoint
    : (checkpoints.length ? checkpoints[checkpoints.length - 1].data : {});
  return {
    id: String(raw.id || runId()),
    task: truncate(raw.task, MAX_TEXT),
    status,
    correlationId: truncate(raw.correlationId || raw.id || '', 300),
    policyRevision: truncate(raw.policyRevision, 200),
    planRevision: truncate(raw.planRevision, 200),
    checkpoint,
    checkpoints,
    rollbacks,
    approvals: Array.isArray(raw.approvals) ? raw.approvals.slice(-100).map((a) => ({
      actor: truncate(a?.actor, 300),
      decision: ['approved', 'rejected', 'expired'].includes(a?.decision) ? a.decision : 'rejected',
      expiresAt: truncate(a?.expiresAt, 100),
      note: truncate(a?.note, 1000),
      planRevision: truncate(a?.planRevision, 200),
      policyRevision: truncate(a?.policyRevision, 200),
      binding: truncate(a?.binding, 64),
      ts: a?.ts || nowIso(),
    })) : [],
    attempts,
    reason: truncate(raw.reason, 1000),
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || nowIso(),
  };
}

export function retryDecision(attempt) {
  if (!attempt) return { retryable: true, reason: 'no prior attempt' };
  if (!attempt.sideEffects) return { retryable: true, reason: 'read-only attempt' };
  if (attempt.status === 'succeeded') return { retryable: false, reason: 'side effect already succeeded' };
  if (attempt.idempotent && attempt.idempotencyKey) return { retryable: true, reason: 'idempotent side effect with key' };
  if (attempt.compensation && attempt.status === 'compensated') return { retryable: true, reason: 'prior effect compensated' };
  return { retryable: false, reason: 'side effect requires idempotency key or completed compensation' };
}

export class RunStore {
  constructor({ storePath = DEFAULT_STORE } = {}) {
    const existing = _instances.get(storePath);
    if (existing) return existing;
    this.storePath = storePath;
    this.runs = new Map();
    this.#load();
    _instances.set(storePath, this);
  }

  #load() {
    try {
      if (!existsSync(this.storePath)) return;
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
      for (const item of (Array.isArray(raw?.runs) ? raw.runs : [])) {
        const run = normaliseRun(item);
        this.runs.set(run.id, run);
      }
    } catch { /* unavailable/corrupt state fails closed to an empty store */ }
  }

  #save() {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const runs = [...this.runs.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, MAX_RUNS);
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, runs }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.storePath);
  }

  #put(run) {
    const fresh = normaliseRun({ ...run, updatedAt: nowIso() });
    this.runs.set(fresh.id, fresh);
    this.#save();
    return this.get(fresh.id);
  }

  create({ id, task, correlationId, policyRevision = '', planRevision = '', checkpoint = {} } = {}) {
    const run = normaliseRun({ id, task, correlationId, policyRevision, planRevision, checkpoint, status: 'created' });
    if (this.runs.has(run.id)) return this.get(run.id);
    return this.#put(run);
  }

  get(id) {
    const run = this.runs.get(String(id));
    return run ? normaliseRun(run) : null;
  }

  list({ activeOnly = false } = {}) {
    return [...this.runs.values()]
      .filter((r) => !activeOnly || ACTIVE.has(r.status))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((r) => normaliseRun(r));
  }

  transition(id, status, { reason = '', checkpoint } = {}) {
    const run = this.get(id);
    if (!run) return null;
    if (!TRANSITIONS[status]) throw new TypeError(`unknown run status: ${status}`);
    if (run.status !== status && !TRANSITIONS[run.status].has(status)) {
      throw new Error(`invalid run transition: ${run.status} → ${status}`);
    }
    run.status = status;
    if (reason) run.reason = truncate(reason, 1000);
    if (checkpoint && typeof checkpoint === 'object') {
      run.checkpoint = checkpoint;
      run.checkpoints.push({ index: run.checkpoints.length, ts: nowIso(), data: checkpoint });
    }
    return this.#put(run);
  }

  checkpoint(id, checkpoint) {
    const run = this.get(id);
    if (!run) return null;
    const data = checkpoint && typeof checkpoint === 'object' ? checkpoint : {};
    run.checkpoint = data;
    run.checkpoints.push({ index: run.checkpoints.length, ts: nowIso(), data });
    return this.#put(run);
  }

  /** List immutable recovery points (checkpoint history) for a run. */
  recoveryPoints(id) {
    const run = this.get(id);
    return run ? run.checkpoints : [];
  }

  /** Terminate an active run with a reason; terminal runs are left unchanged. */
  cancel(id, { reason = 'cancelled by operator' } = {}) {
    const run = this.get(id);
    if (!run) return null;
    if (TERMINAL.has(run.status)) return run;
    return this.transition(id, 'cancelled', { reason });
  }

  /**
   * Reactivate an interrupted run that is not yet terminal. Unlike `transition`,
   * this is intentionally lenient: any active state may resume, since recovery
   * is driven by the persisted attempts rather than the previous state label.
   */
  resume(id) {
    const run = this.get(id);
    if (!run) return null;
    if (TERMINAL.has(run.status)) throw new Error(`cannot resume terminal run: ${run.status}`);
    if (run.status === 'running') return run;
    run.status = 'running';
    run.reason = truncate(run.reason || 'resumed after interruption', 1000);
    return this.#put(run);
  }

  /**
   * Roll a run back to an earlier recovery point and record the compensation
   * event. Defaults to the previous recovery point; pass `toIndex` to target a
   * specific one. Moves the run to the terminal `rolled_back` state.
   */
  rollback(id, { toIndex = null, reason = '' } = {}) {
    const run = this.get(id);
    if (!run) return null;
    if (run.status === 'succeeded' || run.status === 'cancelled') {
      throw new Error(`cannot roll back from terminal status ${run.status}`);
    }
    if (!run.checkpoints.length) throw new Error('no recovery point to roll back to');
    const target = toIndex === null ? Math.max(0, run.checkpoints.length - 2) : toIndex;
    if (!Number.isInteger(target) || target < 0 || target >= run.checkpoints.length) {
      throw new Error(`invalid recovery point index ${target}`);
    }
    const cp = run.checkpoints[target];
    run.checkpoint = cp.data;
    run.rollbacks.push({ ts: nowIso(), fromIndex: run.checkpoints.length - 1, toIndex: target, reason: truncate(reason || `rolled back to recovery point ${target}`, 1000) });
    run.status = 'rolled_back';
    run.reason = truncate(reason || `rolled back to recovery point ${target}`, 1000);
    return this.#put(run);
  }

  approve(id, { actor = '', decision = 'approved', expiresAt = '', note = '', planRevision, policyRevision } = {}) {
    const run = this.get(id);
    if (!run) return null;
    if (!['approved', 'rejected', 'expired'].includes(decision)) throw new TypeError('invalid approval decision');
    if (run.status !== 'awaiting_approval') throw new Error(`run is not awaiting approval: ${run.status}`);
    if (!run.planRevision || !run.policyRevision) throw new Error('approval requires planRevision and policyRevision');
    if (planRevision !== undefined && String(planRevision) !== run.planRevision) throw new Error('approval plan revision mismatch');
    if (policyRevision !== undefined && String(policyRevision) !== run.policyRevision) throw new Error('approval policy revision mismatch');
    if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new TypeError('approval expiresAt must be a valid timestamp');
    run.approvals.push({
      actor: truncate(actor, 300), decision, expiresAt: truncate(expiresAt, 100), note: truncate(note, 1000),
      planRevision: run.planRevision, policyRevision: run.policyRevision, binding: approvalBinding(run), ts: nowIso(),
    });
    return this.#put(run);
  }

  approvalStatus(id, { now = Date.now() } = {}) {
    const run = this.get(id);
    if (!run) return { approved: false, reason: 'unknown run' };
    const approval = [...run.approvals].reverse().find((a) => a.decision === 'approved');
    if (!approval) return { approved: false, reason: 'no approval receipt' };
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= now) return { approved: false, reason: 'approval expired' };
    if (approval.planRevision !== run.planRevision || approval.policyRevision !== run.policyRevision) return { approved: false, reason: 'approval revision mismatch' };
    if (!sameBinding(approval.binding, approvalBinding(run))) return { approved: false, reason: 'approval binding mismatch' };
    return { approved: true, approval };
  }

  startAttempt(id, { tool, idempotencyKey = '', sideEffects = false, idempotent = false, compensation = false } = {}) {
    const run = this.get(id);
    if (!run) return null;
    if (!tool) throw new TypeError('attempt tool is required');
    if (run.attempts.length >= MAX_ATTEMPTS) throw new Error(`max attempts (${MAX_ATTEMPTS}) reached`);
    if (sideEffects && run.status === 'awaiting_approval') {
      const approval = this.approvalStatus(id);
      if (!approval.approved) throw new Error(`side effect requires valid approval: ${approval.reason}`);
      run.status = 'running';
    }
    // A freshly requested side effect must declare an idempotency key before
    // execution. It may still be non-idempotent, but then any interrupted
    // attempt is deliberately sent to manual review rather than retried.
    if (sideEffects && !idempotencyKey) throw new Error('side-effecting attempt requires an idempotency key');
    const prior = run.attempts.find((a) => a.idempotencyKey && a.idempotencyKey === idempotencyKey && a.tool === tool && a.status !== 'compensated');
    const decision = retryDecision(prior);
    if (!decision.retryable) throw new Error(`unsafe retry refused: ${decision.reason}`);
    const attempt = normaliseRun({ attempts: [{ tool, idempotencyKey, sideEffects, idempotent, compensation, status: 'started' }] }).attempts[0];
    run.attempts.push(attempt);
    this.#put(run);
    return { run: this.get(id), attempt, decision };
  }

  finishAttempt(id, attemptId, { status = 'succeeded', result = null } = {}) {
    const run = this.get(id);
    if (!run) return null;
    const attempt = run.attempts.find((a) => a.id === attemptId);
    if (!attempt) return null;
    if (!['succeeded', 'failed', 'unknown', 'compensated'].includes(status)) throw new TypeError('invalid attempt status');
    attempt.status = status;
    attempt.result = result && typeof result === 'object' ? result : null;
    attempt.updatedAt = nowIso();
    return this.#put(run);
  }

  recoverable() {
    return this.list({ activeOnly: true }).map((run) => {
      const incomplete = run.attempts.filter((a) => a.status === 'started' || a.status === 'unknown');
      const unsafe = incomplete.filter((a) => !retryDecision(a).retryable);
      return { run, action: unsafe.length ? 'manual_review' : 'resume', reason: unsafe.length ? 'unfinished side effect lacks safe retry contract' : 'all unfinished work is safe to resume' };
    });
  }

  remove(id) {
    const existed = this.runs.delete(String(id));
    if (existed) this.#save();
    return existed;
  }
}

export const RUN_STATUSES = Object.freeze([...Object.keys(TRANSITIONS)]);
export const ACTIVE_RUN_STATUSES = Object.freeze([...ACTIVE]);
export const TERMINAL_RUN_STATUSES = Object.freeze([...TERMINAL]);
