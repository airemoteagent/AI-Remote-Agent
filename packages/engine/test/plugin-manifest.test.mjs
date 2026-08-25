import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let generateSigningKeyPair, signManifest, verifyManifest, checkCapabilities, normalisePluginManifest, hashManifest;

before(async () => ({
  generateSigningKeyPair, signManifest, verifyManifest, checkCapabilities, normalisePluginManifest, hashManifest,
} = await import('../src/index.mjs')));

const baseManifest = {
  id: 'plugin.disk-cleanup',
  version: '1.2.3',
  capabilities: ['files.read', 'files.trash'],
  compatibility: '>=2.11.0',
  contentHash: 'sha256:deadbeef',
  provenance: 'github.com/remoteagent-online/remote-agent@abc123',
};

describe('plugin manifest signing', () => {
  it('round-trips a valid signature', () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const m = normalisePluginManifest(baseManifest);
    const { hash, signature } = signManifest(m, privateKey);
    const signed = { ...m, hash, signature };
    assert.equal(hashManifest(signed), hash);
    assert.deepEqual(verifyManifest(signed, publicKey), { ok: true });
  });

  it('rejects a tampered manifest (content hash + signature)', () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const m = normalisePluginManifest(baseManifest);
    const { hash, signature } = signManifest(m, privateKey);
    const tampered = { ...m, hash, signature, capabilities: ['files.read', 'files.delete-forever'] };
    assert.equal(verifyManifest(tampered, publicKey).ok, false);
  });

  it('rejects a signature from a different key', () => {
    const { privateKey: signKey } = generateSigningKeyPair();
    const { publicKey: otherKey } = generateSigningKeyPair();
    const m = normalisePluginManifest(baseManifest);
    const { hash, signature } = signManifest(m, signKey);
    assert.equal(verifyManifest({ ...m, hash, signature }, otherKey).ok, false);
  });

  it('rejects a manifest missing required fields', () => {
    assert.throws(() => normalisePluginManifest({ id: 'x' }), /id and version/);
    assert.throws(() => normalisePluginManifest({ id: 'x', version: '1', capabilities: [] }), /compatibility/);
  });
});

describe('plugin capabilities (deny-by-default)', () => {
  it('allows only when every declared capability is granted', () => {
    const m = normalisePluginManifest(baseManifest);
    assert.deepEqual(checkCapabilities(m, ['files.read', 'files.trash']), { allowed: true, reason: '' });
    assert.equal(checkCapabilities(m, ['files.read']).allowed, false);
    assert.match(checkCapabilities(m, []).reason, /files.trash/);
  });
});
