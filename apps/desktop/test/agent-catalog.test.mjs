// agent-catalog — the roster the head reads. A fake HOME keeps every write in a
// temp dir: this test must never touch the real skill config or credentials.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'catalog-'));
process.env.HOME = ROOT;
process.env.REMOTE_AGENT_HOME = join(ROOT, '.remote-agent');
process.env.REMOTE_SKILLS_DIR = join(ROOT, '.remote-agent', 'skills');
mkdirSync(process.env.REMOTE_SKILLS_DIR, { recursive: true });

const { listAgents, startAgent, stopAgent, head, catalog, daemonPid, listModels, policyPosture } = await import('../src/agent-catalog.js');

const found = (list, id) => list.find((a) => a.id === id);

describe('agent-catalog', () => {
  test('lists the daemon as stopped when no pid file is live', () => {
    assert.equal(daemonPid(), null);
    const d = found(listAgents(), 'daemon');
    assert.equal(d.status, 'stopped');
    assert.deepEqual(d.actions, ['start']);
  });

  test('a stale pid file counts as stopped, not as a running agent', () => {
    writeFileSync(join(process.env.REMOTE_AGENT_HOME, 'daemon.pid'), JSON.stringify({ pid: 999999, ts: 1 }));
    assert.equal(daemonPid(), null);
    assert.equal(found(listAgents(), 'daemon').status, 'stopped');
  });

  test('bundled skills show up as installable, then runnable', () => {
    const off = found(listAgents(), 'skill:disk-health');
    assert.equal(off.status, 'available');
    assert.deepEqual(off.actions, ['install']);
    assert.ok(off.description.length > 0, 'description parsed from the bundled SKILL.md');

    const run = startAgent('skill:disk-health');
    assert.equal(run.ok, true, run.message);
    assert.equal(found(listAgents(), 'skill:disk-health').status, 'enabled');
    assert.deepEqual(found(listAgents(), 'skill:disk-health').actions, ['disable']);

    assert.equal(stopAgent('skill:disk-health').ok, true);
    assert.equal(found(listAgents(), 'skill:disk-health').status, 'disabled');
    assert.equal(startAgent('skill:not-a-skill').ok, false);
  });

  test('running processes are listed as stoppable agents', () => {
    const list = listAgents({ running: [{ pid: process.pid, cmd: 'node', cpu: 12, mb: 40 }] });
    const p = found(list, `proc:${process.pid}`);
    assert.equal(p.status, 'running');
    assert.deepEqual(p.actions, ['stop']);
  });

  test('the head reports the roster and never claims to be linked without a key', () => {
    const h = head({ agents: 3, devices: 2 });
    assert.equal(h.kind, 'head');
    assert.equal(h.role, 'ceo');
    assert.equal(h.url, 'https://remoteagent.online');
    assert.deepEqual(h.roster, { agents: 3, devices: 2 });
    assert.equal(h.linked, false);
    assert.equal(h.status, 'offline');
  });

  test('catalog counts agree with the roster it returns', () => {
    const c = catalog({ running: [{ pid: process.pid, cmd: 'node', cpu: 1, mb: 10 }], devices: [{ id: 'self' }] });
    assert.equal(c.counts.all, c.agents.length);
    assert.equal(c.counts.devices, 1);
    assert.equal(c.counts.skills, c.agents.filter((a) => a.kind === 'skill').length);
    assert.equal(c.counts.running, c.agents.filter((a) => a.status === 'running' || a.status === 'paused').length);
  });

  test('every llm the device can reach is listed, cloud first', () => {
    const { models, anyConfigured } = listModels();
    assert.equal(models[0].id, 'cloud:remoteagent.online');
    assert.equal(models[0].kind, 'cloud');
    assert.deepEqual(models.slice(1).map((m) => m.provider), ['anthropic', 'openai', 'ollama']);
    assert.equal(models.find((m) => m.provider === 'ollama').kind, 'local');
    assert.equal(typeof anyConfigured, 'boolean');
  });

  test('the control plane reports the policy actually in force', () => {
    const p = policyPosture();
    assert.ok(['policy file', 'built-in defaults', 'unreadable'].includes(p.source));
    assert.ok(['allow', 'deny', 'confirm', 'prompt'].includes(p.fleetTier));
    assert.equal(typeof p.audit, 'boolean');
  });

  test('a policy that denies fleet refuses run/stop and says why', async () => {
    // strict = read-only observer: the roster is readable, control is not.
    const { writeFileSync } = await import('node:fs');
    const policyPath = join(process.env.REMOTE_AGENT_HOME, 'policy.json');
    writeFileSync(policyPath, JSON.stringify({ audit: false, tools: { fleet: 'deny' } }));
    // Policy.load() defaults to ~/.remote-agent/policy.json, which HOME already points at.
    const r = startAgent('skill:disk-health');
    assert.equal(r.ok, false, 'strict/minimal mode must not start agents');
    assert.equal(r.denied, true);
    assert.match(r.message, /policy/);
    writeFileSync(policyPath, JSON.stringify({ audit: false, tools: { fleet: 'allow' } }));
    assert.equal(startAgent('skill:disk-health').ok, true, 'allow tier runs again');
  });
});
