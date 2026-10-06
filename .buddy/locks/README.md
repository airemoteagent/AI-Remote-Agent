# Locks — advisory file claims

One file per claimed path: `.buddy/locks/<path-with-__>.lock`, containing:

    <agent> <ISO8601> <reason>

TTL 30 minutes. Breaking a stale lock requires a journal line (see TWO-AI-BUDDY.md §3).
