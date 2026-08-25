# remote-agent Architecture

How the open-source device daemon is built, and how it talks to the
remoteagent.online cloud.

## Overview

remote-agent is a **headless Node.js daemon** with two jobs:

1. **Execute** — run local tools (files, shell, network, system info) on
   behalf of the cloud agent.
2. **Report** — stream device metrics and command results back to the cloud
   in real time.

```
┌─────────────────────────────────────┐      ┌──────────────────────────────┐
│  Device (your machine)              │      │  remoteagent.online cloud (SaaS)    │
│                                     │      │                              │
│  remote-agent                         │      │  Control plane API           │
│  ┌──────────────┐   ┌────────────┐  │      │  /api/v1/agent/verify        │
│  │ ControlChannel│◄─►│ tools/     │  │      │  /api/v1/agent/stats        │
│  │ (HTTPS + WS) │   │  files     │  │      │  /api/v1/agent/chat …        │
│  │              │   │  shell     │  │      │                              │
│  │   metrics   │   │  net       │  │      │  AI engine (the brain)       │
│  │   commands  │   │  sysinfo   │  │      │  Dashboard + device overview │
│  └──────────────┘   └────────────┘  │      │  Key vault (AES-256)         │
│         │                           │      │  Audit log                   │
│         ▼                           │      └──────────────────────────────┘
│  TUI (remote-agent gui)               │
│  headless daemon (remote-agent start) │
└─────────────────────────────────────┘
```

## Modules

| Module | Responsibility |
|---|---|
| `bin/remote-agent.js` | CLI entrypoint — `gui`, `start`, `login`, `connect`, `chat`, `exec`, `policy`, `audit` |
| `src/config.js` | Credentials, cloud endpoint resolution, platform detection |
| `src/cloud.js` | REST client for the control plane API (Bearer-auth) |
| `src/control.js` | Control channel: versioned envelopes, command dispatch, metrics streaming |
| `src/api.js` | Local HTTP API + WebSocket (used by the local dashboard / desktop UI) |
| `src/agent.js` | Wires the engine core to the cloud brain, tools and trace reporting |
| `src/taskqueue.js` | Serial task queue — tasks run one at a time, in order, never interleaving steps |
| `src/tools/*` | The tool sandbox: `files`, `shell`, `net`, `sysinfo`, `apps`, `browser`, `web`, `memory`, `notify`, `vector` |
| `src/tui.js` | Terminal dashboard — live log, scrollback, status bar |
| `src/log.js` | Structured logging (quiet in daemon mode) |

## Workspaces

The repo is an npm monorepo with three packages:

| Package | Purpose |
|---|---|
| `packages/engine` (`@remote-agent/engine`) | The agent core — policy-as-code, budget governor, structured memory, the bounded TaskLoop. Zero runtime dependencies; fully testable offline. |
| `packages/protocol` (`@remote-agent/protocol`) | The wire contract — versioned envelopes, message types, close codes. The daemon and the gateway both implement it, so they can never drift apart. |
| `apps/desktop` (`remote-agent`) | The device daemon — consumes both packages; the only credential it holds is the remoteagent.online key. |

The daemon is intentionally thin: it supplies the brain (cloud `think`), the
tools and the trace plumbing — all loop behavior (policy checks, budget
steering, corrective nudges, forced conclusion) is engine code that is
tested once and shared with every future client.

## Control channel lifecycle

1. **Boot** — `config.js` loads `~/.remote-agent/credentials.json` and
   resolves the cloud endpoint (`REMOTE_CLOUD` or `https://remoteagent.online`).
2. **Verify** — the daemon authenticates with `POST /api/v1/agent/verify`
   (Bearer token). The server returns the agent identity and capabilities.
3. **Metrics** — every 10 seconds the daemon POSTs a snapshot to
   `/api/v1/agent/stats`: CPU %, load average, memory, disk, uptime, host
   and platform info.
4. **Commands** — on the Sngine control plane the device **polls the cloud
   task queue** every 2 s (`GET /api/v1/agent/tasks`, claim, then report
   via `POST /api/v1/agent/tasks/:id/result`). No inbound port, no
   WebSocket upgrade required. On the Docker platform, commands arrive
   over the WebSocket control channel instead.
5. **Resilience** — metrics streaming is independent of the WebSocket
   channel. If the server cannot upgrade to WebSocket (e.g. shared hosting
   behind LiteSpeed), the daemon transparently falls back to HTTPS polling
   and keeps streaming — no reconnect storm.

## Agentic execution loop

Every task runs the same loop, wherever it came from (dashboard chat,
CLI, or the cloud queue):

```
        ┌───────────────────────────────────────────────────┐
        │                 remoteagent.online brain                │
        │  reason  answer in text OR emit one tool call   │
        └───────────────┬───────────────────────▲──────────┘
           task (HTTPS) │                       │ tool result
        ┌───────────────▼───────────────────────┴──────────┐
        │                   remote-agent                     │
        │  execute tool locally (sysinfo|shell|files|net)  │
        └───────────────────────────────────────────────────┘
```

- Up to **N tool steps per task** (default 8, owner-configurable 2–16 via the
  cloud brain settings) — the loop ends when the brain answers in plain text.
- Tool protocol is provider-agnostic: the brain replies with a single
  JSON object `{"tool":"<name>","args":{...}}` or plain text. No
  provider-specific function-calling plumbing.
- Every tool call is **policy-checked before execution** (engine Policy):
  unknown tools are denied, shell commands run the base + policy deny lists,
  `confirm`-tier tools require approval.
- **Budget steering** — when the daily token/cost caps approach their limit,
  the engine degrades the reasoning profile (`eco` → `cheap` profile, fewer
  steps; `critical` → minimal profile; `exhausted` → no new tasks).
- Every step is reported to the cloud (`tool.call` / `tool.result`,
  plus `think`, `profile`, `denied`, `correct`, `verify` entries) and
  appears live in the dashboard activity feed.
- **Never loops silently** — each iteration emits `step i/N`; a malformed
  reply gets at most 3 corrective nudges; when the step budget runs out the
  engine forces one final conclusion (`conclude`) instead of hanging.
- The final answer is stored in the cloud conversation — history survives
  restarts and is visible from every client.
- Finished tasks are folded into the engine's **structured memory** (dedupe,
  TTL, scored recall) and recalled into future prompts, so the agent
  remembers what it already did.

### Serial execution

All tasks — from the cloud task queue, the control channel or the CLI —
pass through one **serial task queue** (`src/taskqueue.js`). A task arriving
while another is running waits and reports its position (`task.queued`), so
steps from different tasks can never interleave on the dashboard or in the
audit trail.

### Vector indexing (semantic retrieval)

A dependency-free local vector index (`packages/engine/src/vector.js`)
gives the agent real retrieval over everything it has seen:

- **Embedding** — the hashing trick: tokens (stopwords dropped) map to
  signed features in a fixed 256-dimension vector (djb2 + fnv1a), L2
  normalized. Deterministic across processes, so an index built once
  returns the same results after a restart. No API keys, no network calls.
- **Scoring** — cosine similarity over the hashed feature vectors, with
  optional recency weighting and TTL expiry.
- **Three consumers**:
  1. `MemoryStore.recall` scores by **hybrid vector + recency + hit-boost**
     instead of keyword overlap — "how do I restart the web server" now
     finds the note about nginx.
  2. The **`vector` tool** — `remember` notes and `index` workspace files
     (chunked, binary-safe, workspace-confined), then `search` them in
     natural language.
  3. **Per-task prompt context** — before each task the daemon vector-searches
     the index with the task text and injects the closest hits into the
     brain's system prompt, so it starts with the knowledge that matters.
- Persisted to `~/.remote-agent/vector-index.json` (0600).

### Context compaction

Long tasks are guarded against context-window blowout: when the message
list exceeds a character budget (default 60k), old tool results and
reasoning in the middle of the conversation are compressed and, if needed,
dropped — the system prompt, the original task and the recent turns always
survive verbatim. Compaction is visible (`task.compact` step, audit entry,
log line), never silent.

### Local audit trail

Every task event — start, think, tool call, tool result, denials,
corrections, verify, answer, error — is written to the same tamper-evident,
hash-chained `~/.remote-agent/audit.jsonl` used for policy decisions, so the
device keeps its own verifiable copy of everything the agent did
(`remote-agent audit tail` / `verify`).

## Metrics pipeline (HTTP-first)

The client was designed so that **metrics never depend on a WebSocket
upgrade**:

- Every 10 s: `POST /api/v1/agent/stats` with CPU, memory, disk, load,
  uptime, hostname, platform, arch, version, IP.
- The cloud keeps the latest snapshot plus a rolling 180-point history per
  device; the dashboard polls every 3 s — effectively live.
- A device is shown as **online** when its last snapshot is ≤ 20 s old.

## Security model (client side)

- **No AI provider keys on the device.** Only a remoteagent.online device token is
  stored (`~/.remote-agent/credentials.json`, mode 0600).
- **Local policy is authoritative.** `~/.remote-agent/policy.json`
  (`REMOTE_POLICY` to override) governs every tool call — allow / deny /
  confirm tiers, shell patterns, per-tool rate limits, daily budget caps.
  It is loaded once from disk at startup; the control plane can never
  modify or widen it. Presets: `remote-agent policy preset strict|standard|permissive`.
- **Shell executes argv arrays, never shell strings.** Commands are parsed
  quote-aware; every executable is realpath-resolved and allowlisted
  (chains and pipes re-check each segment); the child environment is
  scrubbed to `PATH/HOME/LANG`; timeouts kill the whole process group.
- **SSRF-safe networking.** DNS is resolved by the agent and every address
  is checked against blocked ranges; connections go to the validated IP
  with Host header + TLS SNI; redirects are re-validated per hop (max 5);
  cloud metadata endpoints are blocked by name and IP.
- **Confined files tool.** Boundary-checked workspace containment with
  symlink-escape and TOCTOU guards (`O_NOFOLLOW` + descriptor check),
  special files refused, deletes move to trash.
- **Tamper-evident audit.** Every policy decision is appended to
  `~/.remote-agent/audit.jsonl` (hash-chained, append-only, 0600) and
  verified with `remote-agent audit verify`.
- **Egress-only** — the daemon opens outbound connections only; it listens
  on localhost only (for the local dashboard).

See [SECURITY.md](../SECURITY.md) for the full model and disclosure policy.

## Why HTTPS polling instead of WebSockets?

The control plane runs on shared hosting (LiteSpeed), where WebSocket
proxying is not always available and long-running Node processes are not
possible. The client therefore uses:

- **WebSocket** when the server upgrades it (self-hosted / VPS setups),
- **HTTPS polling + streaming metrics** everywhere else.

One code path, two transports — the daemon decides at runtime.
