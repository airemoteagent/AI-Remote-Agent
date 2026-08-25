# Plugin & Release Supply Chain

Covers release/plugin attestation, signing, and the trusted-extension marketplace (backlog P1.4 and Goal 7).

## Release evidence (already enforced in `.github/workflows/release.yml`)
1. A tagged release cannot publish until the test suite, declaration tests, and dependency audit pass.
2. The release produces a deterministic source archive, SHA-256 checksums, an SBOM (`sbom.cyclonedx.json`), and a build-provenance attestation.
3. A consumer can verify the archive with a published `sha256sum` command.

## Plugin signing & permissions
1. Every installable plugin ships a manifest with: identity, version, capability/permission list, compatibility range, and a content hash.
2. The manifest is signed; a plugin without a valid signature is never loaded.
3. Permissions are capability-scoped and deny-by-default; a plugin can request only what its manifest declares.

**Done when:** a tampered plugin is rejected before load, and a signed plugin loads only after its permissions are checked.

## Provenance & certification
1. Each plugin carries provenance (who built it, from which revision, with which toolchain).
2. Certification tests exercise the plugin against its declared capabilities before marketplace listing.
3. Interoperability testing is aligned to enterprise standards (ISO 27001, GDPR) where applicable.

**Done when:** every installable extension has machine-verifiable provenance and a documented verification step.

## Marketplace (deferred scope)
The marketplace is a trusted index of signed, certified plugins. Broad third-party expansion remains deferred until durable execution and the three IT-operations runbooks demonstrate safe, repeatable outcomes (see `docs/IMPLEMENTATION-BACKLOG.md`).
