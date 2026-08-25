import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore, memoryBackend } from '../src/credentials.js';

describe('credential store', () => {
  it('round-trips through an injected backend with metadata', () => {
    const store = createCredentialStore({ homeDir: mkdtempSync(join(tmpdir(), 'mona-')), backend: memoryBackend() });
    store.save({ apiKey: 'secret', agentId: 'agent-1' });
    assert.deepEqual(store.load(), { apiKey: 'secret', agentId: 'agent-1' });
    assert.equal(store.metadata().secure, true);
    assert.equal(store.metadata().backend, 'memory');
  });

  it('rejects malformed credentials', () => {
    const store = createCredentialStore({ homeDir: mkdtempSync(join(tmpdir(), 'mona-')), backend: memoryBackend() });
    assert.throws(() => store.save({ agentId: 'x' }), /apiKey/);
  });

  it('migrates a legacy file only after secure read-back', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'mona-'));
    const legacy = join(homeDir, '.mona-agent', 'credentials.json');
    mkdirSync(join(homeDir, '.mona-agent'), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ apiKey: 'secret', agentId: 'a' }));
    const store = createCredentialStore({ homeDir, backend: memoryBackend() });
    assert.equal(store.migrateLegacy(), true);
    assert.deepEqual(store.load(), { apiKey: 'secret', agentId: 'a' });
    assert.equal(existsSync(`${legacy}.migrated`), true);
  });
});
