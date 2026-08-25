# Verified Operations Runbooks

These runbooks are deliberately narrow. They do not grant tools or weaken local policy. Each action remains subject to the device policy and requires explicit human approval where configured. They are tested with static fixtures; production deployment still requires environment-specific pilot evidence.

## Disk full

1. Inspect capacity with an approved `df` invocation and identify the affected mounted volume.
2. Inspect only approved workspace/application paths. Propose candidates; do not delete based solely on age or size.
3. Obtain approval for each cleanup. Use the files tool's trash-first deletion behavior; record expected and observed free space.
4. Verify reclaimed capacity and service health. Escalate if the volume is still above its threshold.

**Success:** free-space threshold is met and the affected service remains healthy.  
**Rollback:** restore from trash where possible; otherwise escalate.  
**Fixture evidence:** `apps/desktop/test/fixtures/runbooks/disk-pressure/`.

## Service down

1. Capture the service manager status and recent, redacted service logs.
2. Classify the failure (configuration, dependency, resource pressure, process crash, or unknown).
3. Present a restart plan and require approval. Never restart an unrecognized service or one outside local policy.
4. Verify the manager reports active/running and check the approved external health signal.

**Success:** service is active and the selected health check succeeds.  
**Rollback/escalation:** do not loop restarts; stop after the configured attempt limit and escalate with captured evidence.  
**Fixture evidence:** `apps/desktop/test/fixtures/runbooks/service-down/`.

## Certificate expiry

1. Inspect certificate metadata from a supplied PEM or approved endpoint; record subject, issuer, serial, and expiry without private key material.
2. Compare expiry to the alert threshold. Renewal remains a planned, explicitly authorized operation.
3. For an expired or near-expiry certificate, create an escalation/renewal plan and require approval before any side effect.
4. Verify a replacement certificate's identity, validity interval, and deployment health.

**Success:** replacement satisfies the expected identity and expiry policy.  
**Rollback/escalation:** retain the previous known-good certificate and escalate when identity or chain verification fails.  
**Fixture evidence:** `apps/desktop/test/fixtures/runbooks/certificate-expiry/`.

## Network down

1. Capture the host's routing and reachability state with approved read-only commands (`ip`, `ping`, `traceroute`, `nslookup`, or the platform equivalent). Never reconfigure an interface as a diagnostic step.
2. Classify the failure: local interface down, DNS resolution failure, gateway/next-hop unreachable, upstream loss, or unknown.
3. Present a remediation plan and require approval before any side effect (interface restart, route change, resolver change, service restart). Do not bring down a healthy interface or change routes without a rollback plan.
4. Verify with a health signal (successful resolution and reachability of the approved endpoint) and record before/after observations.

**Success:** the approved endpoint resolves and is reachable, and the affected service's network-dependent health check succeeds.  
**Rollback/escalation:** capture the previous known-good route/resolver/interface state before any change and restore it on failure; escalate when the failure is upstream or outside the managed boundary.  
**Fixture evidence:** `apps/desktop/test/fixtures/runbooks/network-down/`.

## Versioning policy

Every runbook is a versioned document. A breaking change to steps, approval rules, verification criteria, or rollback behavior increments the minor version; a wording-only or non-semantic correction increments the patch version. The current version is recorded in the runbook header, and the git history is the authoritative changelog. Pilot or fixture evidence is tagged with the runbook version it exercised, so an operator can reconstruct exactly which procedure produced a given outcome.

## Failover, escalation & manual intervention

1. **Stop at the boundary.** A runbook never loops an action that failed verification. After the configured attempt limit, stop and escalate.
2. **Escalate with evidence.** Escalation must carry the run id, policy revision, approval decision, attempt history, before/after observations, and the recovery/rollback decision.
3. **Manual intervention.** Any change outside the runbook's allowed commands is a manual intervention: record the actor, the exact action, the reason the runbook was insufficient, and the outcome in the durable run ledger.
4. **Failover.** Where a service supports failover, prefer failing over to a known-good instance before attempting an in-place repair, and verify the failover target before cutting traffic.

## Evidence requirements

For any production pilot, retain run id, policy revision, approval decision, tool attempts, before/after observations, verification result, and recovery/rollback decision. The durable run ledger is the local source of truth for this evidence.
