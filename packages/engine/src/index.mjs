// remote-agent engine — the lightweight agent core.
//
// Policy-as-code, budget governor, structured memory, bounded task loop.
// Zero runtime dependencies; every piece is unit-testable offline.

export { Policy, PRESETS, auditWrite, auditVerify } from './policy.js';
export { PolicyRegistry, normalisePolicyRevision } from './policy-registry.js';
export { Budget } from './budget.js';
export { MemoryStore } from './memory.js';
export { TaskLoop, parseBrainReply, compactMessages, normaliseToolResult } from './loop.js';
export { ToolCache, DEFAULT_TOOL_CACHE_PATH } from './tool-cache.js';
export { runSubtasks, buildSubSystemPrompt, MAX_SUBTASKS, MAX_SUB_PROMPT, MAX_SUB_STEPS } from './delegate.js';
export { runWorkflow, validatePhases, buildPhaseContext, MAX_PHASES } from './workflow.js';
export { GoalStore, parseGoalMarker, buildGoalRoundPrompt, goalRoundTaskText, normaliseGoal, MAX_GOAL_ROUNDS, MAX_OBJECTIVE } from './goal.js';
export { RunStore, normaliseRun, retryDecision, RUN_STATUSES, ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES } from './run-state.js';
export { JitAccess, ROLES, normaliseGrant } from './jit.js';
export { DeviceRegistry, DEVICE_HEALTH, hashCredential, normaliseDevice, generateDeviceIdentity, generateCredential, signEnrollment, verifyEnrollment } from './device-registry.js';
export { computeRunMetrics, evaluateAlerts } from './metrics.js';
export { hashManifest, generateSigningKeyPair, normalisePluginManifest, signManifest, verifyManifest, checkCapabilities } from './plugin-manifest.js';
export { UpgradeOrchestrator, UPGRADE_STATES, normaliseUpgrade } from './upgrade.js';
export { FleetController } from './fleet.js';
export { buildRunEvidence, readAuditEntries, queryAudit } from './evidence.js';
export { PackageLifecycle, PKG_STATES, normalisePackage, verifyPackageArtifact } from './package-lifecycle.js';
export { toNdjson, exportAuditNdjson, exportRunEvidenceNdjson } from './siem.js';
export { AdminApi } from './admin-api.js';
export { normaliseMarketplaceIndex, hashMarketplaceIndex, signMarketplaceIndex, verifyMarketplaceIndex } from './marketplace-index.js';
export { VectorStore, embed, cosine, tokenize, hashString, hashString2, VECTOR_DIM } from './vector.js';

/**
 * One-call engine wiring with sensible defaults.
 * think(messages, {profile, temperature}) is provided by the caller
 * (any provider/brain); runTool(name, args) executes sandboxed tools.
 */
export function createEngine({ think, runTool, policyPath, storePath, budget } = {}) {
  const policy = policyPath ? Policy.load(policyPath) : new Policy(null);
  const b = budget instanceof Budget ? budget : new Budget(budget || {});
  const memory = new MemoryStore({ storePath });
  const loop = new TaskLoop({ think, runTool, policy, budget: b });
  return { policy, budget: b, memory, loop };
}
