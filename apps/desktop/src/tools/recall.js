// Recall tool — re-hydrate archived context.
//
// When a long task overflows the context budget, the loop archives displaced
// messages in the Cortex and replaces them with [archived; recall("ctx_...")]
// pointers. This tool restores the FULL original content on demand, so the
// brain never has to reason around a hole it cut itself. Large chunks can be
// paged with start/end char offsets.
//
// The cortex is injected by the daemon (agent.js) via configureCortex() — the
// tool itself stays a thin, CLI-safe validation + dispatch layer.

let cortex = null;

/** Inject the daemon's Cortex (idempotent; overwrites on hot swap). */
export function configureCortex(c) {
  cortex = c && typeof c.recall === 'function' ? c : null;
}

function clampOffset(n, total) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return NaN;
  return Math.min(total, Math.max(0, v));
}

export const recall = {
  name: 'recall',
  description: 'Restore context that was archived during compaction (lossless memory). When a message shows [archived; recall("ctx_...")], call recall with that id to read the FULL original content before relying on its details. Large chunks can be paged: pass start/end char offsets (0-based) to read a window; the result reports the remaining range so you can continue.',
  args: {
    id: 'string — the ctx_... id from an [archived; recall("...")] pointer',
    start: 'number — optional start char offset (0-based, inclusive)',
    end: 'number — optional end char offset (exclusive); defaults to the full chunk',
  },
  timeoutMs: 10_000,

  async run(args) {
    const id = String(args?.id || '').trim();
    if (!id) {
      return { error: 'id required — pass the ctx_... id from an [archived; recall("...")] pointer' };
    }
    if (!cortex) {
      return { error: 'recall is only available inside a running agent task on the device daemon' };
    }
    const full = cortex.recall(id);
    if (full == null) {
      return { error: `no archived context for "${id}" — it may belong to an earlier run or have been evicted` };
    }
    const total = full.length;
    const startRaw = clampOffset(args?.start, total);
    const startIdx = Number.isFinite(startRaw) ? startRaw : 0;
    const endRaw = clampOffset(args?.end, total);
    let endIdx = Number.isFinite(endRaw) ? endRaw : total;
    if (endIdx <= startIdx) endIdx = total;
    const text = full.slice(startIdx, endIdx);
    const complete = endIdx >= total;
    return {
      id,
      chars: total,
      start: startIdx,
      end: endIdx,
      text,
      note: complete
        ? 'complete — this is the full archived content'
        : `chars ${endIdx}..${total} remain — call recall again with start=${endIdx} to continue`,
    };
  },
};
