import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-b64-'));
const root = path.join(tmp, 'ws');
fs.mkdirSync(root, { recursive: true });
process.env.REMOTE_WORKSPACE = root;

const { files } = await import('../src/tools/files.js');

after(() => { delete process.env.REMOTE_WORKSPACE; fs.rmSync(tmp, { recursive: true, force: true }); });

test('write accepts base64 and read round-trips the exact bytes', async () => {
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x7f]);
  const w = await files.run({ action: 'write', path: 'img.png', content: payload.toString('base64'), encoding: 'base64' });
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.match(w.hash, /^[0-9a-f]{64}$/);
  assert.equal(w.bytes, payload.length);

  const r = await files.run({ action: 'read', path: 'img.png', encoding: 'base64' });
  assert.equal(r.encoding, 'base64');
  assert.equal(Buffer.from(r.content, 'base64').equals(payload), true);

  // Hash is over the decoded bytes, not the base64 transport string.
  assert.equal(w.hash, createHash('sha256').update(payload).digest('hex'));
});
