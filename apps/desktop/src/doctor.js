// doctor.js — `remote-agent doctor`: diagnose the local install in one shot.
//
// Checks: node version, ~/.remote-agent state (credentials, policy, audit,
// workspace), control-plane reachability, BYO provider config, update
// availability. Best-effort by design — a failed check reports, never
// crashes the doctor.

import { existsSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Policy, auditVerify } from '@remote-agent/engine';
import { loadCreds, CLOUD } from './config.js';
import { VERSION, isUpdateAvailable } from './version.js';
import { loadProviderConfig } from './transport/local.js';

export function checkNodeVersion(v = process.version) {
  const major = Number(String(v).replace(/^v/, '').split('.')[0]);
  return { ok: major >= 20, detail: `Node ${v} (need >= 20)` };
}

export function checkDirState(dir, label) {
  try {
    accessSync(dir, constants.W_OK);
    return { ok: true, detail: `${label} writable: ${dir}` };
  } catch {
    return { ok: false, detail: `${label} missing or not writable: ${dir}` };
  }
}

export function checkFileState(file, label) {
  return { ok: existsSync(file), detail: `${label}: ${file}` };
}

/**
 * Run every check. Returns { checks: [{name, ok, detail}], healthy }.
 * @param {object} [opts] injection points for tests
 */
export async function runDoctor(opts = {}) {
  const fetcher = opts.fetcher || fetch;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('node', checkNodeVersion(opts.nodeVersion || process.version).ok,
    checkNodeVersion(opts.nodeVersion || process.version).detail);

  const home = opts.home || join(homedir(), '.remote-agent');
  add('agent dir', checkDirState(home, '~/.remote-agent').ok, checkDirState(home, '~/.remote-agent').detail);

  const creds = existsSync(join(home, 'credentials.json'))
    ? (() => { try { return loadCreds(); } catch { return null; } })()
    : null;
  add('credentials', Boolean(creds?.apiKey),
    creds?.apiKey ? 'credentials.json present (agent ' + (creds.agentId || 'pending') + ')' : 'no credentials — run remote-agent login');

  try {
    const p = Policy.load();
    add('policy', true, `policy loaded: ${p.preset || 'custom'} (${p.toolTier ? 'v1 tiers' : 'rules'})`);
  } catch (err) {
    add('policy', false, `policy.json broken: ${err.message}`);
  }

  let audit;
  try {
    audit = auditVerify();
  } catch (err) {
    audit = { ok: false, error: err.message };
  }
  add('audit', audit.ok, audit.ok ? 'audit chain verified' : `audit verify failed: ${audit.error || 'no chain yet'}`);

  const ws = opts.workspace || process.env.REMOTE_WORKSPACE || join(home, 'workspace');
  add('workspace', checkDirState(ws, 'workspace').ok, checkDirState(ws, 'workspace').detail);

  try {
    const provider = loadProviderConfig();
    if (provider) {
      add('provider', true, `BYO brain: ${provider.provider}/${provider.model} (prompts stay on-device)`);
    } else if (String(opts.transport || process.env.REMOTE_TRANSPORT || '') === 'local') {
      add('provider', false, 'REMOTE_TRANSPORT=local but no provider — run remote-agent provider set <anthropic|openai|ollama>');
    } else {
      add('provider', true, 'cloud brain (remoteagent.online vault)');
    }
  } catch (err) {
    add('provider', false, err.message);
  }

  try {
    const res = await fetcher(CLOUD.base + '/health', { method: 'GET', signal: AbortSignal.timeout(5000) });
    add('cloud', true, `control plane reachable: ${CLOUD.base} (${res.status})`);
  } catch {
    add('cloud', false, `control plane unreachable: ${CLOUD.base}`);
  }

  add('version', true, `installed v${VERSION}`);

  if (opts.skipUpdate) {
    add('update', true, 'update check skipped');
  } else {
    try {
      const u = await isUpdateAvailable();
      add('update', true, u.available ? `update available: v${u.latest} (run remote-agent update)` : `up to date (v${VERSION})`);
    } catch {
      add('update', false, 'update feed unreachable');
    }
  }

  const healthy = checks.every((c) => c.ok);
  return { checks, healthy };
}

export function formatDoctor({ checks, healthy }) {
  const lines = [];
  for (const c of checks) {
    lines.push(`${c.ok ? 'OK ' : 'FAIL'}  ${c.name.padEnd(12)} ${c.detail}`);
  }
  lines.push('');
  lines.push(healthy ? 'All checks passed.' : 'Some checks failed — see above.');
  return lines.join('\n');
}

/**
 * Machine-readable report for automation and CI (`remote-agent doctor --json`).
 * Returns a plain object that round-trips through JSON unchanged.
 */
export function formatDoctorJson({ checks, healthy }) {
  return {
    version: VERSION,
    healthy,
    checks: checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
  };
}
