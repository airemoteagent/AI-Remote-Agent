# EU AI Act — Transparency & Documentation

The EU AI Act (Regulation (EU) 2024/1689) sets obligations based on the
**risk category** of an AI system. This document records the
classification and the implemented transparency measures for remote-agent
and the remoteagent.online engine.

## Classification

**Limited risk (Article 50 — transparency).** remote-agent is an AI
assistant that helps users operate their own devices: it reasons in the
cloud, executes local tools on request, and answers in chat. It is not
used in any Annex III high-risk context (no critical infrastructure, no
biometrics, no employment/credit decisions, no law enforcement) as
provided by remoteagent.online.

The remoteagent.online engine orchestrates third-party foundation models
(OpenAI, Anthropic, Google, DeepSeek, OpenRouter) on the user's behalf
under their own API keys. remoteagent.online does not deploy or fine-tune
general-purpose models itself.

## Transparency obligations — implemented

| Obligation | Implementation |
|---|---|
| Users know they interact with AI | The dashboard labels the assistant as AI; the CLI and docs state it explicitly |
| AI output is distinguishable | Chat responses are marked `assistant` in the conversation model; no synthetic content is presented as human |
| Documentation | This page + [COMPLIANCE.md](COMPLIANCE.md) + [SECURITY.md](../SECURITY.md) |
| Human oversight | Every tool call is visible in the activity feed before, during and after execution; the user can stop the agent at any time; shell actions are argv-based and allowlisted by default, with policy presets for stricter oversight |
| Record-keeping | Full audit log of tasks, tool calls, LLM calls, and results (audit log, messages) + hash-chained local decision log (`~/.remote-agent/audit.jsonl`) |
| Traceability | Every run has a `run_id`; device metrics are snapshotted with history |

## Safety measures

- **Sandboxed execution** — argv-based allowlisted shell (no string-to-
  shell), path-confined file tool with TOCTOU guards, SSRF-safe networking,
  egress-only networking, per-tool timeouts.
- **No autonomous self-improvement** — the agent does not modify its own
  code, prompts, or safety policy.
- **Prompt-injection resistance** — tool results are fed back as
  structured `TOOL RESULT` messages with explicit boundaries; the system
  prompt reasserts the tool contract every iteration (max 8 steps).
- **Content transparency** — no deepfakes, no synthetic personas; the
  agent does not generate content for distribution.

## Model information (transparency record)

- The device never stores model credentials and never selects a
  provider — the cloud engine resolves the model per user preference
  (default `auto`).
- Provider and model of each call are recorded in the audit log.
- Users configure their own provider keys; remoteagent.online stores them
  encrypted (AES-256-GCM) and never shares them.

## Residual risk & mitigations

| Risk | Mitigation |
|---|---|
| Erroneous tool call | User-visible confirmation via activity feed; allowlisted argv-based execution by default; unrestricted shell requires an audited policy decision (`shell.unsafe`) |
| Hallucinated data | System prompt instructs the model to read real data via tools and never invent it |
| Privacy leakage | Metrics minimised to system telemetry; see [GDPR.md](GDPR.md) |

## Contact

AI Act / compliance questions: `compliance@remoteagent.online`.
