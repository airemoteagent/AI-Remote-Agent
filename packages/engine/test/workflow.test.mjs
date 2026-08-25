// Workflow engine module — multi-phase orchestration.
//
// Offline tests with scripted think(): phase barrier (phase 2 only starts
// after phase 1), context injection across phases, concurrent fan-out within
// a phase, failure isolation, and validation.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let runWorkflow, validatePhases, buildPhaseContext, Policy, Budget, MAX_PHASES;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-wf-'));

before(async () => {
  ({ runWorkflow, validatePhases, buildPhaseContext, Policy, Budget, MAX_PHASES } = await import('../src/index.mjs'));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USAGE = { input: 5, output: 10, total: 15, costUsd: 0.001 };
const policy = () => new Policy(null);

function mkBudget() {
  return new Budget({ storePath: path.join(TMP, `b-${Math.random().toString(36).slice(2)}.json`) });
}

/** Scripted brain: answers based on the task prompt + injected context. */
function scriptedThink(seen) {
  return async (messages) => {
    const user = [...messages].reverse().find((m) => m.role === 'user');
    const p = String(user?.content || '');
    await sleep(15);
    if (p.includes('phaseA-summary')) {
      seen.sawContext = true;
      return { text: JSON.stringify({ reasoning: 'used context', answer: 'synthesized from phase A' }), usage: USAGE };
    }
    if (p.includes('research-topic')) {
      return { text: JSON.stringify({ reasoning: 'done', answer: 'phaseA-summary: found three sources' }), usage: USAGE };
    }
    if (p.includes('crash')) {
      throw new Error('workflow sub brain exploded');
    }
    return { text: JSON.stringify({ reasoning: 'default', answer: 'generic result' }), usage: USAGE };
  };
}

describe('runWorkflow', () => {
  it('runs phases in order and returns structured results', async () => {
    const seen = {};
    const wf = await runWorkflow({
      phases: [
        { name: 'research', tasks: [{ id: 'r1', prompt: 'research-topic x' }] },
        { name: 'synthesize', tasks: [{ id: 's1', prompt: 'write summary' }], context: ['research'] },
      ],
      think: scriptedThink(seen),
      runTool: async () => ({ ok: true }),
      policy: policy(),
      budget: mkBudget(),
    });
    assert.equal(wf.status, 'done');
    assert.equal(wf.phases.length, 2);
    assert.equal(wf.phases[0].name, 'research');
    assert.equal(wf.phases[0].status, 'done');
    assert.equal(wf.results.research[0].answer, 'phaseA-summary: found three sources');
    assert.ok(seen.sawContext, 'phase 2 sub-agent saw phase 1 results');
    assert.equal(wf.results.synthesize[0].answer, 'synthesized from phase A');
  });

  it('enforces the phase barrier — later phases run after earlier ones', async () => {
    const order = [];
    const tracked = async (messages) => {
      const user = [...messages].reverse().find((m) => m.role === 'user');
      order.push(String(user?.content || '').slice(0, 40));
      await sleep(10);
      return { text: JSON.stringify({ reasoning: 'ok', answer: 'done' }), usage: USAGE };
    };
    await runWorkflow({
      phases: [
        { name: 'a', tasks: [{ id: '1', prompt: 'A task' }] },
        { name: 'b', tasks: [{ id: '2', prompt: 'B task' }] },
      ],
      think: tracked,
      runTool: async () => ({ ok: true }),
      policy: policy(),
      budget: mkBudget(),
      concurrency: 2,
    });
    assert.ok(order[0].includes('A task'), 'phase A runs first');
    assert.ok(order[order.length - 1].includes('B task'), 'phase B runs after');
  });

  it('bounds concurrency within a phase', async () => {
    let active = 0, maxActive = 0;
    const tracked = async () => {
      active++; maxActive = Math.max(maxActive, active);
      try { await sleep(20); return { text: JSON.stringify({ reasoning: 'ok', answer: 'x' }), usage: USAGE }; }
      finally { active--; }
    };
    await runWorkflow({
      phases: [
        { name: 'fan', tasks: [
          { id: '1', prompt: 'a' }, { id: '2', prompt: 'b' }, { id: '3', prompt: 'c' }, { id: '4', prompt: 'd' },
        ], concurrency: 2 },
      ],
      think: tracked,
      runTool: async () => ({ ok: true }),
      policy: policy(),
      budget: mkBudget(),
    });
    assert.equal(maxActive, 2, 'at most 2 sub-thinks in flight inside the phase');
  });

  it('isolates failures per sub-task and still reports partial status', async () => {
    const seen = {};
    const wf = await runWorkflow({
      phases: [
        { name: 'p', tasks: [
          { id: 'good', prompt: 'research-topic fine' },
          { id: 'bad', prompt: 'crash' },
        ] },
      ],
      think: scriptedThink(seen),
      runTool: async () => ({ ok: true }),
      policy: policy(),
      budget: mkBudget(),
    });
    assert.equal(wf.status, 'partial');
    assert.equal(wf.phases[0].status, 'partial');
    assert.equal(wf.phases[0].failed, 1);
    const byId = Object.fromEntries(wf.results.p.map((r) => [r.id, r]));
    assert.equal(byId.good.status, 'done');
    assert.equal(byId.bad.status, 'error');
  });

  it('validates phases, names, tasks and context references', async () => {
    await assert.rejects(runWorkflow({ phases: [], think() {}, runTool() {} }), TypeError);
    const tooMany = Array.from({ length: 9 }, (_, i) => ({ name: `p${i}`, tasks: [{ id: 't', prompt: 'x' }] }));
    await assert.rejects(runWorkflow({ phases: tooMany, think() {}, runTool() {} }), RangeError);
    assert.throws(() => validatePhases([{ name: '', tasks: [{ id: 't', prompt: 'x' }] }]), TypeError);
    assert.throws(() => validatePhases([{ name: 'a', tasks: [{ id: 't', prompt: 'x' }] }, { name: 'a', tasks: [{ id: 't', prompt: 'x' }] }]), TypeError);
    // context can only reference earlier phases
    assert.throws(() => validatePhases([
      { name: 'a', tasks: [{ id: 't', prompt: 'x' }], context: ['b'] },
      { name: 'b', tasks: [{ id: 't', prompt: 'x' }] },
    ]), TypeError);
    assert.equal(MAX_PHASES, 8);
  });
});

describe('buildPhaseContext', () => {
  it('renders earlier phase results for injection', () => {
    const ctx = buildPhaseContext(
      { research: [{ id: 'r1', status: 'done', answer: 'found X' }] },
      ['research']
    );
    assert.ok(ctx.includes('research'));
    assert.ok(ctx.includes('found X'));
    assert.ok(ctx.includes('Results from earlier phases'));
  });

  it('returns empty for no context', () => {
    assert.equal(buildPhaseContext({}, []), '');
  });

  it('renders failures transparently', () => {
    const ctx = buildPhaseContext(
      { qa: [{ id: 't1', status: 'error', error: 'boom' }] },
      ['qa']
    );
    assert.ok(ctx.includes('boom'));
  });
});
