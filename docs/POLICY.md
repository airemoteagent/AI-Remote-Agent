# Policy — rule grammar, presets, and `policy explain`

## Centralized versioned administration

The engine also provides a local durable `PolicyRegistry` primitive for centralized administration without claiming an external control-plane or identity-provider integration. Each tenant owns immutable, monotonically versioned policy revisions. Administrators create revisions, activate one revision, and roll back by activating an earlier revision. Tenant identifiers are required for listing and activation; cross-tenant reads return `null`. Policy lifecycle mutations are recorded in the existing hash-chained audit log.

`AdminApi` exposes `createPolicy`, `listPolicies`, `activatePolicy`, and `activePolicy`. These are JSON routing primitives only: transport authentication and operator authorization remain the responsibility of the embedding control plane. JIT grants now carry an optional tenant identifier and tenant-aware checks filter grants by tenant; new administration should always provide it.


The policy engine is the **device-side authority**. It is loaded once from
local disk (`~/.remote-agent/policy.json` or `REMOTE_POLICY`) at startup. The
control plane can never modify it — remote policy updates are rejected
outright. The cloud can only ever *ask*; the device *decides*.

## Two policy shapes

### v1 — tier map (legacy, still supported)

```json
{
  "version": 1,
  "tools": { "shell": "confirm", "web": "deny" },
  "shell": { "deny": ["rm -rf /"], "approval": ["git push"] },
  "rateLimits": { "shell": { "perMinute": 20 }, "*": { "perMinute": 300 } },
  "budget": { "dailyTokens": 500000, "dailyCostUsd": 2 },
  "audit": true
}
```

Tiers: `allow` · `deny` · `confirm`. Known tools default to `allow`;
unknown tools default to `deny`.

### v2 — rules (P3, recommended)

```json
{
  "version": 2,
  "default": "deny",
  "rules": [
    { "tool": "sysinfo.*", "effect": "allow" },
    { "tool": "fs.read", "effect": "allow",
      "when": { "path": { "within": ["~/.remote-agent/workspace"] } } },
    { "tool": "fs.write", "effect": "prompt",
      "when": { "path": { "within": ["~/.remote-agent/workspace"] },
                "size":  { "max": 10485760 } } },
    { "tool": "shell.run", "effect": "prompt",
      "when": { "argv0": { "in": ["git", "npm", "ls", "df"] } } },
    { "tool": "net.fetch", "effect": "allow",
      "when": { "host": { "notIn": ["metadata.google.internal"] },
                "ip":   { "notInCidr": ["127.0.0.0/8", "10.0.0.0/8",
                                        "172.16.0.0/12", "192.168.0.0/16",
                                        "169.254.0.0/16", "::1/128", "fc00::/7"] } } },
    { "tool": "*", "effect": "deny" }
  ],
  "prompt": { "mode": "tui", "timeoutSec": 120, "onTimeout": "deny" },
  "rateLimits": { "shell.run": { "perMinute": 20 }, "*": { "perMinute": 300 } }
}
```

## Rule semantics

- **First-match-wins.** Rules are evaluated top to bottom; the first rule
  whose tool glob matches *and* whose `when` conditions pass decides.
- **Deny by default.** If no rule matches, `default` applies (`deny`
  unless explicitly set to `allow`).
- **Tool globs.** `*` matches everything; `sysinfo.*` matches
  `sysinfo.detail` but **not** bare `sysinfo`; `fs.*` matches `fs.read`.
- **Effects.**
  - `allow` — runs immediately (subject to rate limits).
  - `deny` — refused, audited with the matching rule.
  - `prompt` — interactive approval in the TUI; **auto-denied in headless
    mode** unless the caller explicitly grants approval. Audited either way.
- **`when` conditions** (all optional, ANDed):
  - `in` / `notIn` — scalar membership on an arg value.
  - `within` — realpath containment (symlink-safe; `~` expanded).
  - `min` / `max` — numeric bounds.
  - `inCidr` / `notInCidr` — IPv4/IPv6 CIDR containment (SSRF defense).
- **Rate limits** apply after the effect resolves to allow.

## Presets

| Preset | Effect |
|---|---|
| `strict` | Read-only: shell/net/browser/apps denied, files confined to workspace |
| `standard` | Core skills + safe tools; shell/browser/apps require approval |
| `permissive` | Everything allowed (pre-policy behavior) + startup warning |

```bash
remote-agent policy preset strict|standard|permissive
```

## Debugging: `remote-agent policy explain`

```bash
remote-agent policy explain fs.read path=/tmp/x
remote-agent policy explain net.fetch url=https://example.com ip=93.184.216.34
```

Output shows the matched rule (or the default fallback), the effect, and
why. Every decision is also written to the hash-chained audit log when
`audit` is on.

## The architectural line

> **The control plane cannot widen local policy. Ever.**

A compromised or malicious control plane can ask for anything — the local
policy file is the only thing that decides what the device actually
executes. This is what makes the device trustworthy independent of the
cloud. If managed policy is ever added, it must be a separate **signed**
artifact verified against a pinned org key, and it may only narrow, never
widen.

## Tests

`packages/engine/test/policy-rules.test.mjs` — 18 cases covering glob
matching, CIDR + path containment, first-match-wins, prompt semantics,
SSRF vectors (metadata hosts, private ranges), symlink escape, path
traversal, and the no-widen guarantee.
