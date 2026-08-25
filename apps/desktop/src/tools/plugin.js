// Plugin tool — dynamic tool plugins, managed at runtime.
//
// mona-agent ships with builtin tools; third parties can add more as
// "plugins" — packages named mona-agent-tool-* (or any dir on
// MONA_TOOL_PATH) exporting defineTool() descriptors. Plugins are hot-
// loadable while the daemon runs:
//
//   plugin list            → every tool with its source + policy status
//   plugin load <path>     → discover + register a plugin directory now
//   plugin reload          → re-run discovery for MONA_TOOL_PATH
//   plugin remove <name>   → unregister a plugin tool (until next load)
//
// SECURITY: a plugin tool is denied by default. The owner must explicitly
// allow it in ~/.mona-agent/policy.json, e.g.
//   { "tools": { "my.tool": "allow" } }
// `plugin list` reports exactly which rule each plugin needs. A plugin can
// never override a builtin or another plugin (collision = hard error).

import { tools } from './index.js';

function envToolPaths() {
  return String(process.env.MONA_TOOL_PATH || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

export const plugin = {
  name: 'plugin',
  description: 'Manage dynamic tool plugins loaded at runtime. Actions: list (every tool with source + policy status), load <path> (discover + register a plugin directory now), reload (re-run MONA_TOOL_PATH discovery), remove <name> (unregister a plugin tool). Plugin tools are denied by policy until the owner allows them in ~/.mona-agent/policy.json under "tools" — list shows the exact rule needed.',
  args: {
    action: 'string — list | load | reload | remove',
    path: 'string — plugin directory or package dir (load only)',
    name: 'string — plugin tool name (remove only)',
  },
  timeoutMs: 60_000, // discovery does dynamic imports

  async run(args) {
    const action = String(args.action || '').trim();
    switch (action) {
      case 'list': {
        const src = tools.sources();
        const entries = tools.list().map((t) => {
          const tier = tools.policyTier(t.name);
          const allowed = tier === 'allow';
          return {
            name: t.name,
            source: src[t.name] || 'builtin',
            version: t.version || '',
            allowed,
            policy: allowed ? 'allow' : `denied — add "tools": {"${t.name}": "allow"} to policy.json`,
          };
        });
        const plugins = entries.filter((e) => e.source === 'plugin');
        return {
          count: entries.length,
          plugins: plugins.length,
          tools: entries,
          note: plugins.length
            ? 'Plugin tools shown above with policy status — allow them in ~/.mona-agent/policy.json before use.'
            : 'No plugin tools loaded. Use plugin load <path> or set MONA_TOOL_PATH.',
        };
      }
      case 'load': {
        const p = String(args.path || '').trim();
        if (!p) return { error: 'plugin load requires a path (plugin directory or package dir)' };
        const loaded = await tools.loadExternalTools([p]);
        return {
          loaded,
          note: loaded
            ? `${loaded} plugin tool(s) loaded. Check policy status with plugin list.`
            : 'No plugin tools found at that path (expected a dir with mona-agent-tool-* packages or a package exporting defineTool()).',
        };
      }
      case 'reload': {
        const loaded = await tools.loadExternalTools(envToolPaths());
        return { loaded, note: `${loaded} new plugin tool(s) loaded from MONA_TOOL_PATH + node_modules.` };
      }
      case 'remove': {
        const name = String(args.name || '').trim();
        if (!name) return { error: 'plugin remove requires a name' };
        const wasPlugin = (tools.sources()[name] || '') === 'plugin';
        const removed = tools.unregister(name);
        if (!removed) return { error: `No such tool: ${name}` };
        return { removed: true, name, note: wasPlugin ? `plugin tool ${name} unregistered` : `tool ${name} unregistered` };
      }
      default:
        return { error: `Unknown action "${action}" — use list, load, reload or remove`, actions: ['list', 'load', 'reload', 'remove'] };
    }
  },
};
