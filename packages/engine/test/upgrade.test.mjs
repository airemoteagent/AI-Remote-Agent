import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let DeviceRegistry, UpgradeOrchestrator, auditVerify;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-upgrade-'));
const AUDIT = path.join(TMP, 'audit.jsonl');
process.env.REMOTE_AUDIT = AUDIT;
const storePath = (name) => path.join(TMP, `${name}.json`);

before(async () => ({ DeviceRegistry, UpgradeOrchestrator, auditVerify } = await import('../src/index.mjs')));

function fleet(tenant, n, storeName) {
  const r = new DeviceRegistry({ storePath: storePath(storeName) });
  for (let i = 0; i < n; i++) {
    r.enroll({ tenantId: tenant, hostname: `${tenant}-${i}`, credential: `s${i}`, credentialExpiresAt: '2099-01-01T00:00:00Z' });
  }
  return r;
}

describe('UpgradeOrchestrator staged rollout', () => {
  it('starts a canary cohort and excludes degraded/offline devices', () => {
    const registry = fleet('t', 3, 'fleet-a');
    const degraded = registry.list({ tenantId: 't' }).find((d) => d.hostname === 't-1');
    registry.heartbeat(degraded.id, { health: 'degraded' });

    const o = new UpgradeOrchestrator({ registry, storePath: storePath('upg-a') });
    const u = o.start({ tenantId: 't', version: '2.0.0', canarySize: 1 });
    assert.equal(u.state, 'canary');
    assert.equal(u.canaryDevices.length, 1);
    assert.equal(u.rolloutDevices.length, 1);
    const targeted = [...u.canaryDevices, ...u.rolloutDevices];
    assert.ok(!targeted.includes(degraded.id), 'degraded device must be excluded');
    assert.ok(targeted.every((id) => registry.get(id).health === 'online'));
  });

  it('blocks rollout when a canary device becomes unhealthy, then fails the upgrade', () => {
    const registry = fleet('t', 2, 'fleet-b');
    const o = new UpgradeOrchestrator({ registry, storePath: storePath('upg-b') });
    const u = o.start({ tenantId: 't', version: '2.0.0', canarySize: 1 });
    // Degrade the canary device.
    registry.heartbeat(u.canaryDevices[0], { health: 'degraded' });
    const failed = o.promote(u.id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.reason, /canary devices unhealthy/);
  });

  it('advances canary → rollout → complete when canary stays healthy', () => {
    const registry = fleet('t', 3, 'fleet-c');
    const o = new UpgradeOrchestrator({ registry, storePath: storePath('upg-c') });
    const u = o.start({ tenantId: 't', version: '3.0.0', canarySize: 1 });
    const rollout = o.promote(u.id);
    assert.equal(rollout.state, 'rollout');
    const complete = o.promote(u.id);
    assert.equal(complete.state, 'complete');
    assert.equal(complete.completedDevices.length, 3);
  });

  it('rolls back an in-progress upgrade and refuses to roll back a completed one', () => {
    const registry = fleet('t', 2, 'fleet-d');
    const o = new UpgradeOrchestrator({ registry, storePath: storePath('upg-d') });
    const u = o.start({ tenantId: 't', version: '2.0.0' });
    const rolled = o.rollback(u.id, { reason: 'bad version' });
    assert.equal(rolled.state, 'rolled_back');

    const o2 = new UpgradeOrchestrator({ registry, storePath: storePath('upg-d2') });
    const done = o2.start({ tenantId: 't', version: '4.0.0' });
    o2.promote(done.id);
    o2.promote(done.id);
    assert.throws(() => o2.rollback(done.id), /completed upgrade/);
  });

  it('persists upgrades across restart and audits start/rollback', () => {
    const registry = fleet('t', 2, 'fleet-e');
    const p = storePath('upg-e');
    const a = new UpgradeOrchestrator({ registry, storePath: p });
    const u = a.start({ tenantId: 't', version: '5.0.0' });
    a.rollback(u.id, { reason: 'test' });

    const b = new UpgradeOrchestrator({ registry, storePath: p });
    assert.equal(b.get(u.id).state, 'rolled_back');

    const audit = auditVerify(AUDIT);
    assert.equal(audit.ok, true);
    assert.ok(audit.checked >= 2, 'start and rollback are audited');
  });
});
