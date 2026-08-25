import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let FleetController;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-fleet-'));
const AUDIT = path.join(TMP, 'audit.jsonl');
process.env.MONA_AUDIT = AUDIT;
const p = (name) => path.join(TMP, `${name}.json`);

before(async () => ({ FleetController } = await import('../src/index.mjs')));

describe('FleetController end-to-end workflow', () => {
  it('drives enroll → grant → run → recover → upgrade → report', () => {
    const f = new FleetController({
      deviceStore: p('devices'),
      jitStore: p('jit'),
      runStore: p('runs'),
      upgradeStore: p('upgrades'),
    });

    // Enroll a device and verify its credential.
    const device = f.enroll({ tenantId: 't', hostname: 'web-1', os: 'linux', credential: 'secret', credentialExpiresAt: '2099-01-01T00:00:00Z' });
    assert.equal(f.verifyCredential(device.id, 'secret').ok, true);

    // Grant JIT access to an operator for the device's tenant.
    f.grant({ tenantId: 't', principal: 'bob', role: 'operator', expiresAt: '2099-01-01T00:00:00Z', auditor: 'alice' });
    assert.equal(f.checkAccess('bob', 'shell', { tenantId: 't' }).allowed, true);

    // Drive a durable run with a checkpoint and a safe rollback.
    const run = f.createRun({ task: 'restart web-1' });
    f.transitionRun(run.id, 'running');
    f.checkpointRun(run.id, { phase: 'before-restart' });
    f.checkpointRun(run.id, { phase: 'after-stop' });
    const rolled = f.rollbackRun(run.id, { toIndex: 0 });
    assert.equal(rolled.status, 'rolled_back');

    // Stage an upgrade over the tenant's online devices.
    const upg = f.startUpgrade({ tenantId: 't', version: '2.0.0' });
    assert.equal(upg.state, 'canary');
    assert.equal(f.promoteUpgrade(upg.id).state, 'rollout');
    assert.equal(f.promoteUpgrade(upg.id).state, 'complete');

    // The report joins metrics, alerts, and audit integrity.
    const report = f.report();
    assert.equal(report.metrics.total, 1);
    assert.equal(report.metrics.rolledBack, 1);
    assert.ok(Array.isArray(report.alerts));
    // A rolled-back run at 100% of runs exceeds the default rollback threshold.
    assert.ok(report.alerts.some((a) => a.code === 'elevated_rollback_rate'));
  });

  it('revokes a device and a grant so access is fully withdrawn', () => {
    const f = new FleetController({
      deviceStore: p('devices2'),
      jitStore: p('jit2'),
      runStore: p('runs2'),
      upgradeStore: p('upgrades2'),
    });
    const device = f.enroll({ tenantId: 't', credential: 'secret' });
    const grant = f.grant({ tenantId: 't', principal: 'carol', role: 'admin', expiresAt: '2099-01-01T00:00:00Z' });
    assert.equal(f.checkAccess('carol', 'shell', { tenantId: 't' }).allowed, true);

    f.revokeGrant(grant.id, { reason: 'done' });
    assert.equal(f.checkAccess('carol', 'shell', { tenantId: 't' }).allowed, false);

    f.revokeDevice(device.id, { reason: 'decommission' });
    assert.equal(f.verifyCredential(device.id, 'secret').ok, false);
  });
});
