# Release, Distribution, and Community Validation Checklist

Use this checklist for every tagged release. It is a process template, not evidence that a release or audit has passed.

## Release inputs

- [ ] Pin the release commit, version, supported platforms, Node/npm requirements, and change summary.
- [ ] Identify security-sensitive changes and link their tests and review notes.
- [ ] Confirm `SECURITY.md`, `CHANGELOG.md`, docs, support matrix, and deprecation notices are current.
- [ ] Review dependency updates, lockfile diff, licenses, and generated SBOM.

## Build and artifact integrity

- [ ] Build from a clean checkout in a documented environment.
- [ ] Run the full test suite, including adversarial/security tests; record exact command and result.
- [ ] Produce checksums and provenance/attestation for each published artifact.
- [ ] Verify package contents do not include credentials, fixtures with sensitive data, server-only code, or unexpected files.
- [ ] Test install, upgrade, rollback, and uninstall on each supported OS/architecture.
- [ ] Verify least-privilege file permissions, policy defaults, and updater behavior after installation.

## Distribution channels

For each channel (npm/package, installer, container, or other):

- [ ] Record artifact URL, digest/checksum, signing or provenance metadata, and publication timestamp.
- [ ] Confirm the channel's owner, access controls, 2FA, and recovery contacts.
- [ ] Confirm release notes explain breaking changes, security fixes, migrations, and rollback steps.
- [ ] Validate install instructions in a disposable environment and ensure commands are copy-safe.
- [ ] Check that repository tags, package metadata, SBOM, and docs all identify the same version.

## Community validation

- [ ] Invite independent users/reviewers to test supported platforms with synthetic data.
- [ ] Collect reproducible setup, platform, version, logs (redacted), and expected/actual behavior.
- [ ] Label feedback as bug, security report, compatibility issue, documentation gap, or feature request.
- [ ] Route suspected vulnerabilities privately; do not ask reporters to post exploit details publicly.
- [ ] Publish known limitations and unresolved compatibility issues.
- [ ] Credit contributors only with explicit permission and document retest status.

## Sign-off record

- Release: `__________`  Commit: `__________`  Date: `__________`
- Test command/result: `__________`
- Artifacts and digests: `__________`
- SBOM/provenance links: `__________`
- Reviewer/maintainer sign-off: `__________`
- Exceptions and follow-up owners/dates: `__________`

Do not use this checklist to claim an independent audit, certification, or security guarantee. Those claims require the named external evidence and its scope.
