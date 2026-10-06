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
| `process` | a live agent process the sampler sees | running / paused | stop |

`POST /agents/run {id}` and `POST /agents/stop {id}` are the only write paths.
They are **governed**: the head checks the local policy first
(`Policy.check('fleet', {action,id})`), so a read-only preset refuses control with
the reason attached, every verdict lands in the hash-chained audit log, and the
`standard` preset rate-limits the plane to 30 actions/min. Kills go through the
sampler's protected-pid rules (pid 1, this process, control-surface port owners,
core GUI daemons are never touched).

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
  devices: [ {…device, role, agents, busy, paused }, …roster ],
  head{}, counts{all,running,skills,enabled,devices}, catalog[],
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
