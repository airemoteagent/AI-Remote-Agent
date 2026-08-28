// Environment tool (M1) — on-demand environment snapshot for the brain.
// Thin wrapper over ../env.js. Read-only, policy-safe, no PII by default
// (hostname only via { detail: "full" }, which a policy rule may gate).

import { buildEnvSnapshot, workspaceInfo, capabilityList } from '../env.js';

// Compact role descriptions for the "what_can_i_do" action.
const CAPABILITY_ROLES = {
  sysinfo:  'device telemetry (OS, CPU, RAM, disk, uptime)',
  env:      'environment snapshot and capability orientation',
  shell:    'run shell commands (policy-gated)',
  files:    'read/write files inside the workspace',
  net:      'HTTP requests',
  apps:     'launch and inspect apps',
  browser:  'control a browser',
  web:      'web research and page extraction',
  memory:   'persistent memory (remember / recall / list)',
  notify:   'desktop notifications',
  vector:   'semantic search over local notes',
  jobs:     'background jobs',
  delegate: 'subagent delegation',
  goal:     'goal tracking',
  workflow: 'multi-agent workflows',
  plugin:   'hot-loaded plugin tools',
};

export const env = {
  name: 'env',
  description: 'Environment snapshot and capability orientation: device state, workspace, identity/mode, policy summary, tool + skill capabilities, connectivity and limits. Use before long tasks to orient. Pass { action: "snapshot" } for the full context block, { action: "what_can_i_do" } for a compact capability list, { action: "check_workspace" } for workspace details, { action: "list_capabilities" } for tools + skills.',
  args: {
    action: 'string — snapshot | what_can_i_do | check_workspace | list_capabilities',
    detail: 'string — full | coarse (snapshot only; full adds hostname, gated by policy)',
  },
  platform: process.platform,

  async run(input = {}) {
    const action = String(input?.action || 'snapshot').toLowerCase();

    if (action === 'snapshot') {
      const detail = input?.detail === 'full' ? 'full' : 'coarse';
      return { ok: true, action, detail, text: buildEnvSnapshot({ detail }) };
    }

    if (action === 'what_can_i_do') {
      const caps = capabilityList();
      const bullets = caps.tools.map((t) => '- ' + t + ': ' + (CAPABILITY_ROLES[t] || 'available tool')).join('\n');
      const skills = caps.skills.length
        ? '\nEnabled skills: ' + caps.skills.join(', ')
        : '\nNo skills enabled.';
      const text = 'I can:\n' + bullets + skills
        + '\nAsk me to snapshot the environment, check the workspace, or list capabilities for details.';
      return { ok: true, action, capabilities: caps.tools, skills: caps.skills, text };
    }

    if (action === 'check_workspace') {
      return { ok: true, action, workspace: workspaceInfo() };
    }

    if (action === 'list_capabilities') {
      const caps = capabilityList();
      return { ok: true, action, tools: caps.tools, skills: caps.skills, installedSkills: caps.installedSkills };
    }

    return { ok: false, error: 'Unknown action "' + action + '" — use: snapshot | what_can_i_do | check_workspace | list_capabilities' };
  },
};
