// Tool SDK tests — defineTool validation, registry collision policy,
// schema export dialects, and external package discovery + invocation.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Isolate policy: the registry gates every call through the policy
// engine, which denies unknown tools by default. Give the test tools a
// permissive local policy BEFORE the registry module is imported.
const POLICY_HOME = mkdtempSync(join(tmpdir(), 'mona-sdk-policy-'));
writeFileSync(join(POLICY_HOME, 'policy.json'), JSON.stringify({
  version: 1,
  audit: true,
  tools: { echo: 'allow', hello: 'allow' },
}, null, 2));
process.env.MONA_POLICY = join(POLICY_HOME, 'policy.json');

const { defineTool, isTool } = await import('../src/tools/define.js');
const { ToolRegistry, discoverExternalTools } = await import('../src/tools/registry.js');

after(() => rmSync(POLICY_HOME, { recursive: true, force: true }));

describe('defineTool validation', () => {
  test('accepts a valid descriptor and freezes it', () => {
    const t = defineTool({
      name: 'fs.read',
      version: '1.0.0',
      description: 'Read a file',
      capabilities: ['fs:read'],
      sideEffects: 'none',
      idempotent: true,
      handler: async () => ({ ok: true }),
    });
    assert.ok(isTool(t));
    assert.equal(t.name, 'fs.read');
    assert.equal(t.sideEffects, 'none');
    assert.ok(Object.isFrozen(t), 'descriptor must be frozen');
    assert.equal(t.idempotent, true);
    assert.equal(t.timeoutMs, 30_000, 'default timeout');
  });

  test('rejects bad names, versions, missing handler', () => {
    assert.throws(() => defineTool({ name: '9bad', version: '1.0.0', description: 'x', handler: async () => {} }), /invalid name/);
    assert.throws(() => defineTool({ name: 'ok', version: 'one', description: 'x', handler: async () => {} }), /semver/);
    assert.throws(() => defineTool({ name: 'ok', version: '1.0.0', description: 'x' }), /handler/);
    assert.throws(() => defineTool(null), /options/);
  });

  test('runs the handler through a registry', async () => {
    const reg = new ToolRegistry();
    reg.register(defineTool({
      name: 'echo',
      version: '1.0.0',
      description: 'Echo',
      handler: async ({ v }) => ({ v }),
    }));
    const out = await reg.run('echo', { v: 'hi' });
    assert.deepEqual(out, { v: 'hi' });
    assert.ok(reg.names().includes('echo'));
  });
});

describe('registry collision policy', () => {
  test('hard error on duplicate name — never silent override', () => {
    const reg = new ToolRegistry();
    reg.register(defineTool({ name: 'dup', version: '1.0.0', description: 'a', handler: async () => ({}) }));
    assert.throws(
      () => reg.register(defineTool({ name: 'dup', version: '2.0.0', description: 'b', handler: async () => ({}) })),
      /collision/
    );
  });
});

describe('toSchemas dialects', () => {
  test('openai + anthropic shapes', () => {
    const reg = new ToolRegistry();
    reg.register(defineTool({
      name: 'fs.read',
      version: '1.0.0',
      description: 'Read a file',
      input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async () => ({}),
    }));
    const openai = reg.toSchemas('openai').find((s) => s.function?.name === 'fs.read');
    assert.ok(openai, 'openai dialect');
    assert.equal(openai.function.parameters.required[0], 'path');
    const anthropic = reg.toSchemas('anthropic').find((s) => s.name === 'fs.read');
    assert.ok(anthropic, 'anthropic dialect');
    assert.ok(anthropic.input_schema);
  });
});

describe('external tool package discovery', () => {
  const FAKE = mkdtempSync(join(tmpdir(), 'mona-tools-'));

  before(() => {
    // Simulate: node_modules/mona-agent-tool-hello with a monaAgent manifest.
    const pkgDir = join(FAKE, 'node_modules', 'mona-agent-tool-hello');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: 'mona-agent-tool-hello',
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
      monaAgent: { tools: ['hello'] },
    }));
    writeFileSync(join(pkgDir, 'index.js'), `
import { defineTool } from ${JSON.stringify(join(process.cwd(), 'apps/desktop/src/index.js'))};
export default defineTool({
  name: 'hello', version: '1.0.0', description: 'Hello',
  handler: async ({ name = 'world' }) => ({ greeting: 'Hello, ' + name + '!' }),
});
`);
  });

  after(() => rmSync(FAKE, { recursive: true, force: true }));

  test('discovers, registers and invokes an external tool with no core edits', async () => {
    const discovered = await discoverExternalTools([FAKE]);
    const hello = discovered.find((t) => t.name === 'hello');
    assert.ok(hello, 'hello tool discovered');
    assert.equal(hello.version, '1.0.0');

    const reg = new ToolRegistry();
    reg.register(hello);
    const out = await reg.run('hello', { name: 'SDK' });
    assert.deepEqual(out, { greeting: 'Hello, SDK!' });
  });
});
