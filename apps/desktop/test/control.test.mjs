// Control-channel tests: reconnect backoff, queue flush, terminal close codes.
// Run: node --test test/control.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

const server = new WebSocketServer({ port: 0 });
const port = server.address().port;
const url = `ws://127.0.0.1:${port}/ws?role=device`;

// ControlChannel reads CLOUD.wsUrl at import time — import after env is set.
process.env.REMOTE_CLOUD_WS = url;
const { ControlChannel } = await import('../src/control.js');

let connections = 0;
let closeCode = null;
let lastHello = null;
server.on('connection', (ws) => {
  connections++;
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'hello') {
      lastHello = msg;
      ws.send(JSON.stringify({ type: 'pong', data: {} }));
    }
  });
  if (closeCode !== null) {
    // 1006 is reserved and can never be sent as a close frame — terminate()
    // is what produces a real 1006 (abnormal closure) on the client side.
    if (closeCode === 1006) ws.terminate();
    else ws.close(closeCode);
  }
});

const reset = () => { connections = 0; lastHello = null; };

// terminate() produces an ECONNRESET on the client — expected in the 1006 test.
const quiet = (ch) => ch.on('error', () => {});

describe('control channel', () => {
  before(() => { server.on('connection', () => {}); });
  after(() => server.close());

  it('emits auth-failed and stops on terminal close code 4001', async () => {
    reset();
    closeCode = 4001;
    const ch = new ControlChannel('test-key', 'agent-1');
    const events = [];
    quiet(ch);
    ch.on('auth-failed', (code) => events.push(['auth-failed', code]));

    await new Promise((resolve) => {
      ch.on('disconnected', () => setTimeout(resolve, 100));
      ch.connect();
    });

    assert.equal(events.length, 1);
    assert.equal(events[0][1], 4001);
    assert.equal(ch.stopped, true);

    // No reconnect loop: allow one backoff cycle, assert no new connection.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(connections, 1);
    ch.close();
  });

  it('emits auth-failed and stops on terminal close code 4003 (revoked)', async () => {
    reset();
    closeCode = 4003;
    const ch = new ControlChannel('test-key', 'agent-1');
    let failed = false;
    quiet(ch);
    ch.on('auth-failed', () => { failed = true; });

    await new Promise((resolve) => {
      ch.on('disconnected', () => setTimeout(resolve, 100));
      ch.connect();
    });

    assert.equal(failed, true);
    assert.equal(ch.stopped, true);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(connections, 1);
    ch.close();
  });

  it('reconnects with backoff after a transient close (1006)', async () => {
    reset();
    closeCode = 1006;
    const ch = new ControlChannel('test-key', 'agent-1');
    quiet(ch);

    // A second disconnect can only happen after a reconnect — wait for it.
    let disconnects = 0;
    const reconnected = new Promise((resolve, reject) => {
      ch.on('disconnected', () => {
        if (++disconnects >= 2) resolve(true);
      });
      ch.connect();
      setTimeout(() => reject(new Error('no reconnect within 5s')), 5000);
    });

    assert.equal(await reconnected, true);
    assert.ok(connections >= 2, `expected a reconnect, saw ${connections} connection(s)`);
    closeCode = null;
    ch.close();
  });

  it('queues messages until open, then flushes', async () => {
    reset();
    closeCode = null;
    const ch = new ControlChannel('test-key', 'agent-1');
    let flushed = false;
    quiet(ch);
    ch.connect();
    ch.step('test', { n: 1 }); // sent before open  queued

    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (connections === 1) { flushed = true; clearInterval(timer); resolve(); }
      }, 50);
    });
    assert.equal(flushed, true);
    ch.close();
  });

  it('sends v:1 envelope and announces capabilities in hello', async () => {
    reset();
    closeCode = null;
    const caps = {
      tools: [{ name: 'sysinfo', description: 'System information' }],
      shell: { allowlist: ['df', 'uptime'], unsafe: false, platform: 'darwin' },
    };
    const ch = new ControlChannel('test-key', 'agent-1', caps);
    quiet(ch);
    ch.connect();

    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (lastHello) { clearInterval(timer); resolve(); }
      }, 25);
    });

    assert.equal(lastHello.v, 1);
    assert.equal(lastHello.agentId, 'agent-1');
    assert.ok(Array.isArray(lastHello.data.capabilities.tools));
    assert.equal(lastHello.data.capabilities.tools[0].name, 'sysinfo');
    assert.deepEqual(lastHello.data.capabilities.shell.allowlist, ['df', 'uptime']);
    assert.ok(lastHello.data.host);
    assert.ok(lastHello.data.version);
    ch.close();
  });

  it('streams extended metrics (cpu/mem/disk percent)', async () => {
    reset();
    closeCode = null;
    const ch = new ControlChannel('test-key', 'agent-1', null, { metricsIntervalMs: 120 });
    quiet(ch);
    const got = new Promise((resolve) => ch.on('metrics', resolve));
    ch.connect();

    const m = await Promise.race([
      got,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no metrics within 3s')), 3000)),
    ]);

    assert.equal(typeof m.cpuPercent, 'number');
    assert.ok(m.cpuPercent >= 0 && m.cpuPercent <= 100);
    assert.ok(m.mem.percent >= 0 && m.mem.percent <= 100);
    assert.equal(typeof m.mem.used, 'number');
    assert.equal(typeof m.diskPercent, 'number');
    assert.equal(typeof m.uptimeSeconds, 'number');
    assert.ok(m.cpuModel);
    // Backward-compatible fields the TUI depends on:
    assert.equal(typeof m.mem.total, 'number');
    assert.equal(typeof m.mem.free, 'number');
    assert.ok(Array.isArray(m.cpuLoad));
    ch.close();
  });
});
