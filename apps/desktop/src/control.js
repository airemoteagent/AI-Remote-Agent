// WebSocket control channel — the device dials OUT to agent.mona.expert.
// The WEBSITE is the controller: it sends commands down; the device executes
// them and streams metrics, steps, tokens, and results back up.
// There is NO local server and NO local UI served over HTTP.

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import os from 'node:os';
import { statfsSync } from 'node:fs';
import { CLOUD, DEFAULTS } from './config.js';
import { log } from './log.js';
import { envelope, TYPES, isTerminalClose, parseFrame, checkVersion, validateCommandFrame, CLOSE_CODES } from '@mona/protocol';

// ── Versioned frames ──────────────────────────────────────────────
// Every outbound frame is built with the shared wire contract
// (packages/protocol) so the daemon and the gateway can never drift apart.
// Inbound frames are validated the same way: unknown protocol versions are
// rejected at connect time with the protocol close code.

/** Sampled CPU busy ratio — two os.cpus() readings 100ms apart. */
async function cpuPercent() {
  const a = os.cpus();
  await new Promise((r) => setTimeout(r, 100));
  const b = os.cpus();
  let idle = 0, total = 0;
  for (let i = 0; i < a.length; i++) {
    const ta = a[i].times, tb = b[i].times;
    idle += tb.idle - ta.idle;
    for (const k of Object.keys(tb)) total += tb[k] - ta[k];
  }
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0;
}

/** Used disk % on the device's home volume. */
function diskPercent() {
  try {
    const s = statfsSync(os.homedir());
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return total > 0 ? Math.round((1 - free / total) * 1000) / 10 : 0;
  } catch { return null; }
}

export class ControlChannel extends EventEmitter {
  #apiKey;
  #agentId;
  #capabilities;
  #ws = null;
  #queue = [];
  #llmPending = new Map();
  #metricsTimer = null;
  #metricsIntervalMs;
  #backoff = DEFAULTS.reconnectMinMs;
  #reconnectTimer = null;
  #closing = false;
  #stopped = false;
  #wsSkipped = false;
  #commandReplay = new Map();

  constructor(apiKey, agentId, capabilities = null, { metricsIntervalMs } = {}) {
    super();
    this.#apiKey = apiKey;
    this.#agentId = agentId;
    this.#capabilities = capabilities;
    this.#metricsIntervalMs = metricsIntervalMs || DEFAULTS.metricsIntervalMs;
  }

  /**
   * Update the advertised tool list (dynamic plugins loaded after connect).
   * Takes effect on the next hello/reconnect — the running session keeps
   * its initial list, which is fine because the gateway re-queries tools
   * per task anyway.
   */
  syncTools(toolsList) {
    if (toolsList && this.#capabilities && typeof this.#capabilities === 'object') {
      this.#capabilities.tools = toolsList;
    }
  }

  /** Connect (or reconnect) to the cloud. Returns this for chaining. */
  connect() {
    if (this.#closing || this.#stopped) return this;

    // Device metrics stream over HTTPS, independent of the WS link.
    // This keeps the dashboard live even when the WS relay is down
    // (shared hosting has no Node.js).
    this.#startMetrics();

    let url = CLOUD.wsUrl;
    // Docker platform registers agents by agentId in the query string.
    if (CLOUD.platform === 'docker') {
      url += (url.includes('?') ? '&' : '?') + `agentId=${encodeURIComponent(this.#agentId || 'agent-1')}`;
    }
    log.debug(`Connecting to ${url}`);

    this.#ws = new WebSocket(url, {
      headers: {
        'authorization':    `Bearer ${this.#apiKey}`,
        'x-mona-agent-id':  this.#agentId || '',
        'user-agent':        `mona-agent/${DEFAULTS.version}`,
      },
    });

    this.#ws.on('open', () => {
      this.#backoff = DEFAULTS.reconnectMinMs;
      log.info(`Connected to ${new URL(url).host}`);

      if (CLOUD.platform === 'docker') {
        // Docker platform protocol: flat register message, no hello handshake.
        this.#sendFlat('register', { name: os.hostname(), model: `mona-agent/${DEFAULTS.version}` });
      } else {
        this.#send(TYPES.HELLO, {
          agentId:  this.#agentId,
          host:     os.hostname(),
          platform: os.platform(),
          arch:     os.arch(),
          cpus:     os.cpus().length,
          mem:      os.totalmem(),
          version:  DEFAULTS.version,
          capabilities: this.#capabilities,
        });
      }
      this.#flush();
      this.emit('connected');
    });

    this.#ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Shared contract: reject connections that speak an unknown dialect.
      if (msg && typeof msg === 'object' && msg.v !== undefined && !checkVersion(msg)) {
        log.warn(`Peer speaks protocol v${msg.v} — closing (${CLOSE_CODES.PROTOCOL})`);
        this.#ws.close(CLOSE_CODES.PROTOCOL, 'unsupported protocol version');
        return;
      }

      if (msg.type === TYPES.LLM_RESPONSE || msg.type === TYPES.LLM_ERROR) {
        this.#resolveLlm(msg);
      } else if (msg.type === TYPES.COMMAND) {
        const validation = validateCommandFrame(msg, { seen: this.#commandReplay });
        if (!validation.ok) {
          log.warn(`Rejected command frame: ${validation.reason}`);
          return;
        }
        this.emit('command', msg);
      } else if (CLOUD.platform === 'docker' && msg.type === TYPES.CHAT) {
        // Docker dashboard chat  same run flow as a command.
        this.emit('command', { action: 'run', runId: msg.requestId, payload: { task: msg.message } });
      } else if (msg.type === TYPES.PING) {
        this.#send(TYPES.PONG, {});
      } else {
        this.emit('message', msg);
      }
    });

    this.#ws.on('close', (code) => {
      if (this.#closing) return;
      // WS relay absent (HTTP fallback active): no reconnect loop.
      if (this.#wsSkipped) return;
      // Terminal close: the credential itself was rejected — do not loop.
      if (isTerminalClose(code)) {
        this.#stopped = true;
        clearTimeout(this.#reconnectTimer);
        log.error(`Cloud rejected credentials (code ${code}) — stopping. Run: mona-agent login`);
        this.emit('auth-failed', code);
        this.emit('disconnected', code);
        return;
      }
      // Exponential backoff with jitter
      const jitter = Math.random() * this.#backoff * 0.3;
      const wait = Math.min(this.#backoff + jitter, DEFAULTS.reconnectMaxMs);
      this.#backoff = Math.min(this.#backoff * 2, DEFAULTS.reconnectMaxMs);
      log.warn(`Disconnected (code=${code}), reconnecting in ${(wait / 1000).toFixed(1)}s`);
      this.emit('disconnected', code);
      this.#reconnectTimer = setTimeout(() => this.connect(), wait);
    });

    this.#ws.on('error', (err) => {
      // Shared hosting has no WS relay: LiteSpeed answers the upgrade
      // with a normal HTTP response. Skip WS and keep the HTTPS
      // metrics fallback — the dashboard stays live.
      if (CLOUD.platform === 'sngine' && /unexpected server response/i.test(err.message)) {
        if (!this.#wsSkipped) {
          this.#wsSkipped = true;
          log.info('WS relay unavailable on this control plane — device metrics stream via HTTPS');
        }
        return;
      }
      log.error(`WebSocket error: ${err.message}`);
      this.emit('error', err);
    });

    return this;
  }

  /** Send a typed message upstream — every frame is a versioned envelope. */
  #send(type, data) {
    const msg = JSON.stringify(envelope(type, data, { agentId: this.#agentId }));
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(msg);
    } else {
      this.#queue.push(msg);
    }
  }

  /** Send a flat protocol message (docker platform: fields at top level). */
  #sendFlat(type, obj) {
    const msg = JSON.stringify({ type, ts: Date.now(), ...obj });
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(msg);
    } else {
      this.#queue.push(msg);
    }
  }

  #flush() {
    while (this.#queue.length && this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(this.#queue.shift());
    }
  }

  // ── Public emitters (all consumed by the website dashboard) ─────
  step(name, detail)     { if (CLOUD.platform !== 'docker') this.#send(TYPES.AGENT_STEP, { name, detail }); }
  token(delta, runId)    { if (CLOUD.platform !== 'docker') this.#send(TYPES.AGENT_TOKEN, { delta, runId }); }
  result(runId, output)  { if (CLOUD.platform !== 'docker') this.#send(TYPES.AGENT_RESULT, { runId, output }); }
  log(level, message)    { if (CLOUD.platform !== 'docker') this.#send(TYPES.AGENT_LOG, { level, message }); }

  // ── Docker platform protocol ────────────────────────────────────

  /** Reply to a dashboard chat message (docker platform). */
  chatResponse(requestId, message) {
    this.#sendFlat(TYPES.CHAT_RESPONSE, { requestId, message });
  }

  /**
   * Proxy an LLM call through the docker platform (request/response RPC).
   * No provider or model is named — the control plane decides those.
   * @returns {Promise<{content:string, usage?:object, model?:string, finishReason?:string}>}
   */
  llmRequest({ messages, temperature = 0.7 }) {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#llmPending.delete(requestId);
        reject(new Error('LLM request timed out after 120s'));
      }, 120_000);
      this.#llmPending.set(requestId, { resolve, reject, timeout });
      this.#sendFlat(TYPES.LLM_REQUEST, { requestId, messages, temperature });
    });
  }

  #resolveLlm(msg) {
    const p = this.#llmPending.get(msg.requestId);
    if (!p) return;
    clearTimeout(p.timeout);
    this.#llmPending.delete(msg.requestId);
    if (msg.type === 'llm:error') p.reject(new Error(msg.error));
    else p.resolve({ content: msg.content, usage: msg.usage, model: msg.model, finishReason: msg.finishReason });
  }

  /** Current connection state. */
  get connected() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /** True once the cloud has rejected this credential — the daemon is done. */
  get stopped() {
    return this.#stopped;
  }

  // ── Device metrics stream ──────────────────────────────────────
  #startMetrics() {
    if (this.#metricsTimer) return;
    const tick = async () => {
      const totalMem = os.totalmem(), freeMem = os.freemem();
      const cpus = os.cpus();
      const metrics = {
        cpuLoad: os.loadavg(),
        cpuPercent: await cpuPercent(),
        cpuModel: cpus[0]?.model || 'unknown',
        mem: {
          total: totalMem,
          free: freeMem,
          used: totalMem - freeMem,
          percent: Math.round((1 - freeMem / totalMem) * 1000) / 10,
        },
        diskPercent: diskPercent(),
        uptime: os.uptime(),
        uptimeSeconds: os.uptime(),
        cpus: cpus.length,
      };
      if (CLOUD.platform === 'docker') {
        // Docker dashboard shows live agent status from these broadcasts.
        this.#sendFlat('status', { status: 'online', details: metrics });
      } else {
        this.#send(TYPES.DEVICE_METRICS, metrics);
      }
      // HTTP fallback: shared hosting cannot run the Node WS relay,
      // so also push metrics straight to the Sngine PHP API.
      this.#httpStats(metrics);
      this.emit('metrics', metrics);
    };
    tick();
    this.#metricsTimer = setInterval(tick, this.#metricsIntervalMs);
  }

  /** Push metrics + host info to the Sngine PHP API over HTTPS. */
  #httpStats(payload) {
    const body = {
      agentId: this.#agentId,
      host: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      version: DEFAULTS.version,
      ...payload,
    };
    // Advertise the device's shell security posture (unrestricted vs
    // allowlist, audit on/off) so the dashboard can render it live.
    const shell = this.#capabilities && this.#capabilities.shell;
    if (shell && typeof shell === 'object') {
      body.shell = {
        unsafe: shell.unsafe === true,
        mode: shell.mode || 'argv',
        allowCount: Array.isArray(shell.effectiveAllowlist) ? shell.effectiveAllowlist.length : 0,
        audit: shell.audit !== false,
      };
    }
    fetch(`${CLOUD.base}/api/v1/agent/stats`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  #stopMetrics() {
    if (this.#metricsTimer) {
      clearInterval(this.#metricsTimer);
      this.#metricsTimer = null;
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────
  close() {
    this.#closing = true;
    clearTimeout(this.#reconnectTimer);
    this.#stopMetrics();
    for (const [, p] of this.#llmPending) { clearTimeout(p.timeout); p.reject(new Error('closed')); }
    this.#llmPending.clear();
    if (this.#ws) {
      this.#ws.removeAllListeners('close');
      this.#ws.close(1000, 'agent shutdown');
    }
  }
}
