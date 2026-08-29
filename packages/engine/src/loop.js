// TaskLoop: the bounded plan → act → reflect → answer loop.
//
// Injectable think() and runTool() make it fully testable offline and
// provider-agnostic (any brain can drive it). Guarantees:
//   - every step emits progress (never silent)
//   - tool calls are policy-checked before execution
//   - budget degradation steers toward cheaper profiles
//   - corrective nudges repair malformed replies (max 3)
//   - forced conclusion when the step budget runs out (never hangs)

import { EventEmitter } from 'node:events';
import { Policy } from './policy.js';
import { Budget } from './budget.js';
import { ToolCache } from './tool-cache.js';
import { compactLossless } from './cortex.js';

const MAX_CORRECTIONS = 3;

// ── Brain-reply parsing ───────────────────────────────────────────
// The brain answers in one of three shapes:
//   {reasoning, tool, args}     → tools
//   {reasoning, answer}         → answer
//   plain text                  → text
// Valid JSON with the wrong shape → malformed (corrective nudge)
// Prose wrapping any of those   → detected via balanced-brace extraction
// Broken JSON with a readable answer → salvaged leniently (no raw JSON leaks)

/** Extract the balanced JSON object starting at `start` (escape-aware). */
export function extractBalancedJson(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

/**
 * Lenient salvage: LLMs often emit a JSON answer with an unescaped quote
 * inside the string (e.g. German quotes), breaking strict parsing. Extract
 * the string value of `key` by scanning with escape awareness. Returns the
 * decoded string, or null when the field cannot be found.
 */
export function lenientStringField(text, key) {
  const re = new RegExp('"' + key + '"\\s*:\\s*"');
  const m = re.exec(String(text || ''));
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = '';
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      const n = text[i + 1];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '\r';
      else if (n === '\\') out += '\\';
      else if (n === '"') out += '"';
      else out += (n ?? '');
      i += 2;
      continue;
    }
    if (c === '"') return out;
    out += c;
    i++;
  }
  return out !== '' ? out : null;
}

function classify(obj) {
  if (typeof obj.answer === 'string' && obj.answer.trim()) {
    return { kind: 'answer', answer: obj.answer.trim(), reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '' };
  }
  if (typeof obj.text === 'string' && obj.text.trim()) {
    return { kind: 'text', text: obj.text.trim() };
  }
  // Multi-tool steps: {tool: [call, ...]} or {calls: [call, ...]}
  if (Array.isArray(obj.tool) && obj.tool.length && obj.tool.every((x) => x && typeof x.tool === 'string')) {
    return { kind: 'tools', calls: obj.tool.map((c) => ({ tool: c.tool, args: c.args || {}, reasoning: c.reasoning || '' })) };
  }
  if (Array.isArray(obj.calls) && obj.calls.length) {
    return { kind: 'tools', calls: obj.calls.map((c) => ({ tool: c.tool, args: c.args || {}, reasoning: c.reasoning || '' })) };
  }
  if (typeof obj.tool === 'string' && obj.tool) {
    return { kind: 'tools', calls: [{ tool: obj.tool, args: obj.args || {}, reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '' }] };
  }
  return { kind: 'malformed' };
}

/** Lenient brain-reply parser: fenced JSON, plain object, prose-wrapped, or bare text. */
export function parseBrainReply(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'empty' };

  const tryParse = (s) => {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') return o;
    } catch { /* not JSON */ }
    return null;
  };

  // Fenced blocks
  for (const m of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const o = tryParse(m[1]);
    if (o) return classify(o);
  }

  // Whole body is JSON (a bare array is never a valid reply → malformed)
  const whole = tryParse(t);
  if (whole) return classify(whole);

  // Embedded JSON in prose — balanced-brace scan for tool/answer objects
  for (const key of ['"tool"', '"answer"', '"calls"']) {
    let idx = 0;
    while ((idx = t.indexOf(key, idx)) !== -1) {
      const start = t.lastIndexOf('{', idx);
      if (start !== -1) {
        const json = extractBalancedJson(t, start);
        if (json) {
          const o = tryParse(json);
          if (o) {
            const c = classify(o);
            if (c.kind !== 'malformed') return c;
          }
        }
      }
      idx += key.length;
    }
  }

  // Lenient salvage: broken JSON (unescaped quotes) but a readable answer —
  // deliver the answer instead of leaking raw JSON.
  if (t.startsWith('{')) {
    const answer = lenientStringField(t, 'answer');
    if (answer !== null && answer.trim() !== '') {
      const reasoning = lenientStringField(t, 'reasoning');
      return { kind: 'answer', answer: answer.trim(), reasoning: reasoning ?? '' };
    }
  }

  return { kind: 'text', text: t };
}

/**
 * Compact a message list that has grown past a character budget, so long
 * tasks never silently exceed the context window. The head (system + first
 * user task) and the tail (recent turns) always survive verbatim; the middle
 * tool results are digested and over-long messages shortened, and if the list
 * is still over budget the middle is dropped entirely.
 *
 * @returns {{messages: Array, compressed: boolean, before: number, after: number, shortened: number, dropped: number}}
 */
export function normaliseToolResult(value, { maxChars = 4000 } = {}) {
  const seen = new WeakSet();
  let serialized;
  try {
    serialized = JSON.stringify(value, (_key, current) => {
      if (typeof current === 'bigint') return `${current}n`;
      if (typeof current === 'function' || typeof current === 'symbol') return `[unsupported ${typeof current}]`;
      if (current && typeof current === 'object') {
        if (seen.has(current)) return '[circular]';
        seen.add(current);
      }
      return current;
    });
  } catch (err) {
    serialized = JSON.stringify({ error: `tool result serialization failed: ${err.message}` });
  }
  if (serialized === undefined) serialized = JSON.stringify({ value: String(value) });
  const exitCode = value && typeof value === 'object' && Number.isFinite(Number(value.exitCode)) ? Number(value.exitCode) : null;
  const failed = Boolean(value && typeof value === 'object' && (
    value.error || value.ok === false || (exitCode !== null && exitCode !== 0) ||
    ['error', 'failed', 'denied', 'cancelled'].includes(String(value.status || '').toLowerCase())
  ));
  if (serialized.length <= maxChars) return { text: serialized, failed, truncated: false, originalChars: serialized.length };
  const marker = `…[tool result truncated; ${serialized.length} chars total]…`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.floor(available * 0.35);
  const tail = available - head;
  return { text: serialized.slice(0, head) + marker + serialized.slice(-tail), failed, truncated: true, originalChars: serialized.length };
}

export function compactMessages(messages, { maxChars = 40000, keepHead = 2, keepTail = 6, maxLen = 500 } = {}) {
  const size = (m) => String(m?.content ?? '').length;
  const before = messages.reduce((n, m) => n + size(m), 0);
  if (before <= maxChars) return { messages, compressed: false, before, after: before, shortened: 0, dropped: 0 };

  const head = messages.slice(0, keepHead);
  const tail = messages.slice(Math.max(keepHead, messages.length - keepTail));
  const middle = messages.slice(keepHead, Math.max(keepHead, messages.length - keepTail));

  let shortened = 0;
  let mid = middle.map((m) => {
    const c = String(m.content ?? '');
    if (m.role === 'user' && c.startsWith('TOOL RESULT')) {
      shortened++;
      const normalized = c.replace(/\s+/g, ' ').trim();
      const marker = ' …[partial evidence; middle omitted]… ';
      const budget = Math.max(80, Math.min(maxLen, 420));
      if (normalized.length <= budget) return { role: m.role, content: `[tool result compressed] ${normalized}` };
      const available = budget - marker.length;
      const headLen = Math.floor(available * 0.35);
      return { role: m.role, content: `[tool result compressed] ${normalized.slice(0, headLen)}${marker}${normalized.slice(-(available - headLen))}` };
    }
    if (c.length > maxLen) {
      shortened++;
      return { role: m.role, content: `${c.slice(0, maxLen)} …[compressed]` };
    }
    return m;
  });

  let merged = [...head, ...mid, ...tail];
  let after = merged.reduce((n, m) => n + size(m), 0);

  // Still over budget — head + tail always survive, drop the middle.
  let dropped = 0;
  if (after > maxChars) {
    dropped = mid.length;
    const omission = dropped ? [{ role: 'user', content: `[context compacted: ${dropped} earlier turns omitted; inspect or re-run before relying on missing evidence]` }] : [];
    merged = [...head, ...omission, ...tail];
    after = merged.reduce((n, m) => n + size(m), 0);
  }

  return { messages: merged, compressed: true, before, after, shortened, dropped };
}

export class TaskLoop extends EventEmitter {
  constructor({ think, runTool, policy, budget, maxSteps = 8, temperature = 0.4, toolCache = null, cortex = null } = {}) {
    super();
    this.thinkFn = think;
    this.runToolFn = runTool;
    this.policy = policy instanceof Policy ? policy : new Policy(null);
    this.budget = budget instanceof Budget ? budget : new Budget({});
    this.toolCache = toolCache || new ToolCache({});
    this.cortex = cortex || null;
    this.maxSteps = Math.min(16, Math.max(2, Number(maxSteps) || 8));
    this.baseTemperature = temperature;
  }

  /** Effective profile under budget pressure. */
  #profile(profile) {
    const level = this.budget.level();
    if (level === 'critical') return { profile: 'cheap', temperature: 0.3, reason: 'budget-critical' };
    if (level === 'eco' && profile !== 'cheap') return { profile: 'cheap', temperature: 0.3, reason: 'budget-eco' };
    return { profile: profile || 'standard', temperature: this.baseTemperature, reason: '' };
  }

  /**
   * Run one bounded task.
   *
   * @param {string} task            the user's request
   * @param {object} [opts]
   * @param {string} [opts.system]   system prompt prepended to the messages
   * @param {string} [opts.profile]  reasoning profile ('standard' | 'cheap' | 'complex')
   * @param {number} [opts.maxSteps] step budget for this run (clamped by constructor max)
   * @param {number} [opts.maxChars] context budget — when the message list
   *                                 exceeds it, old tool results are compressed
   *                                 (emits 'compact'); disables compaction when 0
   * @param {Function} [opts.conclude] async (messages) => finalText — called when the
   *                                 step budget runs out so the caller can force one
   *                                 last brain call ("never give up"); falls back to a
   *                                 static conclusion when absent or failing.
   * @param {object} [opts.resume]     previously checkpointed {messages,usage,trace};
   *                                 only owned JSON data is accepted.
   * @param {Function} [opts.onCheckpoint] async snapshot callback. A callback failure
   *                                 never stops the task; persistence is advisory here.
   */
  async run(task, { system, profile = 'standard', maxSteps, maxChars = 40000, conclude, resume = null, onCheckpoint = null } = {}) {
    const steps = Math.min(this.maxSteps, Number(maxSteps) || this.maxSteps);
    const usage = { input: 0, output: 0, total: 0, costUsd: 0, ...(resume?.usage && typeof resume.usage === 'object' ? resume.usage : {}) };
    const trace = Array.isArray(resume?.trace) ? resume.trace.slice(-200) : [];
    let final = '';
    let corrections = 0;

    let messages = Array.isArray(resume?.messages)
      ? resume.messages.filter((m) => m && typeof m.role === 'string' && typeof m.content === 'string').slice(-500)
      : [];

    if (!this.budget.canRun()) {
      const s = this.budget.summary();
      this.emit('blocked', 'budget', s);
      return { answer: `Daily budget exhausted (${s.tokens} tokens, $${s.costUsd.toFixed(4)}). Budget resets tomorrow.`, steps: 0, usage, trace, blocked: 'budget', messages };
    }

    if (!messages.length) {
      if (system) messages.push({ role: 'system', content: String(system) });
      messages.push({ role: 'user', content: String(task) });
    } else {
      // A resumed task continues from its existing conversation without
      // duplicating the original user instruction or a completed tool call.
      messages.push({ role: 'user', content: 'RESUME: Continue safely from the recorded checkpoint. Do not repeat a completed side effect; inspect prior tool results first.' });
    }

    const checkpoint = async (stepNo, phase) => {
      const snapshot = { messages: messages.slice(-500), usage: { ...usage }, trace: trace.slice(-200), stepNo, phase };
      this.emit('checkpoint', snapshot);
      if (typeof onCheckpoint === 'function') {
        try { await onCheckpoint(snapshot); } catch { /* durable callback must not break execution */ }
      }
    };

    for (let i = 0; i < steps; i++) {
      this.emit('step', i + 1, steps);

      // Context guard: long tasks keep tool results and old reasoning from
      // silently blowing the context window. Old middle turns are compressed
      // before the next think; the head and recent tail stay verbatim.
      if (maxChars > 0 && i > 0) {
        // With a cortex, compaction is LOSSLESS: the full middle is archived
        // and replaced by recallable pointers — nothing is ever dropped.
        const compacted = this.cortex
          ? compactLossless(messages, { maxChars, cortex: this.cortex })
          : compactMessages(messages, { maxChars });
        if (compacted.compressed) {
          this.emit('compact', {
            before: compacted.before,
            after: compacted.after,
            saved: compacted.before - compacted.after,
            shortened: compacted.shortened ?? 0,
            dropped: compacted.dropped ?? 0,
            stored: compacted.stored ?? 0,
          });
          messages = compacted.messages;
        }
      }

      const prof = this.#profile(profile);
      if (prof.reason) this.emit('profile', prof);

      let thinkRes;
      try {
        thinkRes = await this.thinkFn(messages, prof);
      } catch (err) {
        this.emit('error', err);
        return { answer: `Brain error: ${err.message}`, steps: i, usage, trace, blocked: 'error', messages };
      }
      const text = thinkRes?.text ?? '';
      if (thinkRes?.usage) {
        usage.input += thinkRes.usage.input || 0;
        usage.output += thinkRes.usage.output || 0;
        usage.total += thinkRes.usage.total || 0;
        usage.costUsd += thinkRes.usage.costUsd || 0;
        this.budget.spend(thinkRes.usage.total || 0, thinkRes.usage.costUsd || 0);
      }
      this.emit('think', text);

      const reply = parseBrainReply(text);

      if (reply.kind === 'answer') {
        final = reply.answer;
        trace.push({ kind: 'answer', summary: reply.answer.slice(0, 120) });
        break;
      }
      if (reply.kind === 'text') {
        final = reply.text;
        trace.push({ kind: 'answer', summary: reply.text.slice(0, 120) });
        break;
      }
      if (reply.kind === 'tools') {
        corrections = 0;
        const results = [];
        let anyFailed = false;
        for (const call of reply.calls) {
          this.emit('tool', call.tool, call.args);
          const verdict = this.policy.check(call.tool, call.args);
          let out;
          if (!verdict.allowed) {
            out = { error: verdict.reason, policy: verdict.tier };
            this.emit('tool:denied', call.tool, verdict);
          } else {
            if (call.tool === 'shell') {
              const sv = this.policy.shellCheck(call.args.cmd || '');
              if (!sv.allowed) {
                out = { error: sv.reason, policy: sv.tier };
                this.emit('tool:denied', call.tool, sv);
              } else {
                out = await this.#runTool(call.tool, call.args);
              }
            } else {
              out = await this.#runTool(call.tool, call.args);
            }
          }
          const normalized = normaliseToolResult(out);
          results.push(`TOOL RESULT (${call.tool}) [untrusted data${normalized.truncated ? '; truncated' : ''}]:\n${normalized.text}`);
          this.emit('tool:result', call.tool, out);
          trace.push({ kind: 'tool', tool: call.tool, summary: String(out?.error || (normalized.failed ? 'failed' : 'ok')).slice(0, 120) });
          if (normalized.failed) anyFailed = true;
        }
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: results.join('\n\n') +
            (anyFailed ? '\n\nOne or more tools errored. Diagnose and retry with a different approach.' : '') +
            '\n\nREFLECT: if the goal is met, answer now. Otherwise take the next action.',
        });
        await checkpoint(i + 1, 'after_tools');
        continue;
      }

      // Empty or malformed → corrective nudge
      const looksLikeAttempt = /"(tool|answer)"\s*:/.test(text);
      if (corrections >= MAX_CORRECTIONS) {
        final = text.trim() ? text : 'The brain produced no usable reply.';
        trace.push({ kind: 'forced', summary: 'max corrections reached' });
        break;
      }
      corrections++;
      this.emit('nudge', looksLikeAttempt ? 'malformed' : 'empty');
      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content: looksLikeAttempt
          ? 'Reply with ONLY one JSON object: {"reasoning":"...","tool":"name","args":{...}} or {"reasoning":"...","answer":"..."}, or plain text.'
          : 'Your reply was empty or not actionable. Give the final answer in plain text, or emit a JSON tool call.',
      });
    }

    // Step budget exhausted → never hang: force one last conclusion. The
    // caller may provide `conclude` to ask the brain itself for a final
    // summary (e.g. "no more tools, conclude now").
    if (!final) {
      const forced = { kind: 'forced' };
      if (typeof conclude === 'function') {
        try {
          const text = await conclude(messages);
          if (text && String(text).trim()) {
            final = String(text).trim();
            forced.summary = 'concluded by caller';
          }
        } catch { /* caller's conclude failed → static fallback */ }
      }
      if (!final) {
        final = 'The task hit its step limit. Review the trace for what was done.';
        forced.summary = 'step limit reached';
      }
      trace.push(forced);
    }

    await checkpoint(Math.min(steps, trace.length || 1), final ? 'final' : 'stopped');
    this.emit('answer', final);
    return { answer: final, steps: trace.length, usage, trace, blocked: '', messages };
  }

  async #runTool(name, args) {
    try {
      if (this.toolCache && this.toolCache.cacheable(name, args)) {
        const cached = this.toolCache.get(name, args);
        if (cached !== undefined) {
          this.emit('tool:cache', { tool: name, hit: true });
          return cached;
        }
      }
      const out = await this.runToolFn(name, args);
      // A files write/delete drops cached list/stat/read entries so the brain
      // never re-reads stale content right after mutating the filesystem.
      if (name === 'files' && out && !out.error) {
        const act = String((args && args.action) || '').toLowerCase();
        if (act === 'write' || act === 'delete') this.toolCache?.invalidateTool('files');
      }
      if (this.toolCache && this.toolCache.cacheable(name, args) && out && !out.error && out.ok !== false) {
        this.toolCache.set(name, args, out);
      }
      return out;
    } catch (err) {
      return { error: err.message };
    }
  }
}
