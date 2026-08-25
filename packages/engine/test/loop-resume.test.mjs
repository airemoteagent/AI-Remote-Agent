import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let TaskLoop;
before(async () => ({ TaskLoop } = await import('../src/index.mjs')));

describe('TaskLoop resume and checkpoints', () => {
  it('continues from a checkpoint without duplicating the original task', async () => {
    const seen = [];
    const loop = new TaskLoop({ think: async (messages) => { seen.push(messages); return { text: 'resumed answer' }; }, runTool: async () => ({}) });
    const result = await loop.run('original task', {
      resume: { messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'original task' }, { role: 'assistant', content: '{"tool":"sysinfo"}' }, { role: 'user', content: 'TOOL RESULT (sysinfo):\n{}' }], usage: { total: 4 }, trace: [{ kind: 'tool' }] },
    });
    assert.equal(result.answer, 'resumed answer');
    assert.equal(result.usage.total, 4);
    assert.equal(seen[0].filter((m) => m.content === 'original task').length, 1);
    assert.match(seen[0].at(-1).content, /RESUME/);
  });

  it('emits persistent checkpoint snapshots after tools and final answer', async () => {
    const snapshots = [];
    let calls = 0;
    const loop = new TaskLoop({
      think: async () => (++calls === 1 ? { text: '{"tool":"echo","args":{"v":"ok"}}' } : { text: 'done' }),
      runTool: async () => ({ ok: true }),
    });
    const result = await loop.run('task', { onCheckpoint: async (snapshot) => snapshots.push(snapshot) });
    assert.equal(result.answer, 'done');
    assert.ok(snapshots.some((s) => s.phase === 'after_tools'));
    assert.equal(snapshots.at(-1).phase, 'final');
    assert.ok(snapshots.every((s) => Array.isArray(s.messages) && Array.isArray(s.trace)));
  });
});
