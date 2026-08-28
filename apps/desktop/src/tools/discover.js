// M7 — discover tool: capability orientation.
// Lets the brain find out what it can do (what_can_i_do), get focused help
// for one tool (tool_help), or get a skill suggestion for a task
// (suggest_skill). Pure metadata — no side effects, no secrets.
//
// Security: all inputs are untrusted text; lookups go through discovery.js
// (keyword matching only). Unknown tools/actions return errors, never throw.

import { TOOL_META, toolHelp, suggestSkills } from '../discovery.js';

export const discover = {
  name: 'discover',
  description: "Discover the agent's capabilities: list all tools with when-to-use hints (what_can_i_do), get help for one tool (tool_help), or suggest a skill for a task (suggest_skill).",
  args: {
    action: 'string — what_can_i_do | tool_help | suggest_skill',
    tool: 'string — tool name (for tool_help)',
    task: 'string — task description (for suggest_skill)',
    skills: 'array of string — enabled skills to filter suggestions (optional, for suggest_skill)',
  },
  platform: 'any',

  async run(input = {}) {
    try {
      const action = String(input.action || 'what_can_i_do').toLowerCase();

      if (action === 'what_can_i_do') {
        const tools = Object.entries(TOOL_META).map(([name, meta]) => ({
          name,
          when_to_use: meta.when_to_use,
        }));
        return { action, count: tools.length, tools };
      }

      if (action === 'tool_help') {
        const name = String(input.tool || '').trim();
        if (!name) {
          return { error: 'tool_help requires a tool name', available: Object.keys(TOOL_META) };
        }
        const help = toolHelp(name);
        if (!help) {
          return { error: `Unknown tool: ${name}`, available: Object.keys(TOOL_META) };
        }
        return { action, help };
      }

      if (action === 'suggest_skill') {
        const task = String(input.task || '').trim();
        if (!task) {
          return { error: 'suggest_skill requires a task description' };
        }
        const skills = Array.isArray(input.skills) ? input.skills : undefined;
        const suggested = suggestSkills(task, skills);
        return {
          action,
          task,
          suggested,
          note: suggested.length ? '' : 'No matching skill found for this task.',
        };
      }

      return { error: `Unknown action: ${action} (use what_can_i_do | tool_help | suggest_skill)` };
    } catch (err) {
      return { error: `discover failed: ${err.message}` };
    }
  },
};
