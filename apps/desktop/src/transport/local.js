// transport/local.js — bring-your-own-key (BYO) local brain transport.
//
// The framework pivot's P5 work package: run the reasoning loop fully
// on-device against a user-supplied LLM instead of the cloud brain.
// Three providers, one interface, zero dependencies:
//
//   - anthropic   https://api.anthropic.com/v1/messages
//   - openai      any OpenAI-compatible /chat/completions endpoint
//                 (OpenAI, OpenRouter, Groq, LM Studio, vLLM, …)
//   - ollama      local models at http://localhost:11434/api/chat
//
// Streaming tokens surface through onChunk; usage is mapped to the
// engine's {input, output, total, costUsd} shape so the budget governor
// keeps working; BYO cost is priced from a local table (overridable),
// which is also the cost-governance trace for bring-your-own keys.
//
// Credentials: ~/.remote-agent/provider.json (0600) with env fallbacks.
// The cloud can never read or change this file — it is device-local by
// construction, exactly like policy.json.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DIR = join(homedir(), '.remote-agent');
const DEFAULT_FILE = join(DIR, 'provider.json');

export const PROVIDERS = ['anthropic', 'openai', 'ollama'];

// Defaults per provider. baseUrl may be overridden per provider.json.
const PROVIDER_DEFAULTS = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-20241022' },
  openai:    { baseUrl: 'https://api.openai.com',     model: 'gpt-4o-mini' },
  ollama:    { baseUrl: 'http://127.0.0.1:11434',     model: 'llama3.2' },
};

// ── Price table ($ per 1M tokens) — cost governance for BYO keys ──
// Conservative defaults; override per config ("prices": {"input":..,"output":..}).
function defaultPrices(provider, model = '') {
  if (provider === 'ollama') return { input: 0, output: 0 }; // local models: tokens are free
  const m = String(model).toLowerCase();
  if (m.includes('opus'))    return { input: 15, output: 75 };
  if (m.includes('sonnet'))  return { input: 3,  output: 15 };
  if (m.includes('haiku'))   return { input: 0.8, output: 4 };
  if (m.includes('o1') || m.includes('o3')) return { input: 15, output: 60 };
  if (m.includes('gpt-4o-mini')) return { input: 0.15, output: 0.6 };
  if (m.includes('gpt-4o')) return { input: 2.5, output: 10 };
  if (m.includes('gpt-4'))  return { input: 30, output: 60 };
  if (m.includes('gpt-3.5')) return { input: 0.5, output: 1.5 };
  if (provider === 'anthropic') return { input: 3, output: 15 };
  return { input: 2.5, output: 10 };
}

export function pricesFor(provider, model, override = null) {
  const base = defaultPrices(provider, model);
  return {
    input:  Number(override?.input ?? base.input),
    output: Number(override?.output ?? base.output),
  };
}

/** Cost in USD from token counts (per-1M pricing). */
export function tokenCost(provider, model, input, output, override = null) {
  const p = pricesFor(provider, model, override);
  return (input * p.input + output * p.output) / 1_000_000;
}

// ── Config load/save ──────────────────────────────────────────────
/**
 * Load the BYO provider config. Resolution order:
 *   1. REMOTE_PROVIDER + env (REMOTE_PROVIDER_KEY/URL/MODEL)
 *   2. REMOTE_PROVIDER_FILE (explicit path, used by tests)
 *   3. ~/.remote-agent/provider.json
 * Returns null when no provider is configured.
 */
export function loadProviderConfig({ env = process.env } = {}) {
  let fileCfg = null;
  const path = env.REMOTE_PROVIDER_FILE || DEFAULT_FILE;
  if (existsSync(path)) {
    try {
      fileCfg = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`provider.json is not valid JSON (${path}): ${err.message}`);
    }
  }

  const envProvider = env.REMOTE_PROVIDER || null;
  if (!envProvider && !fileCfg) return null;

  const provider = (envProvider || fileCfg?.provider || '').toLowerCase();
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider "${provider}" — expected one of: ${PROVIDERS.join(', ')}`);
  }
  const defaults = PROVIDER_DEFAULTS[provider];
  const cfg = {
    provider,
    apiKey:      env.REMOTE_PROVIDER_KEY ?? fileCfg?.apiKey ?? null,
    baseUrl:     (env.REMOTE_PROVIDER_URL || fileCfg?.baseUrl || defaults.baseUrl).replace(/\/+$/, ''),
    model:       env.REMOTE_PROVIDER_MODEL || fileCfg?.model || defaults.model,
    prices:      fileCfg?.prices && typeof fileCfg.prices === 'object' ? fileCfg.prices : null,
    enabled:     fileCfg?.enabled !== false,
    file:        path,
  };
  if (provider !== 'ollama' && !cfg.apiKey) {
    throw new Error(`provider "${provider}" needs an API key — set REMOTE_PROVIDER_KEY or run: remote-agent provider set ${provider}`);
  }
  return cfg;
}

/** Save provider config (0600, atomic-ish, outside the install dir). */
export function saveProviderConfig({ provider, apiKey = null, baseUrl = null, model = null, prices = null, enabled = true, env = process.env }) {
  const p = (provider || '').toLowerCase();
  if (!PROVIDERS.includes(p)) throw new Error(`Unknown provider "${provider}" — expected one of: ${PROVIDERS.join(', ')}`);
  const path = env.REMOTE_PROVIDER_FILE || DEFAULT_FILE;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existing = existsSync(path) ? safeParse(readFileSync(path, 'utf8')) : {};
  const next = {
    ...existing,
    provider: p,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl: baseUrl.replace(/\/+$/, '') } : {}),
    ...(model ? { model } : {}),
    ...(prices ? { prices } : {}),
    ...(enabled === false ? { enabled: false } : { enabled: true }),
  };
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return loadProviderConfig({ env });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

export function removeProviderConfig({ env = process.env } = {}) {
  const path = env.REMOTE_PROVIDER_FILE || DEFAULT_FILE;
  if (existsSync(path)) {
    try { unlinkSync(path); return true; } catch { return false; }
  }
  return false;
}

// ── Streaming body reader (SSE + NDJSON) ──────────────────────────
async function streamLines(res, onLine, onDone) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text().catch(() => '');
    onDone(text);
    return;
  }
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) onLine(line);
    }
    if (buf.trim()) onLine(buf);
  } finally {
    reader.releaseLock();
  }
  onDone(null);
}

// ── Anthropic adapter ─────────────────────────────────────────────
async function anthropicChat({ config, messages, temperature, onChunk, signal }) {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') }));

  const res = await fetch(`${config.baseUrl}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
      messages: rest,
      stream: true,
      ...(temperature != null ? { temperature } : {}),
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`Anthropic API ${res.status}: ${t.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  // Plain JSON (non-streaming) — parse once, done.
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    const j = await res.json();
    const inputTokens = j.usage?.input_tokens || 0;
    const outputTokens = j.usage?.output_tokens || 0;
    return {
      text: (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
      model: j.model || null,
      provider: 'anthropic',
      usage: {
        input: inputTokens, output: outputTokens, total: inputTokens + outputTokens,
        costUsd: tokenCost('anthropic', j.model, inputTokens, outputTokens, config.prices),
      },
    };
  }

  let full = '';
  let model = null;
  let inputTokens = 0;
  let outputTokens = 0;
  await streamLines(res, (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    try {
      const j = JSON.parse(payload);
      if (j.type === 'message_start') {
        model = j.message?.model || model;
        inputTokens = j.message?.usage?.input_tokens || 0;
      } else if (j.type === 'content_block_delta' && j.delta?.text) {
        full += j.delta.text;
        onChunk?.(j.delta.text);
      } else if (j.type === 'message_delta') {
        outputTokens = j.usage?.output_tokens || outputTokens;
      }
    } catch { /* ignore keepalives */ }
  }, () => {});

  const total = inputTokens + outputTokens;
  return {
    text: full,
    model,
    provider: 'anthropic',
    usage: {
      input: inputTokens,
      output: outputTokens,
      total,
      costUsd: tokenCost('anthropic', model, inputTokens, outputTokens, config.prices),
    },
  };
}

// ── OpenAI-compatible adapter ─────────────────────────────────────
async function openaiChat({ config, messages, temperature, onChunk, signal }) {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: messages.map((m) => ({ role: m.role, content: String(m.content ?? '') })),
      stream: true,
      ...(temperature != null ? { temperature } : {}),
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`OpenAI API ${res.status}: ${t.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  // Plain JSON (non-streaming) — parse once, done.
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    const j = await res.json();
    const u = j.usage || {};
    const input = u.prompt_tokens || 0;
    const output = u.completion_tokens || 0;
    return {
      text: j.choices?.[0]?.message?.content || '',
      model: j.model || null,
      provider: 'openai',
      usage: {
        input, output, total: input + output,
        costUsd: tokenCost('openai', j.model, input, output, config.prices),
      },
    };
  }

  let full = '';
  let model = null;
  let usage = { input: 0, output: 0, total: 0 };
  await streamLines(res, (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    try {
      const j = JSON.parse(payload);
      model = j.model || model;
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) { full += delta; onChunk?.(delta); }
      if (j.usage) {
        usage = {
          input: j.usage.prompt_tokens || 0,
          output: j.usage.completion_tokens || 0,
          total: j.usage.total_tokens || 0,
        };
      }
    } catch { /* ignore */ }
  }, () => {});

  return {
    text: full,
    model,
    provider: 'openai',
    usage: {
      input: usage.input,
      output: usage.output,
      total: usage.total,
      costUsd: tokenCost('openai', model, usage.input, usage.output, config.prices),
    },
  };
}

// ── Ollama adapter (NDJSON) ───────────────────────────────────────
async function ollamaChat({ config, messages, temperature, onChunk, signal }) {
  const res = await fetch(`${config.baseUrl}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: messages.map((m) => ({ role: m.role, content: String(m.content ?? '') })),
      stream: true,
      ...(temperature != null ? { options: { temperature } } : {}),
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`Ollama API ${res.status}: ${t.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  // Plain JSON (non-streaming) — parse once, done.
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    const j = await res.json();
    return {
      text: j.message?.content || '',
      model: j.model || null,
      provider: 'ollama',
      usage: { input: j.prompt_eval_count || 0, output: j.eval_count || 0, total: (j.prompt_eval_count || 0) + (j.eval_count || 0), costUsd: 0 },
    };
  }

  let full = '';
  let model = null;
  let inputTokens = 0;
  let outputTokens = 0;
  await streamLines(res, (line) => {
    if (!line.trim()) return;
    try {
      const j = JSON.parse(line);
      model = j.model || model;
      const piece = j.message?.content;
      if (piece) { full += piece; onChunk?.(piece); }
      if (j.done) {
        inputTokens = j.prompt_eval_count || 0;
        outputTokens = j.eval_count || 0;
      }
    } catch { /* ignore */ }
  }, () => {});

  const total = inputTokens + outputTokens;
  return {
    text: full,
    model,
    provider: 'ollama',
    usage: { input: inputTokens, output: outputTokens, total, costUsd: 0 }, // local models: $0
  };
}

const ADAPTERS = { anthropic: anthropicChat, openai: openaiChat, ollama: ollamaChat };

/**
 * Local brain think — the BYO counterpart of cloud think().
 * Same return contract: { text, usage, model, provider }.
 */
export async function localThink({ config, messages, temperature = null, onChunk, onUsage, signal }) {
  const adapter = ADAPTERS[config.provider];
  const out = await adapter({ config, messages, temperature, onChunk, signal });
  if (out.usage) onUsage?.(out.usage);
  return out;
}

/** Is the local transport explicitly requested via REMOTE_TRANSPORT? */
export function transportMode(env = process.env) {
  return String(env.REMOTE_TRANSPORT || 'auto').toLowerCase();
}

/** Fail-fast check for `remote-agent start` when REMOTE_TRANSPORT=local. */
export function requireLocalProvider() {
  const cfg = loadProviderConfig();
  if (!cfg) {
    throw new Error('REMOTE_TRANSPORT=local but no provider is configured — run: remote-agent provider set <anthropic|openai|ollama>');
  }
  return cfg;
}

/** One-shot smoke test used by `remote-agent provider test`. */
export async function providerTest(config, prompt = 'Reply with exactly: OK') {
  const started = Date.now();
  const res = await localThink({
    config,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
  });
  return {
    ok: Boolean(res.text),
    text: res.text?.slice(0, 200) || '',
    model: res.model || config.model,
    provider: res.provider || config.provider,
    usage: res.usage,
    durationMs: Date.now() - started,
  };
}
