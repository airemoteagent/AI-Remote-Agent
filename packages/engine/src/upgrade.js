// Staged upgrade orchestration for the device fleet.
//
// An upgrade rolls out in bounded stages: a small canary cohort first, then the
// remaining eligible devices, then completion. Advancement is gated on live
// device health from the DeviceRegistry — a degraded canary blocks the rollout
// and fails the upgrade rather than propagating a bad version. Every start,
// promotion, and rollback is written to the shared hash-chained audit log.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { auditWrite } from './policy.js';

const DEFAULT_STORE = process.env.MONA_UPGRADES_STORE || join(homedir(), '.mona-agent', 'upgrades.json');
const MAX_UPGRADES = 500;

export const UPGRADE_STATES = Object.freeze(['pending', 'canary', 'rollout', 'complete', 'rolled_back', 'failed']);

function nowIso() { return new Date().toISOString(); }
function upgradeId() { return `upg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

export function normaliseUpgrade(raw = {}) {
  return {
    id: String(raw.id || upgradeId()),
    tenantId: String(raw.tenantId || ''),
    version: String(raw.version || ''),
    previousVersion: String(raw.previousVersion || ''),
    state: UPGRADE_STATES.includes(raw.state) ? raw.state : 'pending',
    canaryDevices: Array.isArray(raw.canaryDevices) ? raw.canaryDevices : [],
    rolloutDevices: Array.isArray(raw.rolloutDevices) ? raw.rolloutDevices : [],
    completedDevices: Array.isArray(raw.completedDevices) ? raw.completedDevices : [],
    reason: String(raw.reason || ''),
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || nowIso(),
  };
}

export class UpgradeOrchestrator {
  constructor({ registry, storePath = DEFAULT_STORE } = {}) {
    if (!registry) throw new TypeError('registry (DeviceRegistry) is required');
    this.registry = registry;
    this.storePath = storePath;
    this.upgrades = new Map();
    this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.storePath)) return;
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
      for (const item of (Array.isArray(raw?.upgrades) ? raw.upgrades : [])) {
        const u = normaliseUpgrade(item);
        this.upgrades.set(u.id, u);
      }
    } catch { /* corrupt store fails closed to empty */ }
  }

  #save() {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const upgrades = [...this.upgrades.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, MAX_UPGRADES);
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, upgrades }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.storePath);
  }

  /**
   * Start a staged upgrade over the tenant's online devices. The first
   * `canarySize` devices form the canary cohort; the rest form the rollout.
   */
  start({ id, tenantId, version, previousVersion = '', canarySize = 1 } = {}) {
    if (!tenantId || !version) throw new TypeError('tenantId and version are required');
    const devices = this.registry.list({ tenantId, health: 'online' });
    if (!devices.length) throw new Error('no eligible online devices to upgrade');
    const canary = devices.slice(0, Math.min(Math.max(1, Number(canarySize) || 1), devices.length)).map((d) => d.id);
    const rollout = devices.slice(canary.length).map((d) => d.id);
    const upgrade = normaliseUpgrade({ id, tenantId, version, previousVersion, state: 'canary', canaryDevices: canary, rolloutDevices: rollout });
    if (this.upgrades.has(upgrade.id)) return this.get(upgrade.id);
    this.upgrades.set(upgrade.id, upgrade);
    this.#save();
    auditWrite({ kind: 'upgrade', action: 'start', upgradeId: upgrade.id, tenantId, version, canary, rollout });
    return this.get(upgrade.id);
  }

  get(id) {
    const u = this.upgrades.get(String(id));
    return u ? normaliseUpgrade(u) : null;
  }

  list({ tenantId } = {}) {
    return [...this.upgrades.values()]
      .filter((u) => tenantId === undefined || u.tenantId === tenantId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((u) => normaliseUpgrade(u));
  }

  /**
   * Advance one stage. Canary → rollout requires every canary device to still
   * be online; otherwise the upgrade fails. Rollout → complete finalises it.
   */
  promote(id) {
    const u = this.upgrades.get(String(id));
    if (!u) return null;
    if (u.state === 'complete' || u.state === 'rolled_back') return this.get(id);

    if (u.state === 'canary') {
      const unhealthy = u.canaryDevices.filter((did) => (this.registry.get(did)?.health ?? 'offline') !== 'online');
      if (unhealthy.length) {
        u.state = 'failed';
        u.reason = `canary devices unhealthy: ${unhealthy.join(', ')}`;
        u.updatedAt = nowIso();
        this.#save();
        return this.get(id);
      }
      u.completedDevices = [...new Set([...u.completedDevices, ...u.canaryDevices])];
      u.canaryDevices = [];
      u.state = 'rollout';
    } else if (u.state === 'rollout') {
      u.completedDevices = [...new Set([...u.completedDevices, ...u.rolloutDevices])];
      u.rolloutDevices = [];
      u.state = 'complete';
    }

    u.updatedAt = nowIso();
    this.#save();
    return this.get(id);
  }

  /** Roll back an in-progress upgrade; a completed upgrade cannot roll back. */
  rollback(id, { reason = '' } = {}) {
    const u = this.upgrades.get(String(id));
    if (!u) return null;
    if (u.state === 'complete') throw new Error('cannot roll back a completed upgrade');
    u.state = 'rolled_back';
    u.reason = reason || 'rolled back';
    u.updatedAt = nowIso();
    this.#save();
    auditWrite({ kind: 'upgrade', action: 'rollback', upgradeId: u.id, tenantId: u.tenantId, version: u.version, reason: u.reason });
    return this.get(id);
  }
}
