// M5 — Context Manager: budget + compression for the system prompt.
//
// Solves the cache/degradation problem: instead of splicing every context
// block into the prompt unchecked, buildContext() fits the blocks into a
// fixed total budget, most important first, and compresses from the back
// when needed. Never crashes, never throws: missing/empty inputs simply
// contribute 0 chars.
//
// Block format: every block is used EXACTLY as delivered — headings,
// <untrusted-...> markers, footers and all (same convention as
// loadMemoryContext / loadSessionContext / buildEnvSnapshot). Truncation
// only ever shortens the content INSIDE the untrusted markers, so the
// markers always survive. Blocks without markers are truncated plainly.
//
// The `task` input is accepted for API symmetry with the coordinator's
// call site but is NOT rendered into the prompt: the task already arrives
// as the user message, and the spec fixes the prompt composition to the
// eight budgeted blocks in priority order. The coordinator may prepend
// the task itself if a self-contained context is desired.

export const CONTEXT_BUDGETS = {
  systemRules: 2500,
  env: 1500,
  persona: 800,
  policy: 1000,
  skills: 1500,
  memory: 3000,
  sessions: 4000,
  vector: 1800,
};

// Fixed first-fit order — most important first (spec M5, line 29).
const BLOCK_ORDER = ['systemRules', 'env', 'persona', 'policy', 'skills', 'vector', 'sessions', 'memory'];

// Map each block name to its input key.
const INPUT_KEYS = {
  systemRules: 'systemRules',
  env: 'envSnapshot',
  persona: 'persona',
  policy: 'policySummary',
  skills: 'skills',
  vector: 'vectorContext',
  sessions: 'sessionContext',
  memory: 'memoryContext',
};

// Order in which the total-budget back-cut trims blocks (memory first,
// then sessions, then vector) — the least important are cut first.
const BACK_CUT_ORDER = ['memory', 'sessions', 'vector'];

// Total budget = sum of the per-block budgets.
const TOTAL_BUDGET = Object.values(CONTEXT_BUDGETS).reduce((a, b) => a + b, 0);

const UNTRUSTED_OPEN = /<untrusted-[a-zA-Z0-9-]+>/;

/**
 * Coerce an input value to its block string. Non-strings that are not
 * null/undefined are stringified so the builder never crashes.
 */
function toBlockString(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

/**
 * Truncate a block to `cap` chars while keeping its <untrusted-...>
 * marker structure intact: only the content between the first open tag
 * and its matching close tag is shortened. If a block carries no
 * recognizable markers, it is truncated as plain text.
 */
function truncateKeepingMarkers(block, cap) {
  if (block.length <= cap) return block;
  const openMatch = block.match(UNTRUSTED_OPEN);
  if (!openMatch) return block.slice(0, cap);
  const open = openMatch[0];
  const close = `</${open.slice(1)}`;
  const openIdx = block.indexOf(open);
  const closeIdx = block.indexOf(close, openIdx + open.length);
  if (closeIdx === -1) return block.slice(0, cap);
  const prefix = block.slice(0, openIdx);
  const body = block.slice(openIdx + open.length, closeIdx);
  const suffix = block.slice(closeIdx + close.length);
  const target = cap - prefix.length - open.length - close.length - suffix.length;
  if (target <= 0) {
    // Cap is smaller than the marker overhead alone: keep markers, drop body.
    return prefix + open + close + suffix;
  }
  const result = prefix + open + body.slice(0, target) + close + suffix;
  // Hard safety net: never exceed the cap (only reachable when the marker
  // overhead itself is larger than the cap).
  return result.length <= cap ? result : block.slice(0, cap);
}

/**
 * Assemble the system-prompt context from the input blocks.
 *
 * @param {object} inputs
 *   { task, systemRules, envSnapshot, persona, policySummary, skills,
 *     memoryContext, sessionContext, vectorContext }
 * @returns {{ prompt: string, budgetLog: { totalChars: number, perBlock: object, truncated: string[] } }}
 */
export function buildContext(inputs = {}) {
  const data = inputs && typeof inputs === 'object' ? inputs : {};
  const perBlock = {};
  const truncated = [];
  const parts = [];
  let total = 0;

  for (const name of BLOCK_ORDER) {
    const raw = toBlockString(data[INPUT_KEYS[name]]);
    if (raw === '') {
      perBlock[name] = 0;
      continue;
    }
    const cap = CONTEXT_BUDGETS[name];
    let block = raw;
    if (block.length > cap) {
      block = truncateKeepingMarkers(block, cap);
      truncated.push(name);
    }
    perBlock[name] = block.length;
    total += block.length;
    parts.push(block);
  }

  // Total-budget guard: if the capped blocks still exceed the total budget,
  // cut from the back — memory first, then sessions, then vector. With the
  // current constants (caps sum to the total) this is defensive, but it
  // keeps the invariant if a future budget change breaks the sum.
  for (const name of BACK_CUT_ORDER) {
    if (total <= TOTAL_BUDGET) break;
    const idx = BLOCK_ORDER.indexOf(name);
    const currentLen = perBlock[name];
    if (currentLen === 0) continue;
    const excess = total - TOTAL_BUDGET;
    if (currentLen <= excess) {
      // Drop the whole block.
      parts.splice(idx, 1);
      perBlock[name] = 0;
      total -= currentLen;
    } else {
      const reduced = truncateKeepingMarkers(parts[idx], currentLen - excess);
      total -= currentLen - reduced.length;
      parts[idx] = reduced;
      perBlock[name] = reduced.length;
    }
    if (!truncated.includes(name)) truncated.push(name);
  }

  const prompt = parts.join('');
  const budgetLog = { totalChars: prompt.length, perBlock, truncated };
  return { prompt, budgetLog };
}

/**
 * One-line human summary of a budgetLog, for audit/debug output.
 * @param {{ totalChars?: number, perBlock?: object, truncated?: string[] }} log
 * @returns {string}
 */
export function summarizeBudget(log) {
  const total = Number(log?.totalChars) || 0;
  const blocks = Object.entries(log?.perBlock || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const truncated = log?.truncated?.length ? log.truncated.join(', ') : 'none';
  return `context ${total}/${TOTAL_BUDGET} chars [${blocks}] truncated: ${truncated}`;
}
