// Centralized, versioned policy registry for tenant-scoped administration.
// This is a local durable primitive: it does not pretend to be a remote IdP or
// control plane. Policies are immutable revisions; promotion changes only the
// tenant's active pointer and every mutation is audit logged.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { auditWrite } from './policy.js';

const DEFAULT_STORE = process.env.REMOTE_POLICY_REGISTRY_STORE || join(homedir(), '.remote-agent', 'policy-registry.json');
const MAX_REVISIONS = 1000;
const EFFECTS = new Set(['allow', 'deny', 'prompt', 'confirm']);

function nowIso() { return new Date().toISOString(); }
function revisionId() { return `pol_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function own(v) { return JSON.parse(JSON.stringify(v)); }
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function digest(v) { return createHash('sha256').update(canonical(v)).digest('hex'); }
function validateDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new TypeError('policy definition must be an object');
  if (definition.rules !== undefined && !Array.isArray(definition.rules)) throw new TypeError('policy rules must be an array');
  for (const rule of definition.rules || []) {
    if (!rule || typeof rule.tool !== 'string' || !rule.tool) throw new TypeError('each policy rule requires tool');
    if (!EFFECTS.has(rule.effect)) throw new TypeError(`invalid policy effect: ${String(rule.effect)}`);
  }
}

export function normalisePolicyRevision(raw = {}) {
  const definition = raw.definition && typeof raw.definition === 'object' ? own(raw.definition) : {};
  validateDefinition(definition);
  return {
    id: String(raw.id || revisionId()), tenantId: String(raw.tenantId || ''),
    version: Number.isInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    definition, hash: String(raw.hash || digest(definition)),
    state: raw.state === 'active' ? 'active' : 'draft',
    createdBy: String(raw.createdBy || ''), createdAt: raw.createdAt || nowIso(),
    activatedAt: raw.activatedAt || null, activatedBy: String(raw.activatedBy || ''),
  };
}

export class PolicyRegistry {
  constructor({ storePath = DEFAULT_STORE } = {}) {
    this.storePath = storePath; this.revisions = new Map(); this.active = new Map(); this.#load();
  }
  #load() {
    try {
      if (!existsSync(this.storePath)) return;
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
      for (const item of Array.isArray(raw?.revisions) ? raw.revisions : []) {
        const r = normalisePolicyRevision(item);
        if (r.hash !== digest(r.definition)) throw new Error(`policy revision hash mismatch: ${r.id}`);
        this.revisions.set(r.id, r);
      }
      for (const [tenant, id] of Object.entries(raw?.active || {})) if (this.revisions.has(id)) this.active.set(tenant, id);
    } catch { /* fail closed */ }
  }
  #save() {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const revisions = [...this.revisions.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, MAX_REVISIONS);
    const active = Object.fromEntries(this.active);
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, revisions, active }, null, 2), { mode: 0o600 }); renameSync(tmp, this.storePath);
  }
  create({ tenantId, definition, createdBy = '' } = {}) {
    if (!tenantId) throw new TypeError('tenantId is required'); validateDefinition(definition);
    const versions = [...this.revisions.values()].filter((r) => r.tenantId === tenantId);
    const r = normalisePolicyRevision({ tenantId, definition, createdBy, version: versions.reduce((m, x) => Math.max(m, x.version), 0) + 1 });
    this.revisions.set(r.id, r); this.#save(); auditWrite({ kind: 'policy', action: 'create', tenantId, revisionId: r.id, policyVersion: r.version, createdBy }); return this.get(r.id, { tenantId });
  }
  get(id, { tenantId } = {}) { const r = this.revisions.get(String(id)); return r && (tenantId === undefined || r.tenantId === tenantId) ? own(r) : null; }
  list({ tenantId } = {}) { if (!tenantId) throw new TypeError('tenantId is required to list policies'); return [...this.revisions.values()].filter((r) => r.tenantId === tenantId).sort((a, b) => b.version - a.version).map(own); }
  activeRevision(tenantId) { if (!tenantId) throw new TypeError('tenantId is required'); const id = this.active.get(tenantId); return id ? this.get(id, { tenantId }) : null; }
  activate(id, { tenantId, activatedBy = '' } = {}) {
    if (!tenantId) throw new TypeError('tenantId is required');
    const r = this.revisions.get(String(id)); if (!r || r.tenantId !== tenantId) return null;
    const current = this.active.get(tenantId); if (current && this.revisions.has(current)) this.revisions.get(current).state = 'draft';
    r.state = 'active'; r.activatedAt = nowIso(); r.activatedBy = activatedBy; this.active.set(tenantId, r.id); this.#save();
    auditWrite({ kind: 'policy', action: 'activate', tenantId, revisionId: r.id, policyVersion: r.version, activatedBy }); return own(r);
  }
  rollback(tenantId, revisionId, opts = {}) { return this.activate(revisionId, { ...opts, tenantId }); }
}
