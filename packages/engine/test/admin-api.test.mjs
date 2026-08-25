import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let AdminApi, FleetController;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-admin-api-'));
process.env.REMOTE_AUDIT = path.join(TMP, 'audit.jsonl');

before(async () => ({ AdminApi, FleetController } = await import('../src/index.mjs')));

function api() {
  const controller = new FleetController({
    deviceStore: path.join(TMP, `${Date.now()}-devices.json`),
    jitStore: path.join(TMP, `${Date.now()}-jit.json`),
    runStore: path.join(TMP, `${Date.now()}-runs.json`),
    upgradeStore: path.join(TMP, `${Date.now()}-upgrades.json`),
  });
  return { controller, api: new AdminApi(controller) };
}

describe('AdminApi', () => {
  it('discovers actions and reports a JSON-safe fleet summary', () => {
    const { api: service } = api();
    assert.ok(service.actions().includes('enroll'));
    const response = service.dispatch('report');
    assert.equal(response.ok, true);
    assert.ok(response.data.metrics);
    assert.ok(Array.isArray(response.data.alerts));
  });

  it('routes enrollment, JIT grants, run creation, and listing', () => {
    const { api: service } = api();
    const enrolled = service.dispatch('enroll', { tenantId: 'tenant-a', name: 'laptop-1', credential: 'secret', groups: ['ops'] });
    assert.equal(enrolled.ok, true);
    assert.equal(enrolled.data.tenantId, 'tenant-a');

    const grant = service.dispatch('grant', { tenantId: 'tenant-a', principal: 'operator-1', role: 'operator', tools: ['status'], ttlMs: 60_000 });
    assert.equal(grant.ok, true);
    assert.equal(service.dispatch('checkAccess', { tenantId: 'tenant-a', principal: 'operator-1', tool: 'status' }).data.allowed, true);
    assert.equal(service.dispatch('checkAccess', { tenantId: 'tenant-b', principal: 'operator-1', tool: 'status' }).data.allowed, false);

    const run = service.dispatch('createRun', { task: 'inspect disk', correlationId: 'corr-admin-api' });
    assert.equal(run.ok, true);
    const listed = service.dispatch('listRuns');
    assert.equal(listed.ok, true);
    assert.equal(listed.data.some((item) => item.id === run.data.id), true);
  });

  it('returns controlled errors for unknown actions, bad params, and service failures', () => {
    const { api: service } = api();
    assert.deepEqual(service.dispatch('nope'), { ok: false, error: 'unknown action: nope' });
    assert.deepEqual(service.dispatch('enroll', []), { ok: false, error: 'params must be a JSON object' });
    const failed = service.dispatch('enroll', { tenantId: '', credential: '' });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /tenantId is required/);
  });

  it('does not expose a live mutable service object', () => {
    const { api: service } = api();
    const response = service.dispatch('enroll', { tenantId: 'tenant-b', hostname: 'host', credential: 'value' });
    response.data.hostname = 'tampered-client-copy';
    const devices = service.dispatch('listDevices', { tenantId: 'tenant-b' });
    assert.equal(devices.data[0].hostname, 'host');
  });
});
