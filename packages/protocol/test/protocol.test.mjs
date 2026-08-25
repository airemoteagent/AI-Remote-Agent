// Wire-contract tests: the daemon and the gateway share this contract, and
// these tests fail if they drift apart.
// Run: node --test test/protocol.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  CLOSE_CODES,
  isTerminalClose,
  TYPES,
  capabilities,
  envelope,
  parseFrame,
  checkVersion,
  validateCommandFrame,
} from '../src/index.mjs';

describe('protocol envelope', () => {
  it('builds a versioned envelope with type, ts, agentId and data', () => {
    const msg = envelope('hello', { host: 'mbp' }, { agentId: 'agent-1' });
    assert.equal(msg.v, PROTOCOL_VERSION);
    assert.equal(msg.type, 'hello');
    assert.equal(msg.agentId, 'agent-1');
    assert.equal(msg.data.host, 'mbp');
    assert.equal(typeof msg.ts, 'number');
  });

  it('omits agentId when not provided', () => {
    const msg = envelope('ping');
    assert.equal(msg.agentId, undefined);
    assert.deepEqual(msg.data, {});
  });
});

describe('protocol parsing', () => {
  it('parses a valid frame', () => {
    const raw = JSON.stringify({ v: 1, type: 'command', ts: 1, data: { id: 7 } });
    const msg = parseFrame(raw);
    assert.equal(msg.type, 'command');
    assert.equal(msg.data.id, 7);
  });

  it('returns null for garbage and keep-alives', () => {
    assert.equal(parseFrame('not json'), null);
    assert.equal(parseFrame(''), null);
    assert.equal(parseFrame('{"no":"type"}'), null);
    assert.equal(parseFrame('42'), null);
  });
});

describe('protocol versioning', () => {
  it('accepts the current version', () => {
    assert.equal(checkVersion({ v: PROTOCOL_VERSION }), true);
  });

  it('rejects unknown and missing versions', () => {
    assert.equal(checkVersion({ v: 2 }), false);
    assert.equal(checkVersion({ v: 99 }), false);
    assert.equal(checkVersion({}), false);
  });
});

describe('command validation and replay protection', () => {
  const command = (overrides = {}) => envelope(TYPES.COMMAND, {
    id: 'command-1', requestId: 'request-1', tool: 'sysinfo', args: {}, ...overrides.data,
  }, { ts: 1_000, ...overrides });

  it('accepts a fresh identified command once', () => {
    const seen = new Map();
    const result = validateCommandFrame(command(), { now: 1_000, seen });
    assert.equal(result.ok, true);
    assert.equal(validateCommandFrame(command(), { now: 1_000, seen }).reason, 'replayed-command');
  });

  it('rejects missing identity and stale/future commands', () => {
    assert.equal(validateCommandFrame(envelope(TYPES.COMMAND, { requestId: 'r' }, { ts: 1_000 }), { now: 1_000 }).reason, 'missing-command-identity');
    assert.equal(validateCommandFrame(command(), { now: 400_000 }).reason, 'stale-command-frame');
    assert.equal(validateCommandFrame(command({ ts: 40_000 }), { now: 1_000 }).reason, 'stale-command-frame');
  });

  it('keeps replay state bounded', () => {
    const seen = new Map();
    for (let i = 0; i < 4; i++) validateCommandFrame(command({ data: { id: `c-${i}`, requestId: `r-${i}` } }), { now: 1_000, seen, maxEntries: 2 });
    assert.equal(seen.size, 2);
  });
});

describe('close codes', () => {
  it('treats auth/revoke/protocol codes as terminal', () => {
    assert.equal(isTerminalClose(CLOSE_CODES.UNAUTHORIZED), true);
    assert.equal(isTerminalClose(CLOSE_CODES.REVOKED), true);
    assert.equal(isTerminalClose(CLOSE_CODES.PROTOCOL), true);
  });

  it('treats normal and other codes as non-terminal', () => {
    assert.equal(isTerminalClose(1000), false);
    assert.equal(isTerminalClose(1006), false);
    assert.equal(isTerminalClose(0), false);
  });
});

describe('capabilities', () => {
  it('shapes tools and shell posture for hello', () => {
    const c = capabilities({ tools: ['sysinfo', 'shell'], shell: { allowlist: ['ls'] } });
    assert.deepEqual(c.tools, ['sysinfo', 'shell']);
    assert.equal(c.shell.allowlist.length, 1);
  });

  it('handles the no-shell case', () => {
    const c = capabilities({ tools: ['sysinfo'] });
    assert.equal(c.shell, null);
  });
});

describe('message types', () => {
  it('exposes every frame type the daemon and gateway use', () => {
    const required = [
      'HELLO', 'HELLO_OK', 'REGISTER', 'COMMAND', 'COMMAND_RESULT', 'COMMAND_ERROR',
      'AGENT_STEP', 'AGENT_TOKEN', 'AGENT_RESULT', 'AGENT_LOG', 'DEVICE_METRICS',
      'PING', 'PONG', 'CHAT', 'CHAT_RESPONSE', 'LLM_REQUEST', 'LLM_RESPONSE', 'LLM_ERROR',
    ];
    for (const k of required) {
      assert.equal(typeof TYPES[k], 'string', `TYPES.${k} missing`);
    }
  });

  it('values match the wire strings the control plane expects', () => {
    assert.equal(TYPES.HELLO, 'hello');
    assert.equal(TYPES.AGENT_STEP, 'agent.step');
    assert.equal(TYPES.AGENT_TOKEN, 'agent.token');
    assert.equal(TYPES.AGENT_RESULT, 'agent.result');
    assert.equal(TYPES.AGENT_LOG, 'agent.log');
    assert.equal(TYPES.DEVICE_METRICS, 'device.metrics');
    assert.equal(TYPES.CHAT_RESPONSE, 'chat:response');
  });
});
