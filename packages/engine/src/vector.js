// Dependency-free local vector index.
//
// A real vector store with zero npm dependencies:
//   - tokenizer: lowercase words, stopwords dropped, word-prefix signal for
//     typo robustness
//   - embedding: the hashing trick — every token maps to a signed feature in
//     a fixed-dimension vector (djb2 + fnv1a, L2-normalized)
//   - scoring: cosine similarity over the hashed feature vectors
//   - persistence: JSON file (0600), lazy load, save after every mutation
//
// It powers three things:
//   - MemoryStore.recall (hybrid vector + recency scoring) — the structured
//     memory the engine folds finished tasks into
//   - the desktop `vector` tool — remember notes and index workspace files,
//     then search them in natural language
//   - the per-task vector context block injected into the brain prompt
//
// Everything is deterministic (string hashes, no randomness), so an index
// built once returns the same results after a restart.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DEFAULT_STORE = process.env.MONA_VECTOR_STORE || join(homedir(), '.mona-agent', 'vector-index.json');
export const VECTOR_DIM = 256;
const MAX_ENTRIES = 2000;
const DEDUPE_THRESHOLD = 0.9;
const SEARCH_THRESHOLD = 0.1;

// Small stopword list keeps hashed vectors focused on content words.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'as', 'it',
  'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they',
  'me', 'him', 'her', 'us', 'them', 'my', 'your', 'our', 'their', 'do', 'does',
  'did', 'have', 'has', 'had', 'not', 'no', 'yes', 'so', 'if', 'then', 'than',
  'too', 'very', 'can', 'will', 'would', 'could', 'should', 'just', 'about',
  'into', 'over', 'after', 'before', 'between', 'out', 'up', 'down', 'off',
  'under', 'again', 'once', 'here', 'there', 'all', 'any', 'both', 'each', 'few',
  'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 's', 't', 'don',
  'now', 'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'how',
]);

/** Tokenize text into weighted content tokens (words + word-prefix hints). */
export function tokenize(text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9]+(?:['’][a-z]+)?/g) || [];
  const out = [];
  for (const w of words) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.push(w);
    // A short prefix of long words adds a signal that survives small typos.
    if (w.length >= 8) out.push(w.slice(0, 5));
  }
  return out;
}

/** djb2 — deterministic unsigned 32-bit string hash. */
export function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

/** fnv1a — a second, decorrelated hash used to sign features. */
export function hashString2(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Embed text into a fixed-dimension, L2-normalized signed feature vector.
 * The hashing trick: token → (index = djb2 % dim, sign = fnv1a parity).
 * Deterministic across processes and restarts.
 */
export function embed(text, dim = VECTOR_DIM) {
  const v = new Float64Array(dim);
  for (const t of tokenize(text)) {
    const idx = hashString(t) % dim;
    const sign = hashString2(t) & 1 ? 1 : -1;
    v[idx] += sign;
  }
  const norm = Math.sqrt(dot(v, v)) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Cosine similarity between two vectors (or a vector and a plain array). */
export function cosine(a, b) {
  if (!a || !b) return 0;
  return dot(a, b);
}

/** Convert a Float64Array vector to a plain array for JSON persistence. */
export function vectorToArray(v) {
  return Array.from(v);
}

export class VectorStore {
  constructor({ storePath = DEFAULT_STORE, dim = VECTOR_DIM, maxEntries = MAX_ENTRIES } = {}) {
    this.storePath = storePath;
    this.dim = dim;
    this.maxEntries = maxEntries;
    this.entries = [];
    this.#load();
  }

  #load() {
    try {
      if (existsSync(this.storePath)) {
        const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
        if (Array.isArray(raw.entries)) {
          this.entries = raw.entries.filter((e) => e && typeof e.text === 'string');
        }
      }
    } catch { /* corrupt index → start empty */ }
  }

  #save() {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify({
        version: 1,
        dim: this.dim,
        entries: this.entries.map((e) => ({ ...e, vector: Array.from(e.vector) })),
      }, null, 2), { mode: 0o600 });
    } catch { /* best-effort */ }
  }

  /** Compute (or lazily restore) the stored vector for an entry. */
  #vec(e) {
    if (!e.vector) e.vector = Array.from(embed(e.text, this.dim));
    return e.vector;
  }

  /**
   * Add a text to the index. Near-duplicates (cosine ≥ threshold) are merged
   * instead of appended: the existing entry's text/meta refresh and its hit
   * counter increments, so the index stays dense, not bloated.
   * @returns {{id: string, merged: boolean}}
   */
  add(text, meta = {}, { dedupe = true, ttlDays = null } = {}) {
    const body = String(text || '').trim();
    if (!body) return null;
    const vec = Array.from(embed(body, this.dim));

    if (dedupe) {
      for (const e of this.entries) {
        if (cosine(vec, this.#vec(e)) >= DEDUPE_THRESHOLD) {
          e.text = body;
          e.vector = vec;
          e.meta = meta;
          e.createdAt = Date.now();
          if (ttlDays !== null) e.ttlDays = ttlDays;
          e.hits = (e.hits || 0) + 1;
          this.#save();
          return { id: e.id, merged: true };
        }
      }
    }

    const entry = {
      id: `vec_${Math.random().toString(36).slice(2, 10)}`,
      text: body,
      meta: meta || {},
      vector: vec,
      ttlDays,
      createdAt: Date.now(),
      hits: 1,
    };
    this.entries.push(entry);
    this.prune();
    this.#save();
    return { id: entry.id, merged: false };
  }

  /**
   * Semantic search: cosine similarity, recency-weighted (optional), TTL-aware.
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.limit=8]
   * @param {number} [opts.threshold=0.1] minimum cosine to return
   * @param {number} [opts.recencyWeight=0] 0–1 — blend of recency (0..1) with cosine
   */
  search(query, { limit = 8, threshold = SEARCH_THRESHOLD, recencyWeight = 0 } = {}) {
    const qv = embed(query, this.dim);
    const now = Date.now();
    const results = [];
    for (const e of this.entries) {
      if (e.ttlDays != null && (now - e.createdAt) / 86400000 > e.ttlDays) continue;
      const cos = cosine(qv, this.#vec(e));
      if (cos < threshold) continue;
      const ageDays = Math.max(0, (now - e.createdAt) / 86400000);
      const recency = 1 / (1 + ageDays / 7); // ~half-life of one week
      const score = (1 - recencyWeight) * cos + recencyWeight * recency;
      results.push({
        id: e.id,
        text: e.text,
        meta: e.meta,
        score: Math.round(score * 10000) / 10000,
        cosine: Math.round(cos * 10000) / 10000,
        createdAt: e.createdAt,
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  remove(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) this.#save();
    return this.entries.length !== before;
  }

  /** Drop TTL-expired entries and cap the total count. */
  prune() {
    const now = Date.now();
    this.entries = this.entries.filter((e) => e.ttlDays == null || (now - e.createdAt) / 86400000 <= e.ttlDays);
    if (this.entries.length > this.maxEntries) {
      this.entries.sort((a, b) => (b.hits || 1) - (a.hits || 1) || a.createdAt - b.createdAt);
      this.entries = this.entries.slice(0, this.maxEntries);
    }
    return this.entries.length;
  }

  clear() {
    this.entries = [];
    this.#save();
  }

  stats() {
    return { entries: this.entries.length, maxEntries: this.maxEntries, dim: this.dim, path: this.storePath };
  }
}
