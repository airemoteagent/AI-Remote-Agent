// agent-catalog — the roster the head reads. A fake HOME keeps every write in a
// temp dir: this test must never touch the real skill config or credentials.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'catalog-'));
process.env.HOME = ROOT;
process.env.REMOTE_AGENT_HOME = join(ROOT, '.remote-agent');
process.env.REMOTE_SKILLS_DIR = join(ROOT, '.remote-agent', 'skills');
mkdirSync(process.env.REMOTE_SKILLS_DIR, { recursive: true });

const { listAgents, startAgent, stopAgent, head, catalog, daemonPid, listModels, policyPosture, probeDevice, probeDevices, deviceAction, devicesWithLiveness, activityLog, detectAgents } = await import('../src/agent-catalog.js');

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

  test('a policy that denies fleet refuses run/stop and says why', async () => {    // strict = read-only observer: the roster is readable, control is not.
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

  test('the activity log reads the audit tail, newest first', async () => {
    const { auditWrite } = await import('@remote-agent/engine');
    const log = join(process.env.REMOTE_AGENT_HOME, 'audit.jsonl');
    for (const tool of ['shell', 'files', 'net']) auditWrite({ kind: 'tool', tool, verdict: 'allow' }, log);
    const out = activityLog(3);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((a) => a.what), ['net', 'files', 'shell'], 'newest first');
    assert.equal(out[0].verdict, 'allow');
    assert.equal(out[0].kind, 'tool');
    // a large head must not stop the tail read (only the last 128 KB is parsed)
    writeFileSync(log, `${'#'.repeat(300_000)}\n`, { flag: 'a' });
    for (const tool of ['jobs']) auditWrite({ kind: 'tool', tool, verdict: 'deny', reason: 'probe' }, log);
    const tail = activityLog(1);
    assert.equal(tail[0].what, 'jobs');
    assert.equal(tail[0].reason, 'probe');
  });

  test('reading the policy posture does not write to the audit log', async () => {
    const { auditWrite } = await import('@remote-agent/engine');
    const log = join(process.env.REMOTE_AGENT_HOME, 'audit.jsonl');
    const before = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
    for (let i = 0; i < 5; i++) policyPosture();
    const after = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
    assert.equal(after, before, 'the dashboard asks every tick; the posture must not be audited');
  });

  test('detection finds every sort of agent, and does not cry wolf', () => {
    const table = [
      ['node', 'node /usr/local/bin/claude --resume', 1],
      ['python3', 'python3 -m aider --model gpt-4o', 2],
      ['codex', 'codex exec "fix tests"', 3],
      ['node', 'node /opt/homebrew/bin/goose session', 4],
      ['ollama', 'ollama serve', 5],
      ['node', 'node /usr/lib/mcp-server-filesystem', 6],
      ['node', 'node /usr/lib/n8n start', 7],
      ['bash', 'bash -c grep -rn claude /tmp', 8],   // a shell that mentions an agent is not one
      ['mysqld', '/usr/local/mysql/bin/mysqld', 9],
      ['node', 'node server.js', 10],
      ['python3', 'python3 -c import os', 11],
      ['node', 'node -e console.log("agent")', 12],   // a one-liner is not an agent
    ].map(([comm, args, pid]) => ({ pid, comm, args, rssMB: 50, user: 'me' }));
    const found = detectAgents(table);
    const by = Object.fromEntries(found.agents.map((a) => [a.pid, a.by]));
    assert.equal(found.scanned, 12);
    for (const pid of [1, 2, 3, 4, 5, 6, 7]) assert.ok(by[pid], `pid ${pid} should be detected`);
    for (const pid of [8, 9, 10, 11, 12]) assert.equal(by[pid], undefined, `pid ${pid} must not be claimed as an agent`);
    assert.equal(found.agents.find((a) => a.pid === 1).confidence, 'known');
    assert.equal(by[2], 'signature:aider');
    assert.equal(by[6], 'signature:mcp-server');
    assert.equal(by[7], 'signature:agent-platform');
  });

  test('the registry makes agents you run yourself detectable', () => {
    const reg = join(process.env.REMOTE_AGENT_HOME, 'agents.json');
    writeFileSync(reg, JSON.stringify({ agents: [
      { id: 'my-bot', name: 'My Bot', match: 'my-bot\\.py' },
      { id: 'edge-1', name: 'Edge One', host: '10.0.0.9', port: 3095, role: 'edge' },
    ] }));
    const found = detectAgents([
      { pid: 42, comm: 'python3', args: 'python3 /srv/my-bot.py --serve', rssMB: 30, user: 'me' },
      { pid: 43, comm: 'node', args: 'node server.js', rssMB: 30, user: 'me' },
    ]);
    const custom = found.agents.find((a) => a.by === 'registry:my-bot');
    assert.ok(custom, 'a registry match is a known agent');
    assert.equal(custom.pid, 42);
    assert.equal(found.agents.some((a) => a.pid === 43), false);
    assert.deepEqual(found.external.map((e) => e.id), ['edge-1'], 'a registered host that is not a local process still shows up');
    assert.deepEqual(found.external[0].actions, ['probe']);
    writeFileSync(reg, JSON.stringify({ agents: [] }));
  });

  test('an idle agent is still an agent (the census threshold must not hide it)', () => {
    // The census only keeps rows above a cpu/memory threshold; detection reads the
    // full process table, so a 0 %-cpu agent that has not been scheduled still shows.
    const found = detectAgents([{ pid: 77, comm: 'node', args: 'node /opt/homebrew/bin/goose session', cpu: 0, rssMB: 12, user: 'me' }]);
    assert.equal(found.agents.length, 1);
    assert.equal(found.agents[0].pid, 77);
  });

  test('a device is online only if something answers on its port', async () => {
    const net = await import('node:net');
    const srv = net.createServer(() => {});
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const live = { id: 'live', host: '127.0.0.1', port: srv.address().port, role: 'edge' };
    const dead = { id: 'dead', host: '127.0.0.1', port: 9, role: 'edge' };

    assert.equal((await probeDevice(live, { timeoutMs: 1500 })).online, true);
    assert.equal((await probeDevice(dead, { timeoutMs: 1500 })).online, false);
    const probed = await probeDevices([live, dead]);
    assert.deepEqual(probed.map((d) => d.online), [true, false]);
    srv.close();
  });

  test('the head governs its own agents, and refuses to pretend it governs a peer', () => {
    assert.deepEqual(devicesWithLiveness([{ id: 'me', host: hostname(), role: 'self' }])[0].actions,
      ['pause-agents', 'resume-agents', 'probe']);
    assert.deepEqual(devicesWithLiveness([{ id: 'pi-1', host: 'pi-1.lan', role: 'edge' }])[0].actions, ['probe']);

    const peer = deviceAction('pi-1.lan', 'pause-agents');
    assert.equal(peer.ok, false);
    assert.match(peer.message, /no remote control channel/);
    assert.match(deviceAction('pi-1.lan', 'probe').message, /probe requested/);

    const junk = deviceAction(hostname(), 'nonsense');
    assert.equal(junk.ok, false);
  });
});
