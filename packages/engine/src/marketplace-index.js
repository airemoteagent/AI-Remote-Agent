// Signed plugin marketplace index.
//
// This is the trust primitive for a future marketplace, not a network client.
// Publishers create a deterministic index containing already signed plugin
// manifests, sign it with Ed25519, and consumers verify both the index and
// every plugin manifest before considering an entry installable.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { normalisePluginManifest, verifyManifest } from './plugin-manifest.js';

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function unsignedIndex(raw = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    version: 1,
    generatedAt: String(input.generatedAt || ''),
    publisher: String(input.publisher || ''),
    plugins: (Array.isArray(input.plugins) ? input.plugins : []).map((plugin) => normalisePluginManifest(plugin)),
  };
}

/** Build a deterministic, JSON-owned marketplace index payload. */
export function normaliseMarketplaceIndex(raw = {}) {
  const index = unsignedIndex(raw);
  if (!index.generatedAt) throw new TypeError('index requires generatedAt');
  if (!index.publisher) throw new TypeError('index requires publisher');
  const seen = new Set();
  for (const plugin of index.plugins) {
    const key = `${plugin.id}@${plugin.version}`;
    if (seen.has(key)) throw new TypeError(`duplicate plugin entry: ${key}`);
    seen.add(key);
  }
  return {
    ...index,
    signer: String(raw.signer || ''),
    signature: String(raw.signature || ''),
    hash: String(raw.hash || ''),
  };
}

/** Compute the index hash excluding mutable signing fields. */
export function hashMarketplaceIndex(index) {
  return createHash('sha256').update(canonicalJson(unsignedIndex(index))).digest('hex');
}

/** Sign an index with an Ed25519 private key; merge the result into the index. */
export function signMarketplaceIndex(index, privateKeyPem) {
  const normalised = normaliseMarketplaceIndex(index);
  const hash = hashMarketplaceIndex(normalised);
  const signature = sign(null, Buffer.from(hash, 'hex'), createPrivateKey(privateKeyPem)).toString('base64');
  return { hash, signature };
}

/**
 * Verify a signed index and each contained plugin manifest.
 * Plugin entries require an explicit public key lookup keyed by manifest signer.
 */
export function verifyMarketplaceIndex(index, publisherPublicKeyPem, { pluginPublicKeys = {} } = {}) {
  try {
    const normalised = normaliseMarketplaceIndex(index);
    const recomputed = hashMarketplaceIndex(normalised);
    if (!normalised.hash || normalised.hash !== recomputed) return { ok: false, reason: 'index hash mismatch', plugins: [] };
    const valid = verify(null, Buffer.from(recomputed, 'hex'), createPublicKey(publisherPublicKeyPem), Buffer.from(normalised.signature, 'base64'));
    if (!valid) return { ok: false, reason: 'invalid index signature', plugins: [] };

    const plugins = normalised.plugins.map((plugin) => {
      const publicKey = pluginPublicKeys[plugin.signer];
      const verification = publicKey ? verifyManifest(plugin, publicKey) : { ok: false, reason: `no public key for plugin signer: ${plugin.signer || '(missing)'}` };
      return { id: plugin.id, version: plugin.version, verification };
    });
    const failed = plugins.find((plugin) => !plugin.verification.ok);
    return failed
      ? { ok: false, reason: `plugin verification failed: ${failed.id}@${failed.version}: ${failed.verification.reason}`, plugins }
      : { ok: true, plugins };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), plugins: [] };
  }
}
