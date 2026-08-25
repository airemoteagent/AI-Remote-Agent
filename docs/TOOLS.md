# Tools Reference

The built-in tools give the cloud agent real hands on your machine. Each tool
runs in a sandbox with clear boundaries.

## files

File operations confined to safe paths.

| Operation | Notes |
|---|---|
| `list` | Directory listing with sizes and mtimes |
| `read` | Read text files (size-capped) |
| `write` | Write text files (atomic) |
| `move` / `delete` | Rename / remove within allowed paths |

**Safety:** the tool refuses to touch paths outside the allowed roots
(home, workspace, temp). Symlink escapes are rejected.

## shell

A guarded, allowlisted command shell.

- Commands run through an allowlist of safe patterns (`ls`, `cat`, `df`,
  `uptime`, …); anything matching a dangerous pattern (`rm -rf /`,
  fork bombs, `sudo` without confirmation) is **blocked before execution**.
- Output is streamed back line-buffered, so the dashboard log feels live.
- Each execution is logged and attached to the audit trail in the cloud.

Example the agent might run:

```bash
df -h / && du -sh ~/Downloads | sort -h | tail -5
```

## net

Network helpers for connectivity checks and HTTP.

| Helper | Use |
|---|---|
| `http` | GET/POST JSON requests (outbound only) |
| `ping` / `reachable` | Host / port reachability |
| `dns` | DNS lookups |
| `wake` | (LAN) wake-on-LAN helper, where supported |

Used by the cloud agent for health checks, webhooks and diagnostics.

## sysinfo

System metrics for the live device dashboard.

| Metric | Snapshot interval |
|---|---|
| CPU usage % | every 10 s |
| Load average (1/5/15) | every 10 s |
| Memory total / used / % | every 10 s |
| Disk usage % | every 10 s |
| Uptime | every 10 s |
| Hostname, platform, arch, CPU model, cores, version, IP | on connect |

The cloud keeps the latest snapshot plus a rolling 180-point history per
device and renders sparklines for CPU and memory in the dashboard.

## apps

Launch or quit desktop applications on the host OS.

| Action | Behaviour |
|---|---|
| `open` | macOS: `open -a`; Linux: `gtk-launch` / `xdg-open`; Windows: `start` |
| `quit` | macOS: `osascript`; Linux: `pkill`; Windows: `taskkill` |

- App names are sanitized (letters, digits, spaces, `.`, `_`, `-` only).
- Commands run with an 8 s timeout; output is capped (2 KB stdout / 1 KB stderr).
- Unsupported platforms return a clear error instead of guessing.

## browser

Open URLs or run web searches in the default browser.

| Action | Behaviour |
|---|---|
| `open` | Opens a URL — only `http:`/`https:` accepted, everything else rejected |
| `search` | Builds a search URL (`site`: `web` → Bing, `google`, `youtube`) |
| `watch` | Opens a URL for viewing (video/streaming) |

- Queries are URL-encoded and capped at 300 chars.
- No browser automation — it opens the user's real default browser.

## memory

Persistent memory across tasks and restarts — plain markdown files under
`~/.mona-agent/memory/` (override with `MONA_MEMORY_DIR`), one file per day.

| Action | Behaviour |
|---|---|
| `remember` | Appends a timestamped note (max 4000 chars) to today's file |
| `recall` | Searches notes for a query |
| `list` | Lists recent note files |

The cloud brain loads these notes at task start (persistent memory injection)
and can update them, so the agent gets smarter with each task.

## vector

Semantic memory + file index — a dependency-free local vector store
(`~/.mona-agent/vector-index.json`, override with `MONA_VECTOR_STORE`).
Notes and workspace files are embedded with a deterministic hashing-trick
embedding (256-dim signed feature vectors) and searched by **meaning**
(cosine similarity), not just literal keywords.

| Action | Behaviour |
|---|---|
| `remember` | Adds a note (`text`) to the index; near-duplicates merge |
| `search` | Natural-language query (`query`); returns scored hits with source |
| `index` | Indexes a file or directory under the workspace (`path`, default `.`) — chunked, binary-safe, size-capped, path-traversal denied |
| `list` | Lists recent index entries |
| `stats` | Index size, dimension, path |
| `forget` | Removes an entry by `id` |

The same index feeds the per-task **vector recall** context block: before a
task starts, the daemon embeds the task text, retrieves the closest notes
and workspace chunks, and injects them into the brain's prompt — so the
agent starts every task already knowing what it has seen before.

Example the agent might run:

```json{"tool":"vector","args":{"action":"search","query":"how do I restart the web server"}}
```

## jobs

Background command management — long-running work must never block the task
loop or die with the 15s shell timeout. `jobs` gives the brain the same job
lifecycle an agent harness exposes: start, poll, read incremental output,
wait, or kill.

| Action | Behaviour |
|---|---|
| `start <cmd> [cwd]` | Runs the command in the background, returns `id` + `pid` immediately |
| `status <id>` | `running` / `done` / `error` / `killed`, exit code, elapsed, bytes captured |
| `output <id> [tail]` | Captured stdout/stderr — last `tail` chars (default 4000) with byte counts |
| `list` | All jobs, newest first |
| `wait <id> [timeoutS]` | Polls until completion (max 120s), then returns status + tail output |
| `kill <id>` | SIGKILLs the whole process group |

**Security parity:** `start` routes through the exact same surface as the
`shell` tool — quote-aware argv parsing (never a shell string), allowlist +
realpath binary resolution, blocked patterns, scrubbed child env, and the
shell policy tier. When policy denies the `shell` tool (or a command matches
`shell.approval`), `jobs start` refuses identically — a background command
can never widen device policy.

**Lifecycle:** each job spawns its own process group (detached), output is
captured in memory (256 KB per stream), and `kill` takes the whole tree
down. Jobs live for the daemon process lifetime — restarting the daemon
clears them.

Example the agent might run for a long build:

```json{"tool":"jobs","args":{"action":"start","cmd":"npm run build"}}
```
then poll with `{"tool":"jobs","args":{"action":"wait","id":"job-3","timeoutS":90}}`.

## delegate

Sub-agent fan-out — split a task into independent sub-tasks and run them
**concurrently** as fresh, bounded sub-agents on the same device.

| Field | Behaviour |
|---|---|
| `tasks` | Array of `{id, prompt}` (max 6) — each becomes a fresh sub-agent |
| `concurrency` | How many sub-agents to run at once (1–4, default: all) |

Every sub-agent gets its own message context (a focused system prompt + the
sub-goal), obeys the **same policy and budget** as the parent, and shares the
same tool sandbox. Each result returns:

```json
{ "id": "sub-1", "status": "done", "answer": "...", "steps": 3,
  "usage": { "total": 412 }, "trace": [ ... ] }
```

`status` is `done`, `error` (sub-brain crashed or loop errored), or
`blocked` (budget/policy limit). Failed sub-agents are reported — never
silently dropped — and the parent is instructed to read every result before
answering. Sub-events are written to the local hash-chained audit log under
`kind: subtask`.

**Safety:** delegation is depth-limited (max 2 levels), so a sub-agent can
never fan out into runaway recursion; sub-loops enforce policy exactly like
the main loop — a sub-agent cannot do anything the parent could not.

Example the agent might run to compare three files:

```json
{"tool":"delegate","args":{"tasks":[
  {"id":"a","prompt":"Summarise README.md in 3 bullets"},
  {"id":"b","prompt":"Summarise CHANGELOG.md in 3 bullets"},
  {"id":"c","prompt":"Summarise docs/TOOLS.md in 3 bullets"}
],"concurrency":3}}
```

## goal

Persistent multi-round completion objectives — the agent's "goal rounds".
Start a long objective and it keeps running across autonomous rounds until
it is genuinely complete (or the round cap is reached).

| Action | Behaviour |
|---|---|
| `start {objective, maxRounds?}` | Creates the goal and runs round 1 immediately (rounds cap 1–16, default 8) |
| `status <id>` | Status, rounds completed, last summary, full round history |
| `list` | All goals, newest first |
| `resume <id>` | Enqueue the next round now (active goals only) |
| `abort <id>` | Stop — no further rounds run |

Each round runs as a **normal queued task** (serial — steps never interleave
with user tasks), seeded with the objective and every previous round's
summary, and must end with exactly:

```
GOAL_COMPLETE: true|false
GOAL_REASON: <one short sentence>
```

`true` only when the objective is genuinely finished and verified. If the
round cap is reached without completion the goal becomes `blocked`; if the
brain crashes mid-round the goal stays active and the next round can resume.

**Durability:** goals persist to `~/.mona-agent/goals.json` (0600, atomic
writes) and survive daemon restarts — the same durable-objective model a
harness uses. Round outcomes are recorded in the local hash-chained audit
log (`kind: goal`).

Example the agent might run for a big cleanup job:

```json
{"tool":"goal","args":{"action":"start","objective":"Find and remove duplicate downloads, then verify disk space gained","maxRounds":5}}
```
then poll with `{"tool":"goal","args":{"action":"status","id":"goal_abc123"}}`.

## workflow

Multi-phase orchestration — coordinate complex jobs as an ordered pipeline
of phases. Each phase fans out to several concurrent sub-agents, with a
**barrier between phases**: a phase starts only after the previous phase's
results exist.

| Field | Behaviour |
|---|---|
| `phases` | Array of `{name, tasks, context?, concurrency?}` (max 8 phases, 6 tasks per phase) |
| `tasks` | `[{id, prompt}]` — each becomes a concurrent sub-agent |
| `context` | `["phaseA", ...]` — earlier phase results injected into this phase's sub-agents |
| `concurrency` | Sub-agents in flight inside this phase (1–6, default all) |

Each phase returns `{name, status, failed, results}` where `results` is the
per-task list (`status: done|error|blocked`, `answer`, `usage`, `trace`).
The top level returns `{status, phases, results}` — `status` is `partial`
when any sub-task failed; failures are reported in place and **never abort
later phases** (they can read the failure and react).

Example — research, then synthesize from the research:

```json
{"tool":"workflow","args":{"phases":[
  {"name":"research","tasks":[
    {"id":"a","prompt":"Summarise README.md"},
    {"id":"b","prompt":"Summarise CHANGELOG.md"}
  ],"concurrency":2},
  {"name":"synthesize","tasks":[
    {"id":"s","prompt":"Write one combined release-note draft"}
  ],"context":["research"]}
]}}
```

**Safety:** workflows reuse the same sub-agent machinery as `delegate` —
same policy, same budget, same tool sandbox, same depth limit (max 2
levels of nesting). Sub-events are recorded in the hash-chained audit log
under `kind: workflow`.

## plugin

Dynamic tool plugins, managed at runtime. Third parties ship extra tools as
packages named `mona-agent-tool-*` (or any directory on `MONA_TOOL_PATH`)
that export `defineTool()` descriptors — the agent SDK. They are hot-loaded
without forking the core.

| Action | Behaviour |
|---|---|
| `list` | Every tool with source (`builtin`/`plugin`) + policy status |
| `load <path>` | Discover + register a plugin directory right now |
| `reload` | Re-run discovery for `MONA_TOOL_PATH` + `node_modules` |
| `remove <name>` | Unregister a plugin tool until the next load |

**Security:** a plugin tool is **denied by default** — it runs through the
same policy choke point as builtins. The owner explicitly allows one in
`~/.mona-agent/policy.json`:

```json
{ "tools": { "my.tool": "allow" } }
```

`plugin list` prints the exact rule each plugin needs. Plugins can never
override builtins or each other (collision = hard error). The daemon
advertises loaded plugins to the cloud when it connects.

Example — load and check a plugin directory:

```json
{"tool":"plugin","args":{"action":"load","path":"/opt/mona-tools"}}
{"tool":"plugin","args":{"action":"list"}}
```

## security

The shell's security posture, advertised to the cloud in the `hello` handshake
so the control plane can enforce `agent_permissions` without probing:

| Field | Meaning |
|---|---|
| `allowlist` | Allowed command names (env `MONA_ALLOW_CMDS`, per-OS defaults) |
| `unsafe` | `true` only when policy `shell.unsafe` is set (or deprecated `MONA_SHELL_UNSAFE=1`) |
| `platform` | Detected OS (`darwin` / `linux` / `win32`) |
| `mode` | `argv` — commands execute as argv arrays, never as a shell string |

Execution model (v2.8+):

- Commands are parsed quote-aware into argv arrays; `&&`, `||`, `;` chains
  and `|` pipes are supported, and EVERY segment's executable must pass the
  allowlist (pipe-to-shell is structurally impossible — `sh`/`bash` are not
  allowlisted).
- Executables are resolved to their realpath before execution.
- Redirects (`>`, `<`), command substitution (`$()`, backticks) and
  env-assignment prefixes are rejected with a clear error.
- The child environment is scrubbed to `PATH/HOME/LANG` (+ a few safe
  vars); only `$HOME`, `$PATH`, `$USER`, `$LANG`, `$PWD`, `$TMPDIR` expand.
- Timeouts kill the whole process group; output is capped at 64 KB per
  stream (8 KB returned in tool results).
- `MONA_SHELL_UNSAFE=1` is deprecated — set
  `{"shell": {"unsafe": true}}` in `~/.mona-agent/policy.json` instead.

Blocked patterns (defence-in-depth, always denied): `rm -rf /`, `mkfs`,
`dd if=`, fork bombs, `sudo`, `shutdown`, `format C:`, `diskpart`, and
friends — see `src/tools/shell.js` for the full list.

## net

SSRF-safe HTTP(S) fetch (v2.8+):

- DNS is resolved by the agent; every address must pass the blocked-range
  check (loopback, private, link-local, metadata, CGNAT, reserved, IPv6
  equivalents) — DNS rebinding cannot walk past it.
- Connections go to the validated IP with the real Host header and TLS SNI.
- Redirects are re-validated on every hop, max 5.
- Cloud metadata endpoints are blocked by name (`metadata.google.internal`,
  …) and by IP (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`).
- Response size is capped (50 KB for the tool) and read as a bounded stream
  — no decompression bombs. No env bypass exists.

## web

Web research — pure Node, no external dependencies, multi-OS.

- `ddgSearch(query, max = 8)` — DuckDuckGo HTML search (no API key), returns
  `[{title, url, snippet}]` with real targets extracted from redirect links.
- `fetch` page → `htmlToText()` — strips scripts/styles/tags, decodes HTML
  entities, caps output at 10 KB.
- 15 s timeout per request, honest `mona-agent/2.x` user agent.

## notify

Desktop notifications — lets the agent surface alerts on your screen.

| Platform | Mechanism |
|---|---|
| macOS | `osascript` `display notification` |
| Linux | `notify-send` (fails silently if absent) |
| Windows | `msg` via PowerShell |

- Titles are capped at 100 chars, bodies at 300.
- All shell metacharacters (`"`, `'`, `\`, backtick) are stripped before the
  command is built — notification text can never escape into the shell.
- Unsupported platforms return a clear error instead of guessing.

## Adding your own tool

Tools live in `apps/desktop/src/tools/` and are plain ES modules. Each tool
exposes a `run(action, args)` and registers itself in
`src/tools/index.js`. Keep the same rules: validate input, never execute
untrusted data, and always stream results.

## Skills

Skills are user-enableable capability packs (a `SKILL.md` with instructions
plus optional `tools/*.mjs` helper tools) installed into
`~/.mona-agent/skills/`. The bundled ones ship with the agent:

```bash
mona-agent skills list          # installed skills + enabled state
mona-agent skills install       # install the bundled skills (idempotent)
mona-agent skills enable <name> # inject its instructions into the brain
mona-agent skills disable <name>
```

### Capability dial (mode)

Instead of tuning skills and policy by hand, set a profile:

```bash
mona-agent mode list
mona-agent mode set minimal   # no skills, strict policy (read-only)
mona-agent mode set standard  # core skills, shell/browser need approval
mona-agent mode set full      # all skills, permissive policy + auto-start daemon
```

`mode set` writes `~/.mona-agent/policy.json`, enables exactly the mode's
skills and — for `full` — marks the daemon for auto-start.

### Daemon (background service)

```bash
mona-agent daemon status      # service + pid state
mona-agent daemon install     # launchd (macOS) / systemd (Linux) auto-start
mona-agent daemon uninstall   # stop + remove
mona-agent daemon stop        # signal the running daemon to exit
```

Single-instance: `~/.mona-agent/daemon.pid` guards against double-run; stale
pid files (after a crash) are cleaned automatically.

Enabled skills' instructions are injected into the agent's context, and their
tools become callable through the same registry as the built-ins.

## Policy (engine)

The engine checks every tool call against a policy before executing it —
and the tool registry enforces the same policy for direct commands
(`mona-agent exec`, dashboard tool calls). Defaults are safe (all built-in
tools allowed, destructive shell patterns blocked); an optional
`~/.mona-agent/policy.json` (or `MONA_POLICY`) tunes it:

```json
{
  "version": 1,
  "tools":     { "shell": "confirm", "web": "deny" },
  "shell":     { "deny": ["git\\s+push"], "unsafe": false },
  "rateLimits": { "shell": { "perMinute": 20 }, "*": { "perMinute": 300 } },
  "budget":    { "dailyTokens": 500000, "dailyCostUsd": 2 },
  "maxSteps":  12,
  "audit":     true
}
```

- `tools`: per-tool tier — `allow` | `deny` | `confirm` (unknown tools are
  default-denied)
- `shell.deny`: extra regex patterns (blocked); `shell.unsafe: true`
  enables unrestricted argv execution (audited — replaces the deprecated
  `MONA_SHELL_UNSAFE=1` env flag); legacy `approval.patterns` still works
- `rateLimits`: per-tool sliding per-minute window (`*` = default for all)
- `budget`: daily caps; `0` = unlimited. Levels degrade automatically:
  normal → eco (cheap profile) → critical (minimal) → exhausted (no tasks)
- `maxSteps`: 2–16 (default 8)
- `audit`: `false` disables the decision log (not recommended)

Presets (write one to `~/.mona-agent/policy.json`):

```bash
mona-agent policy preset strict      # read-only: shell/net/browser/apps denied
mona-agent policy preset standard    # shell & browser need approval, rate limits
mona-agent policy preset permissive  # everything allowed (default behaviour)
mona-agent policy status             # show the active policy + tool tiers
mona-agent policy explain <tool>     # show which rule decides a call
```

The policy file is **local and authoritative** — it loads from disk at
startup and the control plane can never modify or widen it.

## Audit log (engine)

Every policy decision (tool call, shell check, rate-limit denial) is
appended to `~/.mona-agent/audit.jsonl` (0600) as a hash-chained,
append-only JSONL stream — `h_n = sha256(h_{n-1} || entry)`. Tampering
breaks the chain:

```bash
mona-agent audit tail      # last 20 decisions
mona-agent audit verify    # verify the whole chain (exit 1 on tampering)
```

## Budget (engine)

Daily token/cost usage is recorded in `~/.mona-agent/budget.json` (0600) and
survives restarts. When a cap is hit the daemon answers new tasks with a
clear message instead of burning spend — and the dashboard shows the level
in the device stats.

## Memory store (engine)

Alongside the markdown memory tool, the engine keeps a structured store
(`~/.mona-agent/memory-store.json`): deduplicated near-identical entries,
TTL expiry (30 days default), capped at 500 entries, and scored recall —
now **hybrid vector recall**: cosine similarity over hashed feature vectors
(0.7) + recency decay (0.2) + hit boost (0.1). The daemon auto-remembers
finished tasks and recalls them into future prompts; legacy entries without
stored vectors are embedded lazily on first recall.
