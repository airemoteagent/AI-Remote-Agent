import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let RunStore, retryDecision;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-runs-'));
const storePath = (name) => path.join(TMP, `${name}.json`);

before(async () => ({ RunStore, retryDecision } = await import('../src/index.mjs')));

describe('RunStore durable lifecycle', () => {
  it('persists state, checkpoint, approval, and transitions across restart', () => {
    const p = storePath('persist');
    const a = new RunStore({ storePath: p });
    const run = a.create({ id: 'run-persist', task: 'restart service', correlationId: 'c-1', policyRevision: 'p-7', planRevision: 'plan-2' });
    a.transition(run.id, 'planned');
    a.transition(run.id, 'awaiting_approval');
    a.approve(run.id, { actor: 'alice', decision: 'approved', expiresAt: '2030-01-01T00:00:00Z' });
    a.transition(run.id, 'running', { checkpoint: { phase: 'before-restart' } });
    const b = new RunStore({ storePath: p });
    const loaded = b.get(run.id);
    assert.equal(loaded.status, 'running');
    assert.equal(loaded.checkpoint.phase, 'before-restart');
    assert.equal(loaded.approvals[0].actor, 'alice');
    assert.equal(loaded.correlationId, 'c-1');
  });

  it('rejects invalid lifecycle transitions', () => {
    const s = new RunStore({ storePath: storePath('transition') });
    const run = s.create({ task: 'x' });
    assert.throws(() => s.transition(run.id, 'succeeded'), /invalid run transition/);
    s.transition(run.id, 'running');
    s.transition(run.id, 'succeeded');
    assert.throws(() => s.transition(run.id, 'running'), /invalid run transition/);
  });

  it('binds approval receipts to exact plan and policy revisions', () => {
    const s = new RunStore({ storePath: storePath('approval-binding') });
    const run = s.create({ task: 'restart service', planRevision: 'plan-1', policyRevision: 'policy-1' });
    s.transition(run.id, 'awaiting_approval');
    assert.throws(() => s.startAttempt(run.id, { tool: 'service.restart', sideEffects: true, idempotencyKey: 'restart:1' }), /valid approval/);
    assert.throws(() => s.approve(run.id, { actor: 'alice', planRevision: 'plan-2' }), /plan revision mismatch/);
    s.approve(run.id, { actor: 'alice', planRevision: 'plan-1', policyRevision: 'policy-1', expiresAt: '2099-01-01T00:00:00Z' });
    assert.equal(s.approvalStatus(run.id).approved, true);
    const started = s.startAttempt(run.id, { tool: 'service.restart', sideEffects: true, idempotencyKey: 'restart:1' });
    assert.equal(started.run.status, 'running');
  });

  it('rejects expired and tampered approval receipts', () => {
    const storePathValue = storePath('approval-tamper');
    const s = new RunStore({ storePath: storePathValue });
    const run = s.create({ task: 'change config', planRevision: 'plan-1', policyRevision: 'policy-1' });
    s.transition(run.id, 'awaiting_approval');
    s.approve(run.id, { actor: 'alice', expiresAt: '2000-01-01T00:00:00Z' });
    assert.equal(s.approvalStatus(run.id).approved, false);
    const raw = JSON.parse(fs.readFileSync(storePathValue, 'utf8'));
    raw.runs[0].approvals[0].expiresAt = '2099-01-01T00:00:00Z';
    raw.runs[0].approvals[0].planRevision = 'attacker-plan';
    fs.writeFileSync(storePathValue, JSON.stringify(raw));
    const tamperedPath = storePathValue + '-tampered';
    fs.copyFileSync(storePathValue, tamperedPath);
    const fresh = new RunStore({ storePath: tamperedPath });
    assert.equal(fresh.approvalStatus(run.id).approved, false);
  });

  it('allows a read-only retry but refuses unknown side-effect retry', () => {
    const s = new RunStore({ storePath: storePath('retry') });
    const run = s.create({ task: 'x' });
    s.transition(run.id, 'running');
    const read = s.startAttempt(run.id, { tool: 'sysinfo', sideEffects: false });
    s.finishAttempt(run.id, read.attempt.id, { status: 'unknown' });
    assert.doesNotThrow(() => s.startAttempt(run.id, { tool: 'sysinfo', sideEffects: false }));

    assert.throws(() => s.startAttempt(run.id, { tool: 'fs.write', sideEffects: true, idempotent: false }), /idempotency key/);
    const write = s.startAttempt(run.id, { tool: 'fs.write', sideEffects: true, idempotent: false, idempotencyKey: 'write:1' });
    s.finishAttempt(run.id, write.attempt.id, { status: 'unknown' });
    assert.throws(() => s.startAttempt(run.id, { tool: 'fs.write', sideEffects: true, idempotent: false, idempotencyKey: 'write:1' }), /unsafe retry refused/);
  });

  it('permits an idempotent side effect with a matching key after interruption', () => {
    const s = new RunStore({ storePath: storePath('idempotent') });
    const run = s.create({ task: 'apply label' });
    s.transition(run.id, 'running');
    const first = s.startAttempt(run.id, { tool: 'ticket.label', sideEffects: true, idempotent: true, idempotencyKey: 'label:123' });
    s.finishAttempt(run.id, first.attempt.id, { status: 'unknown' });
    const second = s.startAttempt(run.id, { tool: 'ticket.label', sideEffects: true, idempotent: true, idempotencyKey: 'label:123' });
    assert.equal(second.decision.retryable, true);
    assert.match(second.decision.reason, /idempotent/);
  });

  it('marks incomplete unsafe runs for manual recovery review', () => {
    const s = new RunStore({ storePath: storePath('recovery') });
    const safe = s.create({ task: 'read' });
    s.transition(safe.id, 'running');
    s.startAttempt(safe.id, { tool: 'sysinfo', sideEffects: false });
    const unsafe = s.create({ task: 'write' });
    s.transition(unsafe.id, 'running');
    s.startAttempt(unsafe.id, { tool: 'fs.write', sideEffects: true, idempotencyKey: 'write:unsafe' });
    const recovery = s.recoverable();
    assert.equal(recovery.find((x) => x.run.id === safe.id).action, 'resume');
    assert.equal(recovery.find((x) => x.run.id === unsafe.id).action, 'manual_review');
  });
});

describe('retryDecision', () => {
  it('requires an idempotency contract for side effects', () => {
    assert.equal(retryDecision({ sideEffects: true, status: 'unknown' }).retryable, false);
    assert.equal(retryDecision({ sideEffects: true, status: 'unknown', idempotent: true, idempotencyKey: 'k' }).retryable, true);
  });
});
