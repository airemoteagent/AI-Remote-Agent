import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-roots-'));
const defaultRoot = path.join(tmp, 'default');
const rootA = path.join(tmp, 'workspace-a');
const rootB = path.join(tmp, 'workspace-b');
for (const root of [defaultRoot, rootA, rootB]) fs.mkdirSync(root, { recursive: true });
process.env.REMOTE_WORKSPACE = defaultRoot;

const { files, setAgentRoots, runWithAgentRoots } = await import('../src/tools/files.js');

after(() => {
  setAgentRoots(null);
  delete process.env.REMOTE_WORKSPACE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('request-scoped roots isolate concurrent files operations', async () => {
  const gate = [];
  let release;
  const ready = new Promise((resolve) => { release = resolve; });

  const taskA = runWithAgentRoots([rootA], async () => {
    setAgentRoots([rootA]);
    gate.push('a');
    if (gate.length === 2) release();
    await ready;
    await new Promise((resolve) => setImmediate(resolve));
    return files.run({ action: 'write', path: 'same.txt', content: 'from-a' });
  });
  const taskB = runWithAgentRoots([rootB], async () => {
    setAgentRoots([rootB]);
    gate.push('b');
    if (gate.length === 2) release();
    await ready;
    return files.run({ action: 'write', path: 'same.txt', content: 'from-b' });
  });

  const [a, b] = await Promise.all([taskA, taskB]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(fs.readFileSync(path.join(rootA, 'same.txt'), 'utf8'), 'from-a');
  assert.equal(fs.readFileSync(path.join(rootB, 'same.txt'), 'utf8'), 'from-b');
  assert.equal(fs.existsSync(path.join(defaultRoot, 'same.txt')), false);

  const crossA = await runWithAgentRoots([rootA], () => files.run({ action: 'read', path: path.join(rootB, 'same.txt') }));
  const crossB = await runWithAgentRoots([rootB], () => files.run({ action: 'read', path: path.join(rootA, 'same.txt') }));
  assert.match(crossA.error, /traversal/);
  assert.match(crossB.error, /traversal/);
});
