import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPES, envelope, workspaceOperation, checkVersion } from '../src/index.mjs';

test('workspace protocol is additive and versioned', () => {
  const data = workspaceOperation({ opId: 'op_1', workspaceId: 'ws_1', workspaceRevision: 3, operation: 'read', payload: { path: 'src/a.js' } });
  const frame = envelope(TYPES.WORKSPACE_OPERATION, data);
  assert.equal(checkVersion(frame), true);
  assert.equal(frame.type, 'workspace.operation');
  assert.equal(frame.data.workspaceId, 'ws_1');
  assert.equal(frame.data.workspaceRevision, 3);
  assert.deepEqual(frame.data.payload, { path: 'src/a.js' });
});

test('workspace protocol rejects missing or malformed identity', () => {
  assert.throws(() => workspaceOperation({ workspaceId: 'ws_1', operation: 'read' }));
  assert.throws(() => workspaceOperation({ opId: '../x', workspaceId: 'ws_1', operation: 'read' }));
});
