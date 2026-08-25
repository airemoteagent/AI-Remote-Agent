// tool-cache.js — cross-run tool-result cache for idempotent reads.
//
// Speeds up repeated read-only tool calls (sysinfo, web search/fetch, net
// GET/HEAD/ping) without risking stale side effects: only a small whitelist is
// cacheable, and net POST is explicitly excluded (it mutates remote state).
//
// Key = tool + sha1(canonical args) — args are sorted so key order never
// matters. TTL per tool; size-capped with oldest-first eviction. In-memory by
// default; pass storePath (the daemon uses ~/.remote-agent/tool-cache.json, 0600)
// to persist hits across restarts.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const DEFAULT_TOOL_CACHE_PATH = process.env.REMOTE_TOOL_CACHE || join(homedir(), '.remote-agent', 'tool-cache.json');
const MAX_ENTRIES = 200;

const CACHEABLE = new Set(['sysinfo', 'web', 'net', 'files']);

const DEFAULT_TTL_MS = {
  sysinfo: 60000,   // 1 min
  web: 300000,      // 5 min
  net: 300000,      // 5 min
  files: 30000,     // 30 s — list/stat/read only, short to stay fresh
};

// files actions that are safe, idempotent reads. write/delete are never cached.
const FILES_READONLY = new Set(['list', 'stat', 'read']);

function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === 'object') {
    const out = {};
    for (const k of Object.keys(x).sort()) out[k] = sortKeys(x[k]);
    return out;
  }
  return x;
}

function canonicalArgs(args) {
  return JSON.stringify(sortKeys(args == null ? {} : args));
}

function hashString(s) {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

export class ToolCache {
  // In-memory by default (safe for tests / short-lived callers). Pass an
  // explicit storePath to persist across runs (the daemon does this).
  constructor({ storePath = null, maxEntries = MAX_ENTRIES } = {}) {
    this.storePath = storePath;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.#load();
  }

  #load() {
    if (!this.storePath) return;
    try {
      if (existsSync(this.storePath)) {
        const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
        if (raw && Array.isArray(raw.entries)) {
          for (const e of raw.entries) {
            if (e && e.key && e.tool) this.entries.set(e.key, e);
          }
        }
      }
    } catch { /* corrupt -> empty */ }
  }

  #save() {
    if (!this.storePath) return;
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify({ entries: Array.from(this.entries.values()) }, null, 2), { mode: 0o600 });
    } catch { /* best-effort */ }
  }

  #key(tool, args) {
    return String(tool) + ':' + hashString(canonicalArgs(args));
  }

  /** True when this tool+args pair is a safe, idempotent read. */
  cacheable(tool, args = {}) {
    const t = String(tool || '');
    if (!CACHEABLE.has(t)) return false;
    if (t === 'net') {
      const method = String((args && args.method) || 'GET').toUpperCase();
      if (method === 'POST') return false; // POST mutates remote state
    }
    if (t === 'files') {
      const action = String((args && args.action) || 'list').toLowerCase();
      if (!FILES_READONLY.has(action)) return false; // write/delete mutate state
    }
    return true;
  }

  get(tool, args) {
    if (!this.cacheable(tool, args)) return undefined;
    const e = this.entries.get(this.#key(tool, args));
    if (!e) return undefined;
    const ttl = e.ttlMs == null ? (DEFAULT_TTL_MS[tool] || 60000) : e.ttlMs;
    if (ttl > 0 && Date.now() - e.createdAt > ttl) {
      this.entries.delete(e.key);
      return undefined;
    }
    e.hits = (e.hits || 0) + 1;
    return e.result;
  }

  set(tool, args, result, { ttlMs } = {}) {
    if (!this.cacheable(tool, args)) return null;
    const key = this.#key(tool, args);
    const e = {
      key,
      tool: String(tool),
      args: canonicalArgs(args),
      result,
      ttlMs: ttlMs == null ? (DEFAULT_TTL_MS[tool] || 60000) : ttlMs,
      createdAt: Date.now(),
      hits: 1,
    };
    this.entries.set(key, e);
    this.#prune();
    this.#save();
    return e;
  }

  invalidate(tool, args) {
    const had = this.entries.delete(this.#key(tool, args));
    if (had) this.#save();
    return had;
  }

  /** Drop every cached entry for a tool (e.g. after a files write/delete). */
  invalidateTool(tool) {
    const t = String(tool || '');
    let removed = 0;
    for (const [k, e] of this.entries) {
      if (e.tool === t) { this.entries.delete(k); removed++; }
    }
    if (removed) this.#save();
    return removed;
  }

  clear() {
    this.entries.clear();
    this.#save();
  }

  #prune() {
    const now = Date.now();
    for (const [k, e] of this.entries) {
      const ttl = e.ttlMs == null ? (DEFAULT_TTL_MS[e.tool] || 60000) : e.ttlMs;
      if (ttl > 0 && now - e.createdAt > ttl) this.entries.delete(k);
    }
    if (this.entries.size > this.maxEntries) {
      const arr = Array.from(this.entries.values()).sort((a, b) => a.createdAt - b.createdAt);
      const drop = arr.slice(0, this.entries.size - this.maxEntries);
      for (const e of drop) this.entries.delete(e.key);
    }
  }

  stats() {
    return { entries: this.entries.size, maxEntries: this.maxEntries, path: this.storePath };
  }
}
