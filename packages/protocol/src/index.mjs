/**
 * mona.expert wire contract — the single source of truth for the device  gateway
 * WebSocket protocol. The daemon (apps/desktop) and the gateway (apps/gateway)
 * implement this; `test/protocol.test.mjs` fails if they drift apart.
 *
 * Every frame is JSON: { v: 1, type, ts, agentId?, data }. `v` is the protocol
 * version — always sent, always checked. Unknown versions are rejected at
 * connect time, so an old device can never silently speak a broken dialect.
 */

export const PROTOCOL_VERSION = 1;

/** Close codes the gateway uses to permanently reject a connection. */
export const CLOSE_CODES = Object.freeze({
  UNAUTHORIZED: 4001,   // bad / expired key — device must re-login
  REVOKED: 4003,        // device or agent revoked — terminal
  PROTOCOL: 4002,       // unsupported protocol version
});

export const isTerminalClose = (code) =>
  code === CLOSE_CODES.UNAUTHORIZED || code === CLOSE_CODES.REVOKED || code === CLOSE_CODES.PROTOCOL;

/** Message types. `device ` frames are sent by the daemon; `gateway ` by the control plane. */
export const IDENTITY_ALGORITHM = 'Ed25519';

export function enrollmentPayload({ deviceId, tenantId, publicKey, nonce, ts }) {
  if (![deviceId, tenantId, publicKey, nonce, ts].every(Boolean)) throw new TypeError('enrollment fields are required');
  return { deviceId: String(deviceId), tenantId: String(tenantId), publicKey: String(publicKey), nonce: String(nonce), ts: Number(ts) };
}

export const TYPES = Object.freeze({
  /* handshake (device ) */
  HELLO: 'hello',
  HELLO_OK: 'hello.ok',           // gateway  { heartbeatIntervalMs, permissions }
  /* registration */
  REGISTER: 'register',           // device  device fingerprint / name
  /* commands (gateway  device  gateway) */
  COMMAND: 'command',             // gateway  { id, tool, args, timeoutMs, requestId }
  COMMAND_RESULT: 'command.result', // device  { id, ok, output, error, durationMs }
  COMMAND_ERROR: 'command.error',   // device  { id, error }
  /* reasoning stream (device reports steps the engine asked it to take) */
  AGENT_STEP: 'agent.step',       // device  { runId, name, detail }
  AGENT_TOKEN: 'agent.token',     // device  { runId, text }   (kept for TUI streaming)
  AGENT_RESULT: 'agent.result',   // device  { runId, ok, text, usage, error }
  AGENT_LOG: 'agent.log',         // device  { level, message } (daemon diagnostics)
  /* telemetry (device ) */
  DEVICE_METRICS: 'device.metrics',
  /* liveness */
  PING: 'ping',
  PONG: 'pong',
  /* dashboard chat RPC (legacy docker-platform compatibility) */
  CHAT: 'chat',
  CHAT_RESPONSE: 'chat:response',
  LLM_REQUEST: 'llm:request',
  LLM_RESPONSE: 'llm:response',
  LLM_ERROR: 'llm:error',
});

/** Device capability shape announced in `hello`. The gateway turns this into agent_permissions. */
export function capabilities({ tools = [], shell = null }) {
  return { tools: [...tools], shell: shell ? { ...shell } : null };
}

/** Build a versioned envelope. */
export function envelope(type, data = {}, { agentId = null, ts = Date.now() } = {}) {
  const msg = { v: PROTOCOL_VERSION, type, ts };
  if (agentId != null) msg.agentId = agentId;
  msg.data = data;
  return msg;
}

/** Parse a raw frame; returns null for non-protocol JSON (keep-alives, garbage). */
export function parseFrame(raw) {
  try {
    const msg = JSON.parse(raw.toString());
    if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') return null;
    return msg;
  } catch {
    return null;
  }
}

/** Validate the protocol version on a parsed frame. */
export function checkVersion(msg) {
  if (msg.v === undefined) return false;          // v1 tolerated as "implicit v1"? No: v is mandatory.
  return Number(msg.v) === PROTOCOL_VERSION;
}

const COMMAND_MAX_AGE_MS = 5 * 60 * 1000;
const COMMAND_MAX_FUTURE_MS = 30 * 1000;
const COMMAND_MAX_ENTRIES = 2048;

/**
 * Validate and replay-protect a versioned command frame.
 * `seen` is a caller-owned Map so each control channel has an isolated cache.
 */
export function validateCommandFrame(msg, {
  now = Date.now(),
  seen = new Map(),
  maxAgeMs = COMMAND_MAX_AGE_MS,
  maxFutureMs = COMMAND_MAX_FUTURE_MS,
  maxEntries = COMMAND_MAX_ENTRIES,
} = {}) {
  if (!msg || typeof msg !== 'object' || !checkVersion(msg) || msg.type !== TYPES.COMMAND) {
    return { ok: false, reason: 'invalid-command-frame' };
  }
  if (!Number.isFinite(msg.ts) || msg.ts < now - maxAgeMs || msg.ts > now + maxFutureMs) {
    return { ok: false, reason: 'stale-command-frame' };
  }
  const data = msg.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'invalid-command-data' };
  }
  if (typeof data.id !== 'string' || data.id.length === 0 || data.id.length > 256 ||
      typeof data.requestId !== 'string' || data.requestId.length === 0 || data.requestId.length > 256) {
    return { ok: false, reason: 'missing-command-identity' };
  }
  const key = `${data.id}:${data.requestId}`;
  const previous = seen.get(key);
  if (previous !== undefined && previous > now - maxAgeMs) {
    return { ok: false, reason: 'replayed-command' };
  }
  seen.set(key, now);
  for (const [entry, timestamp] of seen) {
    if (timestamp <= now - maxAgeMs) seen.delete(entry);
  }
  while (seen.size > maxEntries) seen.delete(seen.keys().next().value);
  return { ok: true, key };
}
