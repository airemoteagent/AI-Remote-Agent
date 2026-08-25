// Delegate tool — validation + runner dispatch layer.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let delegate, configureDelegateRunner;

before(async () => {
  ({ delegate, configureDelegateRunner } = await import('../src/tools/delegate.js'));
});

describe('delegate tool — without a runner', () => {
  it('refuses with a clear error when no daemon runner is injected', async () => {
    const r = await delegate.run({ tasks: [{ id: 'a', prompt: 'hi' }] });
    assert.ok(r.error && r.error.includes('daemon'));
  });
});

describe('delegate tool — validation', () => {
  it('requires a tasks array', async () => {
    const r = await delegate.run({});
    assert.ok(r.error.includes('tasks'));
  });

  it('caps at 6 sub-tasks', async () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({ id: 't' + i, prompt: 'x' }));
    const r = await delegate.run({ tasks });
    assert.ok(r.error.includes('6'));
  });

  it('rejects malformed task entries', async () => {
    const r = await delegate.run({ tasks: [{ id: 'a' }] });
    assert.ok(r.error.includes('prompt'));
  });
});

describe('delegate tool — with a stubbed runner', () => {
  it('dispatches to the injected runner and returns results summary', async () => {
    let received = null;
    configureDelegateRunner(async (req) => {
      received = req;
      return req.tasks.map((t) => ({ id: t.id, status: 'done', answer: 'ok', steps: 1, usage: { total: 10 } }));
    });
    const r = await delegate.run({
      tasks: [{ id: 'x', prompt: 'p1' }, { id: 'y', prompt: 'p2' }],
      concurrency: 4,
    });
    assert.equal(r.delegated, 2);
    assert.equal(r.done, 2);
    assert.equal(r.failed, 0);
    assert.ok(Array.isArray(r.results));
    assert.equal(received.concurrency, 4);
    assert.equal(received.tasks.length, 2);
    configureDelegateRunner(null); // reset for other tests
  });

  it('clamps concurrency to 1..4', async () => {
    let seen = null;
    configureDelegateRunner(async (req) => { seen = req.concurrency; return []; });
    await delegate.run({ tasks: [{ id: 'a', prompt: 'p' }], concurrency: 99 });
    assert.equal(seen, 4);
    await delegate.run({ tasks: [{ id: 'a', prompt: 'p' }], concurrency: 0 });
    assert.equal(seen, 1);
    configureDelegateRunner(null);
  });

  it('counts non-done results as failures', async () => {
    configureDelegateRunner(async () => [
      { id: 'a', status: 'done', answer: 'ok' },
      { id: 'b', status: 'error', error: 'boom' },
    ]);
    const r = await delegate.run({ tasks: [{ id: 'a', prompt: 'p' }, { id: 'b', prompt: 'p' }] });
    assert.equal(r.done, 1);
    assert.equal(r.failed, 1);
    configureDelegateRunner(null);
  });

  it('surfaces runner exceptions as tool errors', async () => {
    configureDelegateRunner(async () => { throw new Error('depth limit reached'); });
    const r = await delegate.run({ tasks: [{ id: 'a', prompt: 'p' }] });
    assert.match(r.error, /depth limit/);
    configureDelegateRunner(null);
  });
});
