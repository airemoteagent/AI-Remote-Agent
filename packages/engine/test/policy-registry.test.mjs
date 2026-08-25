import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PolicyRegistry } from '../src/policy-registry.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-policy-registry-'));

describe('PolicyRegistry', () => {
  it('creates immutable tenant-scoped revisions and activates/rolls back', () => {
    const r = new PolicyRegistry({ storePath: path.join(tmp, 'policies.json') });
    const one = r.create({ tenantId: 'a', createdBy: 'admin', definition: { rules: [{ tool: '*', effect: 'deny' }] } });
    const two = r.create({ tenantId: 'a', createdBy: 'admin', definition: { rules: [{ tool: 'sysinfo', effect: 'allow' }] } });
    assert.equal(one.version, 1); assert.equal(two.version, 2);
    assert.throws(() => r.activate(two.id, { activatedBy: 'admin' }), /tenantId is required/);
    assert.equal(r.activate(two.id, { tenantId: 'b', activatedBy: 'admin' }), null);
    assert.equal(r.activate(two.id, { tenantId: 'a', activatedBy: 'admin' }).state, 'active');
    assert.equal(r.activeRevision('a').id, two.id);
    assert.equal(r.get(two.id, { tenantId: 'b' }), null);
    assert.throws(() => r.list({}), /tenantId is required/);
    assert.equal(r.rollback('a', one.id, { activatedBy: 'admin' }).id, one.id);
    assert.equal(r.activeRevision('a').id, one.id);
  });

  it('fails closed when a persisted policy definition does not match its hash', () => {
    const storePath = path.join(tmp, 'tampered.json');
    const first = new PolicyRegistry({ storePath });
    first.create({ tenantId: 'a', definition: { rules: [{ tool: '*', effect: 'deny' }] } });
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    stored.revisions[0].definition.rules[0].effect = 'allow';
    fs.writeFileSync(storePath, JSON.stringify(stored));
    const loaded = new PolicyRegistry({ storePath });
    assert.deepEqual(loaded.list({ tenantId: 'a' }), []);
  });
});
