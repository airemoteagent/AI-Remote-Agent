// Cloud API client — all LLM reasoning runs remotely on agent.mona.expert.
// Supports both sngine-based (agent.mona.expert) and Docker-based platforms.
// This device sends prompts up and receives streamed reasoning back.
// No LLM provider keys are ever stored or used locally.

import { CLOUD, DEFAULTS } from './config.js';
import { log } from './log.js';

const UA = `mona-agent/${DEFAULTS.version}`;
const P = CLOUD.paths; // platform-aware API paths

// ── Generic API fetch ─────────────────────────────────────────────
async function apiFetch(path, { apiKey, method = 'POST', body, signal, headers: extraHeaders } = {}) {
  const url = CLOUD.base + path;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'content-type':  'application/json',
    'user-agent':    UA,
    'x-mona-agent':  DEFAULTS.version,
    ...(extraHeaders || {}),
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Cloud API ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// ── Verify API key ────────────────────────────────────────────────
export async function verifyKey(apiKey) {
  const res = await apiFetch(P.verifyKey, { apiKey, method: 'GET' });
  return res.json();
}

// ── WAF-safe bodies ────────────────────────────────────────────────
// Shared-hosting WAFs (ModSecurity on LiteSpeed) intermittently 403 JSON
// bodies that contain shell-like strings (tool results ride inside think
// payloads). Base64-encoding keeps the transport neutral; the server
// decodes before processing. Auth and validation stay server-side.
function b64Body(obj) {
  return { b64: Buffer.from(JSON.stringify(obj)).toString('base64') };
}

// ── Stream reasoning from cloud brain ─────────────────────────────
// Calls the cloud LLM endpoint and streams tokens back via SSE.
// onChunk(text)  — called per delta token
// onUsage(usage) — called with final token counts (if provided)
// Returns { text, usage, model, provider } — usage is null when the
// cloud did not report it (older server or plain JSON without usage).
export async function think({ apiKey, messages, tools, onChunk, onUsage, signal, temperature, profile }) {
  const res = await apiFetch(P.think, {
    apiKey,
    body: b64Body({ messages, tools, stream: true, temperature, profile }),
    signal,
  });

  // Handle both SSE streaming and plain JSON responses
  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream')) {
    // SSE streaming
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    let usage = null;
    let model = null;
    let provider = null;

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
          if (payload === '[DONE]') {
            return { text: full, usage, model, provider };
          }
          try {
            const j = JSON.parse(payload);
            if (j.delta) {
              full += j.delta;
              onChunk?.(j.delta);
            }
            if (j.usage) { usage = j.usage; onUsage?.(j.usage); }
            if (j.model) model = j.model;
            if (j.provider) provider = j.provider;
          } catch {
            // Skip malformed or keepalive lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return { text: full, usage, model, provider };
  }

  // Plain JSON response
  const data = await res.json();
  return {
    text: data.content || data.text || JSON.stringify(data),
    usage: data.usage || null,
    model: data.model || null,
    provider: data.provider || null,
  };
}

// ── Report tool result to cloud ───────────────────────────────────
export async function reportToolResult(apiKey, agentId, tool, result) {
  return apiFetch(P.toolResult, {
    apiKey,
    body: b64Body({ agentId, tool, result }),
  });
}

// ── Cloud task queue (sngine platform — device polls for work) ────
// The response carries the task rows plus the owner's brain config
// (step budget, temperature, extra rules) so the loop can tune itself.
export async function pollTasks(apiKey) {
  const res = await apiFetch('/api/v1/agent/tasks', { apiKey, method: 'GET' });
  const data = await res.json();
  return data || { tasks: [] };
}

export async function claimTask(apiKey, id) {
  return apiFetch('/api/v1/agent/tasks/claim', { apiKey, body: { id } });
}

export async function taskResult(apiKey, id, { result, steps }) {
  return apiFetch(`/api/v1/agent/tasks/${id}/result`, { apiKey, body: b64Body({ result, steps }) });
}

export async function postActivity(apiKey, type, detail, runId, agentId) {
  return apiFetch('/api/v1/agent/activity', { apiKey, body: b64Body({ type, detail, runId, agentId }) });
}

// ── Run trace lifecycle (deep insight: per-step usage, tokens, cost) ──
// Best-effort: the task loop never depends on these succeeding.
export async function runStart(apiKey, { runId, agentId, taskId, message }) {
  return apiFetch('/api/v1/agent/runs', { apiKey, body: b64Body({ runId, agentId, taskId, message }) });
}

export async function runStep(apiKey, runId, step) {
  return apiFetch(`/api/v1/agent/runs/${runId}/step`, { apiKey, body: b64Body(step) });
}

export async function runFinish(apiKey, runId, fin) {
  return apiFetch(`/api/v1/agent/runs/${runId}/finish`, { apiKey, body: b64Body(fin) });
}
