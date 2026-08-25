// Admin console / control-plane API surface.
//
// AdminApi is a thin, validated request router over FleetController. It maps a
// named action + JSON params to the composed services, normalises every
// response to { ok, data | error }, and never lets a service throw escape to
// the caller. It is the JSON boundary an admin console or dashboard consumes,
// and it is fully testable without an HTTP server.

const ACTIONS = new Set([
  'report',
  'listDevices', 'listRuns', 'recoverable',
  'enroll', 'revokeDevice', 'verifyCredential',
  'grant', 'revokeGrant', 'checkAccess',
  'createPolicy', 'listPolicies', 'activatePolicy', 'activePolicy',
  'createRun', 'transitionRun', 'checkpointRun', 'rollbackRun',
  'startUpgrade', 'promoteUpgrade', 'rollbackUpgrade',
]);

function own(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

/**
 * JSON-safe admin/control-plane facade for a FleetController.
 *
 * This does not bind an HTTP port or perform authentication. A transport must
 * authenticate and authorize an operator before forwarding requests here.
 */
export class AdminApi {
  constructor(controller) {
    if (!controller) throw new TypeError('controller (FleetController) is required');
    this.controller = controller;
  }

  /** Return the supported actions for discovery/documentation. */
  actions() {
    return [...ACTIONS].sort();
  }

  /** Dispatch a named action with JSON params. Always returns owned { ok, data|error }. */
  dispatch(action, params = {}) {
    if (typeof action !== 'string' || !ACTIONS.has(action)) {
      return { ok: false, error: `unknown action: ${String(action)}` };
    }
    if (!params || Array.isArray(params) || typeof params !== 'object') {
      return { ok: false, error: 'params must be a JSON object' };
    }

    const p = params;
    try {
      const c = this.controller;
      let data;
      switch (action) {
        case 'report': data = c.report(); break;
        case 'listDevices': data = c.devices.list({ tenantId: p.tenantId, health: p.health, group: p.group, tag: p.tag }); break;
        case 'listRuns': data = c.runs.list({ activeOnly: p.activeOnly }); break;
        case 'recoverable': data = c.recoverable(); break;
        case 'enroll': data = c.enroll(p); break;
        case 'revokeDevice': data = c.revokeDevice(p.id, { reason: p.reason, auditor: p.auditor }); break;
        case 'verifyCredential': data = c.verifyCredential(p.id, p.credential); break;
        case 'grant': data = c.grant(p); break;
        case 'revokeGrant': data = c.revokeGrant(p.id, { reason: p.reason, auditor: p.auditor }); break;
        case 'checkAccess': data = c.checkAccess(p.principal, p.tool, { tenantId: p.tenantId }); break;
        case 'createPolicy': data = c.createPolicy({ tenantId: p.tenantId, definition: p.definition, createdBy: p.actor || p.createdBy }); break;
        case 'listPolicies': data = c.listPolicies({ tenantId: p.tenantId }); break;
        case 'activatePolicy': data = c.activatePolicy(p.id, { tenantId: p.tenantId, activatedBy: p.actor || p.activatedBy }); break;
        case 'activePolicy': data = c.activePolicy(p.tenantId); break;
        case 'createRun': data = c.createRun(p); break;
        case 'transitionRun': data = c.transitionRun(p.id, p.status, { reason: p.reason, checkpoint: p.checkpoint }); break;
        case 'checkpointRun': data = c.checkpointRun(p.id, p.checkpoint); break;
        case 'rollbackRun': data = c.rollbackRun(p.id, { toIndex: p.toIndex, reason: p.reason }); break;
        case 'startUpgrade': data = c.startUpgrade(p); break;
        case 'promoteUpgrade': data = c.promoteUpgrade(p.id); break;
        case 'rollbackUpgrade': data = c.rollbackUpgrade(p.id, { reason: p.reason }); break;
        default: return { ok: false, error: `unknown action: ${action}` };
      }
      return { ok: true, data: own(data) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
