// Device & identity lifecycle registry.
//
// DeviceRegistry owns enrollment, credential rotation, revocation, inventory,
// and health for the device fleet. It persists only owned JSON data through
// atomic 0600 writes, stores credential *hashes* (never the secret), enforces
// tenant scoping on every query, and writes each enrollment/rotation/revocation
// to the shared hash-chained audit log.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { auditWrite } from './policy.js';

const DEFAULT_STORE = process.env.REMOTE_DEVICES_STORE || join(homedir(), '.remote-agent', 'devices.json');
const MAX_DEVICES = 10000;

export const DEVICE_HEALTH = Object.freeze(['online', 'degraded', 'offline']);

function nowIso() { return new Date().toISOString(); }
function deviceId() { return `dev_${randomBytes(16).toString('hex')}`; }

/** One-way hash of a credential so the registry never stores the secret. */
export function hashCredential(secret) {
  return createHash('sha256').update(String(secret ?? '')).digest('hex');
}

const IDENTITY_CONTEXT = 'remote-agent-device-identity-v1';
const CREDENTIAL_BYTES = 32;

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function fingerprint(publicKey) {
  return createHash('sha256').update(publicKey).digest('hex');
}
function validFutureTimestamp(value) {
  if (!value) return true;
  return Number.isFinite(Date.parse(value));
}

/** Generate an Ed25519 identity. Private material is returned only to the caller. */
export function generateDeviceIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  return {
    algorithm: 'Ed25519',
    publicKey: publicKeyPem,
    deviceFingerprint: fingerprint(publicKeyPem),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export function signEnrollment(payload, privateKey) {
  if (!payload || typeof payload !== 'object') throw new TypeError('payload is required');
  return sign(null, Buffer.from(`${IDENTITY_CONTEXT}.${canonical(payload)}`), createPrivateKey(privateKey)).toString('base64url');
}

export function verifyEnrollment(payload, signature, publicKey) {
  try {
    return verify(null, Buffer.from(`${IDENTITY_CONTEXT}.${canonical(payload)}`), createPublicKey(publicKey), Buffer.from(String(signature), 'base64url'));
  } catch { return false; }
}

export function generateCredential() { return randomBytes(CREDENTIAL_BYTES).toString('base64url'); }

export function normaliseDevice(raw = {}) {
  return {
    id: String(raw.id || deviceId()),
    tenantId: String(raw.tenantId || ''),
    hostname: String(raw.hostname || ''),
    os: String(raw.os || ''),
    version: String(raw.version || ''),
    arch: String(raw.arch || ''),
    credentialHash: String(raw.credentialHash || ''),
    credentialId: String(raw.credentialId || ''),
    identityAlgorithm: String(raw.identityAlgorithm || ''),
    publicKey: String(raw.publicKey || ''),
    deviceFingerprint: String(raw.deviceFingerprint || ''),
    credentialIssuedAt: raw.credentialIssuedAt || '',
    credentialRevokedAt: raw.credentialRevokedAt || null,
    credentialExpiresAt: raw.credentialExpiresAt || '',
    health: DEVICE_HEALTH.includes(raw.health) ? raw.health : 'online',
    lastSeen: raw.lastSeen || nowIso(),
    group: String(raw.group || ''),
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 50) : [],
    policyRevision: String(raw.policyRevision || ''),
    outstandingRuns: Number.isInteger(raw.outstandingRuns) ? raw.outstandingRuns : 0,
    enrolledAt: raw.enrolledAt || nowIso(),
    revoked: Boolean(raw.revoked),
    revokedAt: raw.revokedAt || null,
    revokeReason: String(raw.revokeReason || ''),
  };
}

export class DeviceRegistry {
  constructor({ storePath = DEFAULT_STORE } = {}) {
    this.storePath = storePath;
    this.devices = new Map();
    this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.storePath)) return;
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
      for (const item of (Array.isArray(raw?.devices) ? raw.devices : [])) {
        const d = normaliseDevice(item);
        this.devices.set(d.id, d);
      }
    } catch { /* corrupt store fails closed to empty */ }
  }

  #save() {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const devices = [...this.devices.values()].sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))).slice(0, MAX_DEVICES);
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, devices }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.storePath);
  }

  /** Enroll a device. The credential is hashed; the secret is never stored. */
  enroll({ id, tenantId, hostname = '', os = '', version = '', arch = '', credential = '', credentialExpiresAt = '', tags = [], group = '', policyRevision = '', publicKey = '', enrollmentSignature = '', enrollmentPayload, identityAlgorithm = 'Ed25519' } = {}) {
    if (!tenantId) throw new TypeError('tenantId is required');
    if (!credential) throw new TypeError('credential is required');
    if (!validFutureTimestamp(credentialExpiresAt)) throw new TypeError('credentialExpiresAt must be a valid timestamp');
    if (publicKey) {
      if (identityAlgorithm !== 'Ed25519') throw new TypeError('unsupported identity algorithm');
      if (!enrollmentSignature || !enrollmentPayload || !verifyEnrollment(enrollmentPayload, enrollmentSignature, publicKey)) throw new TypeError('invalid enrollment signature');
      if (String(enrollmentPayload.tenantId) !== String(tenantId)) throw new TypeError('enrollment tenant mismatch');
      if (String(enrollmentPayload.publicKey || '') !== String(publicKey)) throw new TypeError('enrollment public key mismatch');
      if (id && String(enrollmentPayload.deviceId || '') !== String(id)) throw new TypeError('enrollment device mismatch');
    }
    const issuedAt = nowIso();
    const device = normaliseDevice({
      id, tenantId, hostname, os, version, arch, tags, group, policyRevision,
      credentialHash: credential ? hashCredential(credential) : hashCredential(generateCredential()),
      credentialId: `cred_${randomBytes(12).toString('hex')}`, credentialIssuedAt: issuedAt,
      credentialExpiresAt, publicKey, identityAlgorithm,
      deviceFingerprint: publicKey ? fingerprint(publicKey) : '',
    });
    if (this.devices.has(device.id)) return this.get(device.id);
    this.devices.set(device.id, device);
    this.#save();
    auditWrite({ kind: 'device', action: 'enroll', deviceId: device.id, tenantId, hostname, os });
    return this.get(device.id);
  }

  /** Read a device. When `tenantId` is supplied, cross-tenant reads return null. */
  get(id, { tenantId } = {}) {
    const d = this.devices.get(String(id));
    if (!d) return null;
    if (tenantId !== undefined && d.tenantId !== tenantId) return null;
    return normaliseDevice(d);
  }

  /** Inventory, strictly tenant-scoped. `tenantId` is required (no implicit global view). */
  list({ tenantId, health, group, tag } = {}) {
    if (!tenantId) throw new TypeError('tenantId is required to list devices');
    return [...this.devices.values()]
      .filter((d) => d.tenantId === tenantId)
      .filter((d) => health === undefined || d.health === health)
      .filter((d) => group === undefined || d.group === group)
      .filter((d) => tag === undefined || d.tags.includes(tag))
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
      .map((d) => normaliseDevice(d));
  }

  /** Record a heartbeat and current health. */
  heartbeat(id, { health = 'online', outstandingRuns = 0, policyRevision = '' } = {}) {
    const d = this.devices.get(String(id));
    if (!d) return null;
    if (!DEVICE_HEALTH.includes(health)) throw new TypeError(`invalid health: ${health}`);
    d.health = health;
    d.lastSeen = nowIso();
    d.outstandingRuns = Number.isInteger(outstandingRuns) ? outstandingRuns : 0;
    if (policyRevision) d.policyRevision = policyRevision;
    this.#save();
    return this.get(id);
  }

  /** Verify a presented credential against the stored hash and expiry window. */
  verifyCredential(id, credential, now = Date.now()) {
    const d = this.devices.get(String(id));
    if (!d || d.revoked) return { ok: false, reason: 'unknown or revoked device' };
    const expected = Buffer.from(d.credentialHash, 'hex');
    const presented = Buffer.from(hashCredential(credential), 'hex');
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return { ok: false, reason: 'credential mismatch' };
    if (d.credentialRevokedAt) return { ok: false, reason: 'credential revoked' };
    if (d.credentialExpiresAt && Date.parse(d.credentialExpiresAt) <= now) return { ok: false, reason: 'credential expired' };
    return { ok: true };
  }

  /** Rotate a credential atomically: the new hash is stored before the old expires. */
  rotateCredential(id, { credential = '', credentialExpiresAt = '', auditor = '' } = {}) {
    const d = this.devices.get(String(id));
    if (!d) return null;
    if (!credential) throw new TypeError('credential is required');
    if (!validFutureTimestamp(credentialExpiresAt)) throw new TypeError('credentialExpiresAt must be a valid timestamp');
    d.credentialHash = hashCredential(credential);
    d.credentialId = `cred_${randomBytes(12).toString('hex')}`;
    d.credentialIssuedAt = nowIso();
    d.credentialRevokedAt = null;
    d.credentialExpiresAt = credentialExpiresAt;
    this.#save();
    auditWrite({ kind: 'device', action: 'rotate', deviceId: d.id, tenantId: d.tenantId, auditor });
    return this.get(id);
  }

  /** Revoke a device immediately. A revoked device can never verify again. */
  revoke(id, { reason = '', auditor = '' } = {}) {
    const d = this.devices.get(String(id));
    if (!d) return null;
    d.revoked = true;
    d.revokedAt = nowIso();
    d.revokeReason = reason;
    this.#save();
    auditWrite({ kind: 'device', action: 'revoke', deviceId: d.id, tenantId: d.tenantId, reason, auditor });
    return this.get(id);
  }

  /** Force-revoke every device in a tenant (compromise response). */
  revokeTenant(tenantId, { reason = 'tenant compromised', auditor = '' } = {}) {
    const ids = [...this.devices.values()].filter((d) => d.tenantId === tenantId && !d.revoked).map((d) => d.id);
    for (const id of ids) this.revoke(id, { reason, auditor });
    return ids;
  }

  /** A device is eligible for autonomous remediation only when online, unrevoked, and with an unexpired credential. */
  eligibleForRemediation(id, now = Date.now()) {
    const d = this.devices.get(String(id));
    if (!d || d.revoked) return false;
    if (d.health !== 'online') return false;
    if (d.credentialExpiresAt && Date.parse(d.credentialExpiresAt) <= now) return false;
    return true;
  }
}
