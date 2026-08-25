// Metrics server — localhost /healthz + /metrics (Prometheus text).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { startMetricsServer } = await import('../src/metrics.js');

const PORT = 4399;
let stop;
let state = {
  connected: true,
  uptimeS: 42,
  tasks: 3,
  toolCalls: 7,
  errors: 1,
  budget: { costUsd: 0.0042 },
  queue: { size: 2 },
};

before(() => {
  stop = startMetricsServer({ port: PORT, getState: () => state });
});

after(async () => {
  await stop?.();
});

describe('metrics server', () => {
  it('GET /healthz reports ok + version + state', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.match(j.version, /^\d+\.\d+\.\d+/);
    assert.equal(j.connected, true);
    assert.equal(j.uptimeS, 42);
    assert.equal(j.queue, 2);
  });

  it('GET /metrics emits prometheus counters and gauges', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/metrics`);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /remote_agent_up 1/);
    assert.match(text, /remote_agent_tasks_total 3/);
    assert.match(text, /remote_agent_tool_calls_total 7/);
    assert.match(text, /remote_agent_errors_total 1/);
    assert.match(text, /remote_agent_connected 1/);
    assert.match(text, /remote_agent_budget_spent_usd 0.0042/);
    assert.match(text, /remote_agent_queue_size 2/);
  });

  it('unknown paths 404', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/nope`);
    assert.equal(r.status, 404);
  });

  it('live state changes are reflected', async () => {
    state.connected = false;
    const r = await fetch(`http://127.0.0.1:${PORT}/metrics`);
    const text = await r.text();
    assert.match(text, /remote_agent_connected 0/);
    state.connected = true;
  });
});
