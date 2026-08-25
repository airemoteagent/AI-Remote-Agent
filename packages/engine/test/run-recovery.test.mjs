import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let RunStore;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-runs-recovery-'));
const storePath = (name) => path.join(TMP, `${name}.json`);

before(async () => ({ RunStore } = await import('../src/index.mjs')));

describe('RunStore recovery points and rollback', () => {
  it('appends immutable recovery points and restores an earlier point on rollback', () => {
    const s = new RunStore({ storePath: storePath('rollback') });
    const run = s.create({ task: 'patch service' });
    s.transition(run.id, 'running');
    s.checkpoint(run.id, { phase: 'before-stop', version: 1 });
    s.checkpoint(run.id, { phase: 'after-stop', version: 2 });
    s.checkpoint(run.id, { phase: 'before-restart', version: 3 });

    assert.equal(s.recoveryPoints(run.id).length, 3);

    const rolled = s.rollback(run.id, { toIndex: 0, reason: 'manual rollback' });
    assert.equal(rolled.status, 'rolled_back');
    assert.deepEqual(rolled.checkpoint, { phase: 'before-stop', version: 1 });
    assert.equal(rolled.rollbacks.length, 1);
    assert.equal(rolled.rollbacks[0].toIndex, 0);
    assert.match(rolled.reason, /manual rollback/);
  });

  it('defaults rollback to the previous recovery point and refuses terminal rollback', () => {
    const s = new RunStore({ storePath: storePath('rollback-default') });
    const run = s.create({ task: 'upgrade' });
    s.transition(run.id, 'running');
    s.checkpoint(run.id, { phase: 'a' });
    s.checkpoint(run.id, { phase: 'b' });
    const rolled = s.rollback(run.id);
    assert.deepEqual(rolled.checkpoint, { phase: 'a' });

    const done = s.create({ task: 'finished' });
    s.transition(done.id, 'running');
    s.transition(done.id, 'succeeded');
    assert.throws(() => s.rollback(done.id), /terminal status succeeded/);
  });

  it('rollback without any recovery point fails safely', () => {
    const s = new RunStore({ storePath: storePath('rollback-empty') });
    const run = s.create({ task: 'x' });
    s.transition(run.id, 'running');
    assert.throws(() => s.rollback(run.id), /no recovery point/);
  });
});

describe('RunStore cancellation and resume', () => {
  it('cancels an active run with a reason and leaves terminal runs unchanged', () => {
    const s = new RunStore({ storePath: storePath('cancel') });
    const run = s.create({ task: 'long job' });
    s.transition(run.id, 'running');
    const cancelled = s.cancel(run.id, { reason: 'operator stopped' });
    assert.equal(cancelled.status, 'cancelled');
    assert.match(cancelled.reason, /operator stopped/);

    // Cancelling an already terminal run is a no-op.
    const again = s.cancel(run.id, { reason: 'again' });
    assert.equal(again.status, 'cancelled');
  });

  it('resumes an interrupted active run and refuses terminal resume', () => {
    const s = new RunStore({ storePath: storePath('resume') });
    const run = s.create({ task: 'interruptible' });
    s.transition(run.id, 'running');
    s.transition(run.id, 'verifying');
    const resumed = s.resume(run.id);
    assert.equal(resumed.status, 'running');

    const done = s.create({ task: 'done' });
    s.transition(done.id, 'running');
    s.transition(done.id, 'succeeded');
    assert.throws(() => s.resume(done.id), /terminal run/);
  });
});

describe('RunStore crash-resumption and duplicate avoidance', () => {
  it('recovers an interrupted run after a simulated process restart', () => {
    const p = storePath('crash');
    const a = new RunStore({ storePath: p });
    const run = a.create({ id: 'run-crash', task: 'apply config' });
    a.transition(run.id, 'running');
    a.checkpoint(run.id, { phase: 'before-apply' });
    a.startAttempt(run.id, { tool: 'config.apply', sideEffects: true, idempotent: true, idempotencyKey: 'config:1' });

    // Simulate crash: a fresh RunStore over the same path rehydrates state.
    const b = new RunStore({ storePath: p });
    const loaded = b.get(run.id);
    assert.equal(loaded.status, 'running');
    assert.equal(loaded.checkpoint.phase, 'before-apply');
    assert.equal(loaded.attempts.length, 1);

    const recovery = b.recoverable().find((x) => x.run.id === run.id);
    assert.equal(recovery.action, 'resume');
    const resumed = b.resume(run.id);
    assert.equal(resumed.status, 'running');
  });

  it('refuses to duplicate a non-idempotent side effect after interruption', () => {
    const s = new RunStore({ storePath: storePath('duplicate') });
    const run = s.create({ task: 'send invoice' });
    s.transition(run.id, 'running');
    const first = s.startAttempt(run.id, { tool: 'billing.send', sideEffects: true, idempotent: false, idempotencyKey: 'invoice:42' });
    s.finishAttempt(run.id, first.attempt.id, { status: 'unknown' });
    // A non-idempotent side effect whose outcome is unknown cannot be safely
    // retried — even with the same key — so the store must refuse it.
    assert.throws(() => s.startAttempt(run.id, { tool: 'billing.send', sideEffects: true, idempotent: false, idempotencyKey: 'invoice:42' }), /unsafe retry refused/);
  });

  it('allows an idempotent side effect with a matching key to be retried safely', () => {
    const s = new RunStore({ storePath: storePath('duplicate-idempotent') });
    const run = s.create({ task: 'apply label' });
    s.transition(run.id, 'running');
    const first = s.startAttempt(run.id, { tool: 'ticket.label', sideEffects: true, idempotent: true, idempotencyKey: 'label:123' });
    s.finishAttempt(run.id, first.attempt.id, { status: 'unknown' });
    const second = s.startAttempt(run.id, { tool: 'ticket.label', sideEffects: true, idempotent: true, idempotencyKey: 'label:123' });
    assert.equal(second.decision.retryable, true);
  });

  it('enforces a bounded attempt count for retry loops', () => {
    const s = new RunStore({ storePath: storePath('retry-limit') });
    const run = s.create({ task: 'flaky' });
    s.transition(run.id, 'running');
    // Read-only attempts are individually safe but bounded in aggregate.
    for (let i = 0; i < 10; i++) {
      const a = s.startAttempt(run.id, { tool: 'sysinfo', sideEffects: false });
      s.finishAttempt(run.id, a.attempt.id, { status: 'failed' });
    }
    assert.throws(() => s.startAttempt(run.id, { tool: 'sysinfo', sideEffects: false }), /max attempts/);
  });
});
