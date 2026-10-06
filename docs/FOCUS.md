# FOCUS — deep-dive + device control

`focus` is the module that hands the machine back to its owner, and makes every
process — and every agent — on it transparent. It answers two questions the rest
of the runtime did not: **where is my CPU actually going**, and **who is allowed
to take it** — and then lets the human, not a daemon, decide.

    remote-agent focus                 # console at http://127.0.0.1:3097
    remote-agent focus --snapshot      # current census as JSON (headless)
    remote-agent focus --resume-all    # un-stop everything focus paused

## What it shows (transparency)

- **Every process**, with CPU measured from **cputime deltas** between two samples —
  never `ps %cpu`, which is a decayed average and lies about a burst.
- CPU split into buckets so a human can read it: `agents · control · apps ·
  browser · system · other`.
- The **agent fleet** — every process classified as an agent (sub-agents, browser
  automation lanes, remote brains) with its live CPU and memory.
- **Load, swap, cores**, and the current **gate** (whether the automatic
  controllers are armed) and the **paused set**.

## What it does (control)

- **pause** (`SIGSTOP`) / **resume** (`SIGCONT`) / **renice** / **kill**, per pid or
  per group (`agents`, `openclaw`, `all-agents`).
- **Focus modes** — one switch for the whole machine:
  | mode | gate | fleet |
  |---|---|---|
  | `agents` | guards disarmed | running — agents get the whole machine |
  | `balanced` | guards armed | running — original behaviour |
  | `gaming` | guards disarmed | **paused** — the machine is yours |
  | `pause` | unchanged | paused |
  | `resume` | unchanged | everything paused is resumed |
- **Arm/disarm the autocontrol** — the automatic guards (`cpu-guard`,
  `dsh-priority` on a full harness install) read `~/.remote-agent/focus-gate.json`
  and do nothing while disarmed. Default is armed, so behaviour is unchanged until
  a switch is flipped.

## Why it is safe

- Binds **127.0.0.1 only** — control never leaves the device.
- `pause`/`resume`/`kill` can never touch **pid 1**, **this process**, a
  **control-surface port owner**, or the core GUI/system daemons
  (`WindowServer`, `loginwindow`, `Dock`, `Finder`, …) — see `NEVER_STOP` and
  `isProtectedPid` in `packages/engine/src/device-control.js`.
- Every action is appended to `~/.remote-agent/focus-audit.jsonl`.
- The paused set is **persisted**, so a SIGSTOP survives a crash and is always
  resumable (`focus --resume-all`).

## Honest limits on macOS without root

- `renice` is **one-way**: lowering priority works unprivileged, raising it needs
  root. To actually free a core, **pause** the process.
- `SIGSTOP` frees **CPU but not RAM**. Under memory pressure, `kill` is the lever.

## Code map

| Path | What |
|---|---|
| `packages/engine/src/device-control.js` | the pure logic: classification, cpu deltas, buckets, group selection, `planMode` (declarative, side-effect free) — fully unit-tested |
| `apps/desktop/src/device-sampler.js` | the OS glue (`ps`/`lsof`/`sysctl`/signals) + the gate and paused store |
| `apps/desktop/src/tools/device.js` | the `device` tool — census + actions, policy-gated like every tool |
| `apps/desktop/src/focus.js` · `focus.html` | the console (HTTP + SSE) and its UI |

Decision logic is separated from the OS on purpose: `device-control.js` is pure,
so `tests are the spec` and the control plan can be reasoned about without running
anything.

## Extending the fleet view

`focus` classifies a process as an agent by its command line
(`classifyProcess`). To surface *logical* agents (delegate sub-agents, goals,
runs) alongside the process view, feed `delegate.js` / `goal.js` / `run-state.js`
state into `snapshot()` in `apps/desktop/src/focus.js` — the console already has a
dedicated "agent fleet" panel waiting for it.
