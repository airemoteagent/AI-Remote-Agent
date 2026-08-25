// Tests for the serial task queue — tasks run one at a time, in order.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let TaskQueue;

before(async () => {
  ({ TaskQueue } = await import('../src/taskqueue.js'));
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('TaskQueue', () => {
  it('runs jobs serially in arrival order', async () => {
    const q = new TaskQueue();
    const order = [];
    const done = [];
    q.enqueue({ runId: 'a', run: async () => { order.push('a-start'); await delay(30); order.push('a-end'); } });
    q.enqueue({ runId: 'b', run: async () => { order.push('b-start'); await delay(5); order.push('b-end'); } });
    q.enqueue({ runId: 'c', run: async () => { order.push('c-start'); order.push('c-end'); } });
    q.on('done', (job) => done.push(job.runId));
    await delay(150);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end']);
    assert.deepEqual(done, ['a', 'b', 'c']);
    assert.equal(q.running, false);
    assert.equal(q.size, 0);
  });

  it('reports queue position and continues after a failing job', async () => {
    const q = new TaskQueue();
    const positions = [];
    const errors = [];
    q.on('queued', ({ position }) => positions.push(position));
    q.on('error', (err) => errors.push(err.message));
    const ran = [];
    q.enqueue({ runId: 'x', run: async () => { throw new Error('boom'); } });
    q.enqueue({ runId: 'y', run: async () => { ran.push('y'); } });
    await delay(80);
    assert.deepEqual(positions, [1, 2]);
    assert.deepEqual(errors, ['boom']);
    assert.deepEqual(ran, ['y']);
    assert.equal(q.running, false);
  });

  it('cancels queued jobs and continues FIFO', async () => {
    const q = new TaskQueue();
    const cancelled = [];
    const ran = [];
    q.on('cancelled', (job) => cancelled.push(job.runId));
    q.enqueue({ runId: 'first', run: async () => { await delay(30); } });
    q.enqueue({ runId: 'skip', run: async () => { ran.push('skip'); } });
    q.enqueue({ runId: 'last', run: async () => { ran.push('last'); } });
    assert.equal(q.cancel('skip'), true);
    await delay(100);
    assert.deepEqual(cancelled, ['skip']);
    assert.deepEqual(ran, ['last']);
  });

  it('aborts a running cooperative job and waits for it to settle', async () => {
    const q = new TaskQueue();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let nextStarted = false;
    q.enqueue({ runId: 'running', run: async ({ signal }) => {
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      });
      await gate;
    } });
    q.enqueue({ runId: 'next', run: async () => { nextStarted = true; } });
    await delay(10);
    assert.equal(q.cancel('running'), true);
    await delay(10);
    assert.equal(nextStarted, false);
    release();
    await delay(40);
    assert.equal(nextStarted, true);
  });

  it('rejects jobs when the bounded queue is full', () => {
    const q = new TaskQueue({ maxSize: 1 });
    const rejected = [];
    q.on('rejected', (event) => rejected.push(event.runId));
    q.enqueue({ runId: 'one', run: async () => { await delay(20); } });
    assert.equal(q.enqueue({ runId: 'two', run: async () => {} }), false);
    assert.deepEqual(rejected, ['two']);
  });

  it('enqueuing during a run does not skip or reorder', async () => {
    const q = new TaskQueue();
    const order = [];
    q.enqueue({ runId: '1', run: async () => { order.push('1'); await delay(30); order.push('1-done'); } });
    // enqueue two more while the first is still running
    await delay(10);
    q.enqueue({ runId: '2', run: async () => { order.push('2'); } });
    q.enqueue({ runId: '3', run: async () => { order.push('3'); } });
    await delay(120);
    assert.deepEqual(order, ['1', '1-done', '2', '3']);
  });
});
