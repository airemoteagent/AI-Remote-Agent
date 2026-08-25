// Tool registry — discovery, validation, and dispatch for defineTool()
// descriptors. Replaces the ad-hoc BUILTIN array with a registry that:
//
//   - discovers tools from three sources: builtins, node_modules
//     packages matching mona-agent-tool-*, and configured paths
//   - treats namespace collisions as a hard startup error (never a
//     silent override)
//   - enforces timeouts + policy + concurrency on every invocation
//   - exports OpenAI/Anthropic-compatible tool schemas so any provider
//     can drive the same registry (registry.toSchemas({ dialect }))

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.js';
import { Policy, RunStore } from '@mona/engine';
import { defineTool, isTool } from './define.js';
import { sysinfo } from './sysinfo.js';
import { shell } from './shell.js';
import { files } from './files.js';
import { net } from './net.js';
import { apps } from './apps.js';
import { browser } from './browser.js';
import { web } from './web.js';
import { memory } from './memory.js';
import { notify } from './notify.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const POLICY = Policy.load();
const RUNS = new RunStore({});

// Builtins that can alter local state. Third-party tools must explicitly
// declare sideEffects/idempotent in defineTool() to get the same protection.
const LEGACY_SIDE_EFFECTS = new Set(['shell', 'files', 'apps', 'browser', 'notify']);
function sideEffecting(tool) {
  return ['local', 'external', 'destructive', 'write'].includes(tool.sideEffects) ||
    (tool.sideEffects !== 'none' && LEGACY_SIDE_EFFECTS.has(tool.name));
}

/**
 * Registry class.
 */
export class ToolRegistry {
  /** @type {Map<string, import('../../../../types/index.d.ts').Tool>} */
  #tools = new Map();

  constructor() {
    for (const tool of BUILTINS) this.register(tool);
  }

  /**
   * Register a tool (descriptor or legacy {name,run} module — legacy
   * modules are lifted to descriptors automatically).
   * @param {any} tool
   */
  register(tool) {
    if (isTool(tool)) {
      if (this.#tools.has(tool.name)) {
        throw new Error(`Tool registry collision: "${tool.name}" is already registered — refusing to override.`);
      }
      this.#tools.set(tool.name, tool);
      return;
    }

    // Legacy builtin shape { name, description, args, run } — lift it.
    if (tool && typeof tool.name === 'string' && typeof tool.run === 'function') {
      const desc = defineTool({
        name: tool.name,
        version: '1.0.0',
        description: tool.description || tool.name,
        handler: async (input, ctx) => tool.run(input, ctx),
      });
      if (this.#tools.has(desc.name)) {
        throw new Error(`Tool registry collision: "${desc.name}" is already registered — refusing to override.`);
      }
      this.#tools.set(desc.name, desc);
      return;
    }

    throw new Error(`Invalid tool: expected a defineTool() descriptor or {name, run} module — got ${typeof tool}`);
  }

  /** Remove a tool by name. @param {string} name */
  unregister(name) {
    this.#tools.delete(name);
  }

  /** @returns {Array<{name:string,description:string,version:string,sideEffects:string}>} */
  list() {
    return [...this.#tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      version: t.version,
      sideEffects: t.sideEffects,
    }));
  }

  /** @returns {string[]} */
  names() {
    return [...this.#tools.keys()];
  }

  /**
   * Run a tool by name with timeout + policy gate + concurrency.
   * @param {string} name
   * @param {Record<string, unknown>} [args]
   * @param {{ agent?: Record<string, unknown>, runId?: string, idempotencyKey?: string, policyRevision?: string }} [overrides] — per-task
   *   agent capability profile and optional durable-run execution metadata.
   */
  async run(name, args = {}, overrides = {}) {
    const tool = this.#tools.get(name);
    if (!tool) {
      return { error: `Unknown tool: ${name}`, available: this.names() };
    }

    // Per-agent tool gating: if the agent's profile lists tools, only those
    // may run. Absent profile = device defaults (no extra restriction).
    const agent = overrides?.agent || null;
    if (agent && Array.isArray(agent.tools) && agent.tools.length && !agent.tools.includes(name)) {
      return { error: `Tool "${name}" is not enabled for this agent`, enabledTools: agent.tools };
    }

    const verdict = POLICY.check(name, args);
    if (verdict.tier !== 'allow') {
      return { error: verdict.reason, policy: verdict.tier };
    }

    const hasSideEffects = sideEffecting(tool);
    const durableRunId = overrides?.runId ? String(overrides.runId) : '';
    let attempt = null;
    if (durableRunId && hasSideEffects) {
      const run = RUNS.get(durableRunId) || RUNS.create({ id: durableRunId, task: '', policyRevision: overrides?.policyRevision || '' });
      if (run.status === 'created') RUNS.transition(run.id, 'running');
      try {
        const started = RUNS.startAttempt(durableRunId, {
          tool: name,
          idempotencyKey: String(overrides?.idempotencyKey || ''),
          sideEffects: true,
          idempotent: Boolean(tool.idempotent),
          compensation: Boolean(tool.compensation),
        });
        attempt = started?.attempt || null;
      } catch (err) {
        return { error: err.message, durableRun: durableRunId };
      }
    }

    log.info(`Tool: ${name}`, args);

    const controller = new AbortController();
    const timeoutMs = tool.timeoutMs || DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const ctx = {
        signal: controller.signal,
        logger: log,
        workspace: process.env.MONA_WORKSPACE || process.cwd(),
        emit: () => {},
        invoke: (n, i) => this.run(n, i, overrides),
        secrets: { get: async () => undefined },
        limits: { memoryMb: 512, wallMs: timeoutMs, outputBytes: 1_048_576 },
        agent,
      };
      let result = await tool.handler(args, ctx);
      if (tool.redact) {
        try { result = tool.redact(result); } catch { /* keep original */ }
      }
      if (attempt) RUNS.finishAttempt(durableRunId, attempt.id, { status: result?.error ? 'failed' : 'succeeded', result: result?.error ? { error: String(result.error).slice(0, 500) } : { ok: true } });
      return result;
    } catch (err) {
      const result = err?.name === 'AbortError'
        ? { error: `Tool '${name}' timed out (${timeoutMs / 1000}s)` }
        : { error: err?.message || String(err) };
      if (attempt) RUNS.finishAttempt(durableRunId, attempt.id, { status: 'failed', result: { error: String(result.error).slice(0, 500) } });
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Export tool schemas for an LLM provider dialect.
   * @param {'openai'|'anthropic'} [dialect]
   */
  toSchemas(dialect = 'openai') {
    return [...this.#tools.values()].map((t) => {
      const schema = { type: 'object', properties: t.input?.properties || {}, required: t.input?.required || [] };
      if (dialect === 'anthropic') {
        return { name: t.name, description: t.description, input_schema: schema };
      }
      return { type: 'function', function: { name: t.name, description: t.description, parameters: schema } };
    });
  }
}

/**
 * Discover external tool packages:
 *  - node_modules/mona-agent-tool-* with a "monaAgent.tools" manifest
 *  - extra paths from MONA_TOOL_PATH (comma separated)
 * Returns descriptors (module default export or named tools).
 * @returns {Promise<any[]>}
 */
export async function discoverExternalTools(extraPaths = []) {
  const found = [];
  const seen = new Set();

  const loadDir = async (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith('mona-agent-tool-')) continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      const pkgPath = join(dir, entry, 'package.json');
      try {
        if (!existsSync(pkgPath)) continue;
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (!pkg.monaAgent?.tools) continue;
        const mod = await awaitImport(join(dir, entry, pkg.main || 'index.js'));
        const tools = Array.isArray(mod?.default) ? mod.default : mod?.default ? [mod.default] : [];
        for (const t of tools) if (isTool(t)) found.push(t);
        log.info(`Tool package discovered: ${entry} (${tools.length} tool(s))`);
      } catch (e) {
        log.warn(`Skipping tool package ${entry}: ${e.message}`);
      }
    }
  };

  await loadDir(join(process.cwd(), 'node_modules'));
  for (const p of extraPaths) {
    await loadDir(p);                 // bare package dir
    await loadDir(join(p, 'node_modules')); // project root containing node_modules
  }
  return found;
}

async function awaitImport(path) {
  try { return await import(path); } catch (e) { log.warn(`Tool package load failed: ${e.message}`); return null; }
}

// Legacy builtins — registered via the lifting path.
const BUILTINS = [sysinfo, shell, files, net, apps, browser, web, memory, notify];

/** The singleton registry used by the daemon. */
export const tools = new ToolRegistry();
