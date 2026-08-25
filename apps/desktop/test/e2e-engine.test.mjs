// End-to-end engine integration — the real TaskLoop drives the real tool
// registry through the real policy gate.
//
// A scripted brain walks the loop through the runtime tools: start a
// background job with `jobs`, wait for it, inspect `plugin list`, then
// answer. This proves the whole smartness chain works together the way the
// daemon uses it — TaskLoop → policy gate → registry → sandboxed tools —
// not just each piece in isolation.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-e2e-'));
process.env.HOME = FAKE_HOME;
process.env.MONA_WORKSPACE = path.join(FAKE_HOME, 'workspace');
process.env.MONA_ALLOW_CMDS = 'node,echo'; // grant the fixtures only

let tools, TaskLoop, Policy, Budget;

before(async () => {
  ({ tools } = await import('../src/tools/index.js'));
  ({ TaskLoop, Policy, Budget } = await import('@mona/engine'));
});

describe('engine → registry integration', () => {
  it('brain loop can start+wait a background job and query plugins', async () => {
    const USAGE = { input: 5, output: 5, total: 10, costUsd: 0.001 };
    let step = 0;
    let jobOk = false;
    const think = async (messages) => {
      step++;
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const content = String(lastUser?.content || '');
      if (step === 1) {
        return { text: JSON.stringify({ reasoning: 'start a background job', tool: 'jobs', args: { action: 'start', cmd: 'node -e "console.log(42)"' } }), usage: USAGE };
      }
      if (step === 2) {
        const m = content.match(/"id":"(job-\d+)"/);
        const id = m ? m[1] : 'job-1';
        return { text: JSON.stringify({ reasoning: 'wait for the job', tool: 'jobs', args: { action: 'wait', id, timeoutS: 10 } }), usage: USAGE };
      }
      if (step === 3) {
        jobOk = content.includes('42'); // last user msg = the wait tool result
        return { text: JSON.stringify({ reasoning: 'check plugin inventory', tool: 'plugin', args: { action: 'list' } }), usage: USAGE };
      }
      const pluginsVisible = content.includes('jobs'); // last user msg = plugin list result
      return {
        text: JSON.stringify({
          reasoning: 'all verified',
          answer: 'verified: ' + (jobOk ? 'job output ok' : 'job output MISSING') + (pluginsVisible ? ' · plugins visible' : ' · plugins MISSING'),
        }),
        usage: USAGE,
      };
    };

    const loop = new TaskLoop({
      think,
      runTool: (name, args) => tools.run(name, args),
      policy: new Policy(null), // safe defaults: known tools allowed
      budget: new Budget({ storePath: path.join(FAKE_HOME, 'budget.json') }),
      maxSteps: 6,
    });
    const res = await loop.run('smoke: verify background jobs and plugins work end to end', { system: 'You are a test agent.' });

    assert.equal(res.blocked, '', `loop should complete cleanly: ${res.blocked}`);
    assert.ok(res.answer.includes('job output ok'), res.answer);
    assert.ok(res.answer.includes('plugins visible'), res.answer);
    assert.ok(res.steps >= 4, 'expected tool calls + answer steps');
    assert.equal(step, 4, 'exactly the scripted steps ran');
  }, { timeout: 30_000 });
});
