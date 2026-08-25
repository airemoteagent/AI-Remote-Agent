import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let RunStore, buildRunEvidence, readAuditEntries, queryAudit;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-evidence-'));
const AUDIT = path.join(TMP, 'audit.jsonl');
process.env.MONA_AUDIT = AUDIT;
const p = (name) => path.join(TMP, `${name}.json`);

before(async () => ({ RunStore, buildRunEvidence, readAuditEntries, queryAudit } = await import('../src/index.mjs')));

describe('buildRunEvidence', () => {
  it('reconstructs a complete run with approvals, attempts, checkpoints, and rollback', () => {
    const s = new RunStore({ storePath: p('runs') });
    const run = s.create({ id: 'run-ev', task: 'restart db', correlationId: 'c-1', policyRevision: 'p-3', planRevision: 'plan-1' });
    s.transition(run.id, 'planned');
    s.transition(run.id, 'awaiting_approval');
    s.approve(run.id, { actor: 'alice', decision: 'approved', note: 'ok' });
    s.transition(run.id, 'running', { checkpoint: { phase: 'before' } });
    const a = s.startAttempt(run.id, { tool: 'db.restart', sideEffects: true, idempotent: true, idempotencyKey: 'db:1' });
    s.finishAttempt(run.id, a.attempt.id, { status: 'unknown' });
    s.checkpoint(run.id, { phase: 'after' });
    s.rollback(run.id, { toIndex: 0 });

    const evidence = buildRunEvidence(s, run.id);
    assert.equal(evidence.run.id, 'run-ev');
    assert.equal(evidence.run.correlationId, 'c-1');
    assert.equal(evidence.run.policyRevision, 'p-3');
    assert.equal(evidence.approvals.length, 1);
    assert.equal(evidence.approvals[0].actor, 'alice');
    assert.equal(evidence.attempts.length, 1);
    assert.equal(evidence.attempts[0].tool, 'db.restart');
    assert.equal(evidence.checkpoints.length, 2);
    assert.equal(evidence.rollbacks.length, 1);
    assert.equal(evidence.rollbacks[0].toIndex, 0);
    assert.equal(evidence.recovery, null, 'terminal runs are not in the recoverable set');
  });

  it('returns null for an unknown run', () => {
    const s = new RunStore({ storePath: p('runs2') });
    assert.equal(buildRunEvidence(s, 'nope'), null);
  });
});

describe('readAuditEntries and queryAudit', () => {
  it('loads and verifies audit entries and filters by kind/verdict', async () => {
    const { Policy } = await import('../src/index.mjs');
    const policy = new Policy({ tools: { sysinfo: 'allow', shell: 'deny' } });
    // Policy.check writes allow/deny tool decisions to the audit log.
    policy.check('sysinfo');
    policy.check('shell', { cmd: 'rm -rf /' });

    const { entries, verification } = readAuditEntries(AUDIT);
    assert.equal(verification.ok, true);
    assert.ok(entries.length >= 2);

    const toolEntries = queryAudit(entries, { kind: 'tool' });
    assert.ok(toolEntries.length >= 2);
    const denials = queryAudit(entries, { kind: 'tool', verdict: 'deny' });
    assert.ok(denials.length >= 1);
    assert.ok(denials.every((e) => e.verdict === 'deny'));
  });
});
