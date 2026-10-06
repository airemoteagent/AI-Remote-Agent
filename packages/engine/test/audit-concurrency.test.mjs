// The audit chain must survive concurrent writers. Measured defect on this device:
// the daemon and a CLI call appended 100 ms apart, both stamped seq 901 with the
// same prev, and auditVerify() has reported "chain break @901" ever since.
//
// This test forks real processes — an in-process test would share the module-level
// auditSeq cache and could never reproduce the fork.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditWrite, auditVerify } from '../src/policy.js';

// The writer child takes the log path from the environment: it must NEVER inherit
// the default path, or a test run appends junk to the device's real audit log
// (measured: one run added 175 entries to ~/.remote-agent/audit.jsonl).
const WRITER = `
  import { auditWrite } from ${JSON.stringify(new URL('../src/policy.js', import.meta.url).href)};
  const path = process.env.AUDIT_PATH;
  if (!path || !path.includes('audit-')) throw new Error('refusing to write outside a temp log');
  for (let i = 0; i < Number(process.env.N); i++) auditWrite({ kind: 'tool', tool: 'probe', i }, path);
`;

test('concurrent processes cannot fork the chain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  const path = join(dir, 'audit.jsonl');
  const N = 25;
  const P = 6;

  // P processes, all writing at once, plus this process writing alongside them.
  const kids = Array.from({ length: P }, () => execFileSync('node', ['--input-type=module', '-e', WRITER], {
    env: { ...process.env, N: String(N), AUDIT_PATH: path }, stdio: 'ignore', timeout: 60000,
  }));
  assert.equal(kids.length, P);
  for (let i = 0; i < N; i++) auditWrite({ kind: 'tool', tool: 'self', i }, path);

  const v = auditVerify(path);
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const seqs = lines.map((l) => JSON.parse(l).seq);

  assert.equal(v.ok, true, `chain broke at ${v.brokenAt}: ${v.reason}`);
  assert.equal(lines.length, P * N + N, 'every write landed exactly once');
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'seqs are strictly increasing in file order');
  assert.equal(new Set(seqs).size, seqs.length, 'no duplicate seq (the fork signature)');
});

test('a tail read does not need the whole file in memory', () => {
  // auditWrite must recover the chain position from the tail: a 4 MB log whose
  // head is unreadable padding still appends correctly.
  const dir = mkdtempSync(join(tmpdir(), 'audit-big-'));
  const path = join(dir, 'audit.jsonl');
  auditWrite({ kind: 'tool', tool: 'seed' }, path);
  const first = JSON.parse(readFileSync(path, 'utf8').trim());
  execFileSync('node', ['-e', `
    const { appendFileSync } = require('node:fs');
    appendFileSync(${JSON.stringify(path)}, '#'.repeat(4 * 1048576) + '\\n');
  `], { timeout: 30000 });
  auditWrite({ kind: 'tool', tool: 'after-pad' }, path);
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.prev, first.hash, 'recovered the tail hash, not a stale cache');
  assert.equal(last.seq, 2);
});
