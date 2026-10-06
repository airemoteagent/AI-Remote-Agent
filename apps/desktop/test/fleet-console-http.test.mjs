// The control plane over real HTTP: the head's roster, the policy gate and the
// device list. A fake HOME keeps every write (skills config, policy, audit) in a
// temp dir — this test must never touch the device's real state.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'plane-'));
process.env.HOME = ROOT;
process.env.REMOTE_AGENT_HOME = join(ROOT, '.remote-agent');
process.env.REMOTE_SKILLS_DIR = join(ROOT, '.remote-agent', 'skills');
mkdirSync(process.env.REMOTE_SKILLS_DIR, { recursive: true });

const { createFleetServer } = await import('../src/fleet-console.js');

let server;
let base;

const j = async (path, body) => {
  const r = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

const policy = (tier) => writeFileSync(join(process.env.REMOTE_AGENT_HOME, 'policy.json'), JSON.stringify({ audit: false, tools: { fleet: tier } }));

describe('control plane over http', () => {
  before(async () => {
    server = createFleetServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server?.close());

  test('the head serves the whole picture in one call', async () => {
    const { status, body } = await j('/overview');
    assert.equal(status, 200);
    assert.equal(body.console, 'fleet');
    assert.equal(body.head.kind, 'head');
    assert.equal(body.head.role, 'ceo');
    assert.ok(Array.isArray(body.catalog) && body.catalog.length > 0, 'roster is not empty');
    assert.ok(body.counts.all >= body.counts.running);
    assert.ok('policy' in body && 'audit' in body && 'models' in body, 'glass block present');
    assert.ok(body.audit.checked >= 0, 'audit posture reports a real check');
  });

  test('the one endpoint a website may call answers, and only for our origin', async () => {
    // remoteagent.online shows whether this console is running on the visitor's
    // machine. The page must not be handed the control surface to get a status
    // light, so /ping is read-only and CORS is scoped to a single origin.
    const allowed = await fetch(`${base}/ping`, { headers: { origin: 'https://remoteagent.online' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://remoteagent.online');
    assert.equal(allowed.headers.get('access-control-allow-private-network'), 'true');
    const body = await allowed.json();
    assert.equal(body.ok, true);
    assert.equal(body.console, 'fleet');

    // any other origin gets the answer, but no permission to read it
    const other = await fetch(`${base}/ping`, { headers: { origin: 'https://example.com' } });
    assert.equal(other.status, 200);
    assert.equal(other.headers.get('access-control-allow-origin'), null);

    // and the preflight carries the private-network grant Chrome demands
    const pre = await fetch(`${base}/ping`, { method: 'OPTIONS', headers: { origin: 'https://remoteagent.online' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  });

  test('the roster lists the daemon and the bundled skills', async () => {
    const { status, body } = await j('/agents');
    assert.equal(status, 200);
    assert.ok(body.agents.some((a) => a.id === 'daemon'));
    assert.ok(body.agents.some((a) => a.kind === 'skill' && a.status === 'available'));
  });

  test('devices are probed, not assumed: self answers, a closed port does not', async () => {
    const { status, body } = await j('/devices');
    assert.equal(status, 200);
    const self = body.devices.find((d) => d.role === 'self');
    assert.equal(self.online, true);
    assert.ok(self.actions.includes('pause-agents'), 'self devices expose local agent control');
    const peer = body.devices.find((d) => d.role !== 'self');
    if (peer) assert.deepEqual(peer.actions, ['probe'], 'a peer is probe-only');
  });

  test('policy decides whether the head may run an agent', async () => {
    policy('deny');
    const denied = await j('/agents/run', { id: 'skill:disk-health' });
    assert.equal(denied.status, 200);
    assert.equal(denied.body.ok, false, 'a deny tier must not start anything');
    assert.equal(denied.body.denied, true);
    assert.match(denied.body.message, /policy/);

    policy('allow');
    const allowed = await j('/agents/run', { id: 'skill:disk-health' });
    assert.equal(allowed.body.ok, true, allowed.body.message);
    const stopped = await j('/agents/stop', { id: 'skill:disk-health' });
    assert.equal(stopped.body.ok, true, stopped.body.message);
  });

  test('a device action is gated too, and never claims remote control it does not have', async () => {
    policy('deny');
    const denied = await j('/devices/action', { id: 'peer-1', action: 'pause-agents' });
    assert.equal(denied.body.denied, true, 'device control is governed by the same policy');

    policy('allow');
    const peer = await j('/devices/action', { id: 'not-this-host', action: 'pause-agents' });
    assert.equal(peer.body.ok, false);
    assert.match(peer.body.message, /no remote control channel/);
    const probe = await j('/devices/action', { id: 'not-this-host', action: 'probe' });
    assert.equal(probe.body.ok, true);
  });

  test('unknown routes and missing ids are refused, not guessed', async () => {
    assert.equal((await j('/nope')).status, 404);
    assert.equal((await j('/agents/run', {})).body.ok, false);
    assert.equal((await j('/devices/action', {})).status, 400);
  });
});
