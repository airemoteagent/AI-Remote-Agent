// FleetController — one coherent entry point over the enterprise services.
//
// It composes DeviceRegistry, JitAccess, RunStore, and UpgradeOrchestrator into
// the workflows an operator actually drives (enroll → grant → run → recover →
// upgrade), plus a single `report()` that joins run metrics, operational
// alerts, and the audit-chain integrity result. It owns no new logic; it is the
// wiring that makes the individual modules usable together.

import { DeviceRegistry } from './device-registry.js';
import { JitAccess } from './jit.js';
import { RunStore } from './run-state.js';
import { UpgradeOrchestrator } from './upgrade.js';
import { computeRunMetrics, evaluateAlerts } from './metrics.js';
import { auditVerify } from './policy.js';
import { PolicyRegistry } from './policy-registry.js';

export class FleetController {
  constructor({ deviceStore, jitStore, runStore, upgradeStore, policyStore } = {}) {
    this.devices = new DeviceRegistry({ storePath: deviceStore });
    this.jit = new JitAccess({ storePath: jitStore });
    this.policies = new PolicyRegistry({ storePath: policyStore });
    this.runs = new RunStore({ storePath: runStore });
    this.upgrades = new UpgradeOrchestrator({ registry: this.devices, storePath: upgradeStore });
  }

  enroll(opts) { return this.devices.enroll(opts); }
  revokeDevice(id, opts) { return this.devices.revoke(id, opts); }
  verifyCredential(id, credential) { return this.devices.verifyCredential(id, credential); }

  grant(opts = {}) { return this.jit.grant({ tenantId: opts.tenantId || 'default', ...opts }); }
  revokeGrant(id, opts) { return this.jit.revoke(id, opts); }
  checkAccess(principal, tool, opts) { return this.jit.check(principal, tool, opts); }
  createPolicy(opts) { return this.policies.create(opts); }
  listPolicies(opts) { return this.policies.list(opts); }
  activatePolicy(id, opts) { return this.policies.activate(id, opts); }
  activePolicy(tenantId) { return this.policies.activeRevision(tenantId); }

  createRun(opts) { return this.runs.create(opts); }
  transitionRun(id, status, opts) { return this.runs.transition(id, status, opts); }
  checkpointRun(id, data) { return this.runs.checkpoint(id, data); }
  recoverable() { return this.runs.recoverable(); }
  rollbackRun(id, opts) { return this.runs.rollback(id, opts); }

  startUpgrade(opts) { return this.upgrades.start(opts); }
  promoteUpgrade(id) { return this.upgrades.promote(id); }
  rollbackUpgrade(id, opts) { return this.upgrades.rollback(id, opts); }

  /** Operator/executive summary: run metrics, alerts, and audit-chain integrity. */
  report() {
    const metrics = computeRunMetrics(this.runs.list());
    const alerts = evaluateAlerts(metrics, { auditOk: auditVerify().ok });
    return { metrics, alerts };
  }
}
