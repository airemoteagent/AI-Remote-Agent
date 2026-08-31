import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-wsreg-'));
process.env.REMOTE_WORKSPACE = path.join(tmp, 'base');
process.env.REMOTE_VECTOR_STORE_DIR = path.join(tmp, 'idx');

const {
  BASE, sanitizeWorkspaceId, resolveWorkspaceRoot, workspaceFolderName,
  workspaceIdentityHash, discoverLocalWorkspaces, workspaceVectorStorePath,
} = await import('../src/workspace-registry.js');

after(() => {
  delete process.env.REMOTE_WORKSPACE;
  delete process.env.REMOTE_VECTOR_STORE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('sanitizeWorkspaceId keeps only canonical folder-safe chars', () => {
  assert.equal(sanitizeWorkspaceId('ws_abc-123'), 'ws_abc-123');
  assert.equal(sanitizeWorkspaceId('..%2F..%2Fetc'), '2F2Fetc');
  assert.equal(sanitizeWorkspaceId('../../evil'), 'evil');
  assert.equal(sanitizeWorkspaceId(''), '');
});

test('resolveWorkspaceRoot maps every workspace to its own folder, never escaping BASE', () => {
  assert.equal(resolveWorkspaceRoot('ws_a'), path.join(BASE, '.workspaces', 'ws_a'));
  assert.equal(resolveWorkspaceRoot('ws_b', 'Anything here'), path.join(BASE, '.workspaces', 'ws_b'));
  // legacy "current"/"default" label maps to BASE
  assert.equal(resolveWorkspaceRoot('ws_x', 'current'), BASE);
  assert.equal(resolveWorkspaceRoot('ws_x', 'Default'), BASE);
  // empty id falls back to BASE
  assert.equal(resolveWorkspaceRoot(''), BASE);
  // traversal ids cannot escape
  assert.equal(resolveWorkspaceRoot('../../etc'), path.join(BASE, '.workspaces', 'etc'));
});

test('workspaceIdentityHash is stable per device+root and differs across inputs', () => {
  const a = workspaceIdentityHash('dev1', '/a');
  const b = workspaceIdentityHash('dev1', '/a');
  assert.equal(a, b);
  assert.notEqual(a, workspaceIdentityHash('dev2', '/a'));
  assert.notEqual(a, workspaceIdentityHash('dev1', '/b'));
  assert.match(a, /^[a-f0-9]{64}$/);
});

test('discoverLocalWorkspaces finds only canonical-named subfolders', () => {
  fs.mkdirSync(path.join(BASE, '.workspaces', 'ws_one'), { recursive: true });
  fs.mkdirSync(path.join(BASE, '.workspaces', 'ws_two'), { recursive: true });
  fs.mkdirSync(path.join(BASE, '.workspaces', 'NOT-CANONICAL name'), { recursive: true }); // space → skipped
  fs.writeFileSync(path.join(BASE, '.workspaces', 'ws_one', 'a.txt'), 'hello');

  const list = discoverLocalWorkspaces(BASE);
  const ids = list.map((w) => w.workspaceId).sort();
  assert.deepEqual(ids, ['ws_one', 'ws_two']);
  const one = list.find((w) => w.workspaceId === 'ws_one');
  assert.equal(one.fileCount, 1);
  assert.equal(one.bytes, 5);
});

test('workspaceVectorStorePath shards the index per workspace', () => {
  process.env.REMOTE_VECTOR_STORE = path.join(tmp, 'idx', 'vector-index.json');
  assert.equal(workspaceVectorStorePath(''), path.join(tmp, 'idx', 'vector-index.json'));
  assert.equal(workspaceVectorStorePath('ws_a'), path.join(tmp, 'idx', 'vector-index-ws_a.json'));
  delete process.env.REMOTE_VECTOR_STORE;
});
