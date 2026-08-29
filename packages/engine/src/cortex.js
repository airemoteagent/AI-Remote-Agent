// Cortex — lossless, content-addressed working memory.
//
// The prompt window is a cache, not a store. When a long task overflows the
// context budget, Cortex archives the FULL content of each displaced message
// and replaces it in the prompt with a compact pointer + preview. Nothing is
// ever truncated or dropped: the original bytes stay addressable and can be
// re-hydrated on demand via recall(). This turns "context degradation" into
// "compression with perfect recall".
//
// Content-addressed: the id is a sha256 digest of the content, so identical
// content collapses to one entry (dedupe for free) and ids are stable.

import { createHash } from 'node:crypto';

const ID_PREFIX = 'ctx_';

export class Cortex {
  constructor({ maxEntries = 0 } = {}) {
    // maxEntries 0 = unbounded (lossless). A positive cap is an operational
    // knob for memory pressure, NOT a correctness limit — eviction under a
    // cap re-introduces degradation, so it defaults off.
    this.maxEntries = Number(maxEntries) || 0;
    this.entries = new Map(); // id -> { text, meta, storedAt, hits }
  }

  /** Archive content losslessly; returns { id, chars, deduped }. */
  store(content, meta = {}) {
    const text = String(content ?? '');
    const id = ID_PREFIX + createHash('sha256').update(text).digest('hex').slice(0, 24);
    const existing = this.entries.get(id);
    if (existing) {
      existing.hits += 1;
      existing.storedAt = Date.now();
      return { id, chars: text.length, deduped: true };
    }
    this.entries.set(id, { text, meta: meta || {}, storedAt: Date.now(), hits: 1 });
    if (this.maxEntries > 0 && this.entries.size > this.maxEntries) {
      let oldest = null;
      for (const [k, v] of this.entries) {
        if (!oldest || v.storedAt < oldest.storedAt) oldest = { k, v };
      }
      if (oldest) this.entries.delete(oldest.k);
    }
    return { id, chars: text.length, deduped: false };
  }

  /** Re-hydrate a stored chunk (full, lossless). Returns null if unknown. */
  recall(id) {
    const entry = this.entries.get(String(id || ''));
    if (!entry) return null;
    entry.hits += 1;
    return entry.text;
  }

  /** Length of a stored chunk without returning it (paging metadata). */
  sizeOf(id) {
    const entry = this.entries.get(String(id || ''));
    return entry ? entry.text.length : null;
  }

  stats() {
    let chars = 0;
    for (const e of this.entries.values()) chars += e.text.length;
    return { entries: this.entries.size, chars, maxEntries: this.maxEntries };
  }
}

/** Extractive preview: head + tail with a marker — a courtesy hint so the
 *  brain knows what a pointer points at before deciding to recall it. */
export function extractivePreview(text, max = 240) {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  const marker = ' …[full text archived]… ';
  const available = Math.max(40, max - marker.length);
  const head = Math.floor(available * 0.6);
  return t.slice(0, head) + marker + t.slice(-(available - head));
}

/** Compact a message list that has grown past a character budget WITHOUT
 *  losing anything: every displaced middle message is archived in the cortex
 *  and replaced by a recallable pointer + preview. Head (system + first task)
 *  and tail (recent turns) always survive verbatim — same invariant as
 *  compactMessages, but the middle is never dropped or truncated.
 *
 * @returns {{messages, compressed, before, after, stored, dropped, ids}}
 */
export function compactLossless(messages, { maxChars = 40000, cortex, keepHead = 2, keepTail = 6, maxPreview = 240 } = {}) {
  if (!cortex || typeof cortex.store !== 'function') {
    throw new TypeError('compactLossless: a cortex with store() is required');
  }
  const size = (m) => String(m?.content ?? '').length;
  const before = messages.reduce((n, m) => n + size(m), 0);
  if (before <= maxChars) {
    return { messages, compressed: false, before, after: before, stored: 0, dropped: 0, ids: [] };
  }

  const head = messages.slice(0, keepHead);
  const tail = messages.slice(Math.max(keepHead, messages.length - keepTail));
  const middle = messages.slice(keepHead, Math.max(keepHead, messages.length - keepTail));

  const ids = [];
  const mid = middle.map((m) => {
    const full = String(m.content ?? '');
    const { id, chars, deduped } = cortex.store(full, { role: m.role, source: 'compact' });
    ids.push({ id, chars, deduped, role: m.role });
    const preview = extractivePreview(full, maxPreview);
    return {
      role: m.role,
      content: `[archived; recall("${id}") to restore full ${chars}-char ${m.role} content]\n${preview}`,
    };
  });

  const merged = [...head, ...mid, ...tail];
  const after = merged.reduce((n, m) => n + size(m), 0);
  return { messages: merged, compressed: true, before, after, stored: mid.length, dropped: 0, ids };
}
