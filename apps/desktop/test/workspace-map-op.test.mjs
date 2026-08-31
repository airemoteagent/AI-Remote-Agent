// The 'map' workspace operation reports RAW facts; the cloud brain derives
// structure server-side so the open-source runtime ships no understanding logic.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-wmapop-'));
process.env.REMOTE_WORKSPACE = path.join(tmp, 'base');
process.env.REMOTE_WORKSPACE_LINKS = path.join(tmp, 'links.json');

const { executeWorkspaceOperation } = await import('../src/workspace-ops.js');

const wsRoot = path.join(tmp, 'base', '.workspaces', 'ws_map');
fs.mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(wsRoot, 'README.md'), '# Mapped\n\nDemo.\n');
fs.writeFileSync(path.join(wsRoot, 'src', 'app.js'), 'export function boot() {}\nconst SECRET_BODY_TEXT = "do-not-leak";\n');

after(() => {
  delete process.env.REMOTE_WORKSPACE;
  delete process.env.REMOTE_WORKSPACE_LINKS;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('map returns raw file facts (rel/size/mtime), no derived structure', async () => {
  const r = await executeWorkspaceOperation({ op_type: 'map', workspace_id: 'ws_map', request: {} });
  assert.equal(r.status, 'succeeded', JSON.stringify(r));
  assert.equal(r.result.workspaceId, 'ws_map');
  const rels = r.result.files.map((f) => f.rel).sort();
  assert.deepEqual(rels, ['README.md', 'src/app.js']);
  for (const f of r.result.files) {
    assert.equal(typeof f.size, 'number');
    assert.equal(typeof f.mtime, 'number');
    // Facts only: the client must NOT compute languages/entry points/outlines.
    assert.ok(!('lang' in f) && !('entryPoints' in f), 'derived fields must not leave the device');
  }
  assert.ok(!('digest' in r.result), 'no digest is computed on the device');
  assert.ok(!('languages' in r.result), 'no language histogram leaves the device');
});

test('map never ships file bodies off the device', async () => {
  const r = await executeWorkspaceOperation({ op_type: 'map', workspace_id: 'ws_map', request: {} });
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes('do-not-leak'), 'file contents must never leave via the map op');
  assert.ok(!serialized.includes('export function boot'), 'symbol/body text must never leave via the map op');
});

test('map of an unknown workspace degrades to empty facts, not an error', async () => {
  const r = await executeWorkspaceOperation({ op_type: 'map', workspace_id: 'ws_missing', request: {} });
  assert.equal(r.status, 'succeeded');
  assert.deepEqual(r.result.files, []);
});

test('map still requires a workspace id', async () => {
  await assert.rejects(() => executeWorkspaceOperation({ op_type: 'map', request: {} }));
});
