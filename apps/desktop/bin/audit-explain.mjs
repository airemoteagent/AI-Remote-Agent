#!/usr/bin/env node
// audit-explain — say WHY the hash chain broke, with the evidence.
//
// Wiring mirrors `remote-agent audit verify` (apps/desktop/bin/remote-agent.js:391-421):
// same path resolution (argv, then REMOTE_AUDIT, then ~/.remote-agent/audit.jsonl),
// same exit code (1 when broken). READ-ONLY: it never writes, repairs, reorders or
// truncates the log — the audit log is append-only by design.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { explainChain } from '../src/audit-explain.js';

const path = process.argv[2] || process.env.REMOTE_AUDIT || join(homedir(), '.remote-agent', 'audit.jsonl');
if (!existsSync(path)) {
  console.log(`\n  No audit log: ${path}\n`);
  process.exit(0);
}

const text = readFileSync(path, 'utf8');   // one read: the daemon may append while we look
const r = explainChain(text);
const clip = (v, n = 80) => {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const h = (v) => (typeof v === 'string' && v ? v.slice(0, 16) + '…' : '(none)');

console.log(`\n  ${r.broken ? 'Audit chain BROKEN' : 'Audit chain OK'} — ${path}`);
console.log(`  entries:        ${r.entries}`);
if (!r.broken) {
  console.log(`  verdict:        intact — the chain verifies end to end${r.seqAnomalies.length ? ` (${r.seqAnomalies.length} seq anomalies)` : ''}\n`);
  process.exit(0);
}

const e = r.evidence;
console.log(`  first break:    line ${r.firstBadIndex}${r.firstBadSeq === null ? '' : ` (seq stamped ${r.firstBadSeq})`}`);
console.log(`  verdict:        ${r.verdict} — ${r.subCause}`);
if (e.firstBadKind === 'hash') {
  console.log(`  hash expected:  ${h(e.recomputedHash)} (recomputed from this record's content)`);
  console.log(`  hash on disk:   ${h(e.storedHash)} (names ${e.successorsOfStoredHash} later record(s))`);
} else if (e.firstBadKind === 'chain') {
  console.log(`  prev expected:  ${h(e.expectedPrev)} (hash of line ${r.firstBadIndex - 1})`);
  console.log(`  prev actual:    ${h(e.actualPrev)} (${e.prevTargetIndex === null
    ? 'names no record in this file — the predecessor is gone'
    : `hash of line ${e.prevTargetIndex}`})`);
  if (e.prevTargetIndex !== null) {
    console.log(`  branch:         line ${e.abandonedIndex} has no successor; its predecessor names ${e.prevTargetSuccessors} record(s)`);
  }
} else {
  console.log(`  damage:         line ${r.firstBadIndex} is not a complete record (${e.parseableRecordsAfter} complete record(s) follow it)`);
}

const lines = text.split('\n');
const show = (n) => {
  const raw = lines[n - 1] ?? '';
  try {
    const o = JSON.parse(raw);
    return `    #${n} seq=${o.seq} ${o.ts} ${o.kind || ''} ${o.tool || ''} ${o.verdict || o.action || ''} ${clip(o.reason ?? o.argsHash ?? '')}`;
  } catch { return `    #${n} ${clip(raw, 80) || '(unreadable)'}`; }
};

console.log(`  tail:           ${r.tailSelfConsistent
  ? 'self-consistent from the break on (the damage is behind it)'
  : `NOT self-consistent from the break on (${r.breaks.length} breaks in the file)`}`);
for (let n = Math.max(1, r.firstBadIndex - 3); n < r.firstBadIndex; n++) console.log(`  before ${show(n)}`);
console.log(`  BREAK  ${show(r.firstBadIndex)}`);
for (let n = r.firstBadIndex + 1; n <= Math.min(r.entries, r.firstBadIndex + 3); n++) console.log(`  after  ${show(n)}`);
console.log(`  all breaks:     ${r.breaks.map((b) => b.index).slice(0, 12).join(', ')}${r.breaks.length > 12 ? `, … (${r.breaks.length} total)` : ''}`);
console.log(`  seq anomalies:  ${r.seqAnomalies.length}${r.seqAnomalies.length ? ` (first at line ${r.seqAnomalies[0].index}: seq ${r.seqAnomalies[0].from} -> ${r.seqAnomalies[0].to})` : ''}`);
console.log(`  not modified:   this run only read the file.\n`);
process.exit(1);
