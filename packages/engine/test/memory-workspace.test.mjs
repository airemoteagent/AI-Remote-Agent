import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory.js';

test('MemoryStore partitions memories by workspace namespace', () => {
  const store = new MemoryStore({ storePath: join(mkdtempSync(join(tmpdir(), 'mem-ws-')), 'mem.json') });

  store.remember('API keys live in the vault service', { workspace: 'wsA' });
  store.remember('The build pipeline uses pnpm not npm', { workspace: 'wsB' });
  store.remember('Deployments go through a staging gate', { workspace: '' });

  // wsA recall returns its own entries, never another workspace's.
  const a = store.recall('vault keys', { workspace: 'wsA' });
  assert.ok(a.some((e) => e.text.includes('vault')));
  assert.ok(!a.some((e) => e.text.includes('pnpm')));

  const b = store.recall('pnpm build', { workspace: 'wsB' });
  assert.ok(b.some((e) => e.text.includes('pnpm')));
  assert.ok(!b.some((e) => e.text.includes('vault')));

  // Cross-workspace isolation: a query that would hit wsB returns nothing in wsA.
  assert.ok(!store.recall('pnpm', { workspace: 'wsA' }).some((e) => e.text.includes('pnpm')));

  // Unscoped recall (workspace null) still sees everything — legacy behavior.
  const all = store.recall('deployments', { workspace: null });
  assert.ok(all.some((e) => e.text.includes('staging')));
});

test('workspace memories never dedupe across workspaces', () => {
  const store = new MemoryStore({ storePath: join(mkdtempSync(join(tmpdir(), 'mem-ws2-')), 'mem.json') });
  store.remember('Use port 3000 for local dev', { workspace: 'wsA' });
  store.remember('Use port 3000 for local dev', { workspace: 'wsB' });
  assert.strictEqual(store.stats().entries, 2); // two namespaces, no cross-dedupe

  store.remember('Use port 3000 for local dev', { workspace: 'wsA' });
  assert.strictEqual(store.stats().entries, 2); // same namespace still dedupes
});

test('learnFromRun tags decision history with the workspace', () => {
  const store = new MemoryStore({ storePath: join(mkdtempSync(join(tmpdir(), 'mem-ws3-')), 'mem.json') });
  store.learnFromRun('fix the login bug', 'patched the auth flow', { outcome: 'success', workspace: 'wsA' });
  const inA = store.recall('login bug', { workspace: 'wsA' });
  assert.ok(inA.some((e) => e.tags.includes('task')));
  assert.ok(!store.recall('login bug', { workspace: 'wsB' }).some((e) => e.tags.includes('task')));
});
