# FLEET CONSOLE — all devices, all agents, full transparency, full control

The control plane. One dynamic view (SSE) of **every known agent — running or
not** — every **device**, and the **head** that governs them: `remoteagent.online`.
It is also the appstore: scroll the roster, run or stop any entry.

    remote-agent fleet                 # console + control plane at 127.0.0.1:3095
    remote-agent fleet --snapshot      # JSON: device + agents + budget + gate
    remote-agent fleet --resume-all    # un-stop everything focus paused

## The roster (the appstore)

`GET /agents` (and `catalog` in the frame) lists every agent the device knows,
with live status and the actions it allows:

| kind | what it is | status | actions |
|---|---|---|---|
| `daemon` | the local agent loop (`~/.remote-agent/daemon.pid`) | running / stopped | start, stop |
| `skill` | a bundled or installed skill (`apps/desktop/skills`, `~/.remote-agent/skills`) | available / enabled / disabled | install, enable, disable |
| `peer` | another assistant from `.buddy/agents/*.json` | online / offline (2 h freshness) | — |
| `process` | any agent process **detected** in the process table | running / paused | stop |
| `external` | an agent you registered that is not a local process | — | probe |

### How detection works (and what it cannot see)

Detection is evidence, not a name list inside the engine:

1. **Signature** (`match: "signature:<id>"`, confidence `known`) — the process
   executable + first arguments match a known agent: `dsh`, `openclaw`,
   `remote-agent`, `claude-code`, `codex`, `aider`, `goose`, `opencode`,
   `gemini-cli`, `cursor-agent`, `cline/continue`, `local-llm` (ollama/lms),
   `autogen`, `crewai`, `langgraph`, `mcp-server`, coding agents
   (swe-agent/openhands/gpt-engineer), browser agents (browser-use/skyvern),
   agent platforms (n8n/dify), autonomous agents (autogpt/letta/eliza).
   Matching looks at `comm` + the first three arguments, and **skips shells**, so
   `bash -c grep claude` is not reported as a Claude session.
2. **Registry** (`match: "registry:<id>"`, confidence `known`) — your own agents in
   `~/.remote-agent/agents.json`; no code change needed:

   ```json
   { "agents": [
     { "id": "my-bot", "name": "My Bot", "match": "my-bot\\.py" },
     { "id": "edge-1", "name": "Edge One", "host": "10.0.0.9", "port": 3095, "role": "edge" }
   ] }
   ```

   An entry with a `host` becomes an `external` agent with a `probe` action.
3. **Heuristic** (confidence `possible`) — a `node`/`python`/`bun`/`deno` process
   whose command line mentions agent/assistant/llm/gpt/chat. It is shown as
   **possible**, never asserted, and never counted as a detected agent.

Detection reads the **full process table** (`ps -Ao`), not the sampled census: the
census drops everything below its cpu/memory threshold, which used to hide an idle
agent (0 % cpu) completely. The console reports `scanned`, `detected` and
`possible` counts, so a miss is visible as a number rather than silent. Nothing
here can see an agent that runs in a container, on another host without a registry
entry, or under a name that matches none of the above.

`POST /agents/run {id}` and `POST /agents/stop {id}` are the only write paths.
They are **governed**: the head checks the local policy first
(`Policy.check('fleet', {action,id})`), so a read-only preset refuses control with
the reason attached, every verdict lands in the hash-chained audit log, and the
`standard` preset rate-limits the plane to 30 actions/min. Kills go through the
sampler's protected-pid rules (pid 1, this process, control-surface port owners,
core GUI daemons are never touched).

## Devices (governed, and probed rather than assumed)

`GET /devices` TCP-probes every device on its control port and caches the verdict
for 15 s (`probe` carries the reason: `tcp host:port ok`, `no answer in 1200ms`,
`tcp ECONNREFUSED`). Inside the per-tick snapshot the cached verdict is used and a
stale one is refreshed in the background, so a dead peer never costs a frame.

`POST /devices/action {id, action}` — actions come from the device entry itself:

| device | actions | meaning |
|---|---|---|
| self | `pause-agents`, `resume-agents`, `probe` | SIGSTOP / SIGCONT this machine's agent processes |
| peer | `probe` | reachability only — **there is no remote control channel**, and the endpoint says so instead of pretending |

Device actions pass the same `Policy.check('fleet', …)` gate as agent run/stop.

## The head

`remoteagent.online` is the head entry (`role: "ceo"`): it reads this roster and
reports whether the device is linked (API key present, backend, expiry). It never
fakes a link — no key means `status: "offline"` in the UI and in JSON.

## Glass: what is enforced, proven, and reachable

`GET /overview` also carries the transparency block the dashboard renders:

```
policy: { source, fleetTier, audit, auditPath, maxSteps, dailyTokens }
audit:  { ok, checked, brokenAt, reason, path }   # auditVerify() of the real chain
models: [ {kind:"cloud"|"byo-key"|"local", provider, model, configured} ]
devices:[ {id, host, platform, cores, memFreeMB, online, …} ]
```

Policy is read from local disk only — a remote policy update is rejected, as ever.

## Data model (`GET /status` / `GET /overview`)

```
{ at, console:"fleet", port,
  device:  { id, host, platform, arch, cores, model, memTotalMB, memFreeMB, uptimeS },
  devices: [ {…device, role, agents, busy, paused, online, probe, actions}, …roster ],
  head{}, counts{all,running,skills,enabled,devices,devicesOnline}, catalog[],
  policy{}, audit{}, models[], modelsError,
  busy, budget{agents,control,apps,browser,system,other}, groups[],
  agents[], procs[], load[], swap{}, gate{}, paused[] }
```

The local device is always present (`role:"self"`). Peers come from the roster
file `~/.remote-agent/fleet.json`:

```json
{ "devices": [ { "id":"pi-1", "host":"pi-1.lan", "platform":"linux", "cores":4, "role":"edge" } ] }
```

## Control (same contract as `focus`)

`POST /mode {mode}` · `/gate {cpuGuard?,priority?}` · `/pause {target|pid}` ·
`/resume {pid?}` · `/renice {pid,nice}` · `/kill {pid,signal?}`

Protected always: pid 1, this process, control-surface port owners, core GUI
daemons. Binds **127.0.0.1 only**. Every action is audited to
`~/.remote-agent/focus-audit.jsonl`.

## Control from the website (no open port, no relay)

The same controls are reachable from **remoteagent.online/console** on a control plane
that has no WebSocket relay and a device behind NAT. The direction is inverted: the
cloud queues, the device pulls.

| step | who | what |
|---|---|---|
| 1 | website | `POST /console/api/<action>` writes a row into `mona_device_commands` (`pending`) |
| 2 | device | `GET /api/v1/agent/commands` (Bearer token, every 2 s) claims it atomically |
| 3 | device | `runDeviceCommand()` policy-checks it with its **own** policy (`fleet` tier) and runs it with the same functions the local dashboard uses |
| 4 | device | `POST /api/v1/agent/commands/{id}/result` reports `done` / `failed` / `refused` |
| 5 | website | polls `GET /console/api/commands?ids=…` until the status is terminal and shows the device's own outcome |

Rules that make it safe to expose:

- **The device decides.** A command the device refuses is reported `refused` with the
  policy reason and rendered as a refusal. The cloud cannot widen what the machine allows,
  cannot skip the audit log, and cannot make an action look done before the device says so.
- **Observer mode is one setting away.** Policy tier `strict` sets `fleet: deny`; remote
  control then answers `refused` with `policy (deny): …` while the roster stays readable.
- **Rate limited on the device**, not only in the cloud: the `fleet` budget
  (`rateLimits.fleet.perMinute`, 30 in the standard preset) is enforced by a policy
  instance held across polls, plus a rolling hard cap the cloud cannot raise.
- **Bounded inputs.** pids must be integers > 1 and are never pid 1 or the daemon; kill
  signals are from a fixed list; payload fields are reduced to typed scalars by the web
  API before they are queued.
- Commands **expire after 10 minutes**; an unclaimed or abandoned command is `expired`,
  never `done`.

`remote-agent audit explain` names the exact line and cause when a hash-chained log stops
verifying, and distinguishes a truncated tail, a rewritten entry and a concurrent-writer
fork — the three things that actually happen.

## Live wiring (this machine)

`http://127.0.0.1:3099/` (the dashboard Mona uses, `~/.dsh/bin/deepdive.mjs`) is a
thin shell: it polls `/overview` on :3095 every 5 s and renders the head, the
roster with run/stop buttons, the glass block, and the plan/goals/todos of every
live DSH session. Its own controls proxy to the plane (`POST /api/agents/run|stop`),
so the plane stays the only writer.

## Why it is "dynamic"

- SSE frame every 2s; CPU from cputime deltas, so bursts are real, not averaged away.
- Devices/agents/procs are derived each tick — the view cannot go stale silently
  (a dead peer shows `online:false`; a dead host shows the page as `stale`).
- The first paint is server-inlined from the last frame: the page never shows
  empty panels while a fetch is in flight.
