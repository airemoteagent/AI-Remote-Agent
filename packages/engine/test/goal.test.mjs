// Goal engine module — persistent multi-round objectives.
//
// Offline tests: GoalStore persistence + transitions, completion-marker
// parsing, round-prompt seeding and validation. No brain, no network.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let GoalStore, parseGoalMarker, buildGoalRoundPrompt, goalRoundTaskText, MAX_GOAL_ROUNDS;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-goal-'));
const storePath = (n) => path.join(TMP, `goals-${n}.json`);

before(async () => {
  ({ GoalStore, parseGoalMarker, buildGoalRoundPrompt, goalRoundTaskText, MAX_GOAL_ROUNDS } = await import('../src/index.mjs'));
});

describe('GoalStore', () => {
  it('creates a goal with id, status active and default round cap', () => {
    const s = new GoalStore({ storePath: storePath('create') });
    const g = s.create({ objective: 'Ship the release' });
    assert.ok(g.id.startsWith('goal_'));
    assert.equal(g.status, 'active');
    assert.equal(g.maxRounds, 8);
    assert.equal(g.roundsCompleted, 0);
    assert.deepEqual(g.rounds, []);
  });

  it('persists across store instances (survives restarts)', () => {
    const p = storePath('persist');
    const s1 = new GoalStore({ storePath: p });
    const g = s1.create({ objective: 'Long objective', maxRounds: 4 });
    s1.recordRound(g.id, { round: 1, summary: 'made progress', tokens: 120 });
    const s2 = new GoalStore({ storePath: p });
    const loaded = s2.get(g.id);
    assert.ok(loaded);
    assert.equal(loaded.roundsCompleted, 1);
    assert.equal(loaded.lastSummary, 'made progress');
    assert.equal(loaded.rounds[0].tokens, 120);
  });

  it('recordRound appends rounds and updates the summary', () => {
    const s = new GoalStore({ storePath: storePath('rounds') });
    const g = s.create({ objective: 'obj', maxRounds: 5 });
    s.recordRound(g.id, { round: 1, summary: 'one' });
    s.recordRound(g.id, { round: 2, summary: 'two' });
    const fresh = s.get(g.id);
    assert.equal(fresh.roundsCompleted, 2);
    assert.equal(fresh.lastSummary, 'two');
    assert.deepEqual(fresh.rounds.map((r) => r.summary), ['one', 'two']);
  });

  it('completes, aborts and blocks with reason', () => {
    const s = new GoalStore({ storePath: storePath('status') });
    const g = s.create({ objective: 'obj' });
    assert.equal(s.setStatus(g.id, { complete: true, reason: 'verified done' }).status, 'complete');
    const aborted = s.abort(s.create({ objective: 'a' }).id);
    assert.equal(aborted.status, 'aborted');
    const blocked = s.block(s.create({ objective: 'b' }).id, 'cap reached');
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.reason, 'cap reached');
  });

  it('validates objective and round caps', () => {
    const s = new GoalStore({ storePath: storePath('validate') });
    assert.throws(() => s.create({ objective: '' }), TypeError);
    assert.throws(() => s.create({ objective: '   ' }), TypeError);
    assert.throws(() => s.create({ objective: 'x'.repeat(1001) }), RangeError);
    assert.equal(s.create({ objective: 'o', maxRounds: 99 }).maxRounds, MAX_GOAL_ROUNDS);
  });

  it('list returns newest first without full round history', async () => {
    const s = new GoalStore({ storePath: storePath('list') });
    const a = s.create({ objective: 'first' });
    await new Promise((r) => setTimeout(r, 5)); // distinct updatedAt
    const b = s.create({ objective: 'second' });
    await new Promise((r) => setTimeout(r, 5));
    s.recordRound(a.id, { round: 1, summary: 'x' }); // touches a → a newest
    const items = s.list();
    assert.equal(items.length, 2);
    assert.equal(items[0].objective, 'first'); // most recently updated first
    assert.ok(!('rounds' in items[0]));
  });
});

describe('parseGoalMarker', () => {
  it('extracts complete + reason and strips the marker lines', () => {
    const r = parseGoalMarker('Did the work.\nGOAL_COMPLETE: true\nGOAL_REASON: all verified');
    assert.equal(r.complete, true);
    assert.equal(r.reason, 'all verified');
    assert.equal(r.clean, 'Did the work.');
  });

  it('defaults to incomplete when the marker is missing', () => {
    const r = parseGoalMarker('Just some progress, no marker');
    assert.equal(r.complete, false);
    assert.equal(r.clean, 'Just some progress, no marker');
  });

  it('handles case-insensitive and false markers', () => {
    assert.equal(parseGoalMarker('x\ngoal_complete: false').complete, false);
    assert.equal(parseGoalMarker('x\nGOAL_COMPLETE: True').complete, true);
  });
});

describe('buildGoalRoundPrompt', () => {
  it('seeds the objective and previous round summaries', () => {
    const s = new GoalStore({ storePath: storePath('prompt') });
    const g = s.create({ objective: 'Ship v2', maxRounds: 4 });
    s.recordRound(g.id, { round: 1, summary: 'set up CI' });
    const p = buildGoalRoundPrompt(s.get(g.id), 2);
    assert.ok(p.includes('Ship v2'));
    assert.ok(p.includes('round 2 of 4'));
    assert.ok(p.includes('set up CI'));
    assert.ok(p.includes('GOAL_COMPLETE: true|false'));
  });

  it('handles the first round with no history', () => {
    const s = new GoalStore({ storePath: storePath('prompt2') });
    const g = s.create({ objective: 'Fresh' });
    const p = buildGoalRoundPrompt(g, 1);
    assert.ok(p.includes('this is the first round'));
    assert.ok(p.includes('round 1 of 8'));
  });
});

describe('goalRoundTaskText', () => {
  it('builds the display text with the round counter', () => {
    const s = new GoalStore({ storePath: storePath('text') });
    const g = s.create({ objective: 'Polish UI', maxRounds: 3 });
    assert.equal(goalRoundTaskText(g, 2), '🎯 Polish UI (round 2/3)');
  });
});
