# FLEET CONSOLE — all devices, all agents, full transparency, full control

The enterprise surface. One dynamic view (SSE) of **every device** and **every
agent process**, with the same control primitives as `focus`.

    remote-agent fleet                 # console at http://127.0.0.1:3096
    remote-agent fleet --snapshot      # JSON: device + agents + budget + gate
    remote-agent fleet --resume-all    # un-stop everything focus paused

## Data model (`GET /status`)

```
{ at, console:"fleet", port,
  device:  { id, host, platform, arch, cores, model, memTotalMB, memFreeMB, uptimeS },
  devices: [ {…device, role, agents, busy, paused }, …roster ],
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

`http://127.0.0.1:3099/` (the dashboard Mona uses) is a thin shell that embeds the
full console, so "full transparency" is one URL. The console itself runs under
launchd as `com.mona.deepdive` on **:3097**.

## Why it is "dynamic"

- SSE frame every 2s; CPU from cputime deltas, so bursts are real, not averaged away.
- Devices/agents/procs are derived each tick — the view cannot go stale silently
  (a dead peer shows `online:false`; a dead host shows the page as `stale`).
