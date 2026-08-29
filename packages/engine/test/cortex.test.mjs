import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Cortex, compactLossless, extractivePreview } from '../src/cortex.js';

describe('Cortex (lossless, content-addressed memory)', () => {
  it('stores and recalls the exact original content (lossless)', () => {
    const c = new Cortex();
    const text = 'FULL TOOL RESULT: ' + 'x'.repeat(5000);
    const { id, chars, deduped } = c.store(text, { role: 'user' });
    assert.equal(chars, text.length);
    assert.equal(deduped, false);
    assert.match(id, /^ctx_/);
    assert.equal(c.recall(id), text);
  });

  it('is content-addressed: identical content dedupes to one id', () => {
    const c = new Cortex();
    const a = c.store('same content');
    const b = c.store('same content');
    assert.equal(a.id, b.id);
    assert.equal(b.deduped, true);
    assert.equal(c.stats().entries, 1);
  });

  it('returns null for unknown ids and reports size for known ones', () => {
    const c = new Cortex();
    assert.equal(c.recall('ctx_nope'), null);
    assert.equal(c.sizeOf('ctx_nope'), null);
    const { id } = c.store('hello world');
    assert.equal(c.sizeOf(id), 'hello world'.length);
  });

  it('tracks stats (entries + total chars)', () => {
    const c = new Cortex();
    c.store('aaa');
    c.store('bbbb');
    const s = c.stats();
    assert.equal(s.entries, 2);
    assert.equal(s.chars, 7);
  });
});

describe('compactLossless', () => {
  it('does nothing when under budget', () => {
    const c = new Cortex();
    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'task' }];
    const r = compactLossless(msgs, { maxChars: 1000, cortex: c });
    assert.equal(r.compressed, false);
    assert.equal(r.stored, 0);
    assert.equal(r.messages, msgs);
  });

  it('requires a cortex', () => {
    assert.throws(() => compactLossless([{ role: 'user', content: 'x' }], { maxChars: 0 }), /cortex/);
  });

  it('archives every middle message losslessly and never drops (no-degradation invariant)', () => {
    const c = new Cortex();
    const make = (n) => `message ${n}: ` + ('data' + n).repeat(400);
    const msgs = [];
    for (let i = 0; i < 12; i++) msgs.push({ role: i % 2 ? 'user' : 'assistant', content: make(i) });
    const r = compactLossless(msgs, { maxChars: 500, cortex: c });
    assert.equal(r.compressed, true);
    assert.equal(r.dropped, 0);
    assert.equal(r.stored, 4);
    assert.ok(r.after < r.before, `after ${r.after} < before ${r.before}`);
    assert.equal(r.messages[0].content, msgs[0].content);
    assert.equal(r.messages[1].content, msgs[1].content);
    const tailStart = r.messages.length - 6;
    for (let k = 0; k < 6; k++) {
      assert.equal(r.messages[tailStart + k].content, msgs[6 + k].content, `tail verbatim at ${k}`);
    }
    for (const entry of r.ids) {
      assert.match(entry.id, /^ctx_/);
      assert.equal(c.recall(entry.id).length, entry.chars);
      assert.ok(r.messages.some((m) => m.content.includes(`recall("${entry.id}")`)), `pointer ${entry.id} present`);
    }
  });

  it('is lossless for the middle: recall(id) equals the original message content', () => {
    const c = new Cortex();
    const msgs = [];
    for (let i = 0; i < 10; i++) msgs.push({ role: 'user', content: 'UNIQUE ' + i + ' ' + 'z'.repeat(600) });
    const r = compactLossless(msgs, { maxChars: 400, cortex: c, keepHead: 2, keepTail: 2 });
    assert.equal(r.stored, 6);
    for (let i = 2; i < 8; i++) {
      const original = msgs[i].content;
      const id = r.ids[i - 2].id;
      assert.equal(c.recall(id), original, `middle message ${i} recoverable`);
    }
  });
});

describe('extractivePreview', () => {
  it('returns short text unchanged', () => {
    assert.equal(extractivePreview('short', 240), 'short');
  });
  it('caps long text and marks the omission', () => {
    const p = extractivePreview('A'.repeat(1000), 200);
    assert.ok(p.length <= 200, `preview length ${p.length}`);
    assert.ok(p.includes('archived'), 'marks that full text is archived');
    assert.ok(!p.includes('A'.repeat(500)), 'does not contain the whole text');
  });
});
