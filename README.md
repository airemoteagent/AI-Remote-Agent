---
license: mit
tags:
- ai-agent
- ai
- agent
- computer-use
- agentic-ai
- llm-agent
- ai-automation
- ai-assistant
- automation
- cli
- terminal
- daemon
- macos
- linux
- wsl2
- raspberry-pi
- self-hosted
- local-ai
- open-source
- ai-security
- sandbox
- policy
- privacy
- multi-agent
- ai-workflow
- tool-sdk
- plugins
- autogpt
- openai-computer-use
- claude-computer-use
- ai-devops
- ai-sysadmin
- background-jobs
- vector-memory
- cron
- remote-agent
language:
- en
---

# Remote Agent Online

**The remote AI agent for all jobs and tasks.** One command installs an AI agent on
your own machine that streams to **remoteagent.online** and does real work — run
commands, manage files, browse the web, automate, and remember — under a policy you
control, with a tamper-evident audit trail. MIT-licensed, one runtime dependency.
macOS · Linux · Windows/WSL2 · Raspberry Pi.

    curl -fsSL https://remoteagent.online/install.sh | bash
    remote-agent login      # pair with remoteagent.online (installed, unconnected until you do)
    remote-agent start      # the daemon starts polling for work

Then chat from https://remoteagent.online — or point any AI agent at the control plane.

<p align="center">
  <a href="https://github.com/remoteagent-online/remote-agent/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js 20+"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20%7C%20WSL2-informational.svg" alt="Platforms: macOS, Linux, Windows, WSL2, Raspberry Pi">
  <img src="https://img.shields.io/badge/api%20keys-on%20device-0-red.svg" alt="Zero API keys on device">
  <img src="https://img.shields.io/badge/version-3.0.0-blueviolet.svg" alt="Version 3.0.0">
  <img src="https://img.shields.io/badge/tests-449%20incl.%20red--team-brightgreen.svg" alt="449 tests incl. security red-team suite">
</p>

## Security and product status

REMOTE's stated goal is to become the first open-source agent framework where the controls an enterprise deployment needs — device identity, tenant-scoped policy, fleet administration, release integrity, and a tamper-evident audit trail — are implemented and tested in the core, not left as an exercise for the operator.

That is a goal, not a finished product. What is implemented and tested in this repository is listed in the capability-status table below. What remains external — hosted SSO/SAML/OIDC, SCIM provisioning, hardware-backed key storage, an independent security audit, and community adoption — is stated plainly rather than implied. Review the capability-status table and the threat model before production deployment.

## Release verification

Every tagged release publishes a source archive, `SHA256SUMS`, and `sbom.cyclonedx.json`. Verify downloaded artifacts before use:

```bash
sha256sum -c SHA256SUMS
```

GitHub release provenance is attested during the release workflow; inspect it with GitHub's artifact-attestation tooling before production deployment. See [Implementation backlog](docs/IMPLEMENTATION-BACKLOG.md) for remaining supply-chain work.

## What is implemented

The repository ships a set of security and operations primitives as first-class, tested modules (all in `packages/engine/src`, with unit tests):

- **Device identity** — Ed25519 key generation, signed enrollment payloads, signature verification, tenant binding, device fingerprints, and credential lifecycle metadata (`device-registry.js`). The private key is returned only to the caller and never persisted or logged by the registry; the registry stores only a credential hash.
- **Centralized policy** — a durable, tenant-scoped policy registry with monotonic revisions, activation and rollback, definition validation, and tamper detection on load (`policy-registry.js`). Cross-tenant reads return nothing.
- **Fleet administration** — a `FleetController` composing devices, JIT access, runs, upgrades, and policy, exposed through a JSON-safe `AdminApi` boundary (`fleet.js`, `admin-api.js`).
- **Just-in-time access** — role-scoped, tenant-aware, expiring grants that can only narrow a role and are always audited (`jit.js`).
- **Durable run lifecycle** — recovery points, rollback, cancellation, resume, bounded retries, and approval receipts bound to the exact plan and policy revisions (`run-state.js`). A side effect is never replayed merely because a process restarted.
- **Release and update integrity** — SHA-256 artifact verification, fail-closed installer checksums on Linux and Windows, and version/archive consistency checks (`update.js`, `install.sh`, `install.ps1`).
- **Prompt-injection defense** — trusted user instructions and local policy are separated from untrusted web, file, email, plugin, and tool content, with regression coverage.
- **Safer reasoning context** — tool results are normalized and bounded, long histories are compacted without dropping terminal evidence, and recalled memory is fenced and labeled untrusted with provenance and relevance.
- **Governed memory** — entries carry source, scope, confidence, and sensitivity; they can be revoked and forgotten, and revoked entries are never recalled.
- **Supply-chain and operations primitives** — signed plugin manifests and marketplace index, package install/upgrade/rollback state, SIEM NDJSON export, and a checksum-verified release workflow with provenance attestation (code-signing is groundwork, not yet a blocking release gate).

These are repository capabilities with automated tests — not evidence of an independent security audit or of a complete enterprise product. Hardware-backed key storage, full SSO/SAML/OIDC, SCIM service integration, external security review, and community adoption remain deployment or validation work.

## Capability status

The project is actively evolving. The table below separates features implemented in this repository from features that are experimental, cloud-dependent, or still planned. It is a product-status statement, not a security guarantee; configure local policy before enabling a tool with side effects.

| Status | Capabilities | Evidence |
|---|---|---|
| **Available now** | Local policy enforcement, bounded task loop, durable recoverable runs, workspace-confined files, argv-based shell execution, SSRF-safe network fetch, audit chain, jobs, skills, memory (with provenance and revocation), vector retrieval, delegation, goals, workflows, MCP, plugin discovery, Ed25519 device identity, tenant-scoped policy registry, JIT access, and the fleet/admin JSON boundary. | [Architecture](docs/ARCHITECTURE.md), [Tools](docs/TOOLS.md), [device lifecycle](docs/DEVICE-LIFECYCLE.md), [policy controls](docs/POLICY.md), and the automated test suite. |
| **Cloud-dependent** | Hosted control-plane task delivery, cloud model routing, dashboard streaming, device token verification, and cloud-side audit/conversation storage. | [Architecture](docs/ARCHITECTURE.md) |
| **Experimental / operator-managed** | Third-party plugin tools, local provider endpoints, platform-specific service/install flows, and the documented-but-not-yet-pilot-verified operations runbooks. Use restrictive policy and validate in a non-production environment first. | [Policy](docs/POLICY.md), [Windows status](docs/WINDOWS.md), [Runbooks](docs/RUNBOOKS.md) |
| **Planned / evidence required** | Complete Windows operational lifecycle support (signed MSI/MSIX, DPAPI/Credential Manager packaging, elevated SCM validation), hosted SSO/SCIM, signed plugin *distribution*, and an independent security review. | [Implementation backlog](docs/IMPLEMENTATION-BACKLOG.md), [Project plan](docs/PROJECT-PLAN.md) |

## What is an AI agent for your computer?

Most AI assistants live in a chat window. They can write you a script —
but they can't run it. They can explain a crash — but they can't look at
your logs. They can suggest a cleanup — but they can't do it.

REMOTE is an open-source agent that runs on your own computer — macOS,
Linux, Windows, WSL2 or a Raspberry Pi — and gives a model real, bounded
access to the machine. You talk to it from the dashboard or the terminal;
it reasons about the task, then acts: checks disk space, restarts a
service, finds a file, opens an app, runs a cleanup, schedules a job — and
streams every step back so you can see what it did and why.

It is built around a bounded plan → act → reflect → verify loop, with
tool-based control through a sandboxed, allowlisted, policy-gated
surface — never a raw prompt-to-shell pipe. Scheduling, background jobs,
skills, memory, and multi-agent orchestration are all built in.

**The agent runs on your hardware. The model is your choice.** Default:
the cloud you control at [remoteagent.online](https://remoteagent.online) —
your provider keys never touch the device, they sit in an AES-256-encrypted
vault, and the device holds a single revocable token. Or **bring your own
keys on-device** (`remote-agent provider set anthropic|openai|ollama`):
prompts never leave the machine, Ollama runs fully offline at $0, and
any OpenAI-compatible endpoint (LM Studio, vLLM, OpenRouter) works too.

## Why it matters

- **It acts, it doesn't just answer.** Chatbots produce words. REMOTE
  produces outcomes — on your machine, under your policy.
- **Every step is visible.** Reasoning, tool calls, results, token usage,
  model, and latency are streamed live and recorded in an append-only
  audit trail.
- **It never loops silently.** Step budgets, corrective nudges, and forced
  conclusions keep a task from running in the background without output.
- **It is yours.** MIT-licensed, runs on hardware you own, egress-only
  networking, revocable access, one runtime dependency.

## What you can build with it

REMOTE is a small but real agent platform, and it is yours to build on. Here
are some of the things people use it for:

| You want… | You build it with… |
|---|---|
| An **autonomous agent** with a finish line | the `goal` tool — persistent multi-round objectives that keep going until genuinely complete, then stop |
| **Home automation** on a Raspberry Pi | `remote-agent start`, `sysinfo`/`shell`/`notify`, and the SDK |
| **Computer automation** | tool-based control: commands, files, network, apps, browser — every step visible |
| **Server and DevOps automation** | the `disk-health` and `briefing` skills, `jobs` for long-running commands, cron scheduling |
| **Workflow automation** | the `workflow` tool — multi-phase pipelines with barriers and phase-to-phase context |
| A **multi-agent system** | the `delegate` tool — up to 6 concurrent sub-agents sharing the same policy and budget |
| **Scheduled automation** | cron from the dashboard, skills, background `jobs`, persistent memory |
| Your own tools | the `defineTool()` SDK — declarative, versioned, schema-checked, provider-agnostic |
| Third-party extensions | hot-loadable plugins — ship tools as packages, no fork required |
| A **self-hosted agent** | the daemon runs entirely on hardware you own, egress-only — BYO keys (Anthropic / OpenAI-compatible / Ollama) keep prompts on-device |
| A **private assistant** | zero API keys on device, revocable tokens, per-user data isolation |
| A **monitoring watchdog** | `disk-health` skill + `notify` + cron — alerted before volumes fill up |
| A **research assistant** | `web-research` skill + vector memory — sources indexed and recalled by meaning |
| A **fleet of device agents** | multi-device task claiming — each task runs on exactly one winning device |

## Everything it can do

| Capability | How |
|---|---|
| Run commands | argv-based, allowlisted shell — no string-to-shell, env scrubbed, output capped |
| Manage files | sandboxed workspace — traversal, symlink and TOCTOU escapes rejected; deletes go to trash |
| Web research | search + page fetch (no API key needed) |
| Launch apps | open/quit desktop applications (`open -a Calendar`) |
| Browser | open URLs / run searches in your default browser |
| System insight | CPU, memory, disk, load, uptime — streamed live to the dashboard |
| Notifications | desktop alerts (macOS / Linux / Windows) |
| Persistent memory | remembers across tasks and restarts |
| **Vector memory + file index** | dependency-free local vector search by meaning; closest hits injected into every prompt |
| **Background jobs** | `jobs start/status/output/wait/kill` — long-running work outlives the task loop |
| **Delegation** | fan out to up to 6 concurrent sub-agents, verify each result, then answer |
| **Goals** | persistent multi-round completion objectives (up to 16 rounds, resumable) |
| **Workflows** | multi-phase pipelines (up to 8 phases × 6 tasks) with barriers and phase context |
| **Dynamic plugins** | third-party tools hot-load via `defineTool()`, gated by your policy |
| **MCP** | `remote-agent mcp` (stdio) / `--http` — expose every tool to other agents |
| **Diagnostics** | `remote-agent doctor` one-shot health report; localhost `/healthz` + Prometheus `/metrics` |
| Skills | bundled `briefing`, `disk-health`, `web-research` — safe, read-only, composable |
| Schedule runs | cron-style tasks from the dashboard |
| Multi-device | agents claim tasks per device — never executed twice |
| Self-update | `remote-agent update` / dashboard-driven version lifecycle |

## How it works, tool by tool

### Shell and commands

A guarded, allowlisted command shell. Commands execute as **argv arrays,
never as a string handed to a shell** — no `bash -c`, no `$()` injection
surface. Every executable is resolved through a realpath allowlist, child
environment variables are scrubbed, output is size-capped, and the whole
process group is killed on timeout. Always-blocked patterns (`sudo`,
`rm -rf /`, `mkfs`, pipe-to-shell downloads) never reach execution.

```bash
remote-agent chat "how full is my disk and what can I safely clean?"
remote-agent exec shell cmd="df -h /"
```

### Files and workspace

File operations are confined to a workspace with boundary checks,
symlink-resolution guards and TOCTOU re-validation after open. Deletes go
to the trash, not to oblivion. A 1 MB write cap keeps runaway output in
check.

### Network and research

SSRF-safe by construction: the agent resolves DNS itself, CIDR-checks
every resolved address, connects to the validated IP, re-validates every
redirect hop (max 5), and blocks cloud-metadata endpoints. Web research
needs no API key.

### Memory and vector search

A dependency-free local vector index (256-dim hashed embeddings, cosine
similarity) searches your notes and workspace files **by meaning** — no
API keys, no network, no npm dependencies. The closest hits are injected
into every task's prompt, so the agent actually remembers what you asked
it to remember. Legacy memory files keep working untouched.

### Background jobs

Long-running commands no longer block the task loop or die with a shell
timeout. `jobs start <cmd>` returns a job id immediately; `status`,
`output`, `list`, `wait` and `kill` manage it — through the *same*
security surface as the shell tool, so a background command can never
widen device policy.

### Delegation — multi-agent fan-out

The brain splits a task into up to **6 independent sub-tasks** that run
concurrently as fresh, bounded loops with their own message context —
sharing the same policy, budget and tool sandbox. Every sub-result
returns status, answer, steps, usage and trace, so the parent verifies
each piece before answering. Depth is limited to 2 levels: delegation can
never nest into runaway recursion.

### Goals — autonomous rounds with a finish line

Start a long-running objective (`goal start {objective, maxRounds?}`)
and it keeps going across **autonomous rounds** until it is genuinely
complete — each round a normal, serial, non-interleaving task seeded with
the objective and every previous round's summary, ending in an explicit
`GOAL_COMPLETE: true|false` marker. Goals persist to disk, survive daemon
restarts, and are capped (default 8, max 16 rounds). Reaching the cap
without completion reports `blocked` — it never spins forever.

### Workflows — multi-phase orchestration

Ordered pipelines of up to **8 phases × 6 tasks**, each phase fanning out
to concurrent sub-agents on the same machinery. A barrier sits between
phases — a phase starts only after the previous phase's results exist —
and a phase can declare `context: ["phaseName"]` to have earlier results
injected into every sub-agent's prompt. Research → synthesize → verify, in
one command.

### Skills

Safe, read-only, composable skill packages that steer the agent's
behavior: `briefing` (morning summary), `disk-health` (flag volumes above
85%, propose — never run — cleanups), `web-research` (search and
synthesize). Skills are enabled or disabled by mode and by your control
plane's per-agent capability profiles.

## Build your own tools — the SDK

Tools are declarative descriptors, not ad-hoc modules. Write one in a few
lines and the registry discovers, schema-checks, sandboxes and exposes it
to any LLM provider dialect:

```js
// your-tool/package.json → name: "remote-agent-tool-example"
import { defineTool } from 'remote-agent';

export default defineTool({
  name: 'fs.snapshot', version: '1.0.0',
  description: 'Snapshot a directory listing inside the workspace.',
  input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  capabilities: ['fs:read'], sideEffects: 'none', idempotent: true,
  handler: async ({ path }, ctx) => { /* ... */ },
});
```

Every descriptor is deep-frozen, name- and version-validated, and carries
declared capabilities, side effects, idempotency, timeout and
concurrency metadata. The registry refuses collisions — a plugin can
never override a builtin or another plugin.

## Plugins — extend without forking

Third-party tools ship as packages (`remote-agent-tool-*` or any directory
on `REMOTE_TOOL_PATH`) and are **hot-loaded at runtime** — at daemon start
and on demand, no restart. Plugins are inert until your local policy
allows them with an explicit `"tools": {"my.tool": "allow"}` rule, and
the daemon advertises loaded plugins to your control plane on connect.
`plugin list|load|reload|remove` manages them.

## Build on a core that says no — the policy engine

The strongest thing you can build on is a core that refuses politely. The
policy engine (`~/.remote-agent/policy.json`) is the **device-side
authority**: deny-by-default, first-match-wins rules with
`when`-conditions, per-tool rate limits, daily budget caps, and presets
(`strict` · `standard` · `permissive`). It is loaded once from local disk
at startup, and the cloud can never widen it — the cloud only ever
*asks*, the device *decides*.

```bash
remote-agent policy preset strict     # read-only agent
remote-agent policy explain shell.run "df -h"   # why did that get allowed?
remote-agent audit tail               # hash-chained, append-only
remote-agent audit verify             # prove the trail was never tampered with
```

The **capability dial** puts the same idea one command away:

```bash
remote-agent mode set minimal   # read-only: no shell, no network writes
remote-agent mode set standard  # balanced: core skills, shell/browser need approval
remote-agent mode set full      # everything on + auto-start daemon (launchd/systemd)
```

Modes write the local policy file and enable the matching skills. They
are a device-side authority — the cloud cannot change them.

## Architecture

```
┌────────────── Your device ──────────────┐   WSS / HTTPS   ┌──────────────────────────────┐
│  remote-agent daemon                      │ ◄────────────► │  remoteagent.online           │
│  ├─ TaskLoop (bounded plan→act→reflect) │   tasks+steps  │  dashboard · API · vault     │
│  ├─ Policy engine  ◄─ local, wins       │                │  AES-256 encrypted AI keys   │
│  ├─ Tool registry (SDK + plugins)       │                │  cron runner · audit trail   │
│  ├─ Vector memory · task queue          │                └──────────────────────────────┘
│  └─ TUI / daemon / CLI                  │
└─────────────────────────────────────────┘
```

- `apps/desktop` — the device agent: daemon, CLI, terminal UI, skills and
  the tool sandbox. Thin on purpose: it supplies the brain, the tools and
  the trace plumbing.
- `packages/engine` (`@remote-agent/engine`) — the agent core: the bounded
  `TaskLoop`, policy engine, budget governor, memory + vector store,
  delegation (`runSubtasks`), goals (`GoalStore`), workflows
  (`runWorkflow`), durable run lifecycle (`RunStore`), device identity
  (`DeviceRegistry`), tenant-scoped policy (`PolicyRegistry`), JIT access,
  package lifecycle, fleet/admin composition, and SIEM export. **Zero
  runtime dependencies**, fully testable offline.
- `packages/protocol` (`@remote-agent/protocol`) — the versioned wire contract
  shared by the daemon and the gateway.
- `docs/` — [architecture](docs/ARCHITECTURE.md), [policy
  grammar](docs/POLICY.md), [tools reference](docs/TOOLS.md), [compliance
  mappings](docs/COMPLIANCE.md), [roadmap](docs/SPEC.md).

Every loop keeps the agent honest: policy check before every tool call,
corrective nudges on malformed replies, forced conclusion at the step
limit, context compaction when history grows, and budget steering that
degrades to cheaper reasoning profiles as daily caps approach. Every
step — think, tool call, result, denial, profile switch — is streamed to
your dashboard and recorded in the audit trail.

## Quickstart — under a minute

```bash
# 1. Install the agent on your computer (macOS / Linux / WSL2 / Raspberry Pi)
curl -fsSL https://remoteagent.online/install.sh | bash

# 2. Log in with a token from your dashboard (Devices → Generate token)
remote-agent login

# 3. Start it — headless daemon or live terminal dashboard
remote-agent start        # background daemon
remote-agent gui          # live terminal dashboard with scrollback
```

Then open **https://remoteagent.online/** — build an agent, chat with
it, schedule it (cron), watch it work on your device, and revoke access
any time with one click. Requires **Node.js 20+**. Installer,
prerequisites and troubleshooting: [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

The installer verifies release tarballs against the GitHub SHA256SUMS
manifest and refuses to run as root. Containers: `docker compose up -d`
(non-root, read-only rootfs, healthcheck). Diagnose anything with
`remote-agent doctor`.

## Security — the strongest claim, and the one we test hardest

- **Local policy is the authority** — deny-by-default, cloud can never
  widen it. Plugins are inert until you write an explicit allow rule.
- **Sandboxed tools** — argv-only shell with a realpath-resolved
  allowlist, workspace-confined files, SSRF-safe network (DNS resolved
  locally, CIDR-checked, metadata endpoints blocked).
- **Every decision audited** — hash-chained append-only trail;
  `remote-agent audit verify` proves integrity.
- **Egress-only networking** — nothing listens for inbound connections;
  works behind NAT, firewalls and CGNAT.
- **Bounded work** — step budgets, corrective nudges, forced conclusions.
- **Revocable access** — one click in the dashboard kills a device token.
- **Verified** — 449 tests including the security red-team suite; CI runs
  Node 20/22/24 on macOS, Ubuntu, and Windows. Every claim maps to a test.

## How it fits the agent landscape

The agent space is crowded, and most of it is genuinely useful — here is
where remote-agent sits, straight:

- **AutoGPT** made autonomous, goal-driven agents famous. remote-agent
  shares the ambition and adds the two things AutoGPT-era projects
  struggled with: a **bounded, resumable goal loop** and a **local policy
  engine** that says no. The `goal` tool gives you the autonomous agent
  experience with a finish line.
- **Computer use agents** (OpenAI's and Anthropic's tooling among them)
  put AI in control of a machine. remote-agent does the same through a
  **tool-based surface** — commands, files, network, apps — rather than
  pixel-watching, which keeps it fast, deterministic and auditable.
- **Personal assistants like ChatGPT** live in the cloud and answer
  questions. remote-agent is the assistant you can also ask to *do*
  things on the machine you're standing in front of — chat from the
  dashboard, act on the device, every step streamed.
- **Coding agents** (Copilot and friends) live inside the IDE. remote-agent
  is broader and simpler: it automates *your computer*, not your
  editor — though `git`, `npm` and test runners are perfectly within its
  reach.
- **Agent frameworks** like LangChain and CrewAI are rich libraries for
  building agent software. remote-agent is a smaller, dependency-free
  platform with a working policy gate, an SDK, and a running daemon — the
  two are complementary: build on remote-agent for anything that touches a
  real machine.
- **MCP** is becoming the standard way to connect agents to tools.
  remote-agent ships it: `remote-agent mcp` (stdio) or `remote-agent mcp
  --http` exposes the whole tool registry to any Model Context Protocol
  client — policy-gated like every other call.

## Frequently asked questions

**Is remote-agent free?** Yes — MIT licensed, free forever, one runtime
dependency (`ws`). The remoteagent.online cloud has a free tier.

**Do I need an API key?** One: your device token from the dashboard. AI
provider keys (OpenAI, Anthropic, …) live only in the cloud vault —
never on your device. Or bring your own keys on-device with
`remote-agent provider set <anthropic|openai|ollama>`.

**Can it run on a Raspberry Pi?** Yes — any Node.js 20+ machine, headless
(`remote-agent start`), small footprint. Perfect home-lab material.

**Does it work on Windows?** Yes, with native PowerShell/Node foreground
execution and a Windows Service Control Manager adapter:

```powershell
remote-agent start
remote-agent daemon install   # elevated PowerShell
remote-agent daemon status
remote-agent daemon stop
remote-agent daemon uninstall
```

The service is named `RemoteAgent`, uses delayed automatic start and restart
recovery, and does not place API keys in its command line. Windows support is
limited to Windows releases receiving active Microsoft security updates; EOL
releases are not production targets. Native service operations have been
implemented and are covered by the Windows CI path, but this development
machine is macOS, so elevated SCM installation has not been executed locally.
See [Windows support](docs/WINDOWS.md) for the exact boundary and remaining
certification work.

**Can it run fully offline?** Yes. `remote-agent provider set ollama` +
`REMOTE_TRANSPORT=local` runs the brain on Ollama at
`http://127.0.0.1:11434` — no API key, $0 tokens, no prompt leaves the
device. Anthropic and any OpenAI-compatible endpoint work the same way.

**How do I update it?** `remote-agent update` — or the dashboard's Update
button. The installer replaces the agent in place; credentials are
untouched.

**How do I uninstall?** `rm -rf ~/.remote-agent ~/.local/bin/remote-agent`.

**What does it send to the cloud?** Only to the cloud you logged into:
device metrics, tool results, and your chat messages. Nothing to third
parties. Details in [SECURITY.md](SECURITY.md).

**Can the agent damage my machine?** The sandbox is layered and the
policy engine is deny-by-default; start with `remote-agent policy preset
strict` for a read-only agent, and treat it like any user with shell
access: grant what you trust. Every decision is audited.

## Design principles

1. **Do, then show.** Action with a visible trail beats confident text.
2. **Local policy wins.** The cloud may ask; your device decides.
3. **Bounded autonomy.** Goals, sub-agents and workflows all have caps —
   autonomy with a finish line.
4. **One dependency.** Zero build step, zero runtime bloat; the code is
   the documentation.
5. **Honest claims.** Every security property in this README maps to a
   test in the red-team suite.

## Roadmap

The [SPEC.md](docs/SPEC.md) is a working document. Shipped: the tool SDK
(P2), policy rules engine (P3), delegation, goals, workflows, jobs,
plugins, vector memory, secure mode, the BYO-key local model (P5 —
Anthropic / OpenAI-compatible / Ollama), MCP transports (stdio + HTTP),
`remote-agent doctor`, localhost `/healthz` + `/metrics`
(`REMOTE_METRICS_PORT`), optional OTel spans, hardened systemd/launchd units,
native Windows Service Control Manager integration, Windows support preflight,
Windows-safe executable resolution, credential-store abstraction, bounded
replay protection for commands, bounded cancellable task queues, a
checksum-verified version-pinned installer, and a non-root Docker image with
compose. The enterprise primitives — device identity, tenant-scoped policy,
fleet administration, JIT access, durable run lifecycle with bound approvals,
and release integrity — are also implemented and tested in the engine.

Remaining work before a first enterprise release: hosted SSO/SCIM, an
authenticated admin transport/UI, hardware-backed key storage, an independent
security review, and complete Windows operational lifecycle (elevated SCM
validation on real Windows builds, signed MSI/MSIX packaging, native
Credential Manager or DPAPI packaging, and Job Object process-tree
validation).

## Documentation

- [Getting started](docs/GETTING-STARTED.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Tools reference + SDK](docs/TOOLS.md)
- [Policy grammar & presets](docs/POLICY.md)
- [Compliance & trust](docs/COMPLIANCE.md)
- [Windows support](docs/WINDOWS.md)
- [Product and engineering goals](docs/GOALS.md)
- [Project plan](docs/PROJECT-PLAN.md)
- [Changelog](CHANGELOG.md)
- [FAQ](docs/FAQ.md)
- [Examples](examples/README.md) — launchd, systemd, health checks

## Contributing

Bug reports, security issues and pull requests are welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) and report vulnerabilities per
[SECURITY.md](SECURITY.md) (90-day coordinated disclosure, CRA-aligned).

## License

MIT — free to read, fork and run. Your machine, your data, your keys, and
a local policy file that says what the cloud may and may not ask of you.
