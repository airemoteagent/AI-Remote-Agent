// Goal tool — validation, standalone store actions, and daemon dispatch.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-goal-tool-'));
process.env.REMOTE_GOALS_STORE = path.join(TMP, 'goals.json');

let goal, configureGoalRunner;

before(async () => {
  ({ goal, configureGoalRunner } = await import('../src/tools/goal.js'));
});

describe('goal tool — validation', () => {
  it('requires an objective for start', async () => {
    const r = await goal.run({ action: 'start' });
    assert.ok(r.error.includes('objective'));
    const tooLong = await goal.run({ action: 'start', objective: 'x'.repeat(1001) });
    assert.ok(tooLong.error.includes('too long'));
  });

  it('rejects unknown actions and unknown ids', async () => {
    const bad = await goal.run({ action: 'frob' });
    assert.ok(bad.error.includes('Unknown action'));
    const missing = await goal.run({ action: 'status', id: 'nope' });
    assert.ok(missing.error.includes('No such goal'));
  });
});

describe('goal tool — without a runner', () => {
  it('start refuses when the daemon runner is not injected', async () => {
    const r = await goal.run({ action: 'start', objective: 'Ship it' });
    assert.ok(r.error && r.error.includes('daemon'));
  });

  it('status/list/abort work standalone via the store', async () => {
    // Seed the store directly (same REMOTE_GOALS_STORE file the tool reads).
    const { GoalStore } = await import('@remote-agent/engine');
    const seeded = new GoalStore({}).create({ objective: 'Standalone goal', maxRounds: 3 });
    const st = await goal.run({ action: 'status', id: seeded.id });
    assert.equal(st.status, 'active');
    assert.equal(st.objective, 'Standalone goal');
    const list = await goal.run({ action: 'list' });
    assert.ok(list.count >= 1);
    const aborted = await goal.run({ action: 'abort', id: seeded.id });
    assert.equal(aborted.status, 'aborted');
  });
});

describe('goal tool — with a runner', () => {
  it('dispatches start with objective + maxRounds and returns the goal', async () => {
    let received = null;
    configureGoalRunner({
      start: async (req) => {
        received = req;
        return { id: 'goal_1', status: 'active', roundsCompleted: 0, maxRounds: req.maxRounds, objective: req.objective };
      },
      resume: async (req) => ({ id: req.id, status: 'active', roundsCompleted: 0, maxRounds: 8 }),
    });
    const r = await goal.run({ action: 'start', objective: 'Do the thing', maxRounds: 6 });
    assert.equal(r.id, 'goal_1');
    assert.equal(received.objective, 'Do the thing');
    assert.equal(received.maxRounds, 6);
    configureGoalRunner(null);
  });

  it('clamps maxRounds to 1..16 (0 = default 8)', async () => {
    let seen = null;
    configureGoalRunner({
      start: async (req) => { seen = req.maxRounds; return { id: 'g', status: 'active', roundsCompleted: 0, maxRounds: seen, objective: 'o' }; },
      resume: async () => ({ id: 'g', status: 'active', roundsCompleted: 0, maxRounds: 8 }),
    });
    await goal.run({ action: 'start', objective: 'o', maxRounds: 99 });
    assert.equal(seen, 16);
    await goal.run({ action: 'start', objective: 'o', maxRounds: 0 });
    assert.equal(seen, 8); // 0 means "not set" → default
    await goal.run({ action: 'start', objective: 'o', maxRounds: 1 });
    assert.equal(seen, 1);
    configureGoalRunner(null);
  });

  it('resume refuses when the goal is not active or at its cap', async () => {
    const { GoalStore } = await import('@remote-agent/engine');
    const store = new GoalStore({}); // same REMOTE_GOALS_STORE file as the tool
    const aborted = store.create({ objective: 'abort me', maxRounds: 2 });
    store.abort(aborted.id);
    const r = await goal.run({ action: 'resume', id: aborted.id });
    assert.ok(r.error.includes('aborted'), r.error);

    const capped = store.create({ objective: 'cap me', maxRounds: 1 });
    store.recordRound(capped.id, { round: 1, summary: 'done once' });
    const r2 = await goal.run({ action: 'resume', id: capped.id });
    assert.ok(/cap|round/.test(r2.error), r2.error);
    configureGoalRunner(null);
  });

  it('surfaces runner failures as tool errors', async () => {
    configureGoalRunner({
      start: async () => { throw new Error('round cap reached'); },
      resume: async () => ({ id: 'x', status: 'active', roundsCompleted: 0, maxRounds: 8 }),
    });
    const r = await goal.run({ action: 'start', objective: 'boom' });
    assert.match(r.error, /round cap reached/);
    configureGoalRunner(null);
  });
});
