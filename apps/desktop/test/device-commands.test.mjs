// device-commands — the device half of the console control channel, driven with a
// STUBBED fetch and injected executor deps: this test never touches the network,
// spawns an agent, signals a process or writes outside its temp HOME.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'devcmd-'));
process.env.HOME = ROOT;
process.env.REMOTE_AGENT_HOME = join(ROOT, '.remote-agent');
mkdirSync(process.env.REMOTE_AGENT_HOME, { recursive: true });

const { runDeviceCommand, pollDeviceCommands } = await import('../src/device-commands.js');

// The same policy file the fleet console reads. The module holds ONE Policy
// instance across commands (its RateLimiter must accumulate), and a changed file
// swaps it — so a test may switch policies between commands.
const policy = (v) => writeFileSync(join(process.env.REMOTE_AGENT_HOME, 'policy.json'),
  JSON.stringify(typeof v === 'string' ? { audit: false, tools: { fleet: v } } : v));

const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });

/** Stub fetch for the whole poll: GET offers `commands`, POST records the report. */
function stubFetch(commands = []) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'POST';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method, body });
    return reply(method === 'GET' ? { commands } : { ok: true });
  };
  return calls;
}

describe('device-commands', () => {
  test('an unknown action is refused, never reported as ok', async () => {
    policy('allow');
    const r = await runDeviceCommand({ action: 'agents.wobble', payload: { id: 'x' } });
    assert.equal(r.status, 'refused');
    assert.match(r.result.reason, /unknown action "agents\.wobble"/);
  });

  test('agent.cancel and chat.send are refused as unsupported, never faked', async () => {
    policy('allow');
    for (const action of ['agent.cancel', 'chat.send']) {
      const r = await runDeviceCommand({ action, payload: { sessionId: 's1', text: 'hi' } });
      assert.equal(r.status, 'refused');
      assert.equal(r.result.reason, 'not supported by this client version');
    }
  });

  test("a strict policy (fleet:'deny') refuses every action with the device's own reason", async () => {
    policy({ version: 1, audit: false, tools: { fleet: 'deny' } });
    let called = 0;
    const deps = {
      startAgent: () => { called++; return { ok: true, message: 'should never run' }; },
      sampler: { pausePids: () => { called++; return { paused: [4242], refused: [] }; }, sample: () => ({ rows: [] }) },
    };
    for (const [action, payload] of [
      ['agents.run', { id: 'skill:demo' }],
      ['pause', { pid: 4242 }],
      ['kill', { pid: 4242 }],
      ['security.action', { action: 'resume-all' }],
    ]) {
      const r = await runDeviceCommand({ action, payload, deps });
      assert.equal(r.status, 'refused', `${action} must be refused under a strict policy`);
      assert.match(r.result.reason, /^policy \(deny\): /);
      assert.match(r.result.reason, /denied by policy/);
    }
    assert.equal(called, 0, 'a denied command must not reach the executor');
  });

  test('a valid pause on pid 1 is refused before any signal is sent', async () => {
    policy('allow');
    let signalled = false;
    const r = await runDeviceCommand({
      action: 'pause', payload: { pid: 1 },
      deps: { sampler: { pausePids: () => { signalled = true; return { paused: [1], refused: [] }; } } },
    });
    assert.equal(signalled, false, 'pid 1 must never reach pausePids');
    assert.equal(r.status, 'refused');
    assert.match(r.result.reason, /refusing pid 1/);
  });

  test('a valid agents.run reaches startAgent and reports done', async () => {
    policy('allow');
    const calls = [];
    const r = await runDeviceCommand({
      action: 'agents.run', payload: { id: 'skill:demo' },
      deps: { startAgent: (id) => { calls.push(id); return { ok: true, message: `started ${id}` }; } },
    });
    assert.deepEqual(calls, ['skill:demo']);
    assert.equal(r.status, 'done');
    assert.equal(r.result.message, 'started skill:demo');
  });

  test("the executor's own denial is reported refused, not failed or ok", async () => {
    policy('allow');
    const r = await runDeviceCommand({
      action: 'agents.stop', payload: { id: 'proc:4242' },
      deps: { stopAgent: () => ({ ok: false, denied: true, message: 'policy (confirm): Tool "fleet" requires approval' }) },
    });
    assert.equal(r.status, 'refused');
    assert.equal(r.result.reason, 'policy (confirm): Tool "fleet" requires approval');
  });

  test('the poll executes a queued command and reports the verdict on the wire', async () => {
    policy('allow');
    const calls = stubFetch([{ id: 7, action: 'pause', payload: { pid: 1 } }]);
    const counts = await pollDeviceCommands({ apiKey: 'k' });

    assert.deepEqual(counts, { done: 0, failed: 0, refused: 1 });
    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post.url, 'https://remoteagent.online/api/v1/agent/commands/7/result');
    assert.equal(post.body.status, 'refused');
    assert.match(post.body.result.reason, /refusing pid 1/);
  });

  test('an unreachable cloud never throws out of the poll', async () => {
    policy('allow');
    globalThis.fetch = async () => { throw new Error('fetch failed'); };
    // A rejection here would fail the test: nothing may escape the poll.
    const r = await pollDeviceCommands({ apiKey: 'k' });
    assert.equal(r.error, 'fetch failed');
  });

  test('every command lands in the tamper-evident audit chain', async () => {
    policy('allow');
    await runDeviceCommand({ action: 'kill', payload: { pid: 1 } });
    const lines = readFileSync(join(process.env.REMOTE_AGENT_HOME, 'audit.jsonl'), 'utf8').trim().split('\n');
    const last = JSON.parse(lines.at(-1));
    assert.equal(last.kind, 'device.command');
    assert.equal(last.action, 'kill');
    assert.equal(last.verdict, 'refused');
  });

  test('a slow executor does not stack a second poll on top of the first', async () => {
    policy('allow');
    stubFetch([{ id: 9, action: 'agents.run', payload: { id: 'slow' } }]);
    let release;
    const held = new Promise((res) => { release = res; });
    const deps = { startAgent: async () => { await held; return { ok: true, message: 'slow' }; } };

    const first = pollDeviceCommands({ apiKey: 'k', deps });
    const second = await pollDeviceCommands({ apiKey: 'k', deps });   // must not start a second executor
    assert.deepEqual(second, { skipped: 'in-flight' });

    release();
    assert.deepEqual(await first, { done: 1, failed: 0, refused: 0 });
  });

  // Last-but-one: proves the held Policy instance keeps its RateLimiter hits.
  test('the held policy instance accumulates its rate limit across commands instead of resetting', async () => {
    policy({ version: 1, audit: false, tools: { fleet: 'allow' }, rateLimits: { fleet: { perMinute: 3 } } });
    const deps = { startAgent: () => ({ ok: true, message: 'ran' }) };
    const seen = [];
    for (let i = 0; i < 4; i++) {
      seen.push((await runDeviceCommand({ action: 'agents.run', payload: { id: 'sk' }, deps })).status);
    }
    // A fresh Policy (and thus a fresh RateLimiter) per command would never refuse.
    assert.deepEqual(seen, ['done', 'done', 'done', 'refused']);
  });

  // Last, because it spends the whole rolling minute.
  test('the device refuses above its own 30-commands-a-minute ceiling, whatever the policy says', async () => {
    policy('allow');   // no rateLimits at all: only the device's own ceiling can refuse
    let executed = 0;
    const deps = { startAgent: () => { executed++; return { ok: true, message: 'ran' }; } };

    let refused = null, allowed = 0;
    for (let i = 0; i < 40 && !refused; i++) {
      const r = await runDeviceCommand({ action: 'agents.run', payload: { id: 'rate-limited' }, deps });
      if (r.status === 'refused') refused = r; else allowed++;
    }

    assert.ok(refused, 'the rolling ceiling must refuse once the minute is spent');
    assert.equal(refused.result.reason, 'device rate limit: 30 commands in the last minute');
    assert.equal(executed, allowed, 'the refused command must not have executed');
  });
});
