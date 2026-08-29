import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let recall, configureCortex;

before(async () => {
  ({ recall, configureCortex } = await import('../src/tools/recall.js'));
});

describe('recall tool — without a cortex', () => {
  it('refuses with a clear error when no daemon cortex is injected', async () => {
    configureCortex(null);
    const r = await recall.run({ id: 'ctx_abc' });
    assert.ok(r.error && r.error.includes('daemon'));
  });
});

describe('recall tool — validation', () => {
  it('requires an id', async () => {
    configureCortex(null);
    const r = await recall.run({});
    assert.ok(r.error.includes('id required'));
  });
});

describe('recall tool — with a stubbed cortex', () => {
  const FAKE = 'line one\nline two\nline three';
  const cortex = {
    recall(id) { return id === 'ctx_known' ? FAKE : null; },
  };

  it('returns the full archived content losslessly', async () => {
    configureCortex(cortex);
    const r = await recall.run({ id: 'ctx_known' });
    assert.equal(r.text, FAKE);
    assert.equal(r.chars, FAKE.length);
    assert.equal(r.note, 'complete — this is the full archived content');
  });

  it('supports paging with start/end char offsets', async () => {
    configureCortex(cortex);
    const r = await recall.run({ id: 'ctx_known', start: 9, end: 13 });
    assert.equal(r.text, 'line');
    assert.equal(r.start, 9);
    assert.equal(r.end, 13);
    assert.ok(r.note.includes('remain'));
  });

  it('reports unknown ids as errors', async () => {
    configureCortex(cortex);
    const r = await recall.run({ id: 'ctx_unknown' });
    assert.ok(r.error.includes('no archived context'));
  });

  it('clamps out-of-range offsets safely', async () => {
    configureCortex(cortex);
    const r = await recall.run({ id: 'ctx_known', start: 0, end: 99999 });
    assert.equal(r.end, FAKE.length);
    assert.equal(r.text, FAKE);
  });
});
