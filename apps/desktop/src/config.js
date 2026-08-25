// Configuration & credential management.
// Supports:
//   - remoteagent.online (sngine-based cloud) — default
//   - Self-hosted Docker platform (port 4300)
//   - Custom control planes via REMOTE_CLOUD / REMOTE_CLOUD_WS
//
// IMPORTANT: only the remoteagent.online API key lives locally.
// No LLM provider keys (OpenAI, Anthropic, etc.) are ever stored on this device.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from './version.js';
import { createCredentialStore } from './credentials.js';

const DIR = join(homedir(), '.remote-agent');
const CRED_FILE = join(DIR, 'credentials.json');
const CONFIG_FILE = join(DIR, 'config.json');

// ── Cloud endpoints ───────────────────────────────────────────────
const baseUrl = process.env.REMOTE_CLOUD || 'https://remoteagent.online';

// Auto-detect platform type from URL
function detectPlatform(url) {
  try {
    // hostname, not host: host includes the port (127.0.0.1:4300).
    const host = new URL(url).hostname;
    // Local control planes (Docker platform, local dev): localhost / 127.0.0.1 / :4300
    if (host === 'localhost' || host === '127.0.0.1' || url.includes(':4300')) return 'docker';
    // Sngine-based: remoteagent.online (and subdomains)
    return 'sngine'; // default
  } catch { return 'sngine'; }
}

const PLATFORM = detectPlatform(baseUrl);

export const CLOUD = {
  base:    baseUrl,
  ws:      process.env.REMOTE_CLOUD_WS || null,
  platform: PLATFORM,

  get wsUrl() {
    if (this.ws) return this.ws;
    const proto = this.base.startsWith('https') ? 'wss' : 'ws';
    const host = new URL(this.base).host;

    if (PLATFORM === 'docker') {
      return `ws://${host}/ws?type=agent`;
    }
    // Sngine: WebSocket relay on same host, port 4390
    // Nginx proxies /ws to localhost:4390
    return `${proto}://${host}/ws?role=device`;
  },

  // API paths — vary by platform
  get paths() {
    if (PLATFORM === 'docker') {
      return {
        verifyKey:  '/api/keys/verify',
        think:      '/api/llm/think',
        health:     '/health',
        agents:     '/api/agents',
        chat:       (id) => `/api/agents/${id}/chat`,
        toolExec:   (id) => `/api/agents/${id}/tool`,
      };
    }
    // Sngine/remoteagent.online
    return {
      verifyKey:  '/api/v1/agent/verify',
      think:      '/api/v1/agent/think',
      toolResult: '/api/v1/agent/tool-result',
      health:     '/api/v1/mona/system',       // uses system endpoint as health check
      agents:     '/api/v1/mona/agents',
      chat:       (id) => `/api/v1/mona/agents/${id}/chat`,
      toolExec:   (id) => `/api/v1/mona/agents/${id}/tool`,
    };
  },
};

Object.freeze(CLOUD);

// ── Agent defaults ────────────────────────────────────────────────
export const DEFAULTS = Object.freeze({
  metricsIntervalMs: 10_000,
  reconnectMinMs:    1_000,
  reconnectMaxMs:    30_000,
  version:           VERSION,
});

// ── Credential management ─────────────────────────────────────────
const credentialStore = createCredentialStore({ homeDir: homedir(), allowFileFallback: true });

export function loadCreds() {
  return credentialStore.load();
}

export function saveCreds(creds) {
  credentialStore.save(creds);
  return CRED_FILE;
}

export function credentialStatus() {
  return credentialStore.metadata();
}

export function requireCreds() {
  const c = loadCreds();
  if (!c?.apiKey) {
    process.stderr.write('No remoteagent.online API key. Run: remote-agent login\n');
    process.exit(1);
  }
  return c;
}

// ── Local config (non-secret preferences) ─────────────────────────
export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(cfg) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

export const PATHS = Object.freeze({
  dir: DIR,
  creds: CRED_FILE,
  config: CONFIG_FILE,
});
