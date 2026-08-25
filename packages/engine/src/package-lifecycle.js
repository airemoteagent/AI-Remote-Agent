// Package install/upgrade/rollback lifecycle for a single host.
//
// PackageLifecycle models the safe state transitions of installing and
// upgrading a package, tracking the current and previous version so a failed
// upgrade can roll back to the last known-good version. It is OS-portable
// (Linux and Windows installers share the same state machine) and persists
// atomically, writing each transition to the shared audit log.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { auditWrite } from './policy.js';

/**
 * Verify a downloaded package before it enters the lifecycle.
 * The digest is deliberately explicit (sha256:<hex> or bare hex) so callers
 * cannot accidentally treat a version string as integrity evidence.
 */
export function verifyPackageArtifact(bytes, expectedDigest) {
  const expected = String(expectedDigest || '').replace(/^sha256:/i, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) return { ok: false, reason: 'missing or invalid sha256 digest' };
  const actual = createHash('sha256').update(bytes).digest('hex');
  return actual === expected ? { ok: true, digest: `sha256:${actual}` } : { ok: false, reason: 'artifact digest mismatch', expected: `sha256:${expected}`, actual: `sha256:${actual}` };
}

const DEFAULT_STORE = process.env.REMOTE_PKGS_STORE || join(homedir(), '.remote-agent', 'packages.json');
const MAX_PACKAGES = 1000;

export const PKG_STATES = Object.freeze(['absent', 'installing', 'installed', 'upgrading', 'rollback_required', 'rolling_back', 'rolled_back', 'failed']);

const TRANSITIONS = {
  absent: new Set(['installing']),
  installing: new Set(['installed', 'failed']),
  installed: new Set(['upgrading']),
  upgrading: new Set(['installed', 'rollback_required', 'failed']),
  rollback_required: new Set(['rolling_back']),
  rolling_back: new Set(['rolled_back', 'failed']),
  rolled_back: new Set(['upgrading']),
  failed: new Set(['installing', 'upgrading']),
};

function nowIso() { return new Date().toISOString(); }

export function normalisePackage(raw = {}) {
  const state = TRANSITIONS[raw.state] ? raw.state : 'absent';
  return {
    id: String(raw.id || ''),
    host: String(raw.host || ''),
    state,
    currentVersion: String(raw.currentVersion || ''),
    previousVersion: String(raw.previousVersion || ''),
    reason: String(raw.reason || ''),
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || nowIso(),
  };
}

export class PackageLifecycle {
  constructor({ storePath = DEFAULT_STORE } = {}) {
    this.storePath = storePath;
    this.packages = new Map();
    this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.storePath)) return;
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
      for (const item of (Array.isArray(raw?.packages) ? raw.packages : [])) {
        const p = normalisePackage(item);
        this.packages.set(`${p.host}:${p.id}`, p);
      }
    } catch { /* corrupt store fails closed to empty */ }
  }

  #save() {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const packages = [...this.packages.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, MAX_PACKAGES);
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, packages }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.storePath);
  }

  #key(host, id) { return `${host}:${id}`; }

  #transition(host, id, next, { reason = '', previousVersion = '' } = {}) {
    const p = this.packages.get(this.#key(host, id));
    if (!p) return null;
    if (p.state !== next && !TRANSITIONS[p.state].has(next)) {
      throw new Error(`invalid package transition: ${p.state} → ${next}`);
    }
    p.state = next;
    if (reason) p.reason = reason;
    if (previousVersion) p.previousVersion = previousVersion;
    p.updatedAt = nowIso();
    this.#save();
    auditWrite({ kind: 'package', action: next, package: id, host, state: next, reason });
    return this.get(host, id);
  }

  get(host, id) {
    const p = this.packages.get(this.#key(host, id));
    return p ? normalisePackage(p) : null;
  }

  /** Begin installing a package on a host (absent or rolled_back → installing). */
  install(host, id, version) {
    const key = this.#key(host, id);
    if (!this.packages.has(key)) {
      this.packages.set(key, normalisePackage({ id, host, state: 'installing', currentVersion: version }));
      this.#save();
      auditWrite({ kind: 'package', action: 'installing', package: id, host, state: 'installing' });
      return this.get(host, id);
    }
    const p = this.packages.get(key);
    if (p.state !== 'absent' && p.state !== 'rolled_back') throw new Error(`cannot install from ${p.state}`);
    p.state = 'installing';
    p.currentVersion = version;
    p.updatedAt = nowIso();
    this.#save();
    auditWrite({ kind: 'package', action: 'installing', package: id, host, state: 'installing' });
    return this.get(host, id);
  }

  /** Confirm a successful install/upgrade (installing/upgrading → installed). */
  confirm(host, id) {
    return this.#transition(host, id, 'installed');
  }

  /** Begin upgrading to a new version, retaining the previous version. */
  upgrade(host, id, version) {
    const p = this.packages.get(this.#key(host, id));
    if (!p || p.state !== 'installed') throw new Error(`cannot upgrade from ${p?.state ?? 'absent'}`);
    p.state = 'upgrading';
    p.previousVersion = p.currentVersion;
    p.currentVersion = version;
    p.updatedAt = nowIso();
    this.#save();
    auditWrite({ kind: 'package', action: 'upgrading', package: id, host, from: p.previousVersion, to: version });
    return this.get(host, id);
  }

  /** Mark a failed install/upgrade; a failed upgrade becomes rollback-eligible. */
  fail(host, id, { reason = '' } = {}) {
    const p = this.packages.get(this.#key(host, id));
    if (!p) return null;
    const next = p.state === 'upgrading' ? 'rollback_required' : 'failed';
    return this.#transition(host, id, next, { reason });
  }

  /** Roll back to the previous known-good version. */
  rollback(host, id, { reason = '' } = {}) {
    const p = this.packages.get(this.#key(host, id));
    if (!p) return null;
    if (p.state !== 'rollback_required' && p.state !== 'upgrading') throw new Error(`cannot roll back from ${p.state}`);
    if (!p.previousVersion) throw new Error('no previous version to roll back to');
    p.state = 'rolling_back';
    p.updatedAt = nowIso();
    this.#save();
    auditWrite({ kind: 'package', action: 'rolling_back', package: id, host, reason });
    // Complete the rollback: restore the previous version.
    const restored = p.currentVersion;
    p.currentVersion = p.previousVersion;
    p.previousVersion = '';
    p.state = 'rolled_back';
    p.reason = reason || `rolled back from ${restored}`;
    p.updatedAt = nowIso();
    this.#save();
    auditWrite({ kind: 'package', action: 'rolled_back', package: id, host, to: p.currentVersion, reason: p.reason });
    return this.get(host, id);
  }
}
