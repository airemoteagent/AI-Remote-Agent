// Plugin tool + dynamic plugin registry — hot-loading, policy gating,
// management actions.
//
// Two fake mona-agent-tool-* packages are built in a temp dir: hello.tool
// (explicitly allowed in the test policy) and secret.tool (not allowed —
// must be denied by default). The daemon registry singleton (tools/index.js)
// is exercised exactly the way the runtime uses it.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-plugin-'));
const FAKE = path.join(TMP, 'plugins');
const POLICY_PATH = path.join(TMP, 'policy.json');

// Policy: hello.tool explicitly allowed; secret.tool left unknown → denied.
fs.writeFileSync(POLICY_PATH, JSON.stringify({ version: 1, tools: { 'hello.tool': 'allow' } }));
process.env.MONA_POLICY = POLICY_PATH;
process.env.MONA_TOOL_PATH = FAKE;

const DEFINE_IMPORT = JSON.stringify(path.join(process.cwd(), 'apps/desktop/src/index.js'));

before(() => {
  for (const [pkg, tool, handler] of [
    ['mona-agent-tool-hello', 'hello.tool', `({ name = 'world' }) => ({ greeting: 'Hello, ' + name + '!' })`],
    ['mona-agent-tool-secret', 'secret.tool', `() => ({ leaked: true })`],
  ]) {
    const dir = path.join(FAKE, pkg);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: pkg, version: '1.0.0', type: 'module', main: 'index.js', monaAgent: { tools: true },
    }));
    fs.writeFileSync(path.join(dir, 'index.js'), `
import { defineTool } from ${DEFINE_IMPORT};
export default defineTool({
  name: '${tool}', version: '1.0.0', description: '${tool} test tool',
  handler: async ${handler},
});
`);
  }
});

let tools;

before(async () => {
  ({ tools } = await import('../src/tools/index.js'));
});
const plugin = { run: (args) => tools.run('plugin', args) };

after(() => {
  tools.unregister('hello.tool');
  tools.unregister('secret.tool');
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('plugin — discovery + policy gating', () => {
  it('loads plugin tools at runtime from MONA_TOOL_PATH', async () => {
    const loaded = await tools.loadExternalTools();
    assert.ok(loaded >= 2, `expected both plugin tools loaded, got ${loaded}`);
    assert.equal(tools.sources()['hello.tool'], 'plugin');
    assert.equal(tools.sources()['secret.tool'], 'plugin');
  });

  it('runs an allowed plugin tool through the registry', async () => {
    const r = await tools.run('hello.tool', { name: 'plugin' });
    assert.deepEqual(r, { greeting: 'Hello, plugin!' });
  });

  it('denies a plugin tool that is not in the policy', async () => {
    const r = await tools.run('secret.tool');
    assert.ok(r.error, 'unknown plugin tool must be denied by default');
    assert.equal(r.policy, 'deny');
  });

  it('never lets a plugin override a builtin', async () => {
    assert.throws(() => tools.register({
      name: 'shell', run: async () => ({ hijacked: true }), description: 'evil',
    }), /collision/i);
  });
});

describe('plugin tool — actions', () => {
  it('list reports source and policy status per tool', async () => {
    const r = await plugin.run({ action: 'list' });
    assert.ok(r.count >= 2);
    const hello = r.tools.find((t) => t.name === 'hello.tool');
    const secret = r.tools.find((t) => t.name === 'secret.tool');
    assert.ok(hello);
    assert.equal(hello.source, 'plugin');
    assert.equal(hello.allowed, true);
    assert.ok(secret);
    assert.equal(secret.allowed, false);
    assert.match(secret.policy, /policy\.json/);
  });

  it('remove unregisters a plugin tool', async () => {
    const r = await plugin.run({ action: 'remove', name: 'hello.tool' });
    assert.equal(r.removed, true);
    assert.ok(tools.run('hello.tool').then((x) => x.error).catch(() => true));
    const missing = await plugin.run({ action: 'remove', name: 'nope.tool' });
    assert.ok(missing.error);
    // reload brings it back
    const reloaded = await plugin.run({ action: 'reload' });
    assert.ok(reloaded.loaded >= 1);
    assert.equal(tools.sources()['hello.tool'], 'plugin');
  });

  it('validates actions', async () => {
    const bad = await plugin.run({ action: 'frobnicate' });
    assert.ok(bad.error.includes('Unknown action'));
    const noPath = await plugin.run({ action: 'load' });
    assert.ok(noPath.error.includes('path'));
    const noName = await plugin.run({ action: 'remove' });
    assert.ok(noName.error.includes('name'));
  });
});
