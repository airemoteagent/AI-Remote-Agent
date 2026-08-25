// Structured local memory: vector recall, near-duplicate dedupe, TTL, pruning.
//
// The agent that remembers everything useful and forgets everything stale.
// Entries carry a creation time and optional tags; recall scores by cosine
// similarity over hashed feature vectors (see ./vector.js) blended with
// recency decay and a hit boost. Near-duplicates are merged instead of
// appended, so memory stays dense instead of bloated.
//
// The on-disk format is unchanged from earlier versions ({ entries: [...] });
// entries without a stored vector get one computed lazily on first recall, so
// old memory files keep working untouched.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { embed, cosine } from './vector.js';

const DEFAULT_STORE = process.env.MONA_MEMORY_STORE || join(homedir(), '.mona-agent', 'memory-store.json');
const MAX_ENTRIES = 500;
const DEFAULT_TTL_DAYS = 30;
const DEDUPE_THRESHOLD = 0.9;
// Outcome-feedback: successful memories rank higher on recall; failures stay
// retrievable (as lessons to avoid) but rank lower.
const OUTCOME_BOOST = { success: 0.15, partial: 0.05, neutral: 0, failure: -0.05 };

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

export class MemoryStore {
  constructor({ storePath = DEFAULT_STORE, maxEntries = MAX_ENTRIES } = {}) {
    this.storePath = storePath;
    this.maxEntries = maxEntries;
    this.entries = [];
    this.#load();
  }

  #load() {
    try {
      if (existsSync(this.storePath)) {
        const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
        if (Array.isArray(raw.entries)) this.entries = raw.entries;
      }
    } catch { /* corrupt → start empty */ }
  }

  #save() {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify({ entries: this.entries }, null, 2), { mode: 0o600 });
    } catch { /* best-effort */ }
  }

  /** Stored vector for an entry, computed lazily from text when absent. */
  #vec(e) {
    if (!e.vector) e.vector = Array.from(embed(e.text));
    return e.vector;
  }

  remember(text, { ttlDays = DEFAULT_TTL_DAYS, tags = [], source = 'agent', scope = 'local', confidence = 0.5, sensitivity = 'normal', outcome = 'neutral' } = {}) {
    const body = String(text || '').trim();
    if (!body) return null;

    // Dedupe: if an existing entry is nearly identical, refresh it instead.
    const v = Array.from(embed(body));
    for (const e of this.entries) {
      if (cosine(v, this.#vec(e)) >= DEDUPE_THRESHOLD) {
        e.text = body;
        e.vector = v;
        e.createdAt = Date.now();
        e.ttlDays = ttlDays;
        e.tags = Array.isArray(tags) ? tags : [];
        e.source = String(source || 'agent');
        e.scope = String(scope || 'local');
        e.confidence = Math.min(1, Math.max(0, Number(confidence) || 0));
        e.sensitivity = String(sensitivity || 'normal');
        e.outcome = String(outcome || 'neutral');
        e.revoked = false;
        e.hits = (e.hits || 0) + 1;
        this.#save();
        return e;
      }
    }

    const entry = {
      id: `mem_${Math.random().toString(36).slice(2, 10)}`,
      text: body,
      tags: Array.isArray(tags) ? tags : [],
      ttlDays,
      source: String(source || 'agent'),
      scope: String(scope || 'local'),
      confidence: Math.min(1, Math.max(0, Number(confidence) || 0)),
      sensitivity: String(sensitivity || 'normal'),
      outcome: String(outcome || 'neutral'),
      revoked: false,
      createdAt: Date.now(),
      hits: 1,
      vector: v,
    };
    this.entries.push(entry);
    this.prune();
    this.#save();
    return entry;
  }

  /**
   * Vector recall: cosine similarity with the query (0.7) + recency decay
   * (0.2) + hit boost (0.1). TTL-expired entries are never returned.
   */
  recall(query, { limit = 8 } = {}) {
    const q = normalize(query);
    const qv = embed(q.join(' '));
    const now = Date.now();
    const results = [];
    for (const e of this.entries) {
      if (e.revoked) continue;
      const ageDays = (now - e.createdAt) / 86400000;
      if (ageDays > (e.ttlDays || DEFAULT_TTL_DAYS)) continue;
      const cos = q.length ? cosine(qv, this.#vec(e)) : 0;
      if (q.length && cos < 0.1) continue;
      const recency = Math.max(0, 1 - ageDays / (e.ttlDays || DEFAULT_TTL_DAYS));
      const outcomeBoost = OUTCOME_BOOST[String(e.outcome || 'neutral')] ?? 0;
      const score = (q.length ? cos * 0.7 : 0.3) + recency * 0.2 + Math.min(0.1, (e.hits || 1) * 0.02) + outcomeBoost;
      results.push({ id: e.id, text: e.text, score, cosine: Math.round(cos * 1000) / 1000, ageDays, tags: e.tags, source: e.source || 'legacy', scope: e.scope || 'local', confidence: Number.isFinite(e.confidence) ? e.confidence : 0.5, sensitivity: e.sensitivity || 'normal', outcome: e.outcome || 'neutral', createdAt: e.createdAt });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  get(id) {
    const entry = this.entries.find((e) => e.id === String(id));
    return entry ? { ...entry, vector: undefined } : null;
  }

  revoke(id) {
    const entry = this.entries.find((e) => e.id === String(id));
    if (!entry) return false;
    entry.revoked = true;
    entry.revokedAt = Date.now();
    this.#save();
    return true;
  }

  remove(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== String(id));
    if (this.entries.length !== before) this.#save();
    return this.entries.length !== before;
  }

  /** Drop expired entries and cap the total count. */
  prune() {
    const now = Date.now();
    this.entries = this.entries.filter((e) => !e.revoked && (now - e.createdAt) / 86400000 <= (e.ttlDays || DEFAULT_TTL_DAYS));
    if (this.entries.length > this.maxEntries) {
      this.entries.sort((a, b) => (b.hits || 1) - (a.hits || 1) || a.createdAt - b.createdAt);
      this.entries = this.entries.slice(0, this.maxEntries);
    }
    return this.entries.length;
  }

  /**
   * Fold a finished run into structured memory with an outcome signal, so
   * future recall favors what worked and keeps failures as avoid-lessons.
   */
  learnFromRun(task, result, { outcome = 'neutral', tags = [], ttlDays = DEFAULT_TTL_DAYS, ...rest } = {}) {
    const body = 'Task: ' + String(task || '').slice(0, 200) + ' | Result: ' + String(result || '').slice(0, 600);
    return this.remember(body, { tags: ['task', 'outcome:' + outcome].concat(Array.isArray(tags) ? tags : []), ttlDays, outcome, ...rest });
  }

  stats() {
    return { entries: this.entries.length, maxEntries: this.maxEntries };
  }
}
