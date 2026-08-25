import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let VectorStore, MemoryStore, compactMessages, normaliseToolResult, embed, cosine;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-vector-'));

before(async () => {
  ({ VectorStore, MemoryStore, compactMessages, normaliseToolResult, embed, cosine } = await import('../src/index.mjs'));
});

describe('vector embedding', () => {
  it('is deterministic across calls and processes', () => {
    const a = embed('the deploy server uses port 65002 for ssh');
    const b = embed('the deploy server uses port 65002 for ssh');
    assert.equal(a.length, 256);
    for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
  });

  it('has unit L2 norm', () => {
    const v = embed('some arbitrary text to normalize');
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(n - 1) < 1e-9);
  });

  it('scores related text far above unrelated text', () => {
    const related = cosine(embed('how to restart the nginx web server'), embed('restart the nginx server service'));
    const unrelated = cosine(embed('how to restart the nginx web server'), embed('my favorite color is deep violet'));
    assert.ok(related > 0.3, `related=${related}`);
    assert.ok(unrelated < related, `unrelated=${unrelated} related=${related}`);
  });

  it('ignores stopwords so queries match content', () => {
    const a = embed('the ssh port is 65002 on the server');
    const b = embed('ssh port 65002 server');
    assert.ok(cosine(a, b) > 0.8, `cosine=${cosine(a, b)}`);
  });
});

describe('VectorStore', () => {
  it('stores, persists and reloads entries', () => {
    const p = path.join(TMP, 'vs1.json');
    const v1 = new VectorStore({ storePath: p });
    v1.add('deploy server uses port 65002 for ssh', { source: 'note' });
    v1.add('favorite color is deep violet');
    const v2 = new VectorStore({ storePath: p });
    assert.equal(v2.stats().entries, 2);
    const hits = v2.search('ssh port deploy', { limit: 3 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].text.includes('65002'), true);
    assert.equal(hits[0].meta.source, 'note');
  });

  it('merges near-duplicates instead of appending', () => {
    const p = path.join(TMP, 'vs2.json');
    const v = new VectorStore({ storePath: p });
    v.add('database user is u702975565');
    const second = v.add('database user is u702975565');
    assert.equal(second.merged, true);
    assert.equal(v.stats().entries, 1);
  });

  it('searches semantically, not just by literal words', () => {
    const p = path.join(TMP, 'vs3.json');
    const v = new VectorStore({ storePath: p });
    v.add('the agent restarted the nginx web server after the config change');
    v.add('bake a chocolate cake at 180 degrees');
    const hits = v.search('web server was down, restart it', { limit: 3 });
    assert.ok(hits.length >= 1);
    assert.ok(hits[0].text.includes('nginx'), `top hit should be the server note, got: ${hits[0]?.text}`);
  });

  it('respects TTL and removal', () => {
    const p = path.join(TMP, 'vs4.json');
    const v = new VectorStore({ storePath: p });
    const e = v.add('old secret fact', { }, { ttlDays: 1 });
    // age it past TTL by rewriting the stored createdAt
    const entry = v.entries[0];
    entry.createdAt = Date.now() - 3 * 86400000;
    v.prune();
    assert.equal(v.stats().entries, 0);
  });

  it('honors a search threshold', () => {
    const p = path.join(TMP, 'vs5.json');
    const v = new VectorStore({ storePath: p });
    v.add('quantum entanglement experiments in the lab');
    const hits = v.search('nothing at all to do with that', { limit: 5, threshold: 0.5 });
    assert.equal(hits.length, 0);
  });
});

describe('MemoryStore hybrid vector recall', () => {
  it('recalls the semantically closest entry first', () => {
    const m = new MemoryStore({ storePath: path.join(TMP, 'mem-vec1.json') });
    m.remember('The deploy server uses port 65002 for SSH.');
    m.remember('Favorite color is deep violet.');
    const hits = m.recall('ssh port server', { limit: 3 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].text.includes('65002'), true);
  });

  it('still dedupes near-identical entries', () => {
    const m = new MemoryStore({ storePath: path.join(TMP, 'mem-vec2.json') });
    m.remember('Database user is u702975565.');
    m.remember('Database user is u702975565.');
    assert.equal(m.stats().entries, 1);
  });

  it('ignores stale entries beyond TTL', () => {
    const m = new MemoryStore({ storePath: path.join(TMP, 'mem-vec3.json') });
    const e = m.remember('old secret', { ttlDays: 1 });
    e.createdAt = Date.now() - 3 * 86400000;
    assert.equal(m.recall('secret').length, 0);
  });

  it('tracks provenance and excludes revoked memories from recall', () => {
    const m = new MemoryStore({ storePath: path.join(TMP, 'mem-provenance.json') });
    const entry = m.remember('production database is atlas', { source: 'user', scope: 'project-a', confidence: 0.95, sensitivity: 'internal' });
    const hit = m.recall('production database', { limit: 1 })[0];
    assert.equal(hit.id, entry.id);
    assert.equal(hit.source, 'user');
    assert.equal(hit.scope, 'project-a');
    assert.equal(hit.confidence, 0.95);
    assert.equal(hit.sensitivity, 'internal');
    assert.equal(m.revoke(entry.id), true);
    assert.equal(m.recall('production database').length, 0);
  });

  it('permanently removes a memory when explicitly forgotten', () => {
    const storePath = path.join(TMP, 'mem-forget.json');
    const m = new MemoryStore({ storePath });
    const entry = m.remember('temporary deployment note');
    assert.equal(m.remove(entry.id), true);
    assert.equal(m.get(entry.id), null);
    assert.equal(new MemoryStore({ storePath }).get(entry.id), null);
  });

  it('loads legacy entries without stored vectors (lazy embedding)', () => {
    const p = path.join(TMP, 'mem-legacy.json');
    fs.writeFileSync(p, JSON.stringify({ entries: [{ id: 'old1', text: 'legacy note about the wifi password', tags: [], ttlDays: 30, createdAt: Date.now(), hits: 1 }] }));
    const m = new MemoryStore({ storePath: p });
    const hits = m.recall('wifi password', { limit: 3 });
    assert.equal(hits.length, 1);
    assert.ok(hits[0].text.includes('wifi'));
  });
});

describe('tool result normalization', () => {
  it('detects structured failures without trusting error-like strings', () => {
    assert.equal(normaliseToolResult({ message: 'the word error is documentation', ok: true }).failed, false);
    assert.equal(normaliseToolResult({ ok: false, message: 'denied' }).failed, true);
    assert.equal(normaliseToolResult({ exitCode: 2, stderr: 'failed' }).failed, true);
  });

  it('bounds circular and oversized results while preserving terminal evidence', () => {
    const circular = { ok: true };
    circular.self = circular;
    assert.match(normaliseToolResult(circular).text, /\[circular\]/);
    const result = normaliseToolResult({ output: 'x'.repeat(5000), error: 'permission denied', path: '/important/file' }, { maxChars: 500 });
    assert.equal(result.failed, true);
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 500);
    assert.match(result.text, /permission denied/);
    assert.match(result.text, /important\/file/);
  });
});

describe('compactMessages', () => {
  const mk = (n) => {
    const msgs = [
      { role: 'system', content: 'SYS'.repeat(40) },
      { role: 'user', content: 'the original task' },
    ];
    for (let i = 0; i < n; i++) {
      msgs.push({ role: 'assistant', content: `think step ${i}`.repeat(25) });          // ~300 chars
      msgs.push({ role: 'user', content: `TOOL RESULT (shell):\n${'x'.repeat(250)} step ${i}` }); // ~300 chars
    }
    return msgs;
  };

  it('leaves small histories untouched', () => {
    const r = compactMessages(mk(1), { maxChars: 100000 });
    assert.equal(r.compressed, false);
    assert.equal(r.messages.length, 4);
  });

  it('compresses oversized histories, keeping head and tail', () => {
    const msgs = mk(8); // ~8 × 600 chars ≈ 4800, head 136 — over a 3000 budget
    const r = compactMessages(msgs, { maxChars: 3000, keepHead: 2, keepTail: 4 });
    assert.equal(r.compressed, true);
    assert.ok(r.after <= 3000, `after=${r.after}`);
    assert.ok(r.after < r.before);
    assert.equal(r.messages[0].role, 'system');
    assert.equal(r.messages[1].content, 'the original task');
    // tail survives: the last message is still a full tool result block
    assert.equal(r.messages[r.messages.length - 1].content.startsWith('TOOL RESULT'), true);
    assert.ok(r.shortened > 0, `shortened=${r.shortened}`);
  });

  it('preserves terminal tool evidence when compressing a middle result', () => {
    const messages = mk(3);
    messages[3].content = `TOOL RESULT (shell):\n${'generic output '.repeat(80)} FINAL exitCode=1 error=permission-denied path=/important/file`;
    const r = compactMessages(messages, { maxChars: 2400, keepHead: 2, keepTail: 2, maxLen: 420 });
    const compacted = r.messages.find((m) => m.content.includes('[tool result compressed]'));
    assert.ok(compacted);
    assert.match(compacted.content, /partial evidence/);
    assert.match(compacted.content, /permission-denied/);
    assert.match(compacted.content, /important\/file/);
  });

  it('marks omitted middle turns when compression is not enough', () => {
    const msgs = mk(12);
    const r = compactMessages(msgs, { maxChars: 400, keepHead: 2, keepTail: 2 });
    assert.equal(r.compressed, true);
    assert.ok(r.dropped > 0, `dropped=${r.dropped}`);
    assert.ok(r.after < r.before);
    assert.equal(r.messages[1].content, 'the original task');
    assert.ok(r.messages.some((m) => m.content.includes('earlier turns omitted')));
  });
});
