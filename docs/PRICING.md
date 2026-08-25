# PRICING — SaaS sustainability plan (control-plane side)

> This document specs the **private control plane** (agent.mona.expert).
> The open-source client stays MIT and free; the plane is the product.
> BYO keys do not threaten this model — see [Why BYO doesn't hurt](#why-byo-doesnt-hurt).

## Principle

**Meter the plane, not the tokens.** Token resale dies to BYO and
everyone undercutting OpenAI/Anthropic. What cannot be BYO'd is what the
plane *does*: task claiming, scheduling, audit, memory, policy profiles,
multi-device coordination, updates, dashboards, compliance exports.
Charge for that work, per device and per seat, regardless of whose keys
fired the model.

## Tiers

| Tier | Price | Includes | Hard caps |
|---|---|---|---|
| **Free** | $0 | 1 device, cloud-routed keys OR BYO keys, 7-day audit, basic chat | 25 tasks/day, 1 cron job, no delegation/workflows/goals |
| **Pro** | $12/device/mo (or $10 yearly) | BYO-key on-device brain, unlimited tasks, multi-device (up to 5), 90-day audit, cost-governance dashboard, goals/workflows/delegation, memory sync | 5 devices |
| **Team** | $25/seat/mo | everything in Pro + fleet policy templates, per-agent capability profiles, SSO, shared audit, compliance exports (CRA/ISO/IEC mappings already in `docs/`), API access | seats metered |
| **Enterprise** | quote | on-prem control plane, signed releases, LTS window, SLA, priority support | contract |

## Metering events (log these, bill these)

Every event below is **plane work**, independent of vault-vs-BYO:

| Event | Unit | Billed in |
|---|---|---|
| `task.run` (chat / dashboard) | per task | Free cap · Pro unlimited |
| `schedule.cron.fire` | per firing | Pro |
| `workflow.run` / `delegate.run` / `goal.round` | per orchestration step | Pro |
| `device.connect` (active month) | per device-month | Pro ($/device) |
| `audit.retention` | days | Free 7 · Pro 90 · Team/Enterprise custom |
| `memory.sync` / `vector.sync` | per GB-month | Pro |
| `policy.profile` (per-agent capabilities) | per agent profile | Team |
| `compliance.export` | per export | Team |
| `mcp.proxy` (if plane proxies MCP calls) | per call | Team/Enterprise |
| `plugin.marketplace.purchase` | per purchase | 25% revenue share |

## Stripe mapping

- **Free→Pro:** subscription per active device count (usage-based line
  items, metered billing). Webhook `invoice.created` + `customer.subscription.updated`.
- **Free-tier enforcement:** server-side quota middleware keyed on the
  events above — the client can never self-report limits.
- **Team:** per-seat subscription + `customer.tax_ids`; SSO gate via
  `portal_session` (Stripe Customer Portal) to avoid building billing UI.
- **Marketplace:** Stripe Connect — `transfer` to tool authors with
  25% platform fee; destination charges, KYC via Connect Express.
- **Dunning:** `invoice.payment_failed` → degrade to Free caps after 14
  days, never hard-kill the agent (device stays safe, plane features
  scale down).

## Why BYO doesn't hurt

1. BYO users consume **identical** plane work (queue, cron, audit,
   memory, fleet) — they simply pay their own provider.
2. BYO on-device is gated as a **Pro feature** (`provider.json` +
   `MONA_TRANSPORT=local` in the client); free tier routes through the
   vault. The escape hatch is the upgrade path.
3. The offline/Ollama segment BYO unlocks is the same segment that stars
   repos and spreads word-of-mouth — marketing acquisition, not
   cannibalization.
4. Cost-governance dashboard works *better* for BYO users (their spend,
   their keys) and is itself the flagship Pro surface.

## Sequencing

1. Free-tier caps (devices, tasks/day, orchestration tools) — revenue
   risk fix #1, one backend sprint.
2. Pro device-metered billing + BYO unlock flag.
3. Cost-governance dashboard (per-run cost traces already land in the
   audit/run trace from the client).
4. Team tier (SSO, profiles, compliance exports) for enterprise.
5. Marketplace (Connect) + engine licensing for OEMs — revenue beyond
   the plane.
