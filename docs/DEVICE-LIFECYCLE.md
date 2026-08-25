# Device & Identity Lifecycle

Covers enrollment, revocation, inventory, health, and tenant isolation (backlog P2.1), and the Windows/Linux operational matrix (backlog P1.3). This is the design contract; implementation tracks against the completion signals below.

## Enrollment
1. A device generates an Ed25519 key pair locally (the private key must be protected by the platform keystore where available) and presents its public key with a one-time nonce/enrollment payload.
2. The payload is signed with the private key. The registry verifies the signature before accepting enrollment and stores only the public key and its SHA-256 fingerprint.
3. A device may continue to use the legacy opaque credential enrollment path for compatibility, but new integrations should use signed enrollment.
4. A device presents a one-time enrollment code + a hardware-bound identity (TPM/Keychain/DPAPI-backed key pair).
2. The control plane issues a short-lived device credential bound to that key; the device never stores a long-lived bearer token.
3. Enrollment records the device's OS, version, arch, and hostname, and assigns a tenant + initial group.

**Done when:** an automated test enrolls a device, rotates its credential, and revokes it end-to-end.

## Inventory & health
1. Devices report a compact heartbeat: last-seen, agent version, policy revision, disk/CPU/memory pressure, and outstanding run count.
2. Inventory is queryable by tenant, group, tag, OS, and health state.
3. Health is a first-class signal for run admission: a device in `degraded` or `offline` state is not eligible for autonomous remediation.

**Done when:** a heartbeat is retained, the inventory query returns it, and a degraded device is excluded from automated remediation.

## Revocation & rotation
1. Revocation is immediate and propagates through the JIT/credential layer (a revoked device credential cannot authorize any subsequent run).
2. Credentials rotate on a bounded interval; rotation is non-disruptive and atomic (the new credential becomes valid before the old expires).
3. A compromised-device path force-revokes every active JIT grant for that device in one operation.

**Done when:** enrollment-to-revocation and cross-tenant isolation are covered by automated tests.

## Tenant isolation & RBAC
1. Every run, device, and grant carries a `tenantId`; a query scoped to one tenant never returns another tenant's data.
2. RBAC is enforced at two layers: device policy (what a device may do) and control-plane roles (who may enroll, grant, or revoke).
3. JIT access (see `packages/engine/src/jit.js`) is the only mechanism for temporary elevation, and it is always audited.

**Done when:** a cross-tenant query returns nothing outside its tenant, and a role without grant permission is refused.

## Windows lifecycle (backlog P1.3)
- Signed installer/update artifacts (Authenticode), OS-backed credential storage (DPAPI/Credential Manager), Event Log integration, least-privilege service account, and install/upgrade/rollback/uninstall acceptance tests.
- Supported matrix: each declared Windows/Windows Server target with lifecycle dates.

## Linux lifecycle (backlog P1.3)
- Native package signing (RPM/DEB), install/upgrade/rollback workflows, and a known-good previous-version rollback path.

**Done when:** every declared Windows and Linux target passes its lifecycle and security acceptance tests.
