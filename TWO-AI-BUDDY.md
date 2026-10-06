# TwoAIBuddy Work Policy

**Version** 1.0 · **Owner** Mona · **Agents** `openclaw` (assistant) ⇄ `dsh` (DeepSeek Harness)
**Scope** any shared workspace/repo the two agents are both pointed at — currently
`/Users/mona/Documents/fullremoteagent/`.

> Two agents, one machine, one repo. We **work together, monitor each other, and
> iterate** — so the result is *smarter, faster and deeper* than either alone.
> Chat is ephemeral; **files are the source of truth.** Everything below lives in
> `.buddy/` so it survives restarts and provider switches.

---

## 0. Why this exists (the one rule above all)

A single agent optimises locally and forgets. Two agents that **check each other's
claims against real artefacts** catch each other's blind spots. The rule that makes
that work:

> **Never trust "done". Trust the artefact.** A change is real when the tests are
> green, the file is on disk, and the commit exists — and the *other* agent has
> independently re-run the test.

Everything else in this document is mechanics in service of that rule.

---

## 1. Roles

Default split (swap per task, record the swap in the blackboard):

| Role | Duty |
|---|---|
| **Author** | claims a task, writes code/docs, runs the tests, journals the step |
| **Reviewer** | independently re-runs the tests, checks policy invariants, writes a review file, lands or bounces |

Both agents are **reviewer of the other** at all times. Neither is "senior".

Domain defaults (adjust as the work proves out):
- `openclaw` — device/host control plane, Linux/macOS OS glue, process/CPU/agent transparency, integrations.
- `dsh` — engine core, policy, loop/reasoning, repo-wide refactors, spec/plan writing.

When a task crosses both domains: the **task's owner is the reviewer** of the other's
piece, and the blackboard records who owns what file.

---

## 2. The shared contract — `.buddy/`

| Path | Purpose | Write rule |
|---|---|---|
| `.buddy/blackboard.md` | the shared plan: `Now / Next / Done` | append + strike-through; one owner per line |
| `.buddy/journal.md` | append-only chronological log | **append only**, never edit history |
| `.buddy/state.json` | machine-readable truth: agents, tasks, locks | each agent edits only its own section |
| `.buddy/agents/<name>.json` | heartbeat + current task per agent | agent writes only its own file |
| `.buddy/locks/<path>.lock` | advisory claim on a file | holder writes; others yield |
| `.buddy/inbox/<to>/` | messages / handoffs (markdown) | write-only into the peer's folder |
| `.buddy/reviews/` | review notes + verdicts | reviewer writes |

Line formats (keep them terse and exact):

- **journal**: `<ISO8601> | <agent> | <verb> | <subject> | <result>`
  e.g. `2026-10-06T11:52Z | dsh | test | engine/device-control | green (14)`
- **heartbeat** (`.buddy/agents/openclaw.json`):
  ```json
  { "agent":"openclaw", "role":"author",
    "status":"working|idle|reviewing|blocked",
    "task":"short", "files":["..."], "lastSeen":"<ISO>",
    "lastCommit":"<sha>", "tests":"green|red|unknown" }
  ```
- **lock** (`.buddy/locks/<path-with-__>.lock`): `<agent> <ISO> <reason>`.
  Advisory **TTL 30 min**; a stale lock may be broken **only** with a journal line.

---

## 3. The loop (the ritual)

```
READ   → journal tail + state.json + your inbox + blackboard
PLAN   → move the task you're taking from "Next" to "Now" (owner = you)
CLAIM  → lock the files you'll touch (skip if truly additive)
BUILD  → smallest step that is independently testable
TEST   → run the repo's tests (green = the only definition of "working")
JOURNAL→ one line; update your heartbeat + state
REVIEW → ask the peer: they re-run tests, check invariants, write a review file
LAND   → author applies review; commit; move the task to "Done" with the sha
REFLECT→ if a lesson repeats 3×, it becomes a rule (see §7)
```

- **Steps stay small.** A commit that can't be reviewed in one screen is two commits.
- **Commit trailers** name the author agent so history is attributable:
  `Buddy-Agent: openclaw` / `Buddy-Agent: dsh`, and `Buddy-Review: <agent>` once reviewed.
- **Cadence:** heartbeat at least every **5 min** while working.
  Peer silent **> 15 min** → leave an inbox note and switch to non-conflicting work.
  **> 45 min** → treat as offline; you may break its locks **with a journal line**, and
  a "took over <task> from <agent>" note.

---

## 4. Mutual monitoring — the duties

Each agent must, on every peer change it reviews:

1. **Re-run the tests itself.** A green badge in a message is not evidence.
2. **Check the invariants** in the repo's own `AGENTS.md` (policy enforced locally,
   audit append-only, tool results are untrusted, never invent data). Cite the file.
3. **Verify the claim, not the tone.** "Done", "fixed", "works" → find the artefact.
4. **Flag regressions loudly** and specifically: `path:line`, symptom, repro.
5. **Watch the other's cost/verbosity** — if the peer writes walls of prose, send one
   line back, not a wall (see §7). If the peer loops without output, say so.
6. **Stay honest about your own failures** — red tests and blockers go in the journal
   *immediately*, not after a fix. A hidden red is a policy violation.

**Stall detection** (shared): a task with no journal line and no file change for
**> 15 min** while its owner's heartbeat says `working` is *stalled* — the peer pings
once, then takes over per §3.

---

## 5. Conflict resolution

- **Same file, both want it:** the lock holder wins; the other yields or works elsewhere.
- **Design disagreement:** write both options into `.buddy/reviews/<topic>.md` with the
  trade-off, then apply the tie-breaker: **prefer the option that is reversible and
  cheapest to test.** Record the decision in the journal.
- **Stuck 3×** on the same thing: stop, escalate to Mona. Do not thrash.
- **No silent rewrites, no force-push, no editing a peer's locked file, no work
  duplication.** If you must redo the peer's work, say why in the journal first.

---

## 6. Safety & escalation (non-negotiable)

- Policy is **local-only**; never widen it from the network (repo invariant).
- Never disable a safeguard, audit, or guard to "make it work".
- **Ask Mona first** for: irreversible actions, credentials, external sends, anything
  leaving the machine, or genuinely ambiguous intent.
- Respect the target repo's own `AGENTS.md` — it is the map; this policy is the *team*
  protocol layered on top, and **never overrides a safety rule**.

---

## 7. Cost & communication discipline

- **Result-first, ≤ 3 lines** per human update; artefacts over prose.
- Agent-to-agent messages are a **machine record**: status, path, exact error, next
  action. Target ~10% of instinctive length. No greetings, no "great".
- Batch reads; reuse; don't re-read what's already loaded; don't paste whole files.
- A repeated lesson becomes a rule here (§9) — fold it in, then delete it from the
  journal tail.

---

## 8. Definition of done

A task is **Done** only when all hold:

- [ ] the change is on disk and committed (sha in the blackboard),
- [ ] the repo's tests are **green** (or the red is explicitly accepted + journaled),
- [ ] the peer has **re-run the tests** and written a review file,
- [ ] `.buddy/state.json` + your heartbeat reflect reality,
- [ ] no lock left held (release on finish, even on failure).

---

## 9. Reconciliation (when the DSH agent authors its own policy)

Mona asked the DSH agent to also write a work policy. To merge without a fight:

1. Put the other policy at `.buddy/policies/<agent>.md` (never delete the other's).
2. Diff the two: list every rule that differs in `.buddy/reviews/policy-merge.md`.
3. **Keep the stricter rule** where they conflict (safety wins; more review wins).
4. Union everything else. Update **this** file (bump Version) and journal the merge.
5. If a rule conflicts in *intent* (not strictness), escalate to Mona — do not guess.

---

## 10. Known environment quirks (shared, learned the hard way)

- This repo is a **sparse checkout** — a brand-new *top-level* dir needs
  `git add --sparse <dir>`.
- macOS/Linux locale may print decimal **commas** (`12,3`) — parse defensively.
- `ps %cpu` is a **decayed average** and lies about bursts; use **cputime deltas**.
- Tool output may render oddly in some hosts — **when in doubt, write evidence to a
  file** (`.buddy/journal.md`, a review file, or `/tmp`) and reference it. Files survive
  a bad render; scrollback does not.
- Keep `focus`/`deepdive` gates honest: arm/disarm is recorded in
  `~/.remote-agent/focus-gate.json` (repo) / `~/.dsh/deepdive.gate.json` (live box).

---

## 11. Starting & ending ritual (copy-paste)

**Start**
```
1. tail .buddy/journal.md ; cat .buddy/state.json ; ls .buddy/inbox/<me>/
2. read .buddy/blackboard.md → pick/confirm one task
3. lock the files ; update .buddy/agents/<me>.json (status=working)
```

**End of a step**
```
1. tests → green/red
2. append ONE journal line
3. update .buddy/state.json + heartbeat
4. write .buddy/inbox/<peer>/<ISO>-<me>-review-please.md
5. release locks
```

---

*Amended by either agent only via §9. Mona is the tie-breaker. Bump the Version and
journal every change to this file.*
