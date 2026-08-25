# Changelog

## [3.0.0] - 2026-08-25 — Remote Agent Online (rebrand + brain upgrades)

Rebranded from mona-agent to **remote-agent** as its own product, streaming to remoteagent.online.

### Changed
- Renamed the whole surface: remote-agent CLI/binary, ~/.remote-agent config dir, REMOTE_* env vars, @remote-agent/* npm scope, default cloud https://remoteagent.online.
- Version bump 2.11.0 -> 3.0.0.

### Added (shipped brain upgrades, now the default)
- Unrestricted audited shell (tier unsafe -> allowed + audited).
- Cross-run tool-result cache (sysinfo/web/net/files read-only), with write/delete invalidation.
- files tool tilde path expansion.
- Outcome-feedback learning memory (learnFromRun success/failure).
- Server-side prompt-prefix caching + provider-aware cache-token accounting.


All notable changes to remote-agent are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased — security hardening

### Added
- Ed25519 device identities with signed enrollment, tenant binding, public-key fingerprints, credential lifecycle metadata, rotation, revocation, and timing-safe verification.
- Durable tenant-scoped policy registry with immutable monotonic revisions, activation/rollback, atomic persistence, and audit-chain records.
- Tenant-aware fleet/JIT administration and policy operations through `FleetController` and `AdminApi`.
- Release/update SHA-256 verification, installer checksum enforcement, and Sigstore release-workflow groundwork.
- Prompt-injection trust-boundary rules separating user/policy authority from untrusted web, file, email, plugin, and tool content.
- Security review scope, release distribution checklist, and public security-review intake artifacts.

### Verification
- Full test suite: **437 passed, 0 failed**.
- This release does not claim an independent security audit, hardware-backed key storage, complete SSO/SCIM integration, or external community validation.

## [2.11.0] — 2026-08-17

### Added
- **`remote-agent doctor`** (`apps/desktop/src/doctor.js`): one-shot local
  diagnostics — node version, ~/.remote-agent state, credentials, policy
  parse, audit-chain verify, workspace, BYO provider, control-plane
  reachability, installed version, update availability. Non-zero exit on
  any failed check.
- **Localhost health + metrics** (`apps/desktop/src/metrics.js`):
  `REMOTE_METRICS_PORT` starts `/healthz` and Prometheus-text `/metrics`
  bound to 127.0.0.1 only — systemd/Docker healthchecks and local
  scrapers; the daemon stays egress-only.
- **HTTP MCP transport**: `remote-agent mcp --http [--port N]` — POST /mcp
  JSON-RPC + GET info/healthz, localhost-bound.
- **Optional OTel spans** (`apps/desktop/src/otel.js`): `task.run` and
  `tool.*` spans when `@opentelemetry/api` is installed; complete no-op
  otherwise (no new dependencies).
- **Hardened systemd unit** (via `remote-agent daemon install`):
  NoNewPrivileges, PrivateTmp, ProtectSystem=strict,
  ProtectHome=read-only + ReadWritePaths=%h/.remote-agent, MemoryMax=1G.
- **Installer hardening** (`apps/desktop/install.sh`): `--version <tag>`
  pins a release, SHA-256 verification against the release SHA256SUMS
  asset (`REMOTE_REQUIRE_CHECKSUM=1` hard-fails), extracted-version check,
  `--dry-run`, refuses root unless `--allow-root`.
- **Docker**: non-root multi-stage `Dockerfile` (HEALTHCHECK on
  /healthz) + `docker-compose.yml` (read-only rootfs, tmpfs, persistent
  state volume, host-loopback metrics port).
- **`.github/workflows/release.yml`**: on tag push, packs the source
  tarball, computes SHA256SUMS and attaches both to the GitHub release.
- Tests: metrics (4), doctor (5), otel (2), mcp-http (1) — suite 339
  green.

## [2.10.1] — 2026-08-17

### Added
- **BYO local brain transport** (`apps/desktop/src/transport/local.js`):
  run the reasoning loop on-device against a user-supplied LLM —
  `anthropic` (Messages API), `openai` (any OpenAI-compatible
  `/chat/completions` endpoint: OpenAI, OpenRouter, Groq, LM Studio,
  vLLM), and `ollama` (fully offline, $0). Streaming with usage mapping
  to the engine's `{input, output, total, costUsd}` shape; per-model
  price tables (overridable per provider) feed the budget governor, so
  BYO runs get the same cost governance as vault runs. Config in
  `~/.remote-agent/provider.json` (0600) with env fallbacks; the cloud can
  never read it.
- **`remote-agent provider` CLI**: `set <anthropic|openai|ollama>
  [--key|--url|--model]`, `status` (masked key, model, pricing),
  `unset`, `test` (one-shot smoke call).
- **`REMOTE_TRANSPORT=local`** — fail-fast local-only brain mode; the
  daemon refuses to start when no provider is configured.
- **Daemon brain dispatch** (`agent.js#brainThink`): every think — main
  loop, forced conclusion, verification pass, delegate sub-agents and
  workflow sub-agents — routes through the BYO provider when configured;
  prompts never leave the device. `usageTotals` now carry `costUsd`
  through to the run trace and audit log.
- **MCP transport** (`apps/desktop/src/transport/mcp.js` + `remote-agent
  mcp`): Model Context Protocol stdio server (JSON-RPC 2.0) exposing the
  tool registry to any MCP client — `initialize`, `tools/list`
  (freeform args → JSON Schema), `tools/call`, `ping`. Every call passes
  the same local policy gate as cloud tasks.
- **Examples**: `scripts/disk-watchdog.sh` (cron recipe — alerts before
  a volume fills), `scripts/morning-briefing.sh` (8am briefing),
  `examples/providers/` (BYO templates: anthropic, openai-compatible,
  ollama).
- **`docs/PRICING.md`** — SaaS pricing & metering spec for the control
  plane (tiers, metering events, Stripe mapping, BYO economics).
- Tests: `local-provider.test.mjs` (14) + `mcp.test.mjs` (9) — full
  suite 327 green.

### Changed
- README/docs updated: BYO on-device brain and MCP are shipped, not
  roadmap; offline FAQ now documents the Ollama path.

## [Unreleased]

### Added
- **Vector indexing (dependency-free, local).** New engine module
  `packages/engine/src/vector.js`: a deterministic hashing-trick embedding
  (256-dim signed feature vectors, djb2 + fnv1a), cosine similarity scoring,
  persistent JSON index (0600), TTL, dedupe-by-merge. No API keys, no
  network, no npm dependencies.
- **`vector` tool** (`apps/desktop/src/tools/vector.js`): `remember` notes,
  `index` workspace files (chunked, binary-safe, workspace-confined),
  `search` in natural language, `list` / `stats` / `forget`.
- **Vector recall in prompts**: `MemoryStore.recall` now scores by hybrid
  vector + recency + hit boost (legacy entries embedded lazily), and the
  daemon injects vector-searched context into every task's system prompt.
- **Serial task queue** (`apps/desktop/src/taskqueue.js`): tasks run one at
  a time in arrival order; waiting tasks report their position; steps from
  different tasks can never interleave.
- **Context compaction** in the engine loop: when a task's message history
  exceeds a character budget, old tool results are compressed (head + recent
  tail always survive verbatim) — long tasks no longer risk blowing the
  brain's context window. Visible via `task.compact` step + audit entry.
- **Local task audit**: every task event (start / think / tool / result /
  denied / compact / verify / answer / error) is written to the same
  hash-chained `~/.remote-agent/audit.jsonl` used for policy decisions —
  `remote-agent audit tail|verify` now covers the full task trail.
- **`jobs` tool — background command management** (`apps/desktop/src/tools/jobs.js`):
  long-running work no longer blocks the task loop or dies with the 15s shell
  timeout. `jobs start <cmd> [cwd]` returns a job id + pid immediately,
  `status <id>`, `output <id> [tail]`, `list`, `wait <id> [timeoutS]` and
  `kill <id>` manage it — the same job lifecycle a harness exposes to the
  brain. Background commands route through the *same* security surface as
  the shell tool (argv parsing, allowlist, blocked patterns, scrubbed env)
  and honour the shell policy tier, so a background command can never widen
  device policy. The tool registry now supports per-tool timeouts (jobs may
  wait up to 130s; every other tool keeps the 30s default).
- **`delegate` tool — sub-agent fan-out** (`packages/engine/src/delegate.js` +
  `apps/desktop/src/tools/delegate.js`): the brain splits a task into up to
  six independent sub-tasks (`[{id, prompt}]`) that run **concurrently** as
  fresh, bounded `TaskLoop`s with their own message context — sharing the
  same policy, budget and tool sandbox. Every sub-result returns
  `{status, answer, steps, usage, trace}` so the parent verifies each piece
  before answering; failed sub-agents are reported, never hidden. Sub-steps
  land in the local hash-chained audit log (`kind: subtask`). Delegation is
  depth-limited (max 2 levels) so it can never nest into runaway recursion,
  and sub-loops respect policy exactly like the main loop.
- **`goal` tool — persistent multi-round objectives** (`packages/engine/src/goal.js` +
  `apps/desktop/src/tools/goal.js`): the brain starts a long-running
  completion objective (`goal start {objective, maxRounds?}`) that keeps
  going across **autonomous rounds** until it is genuinely complete — each
  round runs as a normal queued task (serial, never interleaving with user
  tasks) seeded with the objective + every previous round's summary, and
  must end with a `GOAL_COMPLETE: true|false` marker. `goal status/list/
  resume/abort` manage it; goals persist to `~/.remote-agent/goals.json`
  (0600, atomic writes, per-path in-process singleton so the tool and the
  daemon always agree) and survive daemon restarts. Round cap reached
  without completion → `blocked`.
- **`workflow` tool — multi-phase orchestration** (`packages/engine/src/workflow.js` +
  `apps/desktop/src/tools/workflow.js`): ordered pipelines of phases
  (`[{name, tasks, context?, concurrency?}]`, max 8 phases × 6 tasks), each
  phase fanning out to concurrent sub-agents on the same `runSubtasks`
  machinery. A **barrier** sits between phases — a phase starts only after
  the previous phase's results exist — and a phase can declare
  `context: ["phaseName"]` to have earlier results injected into every
  sub-agent's prompt (research → synthesize → verify). Results are
  structured per phase and per task; failing sub-tasks are reported in
  place (`status: partial`) and never abort the workflow.
- **`plugin` tool + dynamic plugin registry** (`apps/desktop/src/tools/plugin.js`,
  `apps/desktop/src/tools/index.js`): third-party tools ship as packages
  (`remote-agent-tool-*` or any dir on `REMOTE_TOOL_PATH`) exporting
  `defineTool()` descriptors, and are **hot-loaded at runtime** — at daemon
  start and on demand. The runtime registry now accepts descriptors (lifted
  to the legacy shape), reports per-tool source (`builtin`/`plugin`) and
  policy tier, and refuses collisions (a plugin can never override a
  builtin). `plugin list|load|reload|remove` manages them. Plugin tools are
  **denied by default**: the owner allows one with an explicit
  `"tools": {"my.tool": "allow"}` policy rule — `plugin list` prints the
  exact rule needed. The daemon advertises loaded plugins to the cloud on
  connect.

### Changed
- `MemoryStore` recall is vector-based while keeping the same on-disk format
  and public API — existing memory files work untouched.
- Tools list now advertises `vector` to the cloud brain.
- **End-to-end engine integration test** (`apps/desktop/test/e2e-engine.test.mjs`):
  the real `TaskLoop` drives the real tool registry through the real policy
  gate — a scripted brain starts and waits on a background job, queries
  plugins, then answers, proving the whole smartness chain works as the
  daemon uses it.

## [2.8.3] — 2026-08-16

### Added
- Dashboard-driven version lifecycle: `!cmd version|update|status` system
  commands handled locally on the device (zero tokens, never reach the
  brain). Server `GET /agents` now surfaces `version`, `last_seen`,
  `online`; `POST /agents/:id/update` queues a self-update; agents UI shows
  the agent version + live badge + Update button.

### Fixed
- `remote-agent update` now verifies the extracted archive version matches
  the requested tag (guards against stale GitHub CDN archives).
- Pre-existing broken `open` allowlist test (duplicate block + wrong
  export) — suite green again.

## [2.8.2] — 2026-08-16

### Added
- Version lifecycle foundation: single source of truth (`src/version.js`
  reads root `package.json`), `remote-agent version`, `remote-agent update
  [check]` (GitHub release feed with tag fallback, self-update with
  rollback on failure, lifecycle record `~/.remote-agent/update.json`).
- Dashboard `update` + `version` commands over the control channel.

## [2.8.1] — 2026-08-16

### Fixed
- Shell allowlist: `open` added to the macOS default allowlist — the agent
  can launch apps/URLs (`open -a Calendar`) out of the box.

## [2.8.0] — 2026-08-16

### Security
- argv shell: quote-aware parsing, `execFile/spawn shell:false`, realpath
  allowlist per segment, scrubbed child env, process-group kill on timeout,
  redirects/`$()`/backticks rejected. `REMOTE_SHELL_UNSAFE` env var
  deprecated → policy `shell.unsafe` (audited).
- net: DNS resolved by agent, every address CIDR-checked, connect-to-IP +
  Host/SNI, redirect revalidation (max 5), metadata endpoints blocked,
  bounded body reads.
- files: O_NOFOLLOW + fstat TOCTOU guard, special-file refusal, trash-based
  delete, try/catch contract.
- policy v2: hash-chained append-only audit log (`remote-agent audit
  tail|verify`), per-tool rate limits, strict/standard/permissive presets,
  `explain()`, registry-wide policy choke point.

### Added
- CLI: `policy status|explain|preset`, `audit tail|verify`.
- CI: Node 20/22/24 × ubuntu/macos, npm audit job, dependabot, SHA-pinned
  actions.
- Tests: 162 green incl. 58-case red-team suite.

## [2.7.0] — 2026-08-16

### Added
- Wire engine + protocol into the daemon — one core, one wire contract.

## Earlier

- v2.0.0–v2.6.x: initial releases (control plane, device daemon, TUI,
  skills, policy v1, hash-chained audit, mTLS identity, sandboxing).
