import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-wops-'));
process.env.REMOTE_WORKSPACE = path.join(tmp, 'base');

const { executeWorkspaceOperation } = await import('../src/workspace-ops.js');

after(() => { delete process.env.REMOTE_WORKSPACE; fs.rmSync(tmp, { recursive: true, force: true }); });

test('executor rejects unknown operation types', async () => {
  const r = await executeWorkspaceOperation({ op_type: 'rm', workspace_id: 'ws_x', request: {} });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'unsupported_operation');
});

test('executor requires a workspace id', async () => {
  await assert.rejects(() => executeWorkspaceOperation({ op_type: 'read', request: { path: 'x.txt' } }));
});

test('executor sanitizes hostile workspace ids into a safe directory name', async () => {
  const r = await executeWorkspaceOperation({ op_type: 'write', workspace_id: '..%2F..%2Fetc', request: { path: 'ok.txt', content: 'hi' } });
  assert.equal(r.status, 'succeeded', JSON.stringify(r));
  assert.equal(fs.existsSync(path.join(tmp, 'ok.txt')), false); // no escape above base
  assert.equal(fs.existsSync(path.join(tmp, 'base', '.workspaces', '2F2Fetc', 'ok.txt')), true);
});

test('executor blocks path traversal in payloads', async () => {
  const r = await executeWorkspaceOperation({ op_type: 'write', workspace_id: 'ws_x', request: { path: '../evil.txt', content: 'x' } });
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(fs.existsSync(path.join(tmp, 'evil.txt')), false);
});

test('executor isolates roots per workspace (no cross-workspace writes)', async () => {
  await executeWorkspaceOperation({ op_type: 'write', workspace_id: 'ws_a', request: { path: 'a.txt', content: 'a' } });
  await executeWorkspaceOperation({ op_type: 'write', workspace_id: 'ws_b', request: { path: 'a.txt', content: 'b' } });
  assert.equal(fs.readFileSync(path.join(tmp, 'base', '.workspaces', 'ws_a', 'a.txt'), 'utf8'), 'a');
  assert.equal(fs.readFileSync(path.join(tmp, 'base', '.workspaces', 'ws_b', 'a.txt'), 'utf8'), 'b');
});
