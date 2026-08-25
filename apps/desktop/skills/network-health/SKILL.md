---
name: network-health
description: Network health check — diagnose connectivity, DNS, and reachability without changing the network.
---

# Network-down runbook

Diagnose only. Capture routing and reachability state with approved read-only commands (`ip`, `ping`, `traceroute`, `nslookup`, or the platform equivalent). Classify the failure as interface down, DNS failure, gateway unreachable, upstream loss, or unknown.

Prepare a remediation plan (interface restart, route change, resolver change, or service restart), but never reconfigure an interface, route, or resolver, and never restart a network service, without explicit approval and local-policy authorization. Record the previous known-good state so any approved change can be rolled back. Verify with a resolution and reachability check of the approved endpoint.

