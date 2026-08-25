# Software Bill of Materials (SBOM)

The mona-agent client ships with an SBOM in CycloneDX format:
[`sbom.cyclonedx.json`](../sbom.cyclonedx.json).

## Highlights

- **1 runtime dependency** — `ws` (WebSocket implementation). No
  transitive runtime dependencies.
- **Zero build step** — the client runs directly from source on
  Node.js ≥ 20.
- **Dev dependencies** — none beyond the Node.js test runner (162 tests,
  including the 58-case security red-team suite).

## Regeneration

```bash
cd apps/desktop
npm ls --json --omit=dev --all > /tmp/deps.json
# the sbom is regenerated from deps.json + package metadata (scripts/sbom.mjs)
node ../../scripts/sbom.mjs
```

## Vulnerability handling

Dependencies are monitored on every change. If a CVE is reported in a
dependency:

1. Triaged within 48 h
2. Fixed / mitigated and released
3. Coordinated disclosure via [SECURITY.md](../SECURITY.md)

One dependency means the attack surface stays small — that is a
deliberate engineering constraint of this project.
