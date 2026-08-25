---
name: disk-health
description: Disk health check — flag volumes running out of space.
---

When asked to check disk space, storage, or disk health:
1. Run `df -h` via the shell tool (allowed command).
2. For every volume above 85% usage, explain what it is and how much is free.
   Inspect only approved workspace/application paths when identifying candidates.
3. Propose—not execute—cleanup. After explicit approval, use the files tool's
   trash-first delete behavior rather than irreversible shell deletion.
4. Verify the reported free space after any approved cleanup and summarize
   healthy volumes in one line, at-risk volumes in detail.
