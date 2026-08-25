import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateDeviceIdentity, signEnrollment, verifyEnrollment, DeviceRegistry, generateCredential } from '../src/index.mjs';
import os from 'node:os';
import path from 'node:path';

describe('Ed25519 device identity', () => {
  it('generates and verifies signed enrollment', () => {
    const identity = generateDeviceIdentity();
    const payload = { deviceId: 'd1', tenantId: 't1', publicKey: identity.publicKey, nonce: 'n', ts: 1 };
    const signature = signEnrollment(payload, identity.privateKey);
    assert.equal(verifyEnrollment(payload, signature, identity.publicKey), true);
    assert.equal(verifyEnrollment({ ...payload, tenantId: 'other' }, signature, identity.publicKey), false);
    const nested = { ...payload, metadata: { z: 1, a: { second: 2, first: 1 } } };
    const nestedSignature = signEnrollment(nested, identity.privateKey);
    assert.equal(verifyEnrollment({ ...nested, metadata: { a: { first: 1, second: 2 }, z: 1 } }, nestedSignature, identity.publicKey), true);
    assert.equal(verifyEnrollment({ ...nested, metadata: { a: { first: 9, second: 2 }, z: 1 } }, nestedSignature, identity.publicKey), false);
  });

  it('requires a valid signature for public-key enrollment', () => {
    const identity = generateDeviceIdentity();
    const payload = { deviceId: 'd1', tenantId: 't1', publicKey: identity.publicKey, nonce: 'n', ts: 1 };
    const r = new DeviceRegistry({ storePath: path.join(os.tmpdir(), `identity-${Date.now()}.json`) });
    assert.throws(() => r.enroll({ tenantId: 't1', publicKey: identity.publicKey, enrollmentPayload: payload, enrollmentSignature: 'bad', credential: generateCredential() }), /signature/);
    const signature = signEnrollment(payload, identity.privateKey);
    assert.throws(() => r.enroll({ id: 'other', tenantId: 't1', publicKey: identity.publicKey, enrollmentPayload: payload, enrollmentSignature: signature, credential: generateCredential() }), /device mismatch/);
    const otherIdentity = generateDeviceIdentity();
    assert.throws(() => r.enroll({ id: 'd1', tenantId: 't1', publicKey: otherIdentity.publicKey, enrollmentPayload: payload, enrollmentSignature: signature, credential: generateCredential() }), /signature|public key mismatch/);
    assert.throws(() => r.enroll({ id: 'd1', tenantId: 't1', publicKey: identity.publicKey, enrollmentPayload: payload, enrollmentSignature: signature }), /credential is required/);
    const d = r.enroll({ id: 'd1', tenantId: 't1', publicKey: identity.publicKey, enrollmentPayload: payload, enrollmentSignature: signature, credential: generateCredential() });
    assert.equal(d.identityAlgorithm, 'Ed25519');
    assert.equal(d.deviceFingerprint, identity.deviceFingerprint);
  });
});
