import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let JitAccess, ROLES, auditVerify;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-jit-'));
const storePath = (name) => path.join(TMP, `${name}.json`);
const AUDIT = path.join(TMP, 'audit.jsonl');
// Isolate the shared hash-chained audit log before policy.js reads its default.
process.env.REMOTE_AUDIT = AUDIT;

before(async () => ({ JitAccess, ROLES, auditVerify } = await import('../src/index.mjs')));

describe('JitAccess provisioning and revocation', () => {
  it('grants role-scoped access and checks tool coverage', () => {
    const j = new JitAccess({ storePath: storePath('grant') });
    const g = j.grant({ principal: 'bob', role: 'operator', expiresAt: '2099-01-01T00:00:00Z', reason: 'incident', auditor: 'alice' });
    assert.equal(g.role, 'operator');
    assert.ok(g.tools.includes('shell'));

    assert.equal(j.check('bob', 'shell').allowed, true);
    assert.equal(j.check('bob', 'browser').allowed, false, 'operator role does not include browser');
    assert.equal(j.check('carol', 'shell').allowed, false);
  });

  it('narrows an explicit tool list and expands only via admin wildcard', () => {
    const j = new JitAccess({ storePath: storePath('narrow') });
    j.grant({ principal: 'dev', role: 'operator', tools: ['sysinfo', 'files'], expiresAt: '2099-01-01T00:00:00Z' });
    assert.equal(j.check('dev', 'sysinfo').allowed, true);
    assert.equal(j.check('dev', 'shell').allowed, false, 'explicit list narrows the role');

    const admin = new JitAccess({ storePath: storePath('admin') });
    admin.grant({ principal: 'root', role: 'admin', expiresAt: '2099-01-01T00:00:00Z' });
    assert.equal(admin.check('root', 'anything').allowed, true, 'admin wildcard covers any tool');
  });

  it('does not let legacy or other-tenant grants authorize a tenant-scoped check', () => {
    const j = new JitAccess({ storePath: storePath('tenant-isolation') });
    j.grant({ tenantId: '', principal: 'bob', role: 'operator', expiresAt: '2099-01-01T00:00:00Z' });
    j.grant({ tenantId: 'tenant-a', principal: 'bob', role: 'operator', expiresAt: '2099-01-01T00:00:00Z' });
    assert.equal(j.check('bob', 'shell').allowed, true, 'legacy caller can read only an unscoped legacy grant');
    assert.equal(j.check('bob', 'shell', { tenantId: 'tenant-a' }).allowed, true);
    assert.equal(j.check('bob', 'shell', { tenantId: 'tenant-b' }).allowed, false);
  });

  it('expires a grant at its deadline and refuses unknown roles', () => {
    const j = new JitAccess({ storePath: storePath('expiry') });
    j.grant({ principal: 'bob', role: 'operator', expiresAt: '2000-01-01T00:00:00Z' });
    assert.equal(j.check('bob', 'shell').allowed, false, 'expired grant must not authorize');
    assert.equal(j.expired().length, 1);

    assert.throws(() => j.grant({ principal: 'x', role: 'superuser' }), /unknown role/);
  });

  it('revokes a grant immediately and records it in the shared audit log', () => {
    const j = new JitAccess({ storePath: storePath('revoke') });
    const g = j.grant({ principal: 'bob', role: 'admin', expiresAt: '2099-01-01T00:00:00Z', auditor: 'alice' });
    assert.equal(j.check('bob', 'shell').allowed, true);
    const revoked = j.revoke(g.id, { reason: 'incident closed', auditor: 'alice' });
    assert.equal(revoked.revoked, true);
    assert.equal(j.check('bob', 'shell').allowed, false);

    const audit = auditVerify(AUDIT);
    assert.equal(audit.ok, true);
    assert.ok(audit.checked >= 2, 'grant and revoke are both audited');
  });

  it('bulk-expires past-due grants as explicit revocations', () => {
    const j = new JitAccess({ storePath: storePath('bulk-expire') });
    j.grant({ principal: 'bob', role: 'operator', expiresAt: '2000-01-01T00:00:00Z' });
    const closed = j.expire(Date.now(), { auditor: 'system' });
    assert.equal(closed.length, 1);
    assert.equal(j.get(closed[0]).revoked, true);
  });
});

describe('ROLES', () => {
  it('defines a read-only, operator, and admin tier', () => {
    assert.deepEqual([...ROLES['read-only']], ['sysinfo', 'files', 'memory', 'notify', 'vector']);
    assert.ok(ROLES.operator.includes('shell'));
    assert.deepEqual(ROLES.admin, ['*']);
  });
});
