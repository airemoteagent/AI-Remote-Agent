# Verified operations runbooks

These runbooks are evidence-led and non-autonomous. Local policy remains authoritative; every mutating action requires explicit approval when policy or the user requires it. Record commands, outputs, timestamps, device identity, policy verdict, and recovery evidence in the audit trail.

## Disk full

1. Verify filesystem pressure with read-only diagnostics and identify the mount, size, use percentage, and largest safe candidates.
2. Do not delete data automatically. Propose bounded cleanup and request approval before mutation.
3. Prefer reversible cleanup. Verify free space afterwards. **Rollback** means restore moved data from trash or stop the cleanup.
4. Escalate when pressure risks application integrity, the target is not an approved workspace, or verification disagrees with the original measurement.

## Service down

1. Collect service status, logs, listening ports, health endpoint, recent changes, and dependency state without changing configuration.
2. Form a minimal recovery plan. Restart, configuration change, or failover requires approval and local-policy permission.
3. Verify health, logs, dependency reachability, and user-visible function after each action.
4. Rollback to the last known-good configuration or escalate to an operator when recovery is uncertain.

## Certificate expiry

1. Read certificate subject, issuer, validity dates, trust chain, and affected endpoint.
2. Never replace a certificate or private key without approval, ownership verification, and a reversible deployment plan.
3. Verify the renewed certificate, chain, hostname, TLS handshake, and expiry date. Escalation is required for unknown ownership or chain failures.

## Network down

1. Capture interface state, route, DNS, gateway reachability, and a bounded public connectivity probe.
2. Do not modify routes, firewall rules, VPN settings, or DNS without approval and local-policy authorization.
3. Verify each layer after a reversible approved change. Rollback changed settings or escalate with the collected evidence when connectivity is still unavailable.

## Versioning policy

- Every deployed artifact has an immutable version and SHA-256 digest.
- Preserve the previous known-good artifact and configuration before upgrade.
- Use staged rollout: canary, measured validation, then wider rollout.
- Stop and rollback on failed health, audit, security, or acceptance gates.
- Never silently downgrade policy, audit integrity, or approval requirements.

## Failover, escalation & manual intervention

1. Fail over only to a pre-approved healthy target with compatible policy and current evidence.
2. Escalate with evidence: objective, scope, plan/policy revisions, commands, outputs, errors, changed artifacts, hashes, verification results, and rollback state.
3. Manual intervention is required for irreversible actions, ambiguous ownership, degraded audit health, unverified security changes, or recovery beyond approved runbooks.
