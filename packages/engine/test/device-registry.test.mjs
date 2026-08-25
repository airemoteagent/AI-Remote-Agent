import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let DeviceRegistry, hashCredential, auditVerify;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-devices-'));
const storePath = (name) => path.join(TMP, `${name}.json`);
const AUDIT = path.join(TMP, 'audit.jsonl');
process.env.MONA_AUDIT = AUDIT;

before(async () => ({ DeviceRegistry, hashCredential, auditVerify } = await import('../src/index.mjs')));

describe('DeviceRegistry enrollment and credential lifecycle', () => {
  it('enrolls a device, hashes the credential, and verifies it', () => {
    const r = new DeviceRegistry({ storePath: storePath('enroll') });
    const d = r.enroll({ tenantId: 't-1', hostname: 'web-1', os: 'linux', credential: 'secret-123', credentialExpiresAt: '2099-01-01T00:00:00Z' });
    assert.equal(d.tenantId, 't-1');
    assert.equal(d.credentialHash, hashCredential('secret-123'));
    assert.notEqual(d.credentialHash, 'secret-123', 'secret must not be stored in plaintext');

    assert.equal(r.verifyCredential(d.id, 'secret-123').ok, true);
    assert.equal(r.verifyCredential(d.id, 'wrong').ok, false);
  });

  it('rejects expired or malformed credential timestamps', () => {
    const r = new DeviceRegistry({ storePath: storePath('expired') });
    const d = r.enroll({ tenantId: 't-1', credential: 's', credentialExpiresAt: '2000-01-01T00:00:00Z' });
    assert.equal(r.verifyCredential(d.id, 's').ok, false);
    assert.throws(() => r.enroll({ tenantId: 't-1', credential: 's', credentialExpiresAt: 'not-a-date' }), /valid timestamp/);
    assert.throws(() => r.rotateCredential(d.id, { credential: 'next', credentialExpiresAt: 'not-a-date' }), /valid timestamp/);
  });

  it('rotates a credential atomically and revokes a device immediately', () => {
    const r = new DeviceRegistry({ storePath: storePath('rotate-revoke') });
    const d = r.enroll({ tenantId: 't-1', credential: 'old' });
    assert.equal(r.verifyCredential(d.id, 'old').ok, true);

    r.rotateCredential(d.id, { credential: 'new', auditor: 'alice' });
    assert.equal(r.verifyCredential(d.id, 'new').ok, true);
    assert.equal(r.verifyCredential(d.id, 'old').ok, false);

    r.revoke(d.id, { reason: 'decommission', auditor: 'alice' });
    assert.equal(r.get(d.id).revoked, true);
    assert.equal(r.verifyCredential(d.id, 'new').ok, false, 'revoked device cannot verify');
  });
});

describe('DeviceRegistry tenant isolation and health', () => {
  it('scopes inventory to the requested tenant and never leaks another tenant', () => {
    const r = new DeviceRegistry({ storePath: storePath('isolation') });
    r.enroll({ tenantId: 'a', hostname: 'a-1', credential: 's' });
    r.enroll({ tenantId: 'a', hostname: 'a-2', credential: 's' });
    r.enroll({ tenantId: 'b', hostname: 'b-1', credential: 's' });

    const a = r.list({ tenantId: 'a' });
    assert.equal(a.length, 2);
    assert.ok(a.every((d) => d.tenantId === 'a'));

    const b = r.list({ tenantId: 'b' });
    assert.equal(b.length, 1);
    assert.equal(b[0].hostname, 'b-1');

    // Cross-tenant direct read is refused.
    const aDevice = a[0];
    assert.equal(r.get(aDevice.id, { tenantId: 'b' }), null);
  });

  it('tracks health and excludes degraded/offline devices from remediation', () => {
    const r = new DeviceRegistry({ storePath: storePath('health') });
    const d = r.enroll({ tenantId: 't', hostname: 'h', credential: 's', credentialExpiresAt: '2099-01-01T00:00:00Z' });
    assert.equal(r.eligibleForRemediation(d.id), true);

    r.heartbeat(d.id, { health: 'degraded' });
    assert.equal(r.get(d.id).health, 'degraded');
    assert.equal(r.eligibleForRemediation(d.id), false);

    r.heartbeat(d.id, { health: 'offline' });
    assert.equal(r.list({ tenantId: 't', health: 'offline' }).length, 1);
    assert.equal(r.eligibleForRemediation(d.id), false);
  });

  it('force-revokes an entire tenant and audits the lifecycle', () => {
    const r = new DeviceRegistry({ storePath: storePath('tenant-revoke') });
    r.enroll({ tenantId: 'victim', hostname: 'v-1', credential: 's' });
    r.enroll({ tenantId: 'victim', hostname: 'v-2', credential: 's' });
    r.enroll({ tenantId: 'other', hostname: 'o-1', credential: 's' });

    const closed = r.revokeTenant('victim', { auditor: 'secops' });
    assert.equal(closed.length, 2);
    assert.ok(r.list({ tenantId: 'victim' }).every((d) => d.revoked));
    assert.equal(r.list({ tenantId: 'other' })[0].revoked, false);

    const audit = auditVerify(AUDIT);
    assert.equal(audit.ok, true);
    assert.ok(audit.checked >= 5, 'enrollments + revocations are audited');
  });
});
