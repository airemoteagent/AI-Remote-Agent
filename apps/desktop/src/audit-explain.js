// Why is the audit chain broken? Evidence, not guesswork.
//
// Format authority is packages/engine/src/policy.js: `auditWrite` hashes
// JSON.stringify({ seq, ts, ...entry, prev }) with sha256 and appends
// JSON.stringify({ ...record, hash }); `auditVerify` rebuilds that same string.
// The canonicalisation below is that expression verbatim — checked byte-identical
// against every record of the live log (~/.remote-agent/audit.jsonl, 7,048 lines,
// 0 self-hash mismatches), so the first-bad index here matches `audit verify`.
//
// Three things can break a hash chain, and they leave different marks:
//   • an entry whose stored hash ≠ hash(its own content)  -> REWRITE (mutated in place)
//   • a partial final record (no trailing newline)        -> TRUNCATION (tail lost)
//   • a `prev` that names a record which is not its predecessor -> SPLICE/COPY seam
// Anything the evidence does not distinguish is reported UNKNOWN *with* that evidence.

import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The exact string policy.js hashes for a record (key order included). */
const canonical = (rec) => {
  const { hash, ...rest } = rec;          // the hash field is not part of what was hashed
  return JSON.stringify({ seq: rec.seq, ts: rec.ts, ...rest, prev: rec.prev });
};

/** text | entries -> records; unparseable lines become null in place. */
function normalize(input) {
  const raw = Array.isArray(input) ? input.slice() : String(input).split('\n');
  if (!Array.isArray(input) && raw[raw.length - 1] === '') raw.pop();   // trailing newline, not an entry
  const recs = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (!item.trim()) continue;                                       // blank filler line
      try { recs.push(JSON.parse(item)); } catch { recs.push(null); }
    } else if (item) recs.push(item);
  }
  return recs;
}

/** Do the records after `i` chain to one another (index 0-based, exclusive)? */
function tailChains(recs, i) {
  for (let j = i + 1; j < recs.length; j++) {
    if (!recs[j] || !recs[j - 1] || recs[j].prev !== recs[j - 1].hash) return false;
  }
  return true;
}

/**
 * Explain the first break in a hash-chained audit log.
 *
 * @param {string|object[]} input  raw file text, or an array of entries/record objects
 * @param {{hashFn?: (canonicalLine: string) => string}} [opts]
 * @returns {{
 *   broken: boolean, entries: number,
 *   firstBadIndex: number|null, firstBadSeq: number|null,
 *   verdict: 'TRUNCATION'|'REWRITE'|'SPLICE/COPY'|'UNKNOWN'|null, subCause: string|null,
 *   evidence: object, tailSelfConsistent: boolean,
 *   breaks: {index:number,seq:number|null,kind:string}[], seqAnomalies: {index:number,from:number,to:number}[]
 * }}
 */
export function explainChain(input, { hashFn = sha256 } = {}) {
  const text = typeof input === 'string';
  const recs = normalize(input);

  const owner = new Map();      // hash -> 1-based line of the first record carrying it
  const successors = new Map();  // hash -> how many records name it as prev
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    if (r.hash && !owner.has(r.hash)) owner.set(r.hash, i + 1);
    successors.set(r.prev, (successors.get(r.prev) || 0) + 1);
  }

  // Walk the whole file (not just to the first break): the tail's state is evidence too.
  const breaks = [];
  const seqAnomalies = [];
  let prev = '';
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    // `seq` is not a hash-checked field, so it is evidence only, never a verdict — but it is
    // the one witness a whole-line deletion leaves behind (a gap) and a fork leaves (a repeat).
    if (i > 0 && r && recs[i - 1] && typeof r.seq === 'number' && typeof recs[i - 1].seq === 'number'
        && r.seq !== recs[i - 1].seq + 1) {
      seqAnomalies.push({ index: i + 1, from: recs[i - 1].seq, to: r.seq });
    }
    if (!r) { breaks.push({ index: i + 1, seq: null, kind: 'parse' }); continue; }
    const recomputed = hashFn(canonical(r));
    if (r.hash !== recomputed) {
      breaks.push({ index: i + 1, seq: r.seq ?? null, kind: 'hash', storedHash: r.hash, recomputedHash: recomputed });
    } else if (r.prev !== prev) {
      breaks.push({ index: i + 1, seq: r.seq ?? null, kind: 'chain', expectedPrev: prev, actualPrev: r.prev });
    }
    prev = r.hash;
  }

  const head = breaks[0];
  const base = {
    broken: breaks.length > 0,
    entries: recs.length,
    firstBadIndex: head ? head.index : null,
    firstBadSeq: head ? head.seq : null,
    verdict: null,
    subCause: null,
    evidence: {},
    tailSelfConsistent: head ? tailChains(recs, head.index - 1) : true,
    breaks: breaks.map((b) => ({ index: b.index, seq: b.seq, kind: b.kind })),
    seqAnomalies,
  };
  if (!head) return base;
  if (text) base.evidence.fileEndsWithNewline = String(input).endsWith('\n');
  base.evidence.firstBadKind = head.kind;

  // ── a line that is not a record ──────────────────────────────────
  if (head.kind === 'parse') {
    const after = recs.slice(head.index).filter(Boolean).length;
    Object.assign(base.evidence, { index: head.index, lineIsLast: head.index === recs.length, parseableRecordsAfter: after });
    if (head.index === recs.length) {
      base.verdict = 'TRUNCATION';
      base.subCause = 'partial-final-record';   // the tail was cut mid-append: no complete record is lost
    } else {
      // Records follow the damage, so the file was appended to after it — a partial
      // write and a cut-and-rejoin are indistinguishable from the bytes alone.
      base.verdict = 'UNKNOWN';
      base.subCause = 'damaged-record-with-valid-records-after';
    }
    return base;
  }

  // ── an entry that does not hash to its own stored hash ───────────
  if (head.kind === 'hash') {
    Object.assign(base.evidence, {
      index: head.index, seq: head.seq,
      storedHash: head.storedHash, recomputedHash: head.recomputedHash,
      successorsOfStoredHash: successors.get(head.storedHash) || 0,
    });
    base.verdict = 'REWRITE';
    base.subCause = 'content-hash-mismatch';
    return base;
  }

  // ── a prev that names the wrong record ───────────────────────────
  const back = recs[head.index - 2] || null;                 // the record that should have been named
  const target = owner.get(head.actualPrev) ?? null;          // where this prev actually points
  Object.assign(base.evidence, {
    index: head.index, seq: head.seq,
    expectedPrev: head.expectedPrev, actualPrev: head.actualPrev,
    prevTargetIndex: target,
    prevTargetSuccessors: target ? successors.get(head.actualPrev) || 0 : 0,
    abandonedIndex: back ? head.index - 1 : null,
    abandonedIsDeadEnd: back ? (successors.get(back.hash) || 0) === 0 : null,
  });

  if (target !== null && target > head.index) {
    base.verdict = 'SPLICE/COPY';
    base.subCause = 'prev-points-forward';                    // this record continues a later segment
  } else if (target !== null && target < head.index - 1) {
    base.verdict = 'SPLICE/COPY';
    // Two records name the same predecessor and the earlier one leads nowhere:
    // two writers read one tail (policy.js:233) or a segment was re-joined.
    base.subCause = base.evidence.prevTargetSuccessors > 1 && base.evidence.abandonedIsDeadEnd
      ? 'fork-duplicate-prev'
      : 'segment-joined-to-earlier-entry';
  } else if (head.actualPrev === '') {
    base.verdict = 'SPLICE/COPY';
    base.subCause = 'fresh-head-mid-file';                    // a second file's first record
  } else if (target === null) {
    // The named predecessor is nowhere in the file: a record between them is gone.
    base.verdict = 'SPLICE/COPY';
    base.subCause = 'cut-missing-predecessor';
  } else {
    base.verdict = 'UNKNOWN';
    base.subCause = 'unattributable-prev-mismatch';
  }
  return base;
}
