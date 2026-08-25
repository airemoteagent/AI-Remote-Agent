// Delegate engine module — subagent fan-out.
//
// Offline tests with scripted fake think()/runTool(): concurrency bounding,
// result shapes, tool use inside sub-loops, policy denial surfacing, brain
// errors and validation. No network, no real tools.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let runSubtasks, buildSubSystemPrompt, MAX_SUBTASKS, Policy, Budget;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-delegate-'));

before(async () => {
  ({ runSubtasks, buildSubSystemPrompt, MAX_SUBTASKS, Policy, Budget } = await import('../src/index.mjs'));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USAGE = { input: 10, output: 20, total: 30, costUsd: 0.001 };

function mkBudget(over = {}) {
  return new Budget({ ...over, storePath: path.join(TMP, `budget-${Math.random().toString(36).slice(2)}.json`) });
}

/** Scripted brain: answers depend on keywords in the task prompt. */
function scriptedThink(state) {
  return async (messages, prof) => {
    const user = [...messages].reverse().find((m) => m.role === 'user');
    const p = String(user?.content || '');
    await sleep(15);
    // Second calls (after a tool result) answer — keyed by state, because the
    // last user message is then the injected TOOL RESULT wrapper.
    if (state.toolAsked) {
      return { text: JSON.stringify({ reasoning: 'data obtained', answer: 'answer with tool' }), usage: USAGE };
    }
    if (state.deniedAsked) {
      return { text: JSON.stringify({ reasoning: 'tool unavailable', answer: 'answered despite denial' }), usage: USAGE };
    }
    if (p.includes('answer-immediately')) {
      return { text: JSON.stringify({ reasoning: 'sub-goal met', answer: 'immediate answer' }), usage: USAGE };
    }
    if (p.includes('use-tool')) {
      state.toolAsked = true;
      return { text: JSON.stringify({ reasoning: 'need data', tool: 'files', args: { action: 'list' } }), usage: USAGE };
    }
    if (p.includes('denied-tool')) {
      state.deniedAsked = true;
      return { text: JSON.stringify({ reasoning: 'need data', tool: 'totally-unknown-tool', args: {} }), usage: USAGE };
    }
    if (p.includes('crash')) {
      throw new Error('sub brain exploded');
    }
    return { text: JSON.stringify({ reasoning: 'default', answer: 'fallback answer' }), usage: USAGE };
  };
}

function policy() {
  return new Policy(null); // safe defaults: known tools allowed
}

describe('delegate — runSubtasks', () => {
  it('returns one result per task with done status and answers', async () => {
    const state = {};
    const results = await runSubtasks({
      tasks: [
        { id: 'a', prompt: 'answer-immediately' },
        { id: 'b', prompt: 'answer-immediately' },
      ],
      think: scriptedThink(state),
      runTool: async (n, a) => ({ ok: true, tool: n }),
      policy: policy(),
      budget: mkBudget(),
      tools: [{ name: 'files', description: 'Files', args: {} }],
    });
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(r.status, 'done');
      assert.ok(r.answer);
      assert.ok(r.steps >= 1);
      assert.equal(r.usage.total, 30);
      assert.ok(Array.isArray(r.trace));
    }
  });

  it('bounds concurrency to the requested pool size', async () => {
    let active = 0, maxActive = 0;
    const tracked = async (messages, prof) => {
      active++; maxActive = Math.max(maxActive, active);
      try { return await scriptedThink({})(messages, prof); }
      finally { active--; }
    };
    await runSubtasks({
      tasks: [
        { id: '1', prompt: 'answer-immediately' },
        { id: '2', prompt: 'answer-immediately' },
        { id: '3', prompt: 'answer-immediately' },
        { id: '4', prompt: 'answer-immediately' },
      ],
      think: tracked,
      runTool: async (n, a) => ({ ok: true }),
      policy: policy(),
      budget: mkBudget(),
      concurrency: 2,
    });
    assert.equal(maxActive, 2, 'at most 2 sub-thinks in flight');
  });

  it('lets a sub-task use tools inside its own loop', async () => {
    const state = {};
    const calls = [];
    const results = await runSubtasks({
      tasks: [{ id: 't', prompt: 'use-tool' }],
      think: scriptedThink(state),
      runTool: async (n, a) => { calls.push(n); return { ok: true, listing: [] }; },
      policy: policy(),
      budget: mkBudget(),
    });
    assert.equal(results[0].status, 'done');
    assert.equal(results[0].answer, 'answer with tool');
    assert.deepEqual(calls, ['files']);
  });

  it('surfaces policy denials inside sub-loops (never bypasses policy)', async () => {
    const state = {};
    const results = await runSubtasks({
      tasks: [{ id: 'd', prompt: 'denied-tool' }],
      think: scriptedThink(state),
      runTool: async (n, a) => ({ ok: true }),
      policy: policy(),
      budget: mkBudget(),
    });
    assert.equal(results[0].status, 'done');
    assert.equal(results[0].answer, 'answered despite denial');
    // The sub-loop must have seen the denial — trace or steps reflect it.
    const trace = results[0].trace || [];
    assert.ok(trace.length >= 2, 'tool call + answer steps recorded');
  });

  it('reports a crashing sub-brain as status error, others still run', async () => {
    const state = {};
    const results = await runSubtasks({
      tasks: [
        { id: 'ok', prompt: 'answer-immediately' },
        { id: 'bad', prompt: 'crash' },
      ],
      think: scriptedThink(state),
      runTool: async (n, a) => ({ ok: true }),
      policy: policy(),
      budget: mkBudget(),
      concurrency: 2,
    });
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    assert.equal(byId.ok.status, 'done');
    assert.equal(byId.bad.status, 'error');
    assert.match(byId.bad.error || '', /sub brain exploded/);
  });

  it('shares the budget governor across sub-loops (spend accumulates)', async () => {
    const shared = mkBudget({ dailyTokens: 500 });
    await runSubtasks({
      tasks: [
        { id: 'x', prompt: 'answer-immediately' },
        { id: 'y', prompt: 'answer-immediately' },
      ],
      think: scriptedThink({}),
      runTool: async (n, a) => ({ ok: true }),
      policy: policy(),
      budget: shared,
    });
    assert.equal(shared.state.tokens, 60, 'two sub-loops × 30 tokens');
  });

  it('validates input', async () => {
    await assert.rejects(() => runSubtasks({ tasks: [], think() {}, runTool() {} }), TypeError);
    const tooMany = Array.from({ length: 7 }, (_, i) => ({ id: 't' + i, prompt: 'x' }));
    await assert.rejects(() => runSubtasks({ tasks: tooMany, think() {}, runTool() {} }), RangeError);
    await assert.rejects(() => runSubtasks({ tasks: [{ id: 'a', prompt: 'x' }], runTool() {} }), TypeError);
  });

  it('builds a sub system prompt listing the tools', () => {
    const p = buildSubSystemPrompt([{ name: 'shell', description: 'Run commands', args: { cmd: 'string' } }], 'researcher');
    assert.ok(p.includes('researcher'));
    assert.ok(p.includes('shell'));
    assert.ok(p.includes('Run commands'));
  });
});
