// MCP transport — stdio JSON-RPC server over the tool registry.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-mcp-'));
process.env.HOME = FAKE_HOME;
process.env.REMOTE_WORKSPACE = path.join(FAKE_HOME, 'workspace');
fs.mkdirSync(process.env.REMOTE_WORKSPACE, { recursive: true });
process.env.REMOTE_POLICY = path.join(FAKE_HOME, '.remote-agent', 'policy.json');
fs.mkdirSync(path.dirname(process.env.REMOTE_POLICY), { recursive: true });
fs.writeFileSync(process.env.REMOTE_POLICY, JSON.stringify({ version: 1, tools: { shell: 'deny', net: 'deny' } }));

const { tools: allowRegistry } = await import('../src/tools/index.js');
const { createMcpServer, argsToSchema, toolToMcpSchema, runMcpHttpServer } = await import('../src/transport/mcp.js');
const allowServer = createMcpServer({ registry: allowRegistry });

describe('MCP transport', () => {
  it('argsToSchema converts remote-agent freeform args to JSON Schema', () => {
    const s = argsToSchema({ cmd: 'string — the command', verbose: 'boolean — flag' });
    assert.equal(s.type, 'object');
    assert.deepEqual(s.properties.cmd, { type: 'string', description: 'the command' });
    assert.deepEqual(s.properties.verbose, { type: 'boolean', description: 'flag' });
    assert.deepEqual(s.required, []);
  });

  it('initialize handshake reports protocol + server info', async () => {
    const r = await allowServer.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(r.id, 1);
    assert.equal(r.result.protocolVersion, '2024-11-05');
    assert.equal(r.result.serverInfo.name, 'remote-agent');
    assert.match(r.result.serverInfo.version, /^\d+\.\d+\.\d+/);
    assert.ok(r.result.capabilities.tools);
  });

  it('tools/list returns schema-typed builtins', async () => {
    const r = await allowServer.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = r.result.tools.map((t) => t.name);
    assert.ok(names.includes('sysinfo'));
    assert.ok(names.includes('files'));
    assert.ok(names.includes('jobs'));
    assert.ok(names.includes('workflow'));
    const shell = r.result.tools.find((t) => t.name === 'shell');
    assert.equal(shell.inputSchema.type, 'object');
  });

  it('tools/call executes an allowed tool', async () => {
    const r = await allowServer.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sysinfo', arguments: {} } });
    assert.equal(r.id, 3);
    assert.equal(r.result.content.length, 1);
    assert.equal(r.result.content[0].type, 'text');
    assert.ok(!r.result.isError);
    const out = JSON.parse(r.result.content[0].text);
    assert.ok(out.platform !== undefined && out.detail !== undefined, JSON.stringify(out));
  });

  it('tools/call respects the local policy gate (shell denied)', async () => {
    const r = await allowServer.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'shell', arguments: { cmd: 'echo hi' } } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /denied by policy/);
  });

  it('tools/call on an unknown tool errors with available list', async () => {
    const r = await allowServer.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope.tool', arguments: {} } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /Unknown tool/);
  });

  it('unknown method → -32601, malformed → -32700, notifications get no reply', async () => {
    const r = await allowServer.handle({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
    assert.equal(r.error.code, -32601);
    const p = await allowServer.handle({ not: 'rpc' });
    assert.equal(p.error.code, -32700);
    const n = await allowServer.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(n, null);
  });

  it('ping round-trips', async () => {
    const r = await allowServer.handle({ jsonrpc: '2.0', id: 7, method: 'ping' });
    assert.deepEqual(r.result, {});
  });

  it('toolToMcpSchema shapes a plugin-style descriptor', () => {
    const s = toolToMcpSchema({ name: 'fs.read', description: 'read', args: { path: 'string — path' } });
    assert.equal(s.name, 'fs.read');
    assert.equal(s.inputSchema.properties.path.type, 'string');
  });

  it('HTTP transport serves JSON-RPC over POST /mcp', async () => {
    const stop = await runMcpHttpServer({ registry: allowRegistry, port: 4398 });
    try {
      const info = await fetch('http://127.0.0.1:4398/');
      assert.equal(info.status, 200);
      const infoJ = await info.json();
      assert.equal(infoJ.name, 'remote-agent');

      const r = await fetch('http://127.0.0.1:4398/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/list' }),
      });
      const j = await r.json();
      assert.equal(j.id, 100);
      assert.ok(Array.isArray(j.result.tools));
      assert.ok(j.result.tools.some((t) => t.name === 'sysinfo'));

      const bad = await fetch('http://127.0.0.1:4398/mcp', { method: 'POST', body: 'not json' });
      const bj = await bad.json();
      assert.equal(bj.error.code, -32700);
    } finally {
      await stop();
    }
  });
});
