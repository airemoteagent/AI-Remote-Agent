// Tests for the vector indexing tool (semantic memory + workspace index).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let vector;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-vector-tool-'));
const WS = path.join(TMP, 'workspace');
const STORE = path.join(TMP, 'vector-index.json');

before(async () => {
  process.env.REMOTE_WORKSPACE = WS;
  process.env.REMOTE_VECTOR_STORE = STORE;
  fs.mkdirSync(WS, { recursive: true });
  ({ vector } = await import('../src/tools/vector.js'));
});

after(() => {
  delete process.env.REMOTE_WORKSPACE;
  delete process.env.REMOTE_VECTOR_STORE;
});

describe('tools/vector', () => {
  it('remembers and searches notes semantically', async () => {
    await vector.run({ action: 'remember', text: 'the deploy server uses port 65002 for ssh' });
    await vector.run({ action: 'remember', text: 'favorite color is deep violet' });
    const r = await vector.run({ action: 'search', query: 'ssh port of the server' });
    assert.ok(r.hits.length >= 1, JSON.stringify(r));
    assert.ok(r.hits[0].text.includes('65002'), `top hit: ${r.hits[0]?.text}`);
    assert.equal(r.hits[0].source, 'note');
  });

  it('indexes workspace files and finds them by meaning', async () => {
    fs.writeFileSync(path.join(WS, 'deploy-notes.md'),
      '# Deployment notes\nRestart the nginx service with `brew services restart nginx` after a config change.');
    fs.writeFileSync(path.join(WS, 'recipes.txt'), 'Chocolate cake bakes at 180 degrees for 35 minutes.');
    const idx = await vector.run({ action: 'index' });
    assert.equal(idx.ok, true);
    assert.ok(idx.indexed >= 2, JSON.stringify(idx));

    const r = await vector.run({ action: 'search', query: 'how do I restart the web server' });
    assert.ok(r.hits.length >= 1);
    assert.equal(r.hits[0].file, 'deploy-notes.md');
  });

  it('refuses paths outside the workspace', async () => {
    const r = await vector.run({ action: 'index', path: '../../etc/passwd' });
    assert.ok(r.error);
    assert.ok(r.error.includes('Path traversal denied'));
  });

  it('reports stats and removes entries', async () => {
    const s = await vector.run({ action: 'stats' });
    assert.ok(s.entries >= 2);
    const list = await vector.run({ action: 'list', limit: 20 });
    const first = list.entries[0];
    const removed = await vector.run({ action: 'forget', id: first.id });
    assert.equal(removed.ok, true);
    const s2 = await vector.run({ action: 'stats' });
    assert.equal(s2.entries, list.total - 1);
  });
});
