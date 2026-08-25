// Plugin manifest signing, verification, and capability gating.
//
// A plugin ships a manifest (identity, version, capabilities, compatibility,
// content hash, provenance). The manifest is canonicalised and signed with
// Ed25519; the signature covers the manifest content, so any tampering breaks
// verification. Capabilities are deny-by-default: a plugin loads only when its
// declared capabilities are all granted by the runtime.

import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

// Deterministic JSON serialisation so the same manifest always hashes the same.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function stripSignatureFields(manifest) {
  const { signature, hash, signer, ...rest } = (manifest && typeof manifest === 'object' ? manifest : {});
  return rest;
}

/** Canonical content hash of a manifest (signature/hash/signer excluded). */
export function hashManifest(manifest) {
  return createHash('sha256').update(canonicalJson(stripSignatureFields(manifest))).digest('hex');
}

/** Generate an Ed25519 signing key pair (PEM). */
export function generateSigningKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/** Validate and normalise a plugin manifest's required fields. */
export function normalisePluginManifest(raw = {}) {
  const manifest = raw && typeof raw === 'object' ? raw : {};
  if (!manifest.id || !manifest.version) throw new TypeError('manifest requires id and version');
  if (!Array.isArray(manifest.capabilities)) throw new TypeError('manifest requires a capabilities array');
  if (!manifest.compatibility) throw new TypeError('manifest requires a compatibility range');
  if (!manifest.contentHash) throw new TypeError('manifest requires a contentHash');
  return {
    id: String(manifest.id),
    version: String(manifest.version),
    capabilities: manifest.capabilities.map(String),
    compatibility: String(manifest.compatibility),
    contentHash: String(manifest.contentHash),
    provenance: String(manifest.provenance || ''),
    signer: String(manifest.signer || ''),
    signature: String(manifest.signature || ''),
    hash: String(manifest.hash || ''),
  };
}

/** Sign a manifest; returns the fields to merge into the signed manifest. */
export function signManifest(manifest, privateKeyPem) {
  const hash = hashManifest(manifest);
  const signature = sign(null, Buffer.from(hash, 'hex'), createPrivateKey(privateKeyPem)).toString('base64');
  return { hash, signature };
}

/**
 * Verify a signed manifest against a public key. Returns { ok, reason }.
 * A tampered manifest fails its content-hash or signature check.
 */
export function verifyManifest(manifest, publicKeyPem) {
  try {
    const m = normalisePluginManifest(manifest);
    const recomputed = hashManifest(m);
    if (m.hash && m.hash !== recomputed) return { ok: false, reason: 'manifest hash mismatch' };
    const sig = Buffer.from(m.signature, 'base64');
    const valid = verify(null, Buffer.from(recomputed, 'hex'), createPublicKey(publicKeyPem), sig);
    return valid ? { ok: true } : { ok: false, reason: 'invalid signature' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Deny-by-default capability check. */
export function checkCapabilities(manifest, granted = []) {
  const m = normalisePluginManifest(manifest);
  const grantedSet = new Set((Array.isArray(granted) ? granted : []).map(String));
  const missing = m.capabilities.filter((c) => !grantedSet.has(c));
  if (missing.length) return { allowed: false, reason: `missing capabilities: ${missing.join(', ')}` };
  return { allowed: true, reason: '' };
}
