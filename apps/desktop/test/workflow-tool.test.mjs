// Workflow tool — validation + dispatch layer.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let workflow, configureWorkflowRunner;

before(async () => {
  ({ workflow, configureWorkflowRunner } = await import('../src/tools/workflow.js'));
});

const goodPhases = () => [
  { name: 'research', tasks: [{ id: 'r1', prompt: 'find facts' }] },
  { name: 'write', tasks: [{ id: 'w1', prompt: 'draft' }], context: ['research'] },
];

describe('workflow tool — validation', () => {
  it('requires phases', async () => {
    const r = await workflow.run({});
    assert.ok(r.error.includes('phases'));
  });

  it('caps at 8 phases and 6 tasks per phase', async () => {
    const tooManyPhases = Array.from({ length: 9 }, (_, i) => ({ name: `p${i}`, tasks: [{ id: 't', prompt: 'x' }] }));
    assert.ok((await workflow.run({ phases: tooManyPhases })).error.includes('8'));
    const tooManyTasks = [{ name: 'p', tasks: Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, prompt: 'x' })) }];
    assert.ok((await workflow.run({ phases: tooManyTasks })).error.includes('6'));
  });

  it('rejects duplicate names and bad context references', async () => {
    const dup = [{ name: 'a', tasks: [{ id: 't', prompt: 'x' }] }, { name: 'a', tasks: [{ id: 't', prompt: 'x' }] }];
    assert.ok((await workflow.run({ phases: dup })).error.includes('duplicate'));
    const badRef = [{ name: 'a', tasks: [{ id: 't', prompt: 'x' }], context: ['z'] }];
    assert.ok((await workflow.run({ phases: badRef })).error.includes('earlier phase'));
  });

  it('rejects tasks without a prompt', async () => {
    const bad = [{ name: 'a', tasks: [{ id: 't' }] }];
    assert.ok((await workflow.run({ phases: bad })).error.includes('prompt'));
  });
});

describe('workflow tool — dispatch', () => {
  it('refuses when no daemon runner is injected', async () => {
    const r = await workflow.run({ phases: goodPhases() });
    assert.ok(r.error && r.error.includes('daemon'));
  });

  it('dispatches phases to the runner and summarizes results', async () => {
    let received = null;
    configureWorkflowRunner(async (req) => {
      received = req;
      return {
        status: 'partial',
        phases: [{ name: 'research', status: 'done', failed: 0 }, { name: 'write', status: 'partial', failed: 1 }],
        results: {
          research: [{ id: 'r1', status: 'done', answer: 'facts' }],
          write: [{ id: 'w1', status: 'error', error: 'boom' }],
        },
      };
    });
    const r = await workflow.run({ phases: goodPhases() });
    assert.equal(received.phases.length, 2);
    assert.equal(r.status, 'partial');
    assert.equal(r.total, 2);
    assert.equal(r.done, 1);
    assert.equal(r.phases.length, 2);
    assert.ok(r.results.write);
    configureWorkflowRunner(null);
  });

  it('surfaces runner exceptions as tool errors', async () => {
    configureWorkflowRunner(async () => { throw new Error('phase barrier violated'); });
    const r = await workflow.run({ phases: goodPhases() });
    assert.match(r.error, /phase barrier/);
    configureWorkflowRunner(null);
  });
});
