// Jobs tool — policy parity: background commands must never widen the
// device policy. Two fresh module instances (fresh Policy.load() calls):
//   1. shell denied by policy      → `jobs start` refuses identically
//   2. shell allowed, approval set → commands matching shell.approval
//      are refused; others still run (through the allowlist)

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-jobs-pol-'));
process.env.HOME = FAKE_HOME;
process.env.MONA_WORKSPACE = path.join(FAKE_HOME, 'workspace');
process.env.MONA_ALLOW_CMDS = 'echo,node';

const POLICY_PATH = path.join(FAKE_HOME, '.mona-agent', 'policy.json');
const writePolicy = (obj) => {
  fs.mkdirSync(path.dirname(POLICY_PATH), { recursive: true });
  fs.writeFileSync(POLICY_PATH, JSON.stringify(obj));
};

before(() => {
  writePolicy({ version: 1, tools: { shell: 'deny' } });
});

// Module instance A — shell denied at load time.
const { jobs: denyJobs } = await import('../src/tools/jobs.js?policy=deny');

describe('jobs — policy parity: shell denied', () => {
  it('refuses start when the shell tool is denied by policy', async () => {
    const r = await denyJobs.run({ action: 'start', cmd: 'echo hello' });
    assert.ok(r.error.includes('denied by policy'), r.error);
    assert.equal(r.policy, 'deny');
  });

  it('non-start actions still work (list is not shell-gated)', async () => {
    const l = await denyJobs.run({ action: 'list' });
    assert.equal(typeof l.count, 'number');
  });
});

// Module instance B — shell allowed but approval patterns defined.
writePolicy({
  version: 1,
  tools: { shell: 'allow' },
  shell: { approval: ['git\\s+push'] },
});
const { jobs: approvalJobs } = await import('../src/tools/jobs.js?policy=approval');

describe('jobs — policy parity: approval patterns', () => {
  it('refuses a command matching a shell.approval pattern', async () => {
    const r = await approvalJobs.run({ action: 'start', cmd: 'git push origin main' });
    assert.ok(r.error, 'approval-gated command must be refused');
  });

  it('allows a non-matching command through the allowlist', async () => {
    const r = await approvalJobs.run({ action: 'start', cmd: 'echo hello' });
    assert.ok(r.id, 'plain command starts');
  });
});
