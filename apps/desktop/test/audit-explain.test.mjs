// audit-explain — every verdict, on fixtures built here. Asserts on returned values,
// never on printed text. The fixtures restate the wire format independently of
// audit-explain (same expression as policy.js:312): if the module's canonicalisation
// drifts, these fixtures stop verifying and that failure is the point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { explainChain } from '../src/audit-explain.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');       // the product's hasher — fixtures' default
const H = (s) => 'h' + sha(s);                                         // an injected hasher, for the option test

const body = (e, prev) => { const { hash, ...rest } = e; return JSON.stringify({ seq: rest.seq, ts: rest.ts, ...rest, prev }); };
const seal = (e, prev, hashFn) => { const b = body(e, prev); return { ...JSON.parse(b), hash: hashFn(b) }; };

/** A clean, contiguous chain of n entries. */
const chain = (n, hashFn = sha) => {
  const out = []; let prev = '';
  for (let seq = 1; seq <= n; seq++) {
    const rec = seal({ seq, ts: `2026-01-01T00:00:0${seq % 10}.000Z`, kind: 'tool', tool: 'shell', verdict: 'allow' }, prev, hashFn);
    out.push(rec); prev = rec.hash;
  }
  return out;
};
/** Rewrite one entry's prev and re-seal it: the record stays self-consistent. */
const relink = (rec, prev, hashFn = sha) => { const b = body(rec, prev); return { ...JSON.parse(b), hash: hashFn(b) }; };
/** Re-seal everything from `from` on so the suffix chains again (a re-joined segment). */
const reseal = (recs, from) => { for (let i = from; i < recs.length; i++) recs[i] = relink(recs[i], recs[i - 1].hash); return recs; };
const text = (recs) => recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

test('intact chain reports broken=false (the negative)', () => {
  const r = explainChain(text(chain(5)));
  assert.equal(r.broken, false);
  assert.equal(r.entries, 5);
  assert.equal(r.firstBadIndex, null);
  assert.equal(r.firstBadSeq, null);
  assert.equal(r.verdict, null);
  assert.equal(r.subCause, null);
  assert.deepEqual(r.breaks, []);
  assert.deepEqual(r.seqAnomalies, []);
  assert.equal(r.tailSelfConsistent, true);
  assert.deepEqual(r.evidence, {});            // nothing claimed without a break
});

test('REWRITE: an entry whose own hash no longer matches its content', () => {
  const recs = chain(5);
  recs[2] = { ...recs[2], verdict: 'deny' };   // mutated after the hash was computed
  const r = explainChain(text(recs));
  assert.equal(r.broken, true);
  assert.equal(r.firstBadIndex, 3);
  assert.equal(r.firstBadSeq, 3);
  assert.equal(r.verdict, 'REWRITE');
  assert.equal(r.subCause, 'content-hash-mismatch');
  assert.notEqual(r.evidence.storedHash, r.evidence.recomputedHash);
  assert.equal(r.evidence.storedHash, chain(5)[2].hash); // the pre-mutation hash is still on disk
  assert.equal(r.evidence.successorsOfStoredHash, 1);    // entry 4 still trusts the stored hash
  assert.equal(r.breaks.length, 1);                      // a rewrite breaks exactly one link
});

test('SPLICE/COPY: entries 3-4 cut out of the chain, entry 5 re-pointed at entry 2', () => {
  const recs = chain(7);
  recs[4] = relink(recs[4], recs[1].hash);     // entry 5 now names entry 2, which is in the file — elsewhere
  reseal(recs, 5);                             // the suffix (6,7) was rebuilt on top of the re-pointed entry
  const r = explainChain(text(recs));
  assert.equal(r.broken, true);
  assert.equal(r.firstBadIndex, 5);
  assert.equal(r.verdict, 'SPLICE/COPY');
  assert.equal(r.subCause, 'fork-duplicate-prev');
  assert.equal(r.evidence.expectedPrev, recs[3].hash);   // entry 4 is the true predecessor
  assert.equal(r.evidence.actualPrev, recs[1].hash);     // entry 2 is what it names
  assert.equal(r.evidence.prevTargetIndex, 2);           // ...and entry 2 is at line 2 of this file
  assert.equal(r.evidence.prevTargetSuccessors, 2);      // entries 3 and 5 both name entry 2
  assert.equal(r.evidence.abandonedIndex, 4);
  assert.equal(r.evidence.abandonedIsDeadEnd, true);     // the 3-4 branch leads nowhere
  assert.equal(r.tailSelfConsistent, true);              // entries 6-7 are an intact segment
});

test('SPLICE/COPY cut: the named predecessor is gone from the file', () => {
  const recs = chain(7);
  const cut = [recs[0], recs[1], recs[5], recs[6]];      // entries 3-5 physically removed
  const r = explainChain(text(cut));
  assert.equal(r.broken, true);
  assert.equal(r.firstBadIndex, 3);
  assert.equal(r.verdict, 'SPLICE/COPY');
  assert.equal(r.subCause, 'cut-missing-predecessor');
  assert.equal(r.evidence.actualPrev, recs[4].hash);     // names entry 5...
  assert.equal(r.evidence.prevTargetIndex, null);        // ...which exists nowhere in this file
  assert.equal(r.tailSelfConsistent, true);              // entries 6-7 still chain to each other
});

test('TRUNCATION: the tail is cut mid-record and every complete entry verifies', () => {
  const recs = chain(5);
  const cut = text(recs.slice(0, 4)) + JSON.stringify(recs[4]).slice(0, 60);  // no trailing newline
  const r = explainChain(cut);
  assert.equal(r.broken, true);
  assert.equal(r.firstBadIndex, 5);
  assert.equal(r.firstBadSeq, null);                     // the partial line has no readable seq
  assert.equal(r.verdict, 'TRUNCATION');
  assert.equal(r.subCause, 'partial-final-record');
  assert.equal(r.evidence.lineIsLast, true);
  assert.equal(r.evidence.parseableRecordsAfter, 0);
  assert.equal(r.evidence.fileEndsWithNewline, false);
  assert.equal(r.evidence.firstBadKind, 'parse');
  assert.equal(r.tailSelfConsistent, true);              // nothing follows the break, and 1-4 are clean
});

test('UNKNOWN: a damaged record with valid records after it', () => {
  const recs = chain(5);
  const lines = [JSON.stringify(recs[0]), JSON.stringify(recs[1]), JSON.stringify(recs[2]).slice(0, 70),
                 JSON.stringify(recs[3]), JSON.stringify(recs[4])];
  const r = explainChain(lines.join('\n') + '\n');
  assert.equal(r.broken, true);
  assert.equal(r.firstBadIndex, 3);
  assert.equal(r.verdict, 'UNKNOWN');                    // a partial write and a cut+rejoin look alike here
  assert.equal(r.subCause, 'damaged-record-with-valid-records-after');
  assert.equal(r.evidence.lineIsLast, false);
  assert.equal(r.evidence.parseableRecordsAfter, 2);     // the proof it was appended to after the damage
});

test('a whole-line deletion that leaves a valid chain is invisible to hashes — and is reported as such', () => {
  const recs = chain(5);
  const five = relink(recs[4], recs[1].hash);            // entry 5 re-pointed at entry 2 (as the task's fixture says)
  const r = explainChain(text([recs[0], recs[1], five])); // ...and entries 3-4 physically gone
  assert.equal(r.broken, false);                         // no hash can show it: prev is adjacent again
  assert.equal(r.verdict, null);
  assert.deepEqual(r.seqAnomalies, [{ index: 3, from: 2, to: 5 }]);  // the seq counter is the only witness
});

test('hashFn is the injected one, and the default is sha256 of the canonical line', () => {
  const prefixed = text(chain(5, H));
  assert.equal(explainChain(prefixed, { hashFn: H }).broken, false);
  assert.equal(explainChain(prefixed).verdict, 'REWRITE');   // sha256 does not produce 'h…' hashes
  assert.equal(explainChain(prefixed).firstBadIndex, 1);
  assert.equal(explainChain(text(chain(5, sha))).broken, false);   // the product's hasher, unmodified
  assert.equal(explainChain(chain(5, sha)).broken, false);         // array input, not only text
});
