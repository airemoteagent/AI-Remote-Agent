// Just-In-Time (JIT) access provisioning and revocation.
//
// JitAccess issues short-lived, role-scoped grants to a principal, persists
// them atomically, and records every grant and revocation in the shared
// hash-chained audit log so an operator can reconstruct exactly who granted
// what, to whom, when, and why. A grant never widens a tool beyond its role;
// it only scopes an existing principal to a bounded window.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { auditWrite } from './policy.js';

const DEFAULT_STORE = process.env.REMOTE_JIT_STORE || join(homedir(), '.remote-agent', 'jit.json');
const MAX_GRANTS = 1000;

// Role → allowed tools. `*` means any tool. Roles are the only way a grant
// widens access; an explicit `tools` list narrows the role further.
export const ROLES = Object.freeze({
  'read-only': Object.freeze(['sysinfo', 'files', 'memory', 'notify', 'vector']),
  operator: Object.freeze(['sysinfo', 'files', 'shell', 'net', 'web', 'memory', 'notify', 'vector', 'apps']),
  admin: Object.freeze(['*']),
});

function nowIso() { return new Date().toISOString(); }
function grantId() { return `jit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

function covers(tools, tool) {
  return Array.isArray(tools) && (tools.includes('*') || tools.includes(tool));
}

export function normaliseGrant(raw = {}) {
  const role = ROLES[raw.role] ? raw.role : '';
  const tools = Array.isArray(raw.tools) && raw.tools.length
    ? raw.tools
    : (role ? [...ROLES[role]] : []);
  return {
    id: String(raw.id || grantId()),
    principal: String(raw.principal || ''),
    role,
    tools,
    notBefore: raw.notBefore || nowIso(),
    expiresAt: raw.expiresAt || '',
    reason: String(raw.reason || ''),
    auditor: String(raw.auditor || ''),
    tenantId: String(raw.tenantId || ''),
    revoked: Boolean(raw.revoked),
    revokedAt: raw.revokedAt || null,
    revokeReason: String(raw.revokeReason || ''),
    createdAt: raw.createdAt || nowIso(),
  };
}

function activeWindow(g, now) {
  const nb = g.notBefore ? Date.parse(g.notBefore) : 0;
  const ex = g.expiresAt ? Date.parse(g.expiresAt) : Infinity;
  return !g.revoked && now >= nb && now < ex;
}

export class JitAccess {
  constructor({ storePath = DEFAULT_STORE } = {}) {
    this.storePath = storePath;
    this.grants = new Map();
    this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.storePath)) return;
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
      for (const item of (Array.isArray(raw?.grants) ? raw.grants : [])) {
        const g = normaliseGrant(item);
        this.grants.set(g.id, g);
      }
    } catch { /* corrupt store fails closed to empty */ }
  }

  #save() {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const grants = [...this.grants.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, MAX_GRANTS);
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, grants }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.storePath);
  }

  /** Provision a bounded, role-scoped grant. Audit is mandatory and never throws. */
  grant({ id, tenantId = '', principal, role, tools = [], notBefore = '', expiresAt = '', reason = '', auditor = '' } = {}) {
    if (!principal) throw new TypeError('principal is required');
    if (role && !ROLES[role]) throw new TypeError(`unknown role "${role}"`);
    const grant = normaliseGrant({ id, tenantId, principal, role, tools, notBefore, expiresAt, reason, auditor });
    if (this.grants.has(grant.id)) return this.get(grant.id);
    this.grants.set(grant.id, grant);
    this.#save();
    auditWrite({ kind: 'jit', action: 'grant', grantId: grant.id, tenantId, principal, role: grant.role, tools: grant.tools, expiresAt: grant.expiresAt, reason, auditor });
    return this.get(grant.id);
  }

  get(id) {
    const g = this.grants.get(String(id));
    return g ? normaliseGrant(g) : null;
  }

  /** Revoke a grant. Expired-but-unrevoked grants are also revocable for the record. */
  revoke(id, { reason = '', auditor = '' } = {}) {
    const g = this.grants.get(String(id));
    if (!g) return null;
    g.revoked = true;
    g.revokedAt = nowIso();
    g.revokeReason = reason;
    if (auditor) g.auditor = auditor;
    this.#save();
    auditWrite({ kind: 'jit', action: 'revoke', grantId: g.id, principal: g.principal, reason: reason || g.revokeReason, auditor });
    return this.get(id);
  }

  /** Whether a principal currently holds an active grant covering `tool`. */
  // Tenant-aware checks accept only grants bound to that exact tenant. Legacy
  // unscoped grants remain usable only by legacy callers that omit tenantId.
  check(principal, tool, { tenantId, now = Date.now() } = {}) {
    const active = [...this.grants.values()].filter((g) => g.principal === principal && (tenantId === undefined ? !g.tenantId : g.tenantId === tenantId) && covers(g.tools, tool) && activeWindow(g, now));
    return {
      allowed: active.length > 0,
      grants: active.map((g) => g.id),
      reason: active.length ? 'active JIT grant' : 'no active JIT grant covers this tool',
    };
  }

  /** List currently active (non-expired, non-revoked) grants for a principal. */
  active(principal, now = Date.now()) {
    return [...this.grants.values()]
      .filter((g) => (principal === undefined || g.principal === principal) && activeWindow(g, now))
      .map((g) => normaliseGrant(g));
  }

  /** List grants that have expired but are not yet revoked (for cleanup/audit). */
  expired(now = Date.now()) {
    return [...this.grants.values()]
      .filter((g) => !g.revoked && g.expiresAt && Date.parse(g.expiresAt) <= now)
      .map((g) => normaliseGrant(g));
  }

  /** Bulk-revoke expired grants so they are explicitly closed in the ledger. */
  expire(now = Date.now(), { auditor = 'system' } = {}) {
    const expired = this.expired(now);
    for (const g of expired) this.revoke(g.id, { reason: 'expired', auditor });
    return expired.map((g) => g.id);
  }
}
