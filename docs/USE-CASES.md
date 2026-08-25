# Use Cases

Concrete scenarios for mona-agent, from personal automation to operations.

## 1. Personal Mac assistant
Open apps, check system health, run small scripts, control media — from any
browser, including the phone. The brain decides what to do; the Mac executes.
- Chat: "How's my disk?" → agent measures and reports with numbers.
- Chat: "Open Safari and play some Avicii" → apps + browser tools.

## 2. Developer machine automation
Delegated, audited command execution on a dev box: run tests, check logs,
restart services — with a full trace of every step for review.
- Chat: "Run the test suite and summarize failures."

## 3. Home-lab / server operations
For machines without interactive access: health checks, log tailing, package
status. No SSH needed from the phone — the device polls the cloud.
- Chat: "What's the uptime and load of the NAS?"

## 4. Kiosk & presentation machines
Control long-running GUI programs in the background (media playback, demo
windows) and restart them on demand.
- Chat: "Restart the demo window on the kiosk."

## 5. Compliance-heavy environments
Every action is traced (reasoning → tool call → result → answer →
verification) with tokens, cost and latency — exportable as JSONL for audits
and model fine-tuning. On the device, every policy decision lands in a
hash-chained, tamper-evident local audit log (`mona-agent audit verify`)
and the policy file (presets: strict/standard/permissive) bounds what any
remote party can ever ask the machine to do. See `additional-documents/`
for ISO, IEC and CRA readiness.

## 6. Model evaluation & training
Collect real conversation traces with human feedback (Good/Bad ratings) and
export them as a ready-to-use fine-tuning dataset.

## 7. Multi-device fleets
One dashboard, many devices — each with its own revocable token and
telemetry. Start with one Mac, grow to a fleet without changing the model.
