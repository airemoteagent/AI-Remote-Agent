import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorStore } from '../src/vector.js';

test('VectorStore.search supports a workspace filter predicate', () => {
  const vs = new VectorStore({ storePath: join(mkdtempSync(join(tmpdir(), 'vec-ws-')), 'vec.json') });
  vs.add('React dashboard components render the UI', { source: 'workspace', workspace: 'wsA' });
  vs.add('Database docker compose postgres runs storage', { source: 'workspace', workspace: 'wsB' });
  vs.add('Team preference typescript everywhere', { source: 'note' });

  // wsA scope: own entries + global notes; never wsB.
  const wsAScope = (e) => { const w = e.meta?.workspace || ''; return w === '' || w === 'wsA'; };
  const a = vs.search('dashboard', { filter: wsAScope });
  assert.ok(a.some((h) => h.text.includes('dashboard')));
  assert.ok(!a.some((h) => h.text.includes('postgres')));

  const b = vs.search('postgres', { filter: (e) => { const w = e.meta?.workspace || ''; return w === '' || w === 'wsB'; } });
  assert.ok(b.some((h) => h.text.includes('postgres')));
  assert.ok(!b.some((h) => h.text.includes('dashboard')));

  // A global note surfaces inside a workspace scope.
  const global = vs.search('typescript', { filter: wsAScope });
  assert.ok(global.some((h) => h.text.includes('typescript')));

  // Strict scope excludes global notes and other workspaces.
  const strict = vs.search('typescript', { filter: (e) => (e.meta?.workspace || '') === 'wsA' });
  assert.ok(!strict.some((h) => h.text.includes('typescript')));
});
