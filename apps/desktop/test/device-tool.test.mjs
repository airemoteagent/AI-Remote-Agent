// device tool — deep-dive + control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { device } from '../src/tools/device.js';
import { tools } from '../src/tools/index.js';

test('device tool is registered and well-formed', () => {
  assert.equal(device.name, 'device');
  assert.ok(tools.names().includes('device'));
  assert.equal(typeof device.run, 'function');
});

test('device census returns budget, groups and rows', async () => {
  const r = await device.run({ action: 'census', n: 5 });
  assert.equal(typeof r.busyPercent, 'number');
  assert.ok(r.budget && typeof r.budget.agents === 'number' && typeof r.budget.system === 'number');
  assert.ok(Array.isArray(r.groups));
  assert.ok(Array.isArray(r.top));
  assert.ok(r.gate && typeof r.gate.cpuGuard === 'boolean');
});

test('device refuses to pause a protected pid (pid 1)', async () => {
  const r = await device.run({ action: 'pause', pid: 1 });
  assert.deepEqual(r.paused, []);
  assert.ok(r.refused.length >= 1);
});

test('device refuses to kill a protected pid (pid 1)', async () => {
  const r = await device.run({ action: 'kill', pid: 1 });
  assert.equal(r.ok, false);
});

test('device mode returns a plan result', async () => {
  const r = await device.run({ action: 'mode', mode: 'balanced' });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'balanced');
});

test('device rejects an unknown action and an unknown mode', async () => {
  assert.ok((await device.run({ action: 'nope' })).error);
  assert.ok((await device.run({ action: 'mode', mode: 'bogus' })).error);
});
