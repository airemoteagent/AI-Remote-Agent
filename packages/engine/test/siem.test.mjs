import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let RunStore, Policy, toNdjson, exportAuditNdjson, exportRunEvidenceNdjson;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-siem-'));
const AUDIT = path.join(TMP, 'audit.jsonl');
process.env.REMOTE_AUDIT = AUDIT;
const p = (name) => path.join(TMP, `${name}.json`);

before(async () => ({
  RunStore, Policy, toNdjson, exportAuditNdjson, exportRunEvidenceNdjson,
} = await import('../src/index.mjs')));

describe('SIEM export', () => {
  it('serialises records as one JSON object per line', () => {
    const ndjson = toNdjson([{ a: 1 }, { b: 2 }]);
    const lines = ndjson.split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
    assert.deepEqual(JSON.parse(lines[1]), { b: 2 });
  });

  it('exports verified audit entries and filters them', () => {
    const policy = new Policy({ tools: { sysinfo: 'allow', shell: 'deny' } });
    policy.check('sysinfo');
    policy.check('shell', { cmd: 'x' });

    const all = exportAuditNdjson({ path: AUDIT });
    assert.equal(all.verification.ok, true);
    assert.ok(all.count >= 2);

    const denials = exportAuditNdjson({ path: AUDIT, filter: { kind: 'tool', verdict: 'deny' } });
    assert.ok(denials.count >= 1);
    assert.ok(denials.ndjson.split('\n').every((l) => JSON.parse(l).verdict === 'deny'));
  });

  it('exports run evidence plus a metrics/alerts summary line', () => {
    const s = new RunStore({ storePath: p('runs') });
    const run = s.create({ task: 'restart' });
    s.transition(run.id, 'running');
    s.checkpoint(run.id, { phase: 'a' });
    s.rollback(run.id, { toIndex: 0 });

    const out = exportRunEvidenceNdjson(s);
    const lines = out.ndjson.split('\n');
    assert.equal(out.count, 1);
    const summary = JSON.parse(lines[lines.length - 1]);
    assert.equal(summary._type, 'summary');
    assert.equal(summary.metrics.total, 1);
    assert.ok(Array.isArray(summary.alerts));
  });
});
