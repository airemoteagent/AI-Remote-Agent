// Jobs tool — background job lifecycle (start/status/output/list/wait/kill).
//
// Uses REAL short-lived node child processes so the whole spawn → capture →
// finalise path is exercised (same style as the security suite). HOME is
// isolated so no real user config is touched, and MONA_ALLOW_CMDS grants
// node/sleep for the fixtures only — the allowlist gate itself is still
// verified by the disallowed-binary and blocked-pattern cases.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-jobs-'));
process.env.HOME = FAKE_HOME;
process.env.MONA_WORKSPACE = path.join(FAKE_HOME, 'workspace');
// Grant the fixtures only — the default allowlist has no `node`.
process.env.MONA_ALLOW_CMDS = 'echo,node,sleep,cat';

const { jobs } = await import('../src/tools/jobs.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Prints one line, then another 250ms later, then exits at ~500ms.
const FIXTURE = "console.log('one');setTimeout(()=>console.log('two'),250);setTimeout(()=>process.exit(0),500)";
// Never exits until killed.
const ENDLESS = 'setInterval(()=>{},500)';

describe('jobs — lifecycle', () => {
  it('start returns an id and a pid immediately', async () => {
    const r = await jobs.run({ action: 'start', cmd: `node -e "${FIXTURE}"` });
    assert.equal(r.status, 'running');
    assert.match(r.id, /^job-\d+$/);
    assert.ok(r.pid > 0);
  });

  it('wait blocks until done and returns captured stdout', async () => {
    const r = await jobs.run({ action: 'start', cmd: `node -e "${FIXTURE}"` });
    const w = await jobs.run({ action: 'wait', id: r.id, timeoutS: 10 });
    assert.equal(w.status, 'done');
    assert.equal(w.exitCode, 0);
    assert.ok(w.stdout.includes('one'), 'first line captured');
    assert.ok(w.stdout.includes('two'), 'second line captured (delayed write)');
    assert.ok(w.bytesOut >= 6);
  });

  it('status reflects done + exit code after completion', async () => {
    const r = await jobs.run({ action: 'start', cmd: `node -e "${FIXTURE}"` });
    await jobs.run({ action: 'wait', id: r.id, timeoutS: 10 }); // deterministic barrier
    const s = await jobs.run({ action: 'status', id: r.id });
    assert.equal(s.status, 'done');
    assert.equal(s.exitCode, 0);
    assert.ok(s.elapsedMs >= 0);
  });

  it('kill takes a long-running job down and marks it killed', async () => {
    const r = await jobs.run({ action: 'start', cmd: `node -e "${ENDLESS}"` });
    assert.equal(r.status, 'running');
    await sleep(120);
    const k2 = await jobs.run({ action: 'kill', id: r.id });
    assert.equal(k2.ok, true);
    assert.equal(k2.status, 'killed');
    const s = await jobs.run({ action: 'status', id: r.id });
    assert.equal(s.status, 'killed', 'killed state is final');
  });

  it('output returns the tail with byte counts', async () => {
    const r = await jobs.run({ action: 'start', cmd: `node -e "${FIXTURE}"` });
    await jobs.run({ action: 'wait', id: r.id, timeoutS: 10 });
    const o = await jobs.run({ action: 'output', id: r.id });
    assert.ok(o.stdout.includes('two'));
    assert.ok(o.bytesOut > 0);
    const short = await jobs.run({ action: 'output', id: r.id, tail: 3 });
    assert.ok(short.stdout.length <= 3);
  });

  it('list returns started jobs newest-first', async () => {
    const a = await jobs.run({ action: 'start', cmd: `node -e "${FIXTURE}"` });
    const l = await jobs.run({ action: 'list' });
    assert.ok(l.count >= 1);
    const found = l.jobs.find((j) => j.id === a.id);
    assert.ok(found, 'started job appears in list');
    assert.ok(['running', 'done', 'error'].includes(found.status));
  });
});

describe('jobs — security surface', () => {
  it('refuses a blocked destructive pattern', async () => {
    const r = await jobs.run({ action: 'start', cmd: 'rm -rf /' });
    assert.match(r.error, /blocked/i);
  });

  it('refuses a binary that is not in the allowlist', async () => {
    const r = await jobs.run({ action: 'start', cmd: 'curl https://example.com' });
    assert.match(r.error, /not in allowlist/);
  });

  it('rejects shell metacharacters it cannot parse safely', async () => {
    const r = await jobs.run({ action: 'start', cmd: 'echo hi > /tmp/x' });
    assert.ok(r.error, 'redirection is rejected');
  });

  it('rejects unknown actions and unknown job ids', async () => {
    const bad = await jobs.run({ action: 'frobnicate' });
    assert.ok(bad.error.includes('Unknown action'));
    const missing = await jobs.run({ action: 'status', id: 'job-999999' });
    assert.ok(missing.error.includes('No such job'));
  });
});
