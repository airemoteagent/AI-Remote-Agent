import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-prev-'));
process.env.REMOTE_WORKSPACE = path.join(tmp, 'base');
process.env.REMOTE_PREVIEW_STATE_DIR = path.join(tmp, 'state');

const { executeWorkspaceOperation } = await import('../src/workspace-ops.js');

after(() => {
  delete process.env.REMOTE_WORKSPACE;
  delete process.env.REMOTE_PREVIEW_STATE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('preview lifecycle: start, fetch, status, stop', async () => {
  const root = path.join(tmp, 'base', '.workspaces', 'ws_p');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'server.js'),
    "const http = require('http'); http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<h1>preview-ok</h1>');}).listen(Number(process.env.PORT)||8177,'127.0.0.1');");

  const start = await executeWorkspaceOperation({ op_type: 'preview-start', workspace_id: 'ws_p', request: { command: 'node server.js', port: 8177 } });
  assert.equal(start.status, 'succeeded', JSON.stringify(start));
  assert.equal(start.result.status, 'running');
  assert.equal(start.result.port, 8177);

  const fetch = await executeWorkspaceOperation({ op_type: 'preview-fetch', workspace_id: 'ws_p', request: { port: 8177 } });
  assert.equal(fetch.status, 'succeeded', JSON.stringify(fetch));
  assert.ok(String(fetch.result.content).includes('preview-ok'));

  const status = await executeWorkspaceOperation({ op_type: 'preview-status', workspace_id: 'ws_p', request: {} });
  assert.equal(status.result.status, 'running');

  const stop = await executeWorkspaceOperation({ op_type: 'preview-stop', workspace_id: 'ws_p', request: {} });
  assert.equal(stop.result.status, 'stopped');

  const afterStop = await executeWorkspaceOperation({ op_type: 'preview-status', workspace_id: 'ws_p', request: {} });
  assert.equal(afterStop.result.status, 'stopped');
});

test('preview-start rejects non-allowlisted binaries and shell metacharacters', async () => {
  const r1 = await executeWorkspaceOperation({ op_type: 'preview-start', workspace_id: 'ws_x', request: { command: 'rm -rf /tmp', port: 8180 } });
  assert.equal(r1.status, 'failed', JSON.stringify(r1));
  assert.equal(r1.errorCode, 'preview_failed');

  const r2 = await executeWorkspaceOperation({ op_type: 'preview-start', workspace_id: 'ws_x', request: { command: 'node server.js; echo hi', port: 8181 } });
  assert.equal(r2.status, 'failed', JSON.stringify(r2));

  const r3 = await executeWorkspaceOperation({ op_type: 'preview-start', workspace_id: 'ws_x', request: { command: 'bash -c evil', port: 8182 } });
  assert.equal(r3.status, 'failed', JSON.stringify(r3));
});
