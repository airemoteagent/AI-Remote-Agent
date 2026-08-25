// Tool registry — discovers and dispatches tool calls.
//
// Two kinds of tool can be registered:
//   - legacy modules  { name, description, args, run(args, signal) }
//   - defineTool() descriptors { name, version, description, input, handler }
//     (dynamic plugins) — lifted to the runtime shape automatically.
//
// Plugin tools are hot-loadable at runtime (discoverExternalTools reads
// node_modules/remote-agent-tool-* and REMOTE_TOOL_PATH) and are gated by the
// SAME policy choke point as builtins: an unknown tool is denied by default,
// and an owner explicitly allows a plugin with a policy rule
// ("tools": {"my.tool": "allow"}).

import { log } from '../log.js';
import { Policy } from '@remote-agent/engine';
import { isTool } from './define.js';
import { discoverExternalTools } from './registry.js';
import { sysinfo } from './sysinfo.js';
import { shell } from './shell.js';
import { files } from './files.js';
import { net } from './net.js';
import { apps } from './apps.js';
import { browser } from './browser.js';
import { web } from './web.js';
import { memory } from './memory.js';
import { notify } from './notify.js';
import { vector } from './vector.js';
import { jobs } from './jobs.js';
import { delegate } from './delegate.js';
import { goal } from './goal.js';
import { workflow } from './workflow.js';
import { plugin } from './plugin.js';

const BUILTIN = [sysinfo, shell, files, net, apps, browser, web, memory, notify, vector, jobs, delegate, goal, workflow, plugin];
const TIMEOUT_MS = 30_000;

// Policy choke point: EVERY tool invocation (daemon, brain loop, CLI exec)
// passes through the local policy engine. The control plane can never
// widen this — it is loaded once from disk at startup. Plugin tools are
// denied by default until the owner adds an explicit policy rule.
const POLICY = Policy.load();

/** Lift a defineTool() descriptor to the legacy runtime shape. */
function liftDescriptor(tool) {
  return {
    name:        tool.name,
    version:     tool.version,
    description: tool.description,
    args:        tool.input?.properties || {},
    timeoutMs:   tool.timeoutMs,
    run:         async (args, signal) => tool.handler(args, {
      signal,
      logger: log,
      workspace: process.env.REMOTE_WORKSPACE || process.cwd(),
      invoke: (n, i) => tools.run(n, i),
    }),
  };
}

function envToolPaths() {
  return String(process.env.REMOTE_TOOL_PATH || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

class ToolRegistry {
  #tools = new Map();
  #sources = new Map(); // name → 'builtin' | 'plugin'

  constructor() {
    for (const tool of BUILTIN) {
      this.register(tool, 'builtin');
    }
  }

  /**
   * Register a tool (legacy {name,run} or defineTool descriptor).
   * Collisions are a hard error — plugins may never silently override
   * builtins or each other.
   */
  register(tool, source = 'builtin') {
    const lifted = isTool(tool) ? liftDescriptor(tool) : tool;
    if (!lifted || typeof lifted.name !== 'string' || typeof lifted.run !== 'function') {
      throw new Error(`Invalid tool: expected a defineTool() descriptor or {name, run} module — got ${typeof tool}`);
    }
    if (this.#tools.has(lifted.name)) {
      throw new Error(`Tool registry collision: "${lifted.name}" is already registered — refusing to override.`);
    }
    this.#tools.set(lifted.name, lifted);
    this.#sources.set(lifted.name, source);
    return lifted.name;
  }

  /** Remove a tool by name (plugin unload). Returns true when removed. */
  unregister(name) {
    const had = this.#tools.delete(name);
    this.#sources.delete(name);
    return had;
  }

  /** List all registered tools (for cloud brain context). */
  list() {
    return [...this.#tools.values()].map(t => ({
      name:        t.name,
      description: t.description,
      args:        t.args || {},
      version:     t.version || undefined,
    }));
  }

  /** List tool names. */
  names() {
    return [...this.#tools.keys()];
  }

  /** name → 'builtin' | 'plugin'. */
  sources() {
    return Object.fromEntries([...this.#sources.entries()]);
  }

  /** Policy tier for a tool under the loaded policy (deny unless allowed). */
  policyTier(name) {
    return POLICY.toolTier(name);
  }

  /**
   * Discover + register dynamic plugins (node_modules/remote-agent-tool-*
   * plus extra dirs and REMOTE_TOOL_PATH). Hot-loadable at runtime.
   * @returns {Promise<number>} tools loaded
   */
  async loadExternalTools(extraPaths = []) {
    const paths = [...new Set([...envToolPaths(), ...extraPaths])];
    const discovered = await discoverExternalTools(paths);
    let loaded = 0;
    for (const t of discovered) {
      try {
        this.register(t, 'plugin');
        loaded++;
        log.info(`Plugin tool loaded: ${t.name} v${t.version || '?'}`);
      } catch (err) {
        log.warn(`Plugin tool "${t.name}" not loaded: ${err.message}`);
      }
    }
    return loaded;
  }

  /** Run a tool by name with timeout enforcement + policy gate. */
  async run(name, args = {}) {
    const tool = this.#tools.get(name);
    if (!tool) {
      return { error: `Unknown tool: ${name}`, available: this.names() };
    }

    // Policy gate (deny / confirm / rate limit).
    const verdict = POLICY.check(name, args);
    if (verdict.tier !== 'allow') {
      return { error: verdict.reason, policy: verdict.tier };
    }

    log.info(`Tool: ${name}`, args);

    // Per-tool timeout override (e.g. `jobs.wait` may legitimately poll for
    // minutes) — default 30s stays for every other tool.
    const timeoutMs = Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0 ? tool.timeoutMs : TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await tool.run(args, controller.signal);
      return result;
    } catch (err) {
      if (err.name === 'AbortError') {
        return { error: `Tool '${name}' timed out (${timeoutMs / 1000}s)` };
      }
      return { error: err.message };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const tools = new ToolRegistry();
