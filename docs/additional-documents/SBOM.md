# Software Bill of Materials (SBOM)

Client-side component inventory for the remote-agent device daemon.

## Runtime dependencies

| Component | Version | Purpose | License |
|---|---|---|---|
| Node.js (runtime) | ≥ 20 | JavaScript runtime | MIT |
| ws | ^8.18 | WebSocket client (optional relay) | MIT |

The client has exactly **one npm dependency** (`ws`); everything else —
cloud client, engine protocol, SSE handling, tool registry, TUI — is
implemented in this repository with Node built-ins.

## Build & toolchain

| Component | Purpose |
|---|---|
| node:test | Test runner (451 tests incl. security red-team suite, no external test deps) |
| npm workspaces | Monorepo layout (packages/engine, packages/protocol, apps/desktop) |

## Server-side (operated by the platform)

The cloud side is a PHP application on standard shared hosting (LiteSpeed,
MySQL/MariaDB, PHP 8.x) plus the Sngine framework for accounts and payments.
Provider SDKs are not used; LLM calls are plain HTTPS REST. Server components
are the operator's responsibility and are documented for audits in this
folder.

## Generating a full SBOM

```bash
npm ls --all --json > sbom-npm.json
```

Combine with the Git tag manifest (`git tag`, `CHANGELOG.md`) for a complete
release inventory.

## Vulnerability monitoring

- `npm audit` on the single dependency per release
- GitHub Security advisories for the repository
- SECURITY.md reporting path for external findings
