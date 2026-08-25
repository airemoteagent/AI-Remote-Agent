import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let generateSigningKeyPair, signManifest, signMarketplaceIndex, verifyMarketplaceIndex, normaliseMarketplaceIndex;
before(async () => ({ generateSigningKeyPair, signManifest, signMarketplaceIndex, verifyMarketplaceIndex, normaliseMarketplaceIndex } = await import('../src/index.mjs')));

function signedPlugin(keys) {
  const base = {
    id: 'com.example.disk-health', version: '1.0.0', capabilities: ['sysinfo.read'],
    compatibility: '>=2.0.0', contentHash: 'a'.repeat(64), provenance: 'https://example.test/provenance', signer: 'plugin-signer',
  };
  return { ...base, ...signManifest(base, keys.privateKey) };
}

describe('signed marketplace index', () => {
  it('accepts an index only when the index and every plugin are verified', () => {
    const publisher = generateSigningKeyPair();
    const pluginKeys = generateSigningKeyPair();
    const plugin = signedPlugin(pluginKeys);
    const base = { generatedAt: '2026-03-12T00:00:00.000Z', publisher: 'Mona Expert', signer: 'marketplace-signer', plugins: [plugin] };
    const index = { ...base, ...signMarketplaceIndex(base, publisher.privateKey) };

    const verified = verifyMarketplaceIndex(index, publisher.publicKey, { pluginPublicKeys: { 'plugin-signer': pluginKeys.publicKey } });
    assert.equal(verified.ok, true);
    assert.equal(verified.plugins[0].verification.ok, true);
  });

  it('fails closed on tampered index data or missing plugin signer keys', () => {
    const publisher = generateSigningKeyPair();
    const pluginKeys = generateSigningKeyPair();
    const plugin = signedPlugin(pluginKeys);
    const base = { generatedAt: '2026-03-12T00:00:00.000Z', publisher: 'Mona Expert', signer: 'marketplace-signer', plugins: [plugin] };
    const index = { ...base, ...signMarketplaceIndex(base, publisher.privateKey) };

    assert.equal(verifyMarketplaceIndex({ ...index, publisher: 'attacker' }, publisher.publicKey).ok, false);
    const noPluginKey = verifyMarketplaceIndex(index, publisher.publicKey);
    assert.equal(noPluginKey.ok, false);
    assert.match(noPluginKey.reason, /no public key/);
  });

  it('rejects duplicate plugin versions in an index', () => {
    const plugin = { id: 'plugin', version: '1.0.0', capabilities: [], compatibility: '>=1', contentHash: 'b'.repeat(64) };
    assert.throws(() => normaliseMarketplaceIndex({ generatedAt: 'now', publisher: 'publisher', plugins: [plugin, plugin] }), /duplicate plugin entry/);
  });
});
