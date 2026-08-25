// presence.js — anonymous install-presence heartbeat.
// ============================================================================
// Privacy-first: this sends ONLY {platform, arch, version, first} — no install
// id, no hostname, no IP (we never read it client-side), no username. The
// server stores aggregate counts only, so an install can never be linked to
// a person. Opt out with REMOTE_TELEMETRY=0.
//
// It fires:
//   • once per CLI run (any command) while the agent is still UNPAIRED, and
//   • every 15 min from the setup dashboard (remote-agent gui) while unpaired.
// The first-ever ping sets a local flag so the server counts "installed" once.
import os from 'node:os';
import { CLOUD, DEFAULTS, loadCreds, loadConfig, saveConfig } from './config.js';

const INTERVAL_MS = 15 * 60 * 1000;
let timer = null;

function enabled() {
  const v = process.env.REMOTE_TELEMETRY;
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

export async function pingPresence() {
  if (!enabled()) return;
  // Paired (has an API key) → the authenticated stats stream takes over.
  if (loadCreds()?.apiKey) return;
  const cfg = loadConfig() || {};
  const first = !cfg.presence_sent;
  try {
    const res = await fetch(`${CLOUD.base}/api/v1/agent/presence/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `remote-agent/${DEFAULTS.version}` },
      body: JSON.stringify({ platform: os.platform(), arch: os.arch(), version: DEFAULTS.version, first }),
    });
    if (res.ok && first) {
      cfg.presence_sent = true;
      saveConfig(cfg);
    }
  } catch {
    /* silent — presence is best-effort and never blocks the agent */
  }
}

export function startPresence() {
  if (!enabled() || timer) return;
  pingPresence();
  timer = setInterval(pingPresence, INTERVAL_MS);
  if (timer.unref) timer.unref();
}

export function stopPresence() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
