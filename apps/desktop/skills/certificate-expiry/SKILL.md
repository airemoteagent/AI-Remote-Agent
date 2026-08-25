---
name: certificate-expiry
description: Inspect certificate expiry evidence and prepare an approved renewal or escalation plan.
---

# Certificate-expiry runbook

Inspect only certificate metadata needed for the task: subject, issuer, serial, validity period, and expiry. Never read, display, upload, or store private keys. Classify certificates as valid, near expiry, or expired against the requested threshold.

Prepare a renewal or escalation plan, but do not renew, replace, deploy, or restart any service without explicit approval and local-policy authorization. Verify identity, validity, and service health after any approved replacement.
