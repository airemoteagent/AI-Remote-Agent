// HTTP API client — direct communication with the mona.expert control plane.
// Works alongside the WebSocket control channel. Use for:
//   - Sending chat messages and getting responses
//   - Executing tools directly  
//   - Testing connectivity
//   - Managing agent registration
//
// Supports both sngine-based (agent.mona.expert) and Docker-based platforms.

import { CLOUD, DEFAULTS } from './config.js';
import { log } from './log.js';

const UA = `mona-agent/${DEFAULTS.version}`;
const P = CLOUD.paths; // platform-aware API paths

// ── Generic fetch with auth ───────────────────────────────────────
async function apiFetch(apiKey, path, { method = 'GET', body, signal, headers: extraHeaders } = {}) {
  const url = CLOUD.base + path;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'user-agent': UA,
    'x-mona-agent': DEFAULTS.version,
    ...(extraHeaders || {}),
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    let text;
    try { text = await res.text(); } catch { text = ''; }
    const err = new Error(`API ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// ── Health check ──────────────────────────────────────────────────
export async function checkHealth(apiKey) {
  try {
    const res = await apiFetch(apiKey, P.health);
    const data = await res.json();
    // Normalize response
    return {
      ok: true,
      uptime: data.uptime || data.ok ? 1 : 0,
      platform: CLOUD.platform,
      ...data,
    };
  } catch (err) {
    return { ok: false, error: err.message, platform: CLOUD.platform };
  }
}

// ── Verify API key ────────────────────────────────────────────────
export async function verifyKey(apiKey) {
  const res = await apiFetch(apiKey, P.verifyKey, { method: 'GET' });
  return res.json();
}

// ── Send chat message ─────────────────────────────────────────────
export async function sendChat(apiKey, agentId, message) {
  const res = await apiFetch(apiKey, P.chat(agentId), {
    method: 'POST',
    body: { message },
  });
  return res.json();
}

// ── Execute tool directly via API ─────────────────────────────────
export async function execTool(apiKey, agentId, tool, args) {
  const res = await apiFetch(apiKey, P.toolExec(agentId), {
    method: 'POST',
    body: { tool, args },
  });
  return res.json();
}

// ── List agents ───────────────────────────────────────────────────
export async function listAgents(apiKey) {
  // Sngine returns array directly, Docker returns { ok: true, agents: [...] }
  const res = await apiFetch(apiKey, P.agents);
  const data = await res.json();
  if (Array.isArray(data)) return data;
  return data.agents || data.agent || data;
}

// ── Get agent status ──────────────────────────────────────────────
export async function getAgent(apiKey, agentId) {
  const res = await apiFetch(apiKey, P.agents + '/' + agentId);
  return res.json();
}

// ── Stream reasoning from cloud (SSE) ─────────────────────────────
export async function think({ apiKey, messages, tools, onChunk, onUsage, signal }) {
  const res = await apiFetch(apiKey, P.think, {
    method: 'POST',
    body: { messages, tools, stream: true },
  });

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return full;
        try {
          const j = JSON.parse(payload);
          if (j.delta) {
            full += j.delta;
            onChunk?.(j.delta);
          }
          if (j.usage) onUsage?.(j.usage);
        } catch {
          // Skip malformed keepalive lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return full;
}

// ── Force connection test ─────────────────────────────────────────
export async function testConnection(apiKey, targetUrl) {
  // Override base temporarily if targetUrl provided
  const base = targetUrl || CLOUD.base;
  const results = {};

  try {
    log.info(`Testing ${base}...`);

    // 1. Health check
    results.health = await checkHealth(apiKey);

    // 2. Verify auth
    try {
      results.auth = await verifyKey(apiKey);
    } catch (err) {
      results.auth = { error: err.message };
    }

    // 3. List agents
    try {
      const agents = await listAgents(apiKey);
      results.agents = agents;
    } catch (err) {
      results.agents = { error: err.message };
    }
  } catch (err) {
    results.error = err.message;
  }

  return results;
}
