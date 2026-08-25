// Docker-platform protocol tests: flat register, chat mapping, llm:request RPC.
// Run: node --test test/docker-control.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

// Start the fake platform first, then import ControlChannel with the env pointing at it.
const server = new WebSocketServer({ port: 0 });
const port = server.address().port;
process.env.REMOTE_CLOUD = `http://127.0.0.1:${port}`;
process.env.REMOTE_CLOUD_WS = `ws://127.0.0.1:${port}/ws`;
const { ControlChannel } = await import('../src/control.js');

const received = [];
const connections = [];
server.on('connection', (ws) => {
  connections.push(ws);
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    received.push(msg);
    if (msg.type === 'llm:request') {
      if (msg.messages?.[0]?.content === 'boom') {
        ws.send(JSON.stringify({ type: 'llm:error', requestId: msg.requestId, error: 'no key for provider' }));
      } else {
        ws.send(JSON.stringify({
          type: 'llm:response', requestId: msg.requestId,
          content: 'hello from fake platform', usage: { inputTokens: 5, outputTokens: 3 },
        }));
      }
    }
  });
});

const waitFor = (pred, ms = 3000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const hit = pred();
    if (hit) { clearInterval(iv); resolve(hit); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout waiting for condition')); }
  }, 20);
});

describe('docker platform protocol', () => {
  before(() => {});
  after(() => server.close());

  it('connects and sends a flat register message', async () => {
    const ch = new ControlChannel('key', 'agent-1');
    ch.on('error', () => {});
    ch.connect();
    const reg = await waitFor(() => received.find(m => m.type === 'register'));
    assert.ok(reg);
    assert.equal(reg.type, 'register');
    assert.ok(reg.name);
    assert.ok(reg.model.includes('remote-agent'));
    ch.close();
  });

  it('proxies llm:request and resolves llm:response', async () => {
    const ch = new ControlChannel('key', 'agent-1');
    ch.on('error', () => {});
    ch.connect();
    const p = ch.llmRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const res = await Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no llm response')), 3000)),
    ]);
    assert.equal(res.content, 'hello from fake platform');
    assert.deepEqual(res.usage, { inputTokens: 5, outputTokens: 3 });
    ch.close();
  });

  it('rejects when the platform answers llm:error', async () => {
    const ch = new ControlChannel('key', 'agent-1');
    ch.on('error', () => {});
    ch.connect();
    await assert.rejects(
      ch.llmRequest({ messages: [{ role: 'user', content: 'boom' }] }),
      /no key for provider/
    );
    ch.close();
  });

  it('maps inbound chat messages to run commands', async () => {
    const ch = new ControlChannel('key', 'agent-1');
    ch.on('error', () => {});
    const cmd = new Promise((resolve) => ch.on('command', resolve));
    ch.connect();
    // Wait for the connection to be open before pushing a chat message.
    await waitFor(() => ch.connected);
    connections.at(-1).send(JSON.stringify({ type: 'chat', requestId: 'req_42', message: 'do the thing' }));
    const m = await Promise.race([cmd, new Promise((_, reject) => setTimeout(() => reject(new Error('no command')), 3000))]);
    assert.equal(m.action, 'run');
    assert.equal(m.runId, 'req_42');
    assert.equal(m.payload.task, 'do the thing');
    ch.close();
  });
});
