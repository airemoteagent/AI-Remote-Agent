# SPEC — mona-agent → Enterprise Agent Framework

> Status: **proposed roadmap** · Owner: implementing agent · Target: v2.0.0+
> This document is the build specification. Work packages ship in order,
> one PR each, each independently green and revertible. Nothing below is
> applied blind: every package starts with reading the real source.

---

## 0. Ground truth (verify first)

Current state as documented:

- `mona-agent` v2.8.x, ESM, Node ≥20, one runtime dep (`ws@^8.18`), MIT
- Monorepo: `packages/{engine,protocol}`, `apps/desktop` (12+ source files,
  bin at `apps/desktop/bin/mona-agent.js`)
- Test suites: `apps/desktop/test/*.test.mjs` + `packages/*/test/*.test.mjs`
  (167 cases incl. security red-team suite), no CI visible, tags v2.0.0–v2.8.3
- Model: "cloud-brained" — control plane holds LLM keys, device is a tool
  executor over WSS + an HTTPS task-polling channel
- Version lifecycle (v2.8.2+): single source of truth in root
  `package.json`, `mona-agent version|update [check]`, dashboard Update
  button drives `!cmd update` over the task channel

Confirmed defect to fix first: `apps/desktop/package.json` reports 1.8.1
while root reports 2.8.x — version.js reads the root, but the desktop
package metadata is stale. Also description claims Windows support while
README badges claim macOS | Linux | WSL2. Pick one and make it true.

Before writing code: clone, run `npm test`, run `npx madge --circular src`,
and produce `docs/AUDIT.md` mapping every exported function to:
keep as-is · keep with hardening · move into new module · delete.

## 1. The core problem

The repo is a single-purpose remote-execution daemon with an LLM-shaped
control plane in front of it. It is not yet a framework: no public API,
no way to define an agent, no way to add a tool without editing
`src/tools/index.js`, no types, no extension points. "Free forever, MIT,
1 dependency" is a real asset — the upgrade must not destroy it.

The serious problem is security posture: a compromised or malicious
control plane gets arbitrary shell on every connected device, with only
an env-var allowlist in the way. An enterprise buyer fails that in the
first security review.

Everything below serves two goals:
**(A)** make the device trustworthy independent of the control plane, and
**(B)** turn the tool registry into a real SDK.

## 2. Target architecture

```
┌──────────── Device ─────────────────┐
│  Kernel (runtime)                   │
│   ├─ Session/Task manager           │
│   ├─ Policy Engine  ◄── local, wins │
│   ├─ Tool Registry (plugin SDK)     │
│   ├─ Sandbox (worker/child + limits)│
│   ├─ Event Bus → Log/OTel/Audit     │
│   └─ Transport adapters             │
│        ├─ cloud (WSS, existing)     │
│        ├─ local (BYO provider key)  │
│        └─ mcp (stdio/HTTP)          │
└─────────────────────────────────────┘
```

Three inversions of the current design:

1. **Policy is local and authoritative.** The control plane requests; the
   device decides. A signed local policy file bounds what any remote party
   can ever ask for. The cloud cannot widen it.
2. **Transport is pluggable.** `cloud.js` becomes one adapter behind an
   interface, so the same agent runs fully offline with a local key,
   against a self-hosted plane, or as an MCP server.
3. **Tools are packages, not files.** Third parties ship tools without
   forking.

## 3. Target layout

```
agent/
├─ bin/mona-agent.js            thin arg parse → src/cli/
├─ src/
│  ├─ cli/                      command per file, registry-based
│  ├─ kernel/
│  │   ├─ agent.js              loop: plan→policy→dispatch→observe
│  │   ├─ session.js            durable task state, idempotency
│  │   ├─ queue.js              bounded, priority, backpressure
│  │   └─ cancel.js             AbortController propagation
│  ├─ policy/
│  │   ├─ engine.js             evaluate(request, ctx) → allow/deny/prompt
│  │   ├─ schema.js             policy file schema + validator
│  │   └─ defaults.js           deny-by-default baseline
│  ├─ tools/
│  │   ├─ define.js             defineTool() — the public SDK
│  │   ├─ registry.js           discovery, versioning, conflict resolution
│  │   ├─ sandbox.js            worker_threads/child_process isolation
│  │   └─ builtin/{sysinfo,shell,files,net,process,clipboard}.js
│  ├─ transport/
│  │   ├─ index.js              adapter interface
│  │   ├─ cloud.js              existing WSS + hardening
│  │   ├─ local.js              direct provider (BYO key, opt-in)
│  │   └─ mcp.js                MCP server + client
│  ├─ observability/
│  │   ├─ log.js                JSON lines, redaction, levels
│  │   ├─ otel.js               optional peer dep, no-op if absent
│  │   ├─ audit.js              hash-chained append-only local log
│  │   └─ metrics.js
│  ├─ config/
│  │   ├─ schema.js, load.js    file + env + flag precedence
│  │   └─ credentials.js        keychain → file fallback
│  ├─ tui/                      split: render/state/input/panels
│  └─ index.js                  public entry: exports the SDK
├─ types/index.d.ts             hand-written, shipped
├─ examples/                    5+ runnable agents
├─ docs/
├─ test/{unit,integration,security,e2e}/
└─ .github/workflows/
```

Rule: `src/index.js` is the API contract. Anything not exported there is
internal and may change. Document in `docs/STABILITY.md`.

## 4. Work packages

Do these in order, one PR each, each independently green.

### P0 — Repo hygiene (1 commit, no behavior change)
- Fix `repository.url`, `homepage`, `bugs`, stale desktop version.
- Add `SECURITY.md` (disclosure + 90-day policy), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `CHANGELOG.md` (Keep a Changelog).
- `.editorconfig`, `eslint.config.js` (flat, eslint-plugin-security + -n),
  prettier.
- `.github/workflows/ci.yml`: matrix node [20,22,24] × os
  [ubuntu,macos,windows], jobs = lint, test, `npm audit --audit-level=high`,
  actionlint. `.github/dependabot.yml`. Pin actions to SHAs.
- `package.json`: `exports`, `files`, `types`, `engines.npm`,
  `publishConfig.provenance`.
- **Acceptance:** CI green on all 9 cells; `npm pack --dry-run` contains no
  test/dev files.

### P1 — Types and public API
No TypeScript conversion — keep zero-build + one-dependency. JSDoc types +
`checkJs` + hand-written `types/index.d.ts`. `tsconfig.json` with
`{"checkJs": true, "noEmit": true, "strict": true, "allowJs": true}`.
`test/types.test-d.ts` with tsd.
- **Acceptance:** `tsc --noEmit` clean; tsd passes; typed example gets full
  IntelliSense with zero build step.

### P2 — Tool SDK (highest leverage)
Replace ad-hoc dispatch in `src/tools/index.js` with `defineTool()`:

```js
export function defineTool({
  name,            // /^[a-z][a-z0-9_-]{1,31}$/, namespaced "fs.read"
  version,         // semver, required
  description,     // used verbatim in LLM tool schemas
  input,           // JSON Schema draft 2020-12
  output,          // JSON Schema — validate BOTH directions
  capabilities,    // ['fs:read','net:egress','proc:spawn','env:read']
  sideEffects,     // 'none' | 'local' | 'external' | 'destructive'
  idempotent,      // boolean — enables safe retry
  timeoutMs,       // default + hard ceiling
  concurrency,     // max parallel invocations
  redact,          // (result) => result, strips secrets before logging
  handler,         // async (input, ctx) => output
}) { /* freeze, validate, return descriptor */ }
```

`ToolContext` (ctx) provides exactly:
`{ signal, logger, workspace, emit(event), invoke(name, input), secrets.get(key), limits: { memoryMb, wallMs, outputBytes } }`

Registry: discovery from builtin + `node_modules/mona-agent-tool-*`
(package.json `monaAgent.tools` field) + configured paths. Namespace
collision = hard startup error. `mona-agent tools list|inspect|validate`.
`registry.toSchemas({dialect})` → OpenAI/Anthropic-compatible schema.
Migrate all builtins; the existing tests must pass unchanged.
- **Acceptance:** a tool in `examples/tools/hello/` installed via
  `npm i ./examples/tools/hello` is discovered, listed, invokable with no
  core edits.

### P3 — Policy engine (the security pivot)
New `src/policy/`. Deny-by-default, evaluated on every tool invocation
including tool→tool. Policy file `~/.mona-agent/policy.json`:

```json
{
  "version": 1,
  "default": "deny",
  "rules": [
    { "tool": "sysinfo.*", "effect": "allow" },
    { "tool": "fs.read", "effect": "allow",
      "when": { "path": { "within": ["~/.mona-agent/workspace"] } } },
    { "tool": "fs.write", "effect": "prompt",
      "when": { "path": { "within": ["~/.mona-agent/workspace"] },
                "size": { "max": 10485760 } } },
    { "tool": "shell.run", "effect": "prompt",
      "when": { "argv0": { "in": ["git","npm","ls","df"] } } },
    { "tool": "net.fetch", "effect": "allow",
      "when": { "host": { "notIn": ["metadata.google.internal"] },
                "ip": { "notInCidr": ["127.0.0.0/8","10.0.0.0/8","172.16.0.0/12",
                                      "192.168.0.0/16","169.254.0.0/16","::1/128","fc00::/7"] } } },
    { "tool": "*", "effect": "deny" }
  ],
  "prompt": { "mode": "tui", "timeoutSec": 120, "onTimeout": "deny" },
  "rateLimits": { "shell.run": { "perMinute": 20 }, "*": { "perMinute": 300 } }
}
```

Hard requirements:
- The control plane **cannot** modify policy. Local disk at startup;
  remote updates rejected outright.
- Effects: `allow`, `deny`, `prompt` (TUI approval; auto-deny headless
  unless `--yes-i-know`).
- Every decision audited with full request + matching rule + outcome.
- First-match-wins, ordered, `mona-agent policy explain <tool> <input>`.
- Presets: `strict` (read-only), `standard` (workspace writes, prompted
  shell), `permissive` (current behavior + startup warning banner).
- **Acceptance:** `test/security/policy.test.mjs` ≥40 cases: path
  traversal, symlink escape, SSRF — all denied.

### P4 — Harden the four builtin tools
**shell.js** — never a string to a shell: `execFile/spawn shell:false`
+ argv array. Allowlist matches argv[0] only, realpath'd, set membership
(not substring). Wall-clock timeout, output cap (1 MiB, truncate+flag),
process-group kill on abort, scrubbed env (`PATH,HOME,LANG`), cwd inside
workspace. Remove `MONA_SHELL_UNSAFE` env var (policy-file decision only).

**files.js** — realpath + prefix containment with trailing separator
(symlink-safe), re-check after open (TOCTOU: O_NOFOLLOW + fstat), deny
dotfiles outside workspace + special files (/dev,/proc,FIFOs), cap sizes,
trash-based delete with `--purge` opt-in.

**net.js** — SSRF: resolve DNS yourself, check every resolved IP against
blocked CIDRs, connect to validated IP with Host header (DNS-rebinding
safe), re-validate every redirect hop (max 5), cap response size + time,
no decompression bombs, block metadata endpoints
(169.254.169.254, metadata.google.internal, fd00:ec2::254).

**sysinfo.js** — detail level: coarse by default (fingerprintable PII
gated behind `detail: "full"` + policy allow).

- **Acceptance:** red-team suite in `test/security/`: command injection,
  path traversal, symlink escape, TOCTOU, SSRF-via-rebinding,
  redirect-to-metadata, zip bomb, fork bomb, output flood — all denied +
  audited.

### P5 — Transport hardening + adapters

> **Status: partially shipped (v2.10.1).** `apps/desktop/src/transport/local.js`
> (BYO-key on-device brain: anthropic / openai-compatible / ollama) and
> `apps/desktop/src/transport/mcp.js` (MCP stdio server over the registry)
> are implemented and tested. Signed commands, replay cache and the
> HTTP MCP transport remain.

`src/transport/index.js` interface:
`{ name, connect(opts), send(msg), on(event, fn), close(), health() }`

**cloud.js hardening:** reject non-wss in production (localhost or
`--insecure` banner allowed); signed commands
`{nonce, issuedAt, deviceId, payloadHash}` verified against pinned
control-plane key; replay cache; optional `MONA_CA_PIN`; exponential
backoff with jitter (cap 60s) + circuit breaker; heartbeat ping/pong +
app-level liveness; bounded inbound queue (drop-with-audit under
pressure); idempotent commands (`commandId`, re-delivery returns cached
result).

**local.js (new):** run the loop fully on-device with a user-supplied
provider key — Anthropic + OpenAI-compatible + Ollama via a 3-function
provider interface, zero-dep with fetch.

**mcp.js (new):** expose the registry as an MCP server (stdio + HTTP)
and consume external MCP servers as tools.

- **Acceptance:** `examples/researcher.js` runs unchanged under all three
  adapters, selected by config.

### P6 — Durability, observability, operations
- Sessions: `~/.mona-agent/sessions/<id>.jsonl` append-only +
  `mona-agent sessions ls|show|resume|rm`.
- Audit: hash-chained (`h_n = sha256(h_{n-1} || entry)`), 0600, rotated,
  `mona-agent audit verify`.
- Logs: JSON Lines to stderr, TRACE..FATAL, traceId/spanId/sessionId,
  regex + entropy redaction; pretty printer only on TTY.
- OTel: optional peer dep, loaded dynamically, no-op absent. Spans:
  session → step → tool-invocation → subprocess.
- `mona-agent doctor` (env, perms, connectivity, clock skew, policy lint,
  keychain) + optional localhost `/healthz` + `/metrics` on
  `--metrics-port`.
- Credentials: OS keychain first (security / libsecret / DPAPI), 0600 file
  fallback; never argv (`mona-agent login` reads stdin).
- Service units: launchd plist, hardened systemd
  (NoNewPrivileges, PrivateTmp, ProtectSystem=strict, MemoryMax),
  Windows Service wrapper if Windows is claimed.
  `mona-agent service install|uninstall|status`.
- Containers: distroless multi-stage Dockerfile, non-root, read-only
  rootfs, HEALTHCHECK, docker-compose.yml.

## 5. Supply chain and release

- Publish to npm; `npm i -g mona-agent` primary, curl|bash fallback.
- install.sh: SHA-256 checksum from signed manifest, Sigstore/cosign
  verify, version-pinned by default, `--dry-run`, refuse root,
  shellcheck-clean.
- npm provenance via OIDC publish workflow; releases from tags only with
  environment protection.
- CycloneDX SBOM per release; OpenSSF Scorecard workflow + badge;
  branch protection (required checks, signed commits, no force-push).
- Conventional Commits + release-please for automated CHANGELOG/semver.

## 6. Test matrix

| Suite | Target | Notes |
|---|---|---|
| test/unit | ≥85% line, 100% on policy/ + tools/builtin/ | `node --test --experimental-test-coverage` |
| test/security | ≥60 adversarial cases | red-team list from P4 |
| test/integration | full loop vs mock control plane | ws fixture, chaos: drop/delay/dup/reorder/malformed |
| test/e2e | install → login → connect → task → result | Docker, per-OS |
| test/fuzz | policy evaluator + frame parser | fast-check devDep |
| test/types | public API surface | tsd |

Add a 24 h soak test: flat RSS, no FD leak. Enforce coverage in CI.

## 7. Documentation deliverables

`docs/`: ARCHITECTURE.md (diagram + trust boundary drawn explicitly),
THREAT_MODEL.md (STRIDE; compromised control plane in scope + how policy
mitigates), SECURITY_MODEL.md (what sandbox does/doesn't guarantee — it is
not a VM), TOOLS.md (defineTool reference + "write your first tool in 20
lines"), POLICY.md (grammar, presets, explain walkthrough), DEPLOYMENT.md
(systemd/launchd/Docker/fleet), PROTOCOL.md (versioned wire format),
MIGRATION-1.x-to-2.0.md, ADRs for the three inversions.
Rewrite README around the framework story: 4-line quickstart, 20-line
"build your own agent" above the fold, SaaS as one deployment of it.

## 8. Commit / PR sequence

1. `chore`: repo hygiene, CI matrix, metadata fixes
2. `chore`: eslint/prettier/tsc --checkJs, zero warnings
3. `feat(types)`: hand-written d.ts + tsd
4. `feat(tools)`: defineTool SDK + registry (builtins migrated, tests unchanged)
5. `feat(policy)`: deny-by-default engine + presets + explain
6. `fix(security)`: shell argv execution ← flag as security release
7. `fix(security)`: fs realpath containment + TOCTOU
8. `fix(security)`: SSRF — DNS pinning, CIDR deny, redirect revalidation
9. `feat(transport)`: adapter interface + signed commands + idempotency
10. `feat(transport)`: local + mcp adapters
11. `feat(obs)`: JSON logs, redaction, hash-chained audit, optional OTel
12. `feat(ops)`: service units, Docker, doctor, signed installer, provenance

Then tag v2.0.0, publish with provenance, file a GHSA for #6–#8 if the
string-shell path shipped.

## 9. Non-negotiables

- **Do not add runtime dependencies.** ws stays; everything else
  devDependency or optional peer loaded dynamically. The one-dependency
  badge is a competitive asset.
- **Do not break 2.x CLI invocations** without a deprecation path +
  warning for one minor version.
- **Do not let the control plane widen local policy. Ever.**
- **Do not claim a security property the tests don't prove.** Every README
  claim maps to a test file named in docs/SECURITY_MODEL.md.
- **Preserve the TUI.** Add a panel for pending policy prompts + denied
  requests — make the security model a visible feature.
