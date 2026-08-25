---
name: service-health
description: Diagnose an approved service failure and propose a verified restart; never restart automatically.
---

# Service-health runbook

Collect the service manager status and safe, redacted recent logs for the named service. Identify likely dependency, configuration, resource, or process failures. Do not restart, stop, enable, or reconfigure a service without explicit approval and local-policy authorization.

After an approved action, verify both manager state and the service's approved health signal. Do not repeat restarts in a loop: report evidence and escalate after a failed verification.
