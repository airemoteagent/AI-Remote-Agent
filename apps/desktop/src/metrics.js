// metrics.js — localhost-only /healthz + /metrics (Prometheus text format).
//
// Enabled with REMOTE_METRICS_PORT (default: off). The listener binds to
// 127.0.0.1 only — it is health/observability for local tooling
// (systemd, Docker HEALTHCHECK, scrapers on the same host), never a
// public surface. The daemon stays egress-only.

import http from 'node:http';
import { VERSION } from './version.js';

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {() => object} opts.getState — returns { connected, uptimeS,
 *   tasks, toolCalls, errors, budget: {costUsd}, queue: {size} }
 * @returns {() => Promise<void>} disposer
 */
export function startMetricsServer({ port, getState }) {
  const server = http.createServer((req, res) => {
    const state = getState?.() ?? {};

    if (req.url === '/healthz' || req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        version: VERSION,
        connected: Boolean(state.connected),
        uptimeS: state.uptimeS ?? 0,
        queue: state.queue?.size ?? 0,
      }));
      return;
    }

    if (req.url === '/metrics') {
      const lines = [
        '# HELP remote_agent_up Whether the agent daemon is up.',
        '# TYPE remote_agent_up gauge',
        'remote_agent_up 1',
        '# HELP remote_agent_tasks_total Total tasks run.',
        '# TYPE remote_agent_tasks_total counter',
        `remote_agent_tasks_total ${state.tasks ?? 0}`,
        '# HELP remote_agent_tool_calls_total Total tool calls executed.',
        '# TYPE remote_agent_tool_calls_total counter',
        `remote_agent_tool_calls_total ${state.toolCalls ?? 0}`,
        '# HELP remote_agent_errors_total Total task errors.',
        '# TYPE remote_agent_errors_total counter',
        `remote_agent_errors_total ${state.errors ?? 0}`,
        '# HELP remote_agent_connected Control-plane connection (1=up).',
        '# TYPE remote_agent_connected gauge',
        `remote_agent_connected ${state.connected ? 1 : 0}`,
        '# HELP remote_agent_budget_spent_usd Daily budget spent (USD).',
        '# TYPE remote_agent_budget_spent_usd gauge',
        `remote_agent_budget_spent_usd ${state.budget?.costUsd ?? 0}`,
        '# HELP remote_agent_queue_size Tasks waiting in the serial queue.',
        '# TYPE remote_agent_queue_size gauge',
        `remote_agent_queue_size ${state.queue?.size ?? 0}`,
      ];
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(lines.join('\n') + '\n');
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });

  server.on('error', () => { /* port taken — metrics are optional */ });
  server.listen(port, '127.0.0.1');

  return () => new Promise((resolve) => server.close(() => resolve()));
}
