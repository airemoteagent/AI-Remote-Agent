// M7 — Discovery/Adaptation: tool metadata (when_to_use + limits) and
// skill suggestion via keyword matching.
//
// TOOL_META is derived from the builtin tool descriptions in
// src/tools/*.js (see the BUILTIN list in src/tools/index.js) and the
// bundled skill catalog. It lets the brain orient itself: what a tool is
// FOR and where it STOPS, before invoking it.
//
// Security: every input here (tool names, task text, skills lists) is
// UNTRUSTED data — matched as plain text, never executed and never treated
// as instructions. No I/O, no secrets.

// One entry per builtin tool (all 15 from src/tools/index.js BUILTIN).
export const TOOL_META = {
  sysinfo: {
    when_to_use: 'Get device telemetry (OS, CPU, memory, load, uptime) before resource-sensitive work, capacity checks, or to verify the runtime environment.',
    limits: 'Read-only snapshot at call time; coarse by default, hostname/network detail requires policy-gated detail:"full".',
  },
  shell: {
    when_to_use: 'Run an on-device shell command that no dedicated tool covers — install, inspect, orchestrate processes, custom scripts.',
    limits: 'Allowlisted argv commands by default, 15s timeout (use background:true for long-running/GUI), full output can be large.',
  },
  files: {
    when_to_use: 'Read, write, list, delete or stat files inside the agent workspace during file-centric tasks.',
    limits: 'Confined to the workspace paths; arbitrary paths outside are denied.',
  },
  net: {
    when_to_use: 'HTTP requests (GET/POST/HEAD) to public endpoints — API calls, health checks, downloads.',
    limits: 'SSRF-safe: private/loopback/metadata addresses are blocked; only public http(s) targets.',
  },
  apps: {
    when_to_use: 'Launch or quit installed desktop applications (e.g. open an editor or a settings app).',
    limits: 'Platform-specific and only for installed apps; cannot automate or inspect the app UI.',
  },
  browser: {
    when_to_use: 'Open a URL or run a search in the default browser when the user wants to see a page interactively.',
    limits: 'Opens a real browser window; no headless control, scraping or result extraction.',
  },
  web: {
    when_to_use: 'Web research: search the web (DuckDuckGo) and fetch page content as text for facts, sources and current information.',
    limits: 'Text-only extraction with truncated snippets/pages; quality depends on network and page availability.',
  },
  memory: {
    when_to_use: 'Persist facts across tasks, recall/search previously saved notes, or list recent memory for continuity.',
    limits: 'Local note store; recall quality depends on what was explicitly saved — no automatic capture.',
  },
  notify: {
    when_to_use: 'Show a desktop notification to surface an async result, a long job finishing, or a user-relevant event.',
    limits: 'One-shot notification on the local desktop; no scheduling, delivery guarantee, or queue.',
  },
  vector: {
    when_to_use: 'Semantic memory and file index: remember notes / index workspace files and search them by MEANING (similarity, not keywords).',
    limits: 'Local 256-dim index with TTL/recency; only content that was explicitly indexed is searchable.',
  },
  jobs: {
    when_to_use: 'Run long or background commands that exceed the shell tool timeout and manage them (start/status/output/list/wait/kill).',
    limits: 'Same command allowlist/policy as shell; jobs live only until the daemon restarts.',
  },
  delegate: {
    when_to_use: 'Split parallelizable work into fresh sub-agents on this device — research several files, test several approaches, compare options.',
    limits: 'Max 6 tasks, concurrency 1-4, device-local; each sub-agent follows the same policy and budget, results must be checked per task.',
  },
  goal: {
    when_to_use: 'Run a long objective across multiple autonomous rounds (start/status/list/resume/abort) when the task genuinely needs sustained multi-round effort.',
    limits: 'Bounded by maxRounds and brain-reported completion; can take many rounds and consume budget.',
  },
  workflow: {
    when_to_use: 'Coordinate complex multi-stage jobs (research → synthesize → verify) as an ordered pipeline with concurrent sub-agents per phase.',
    limits: 'Max 8 phases and 6 tasks per phase; failed sub-agents are reported, not hidden — verify phase results before acting on them.',
  },
  plugin: {
    when_to_use: 'Manage dynamic tool plugins: list sources/policy status, load a plugin directory, reload REMOTE_TOOL_PATH discovery, or unregister one.',
    limits: 'Plugins are denied by policy until explicitly allowed in ~/.remote-agent/policy.json under "tools"; only registered names become callable.',
  },
};

/** Help for a single tool: { name, when_to_use, limits } or null when unknown. */
export function toolHelp(name) {
  try {
    const meta = TOOL_META[name];
    return meta
      ? { name, when_to_use: meta.when_to_use, limits: meta.limits }
      : null;
  } catch {
    return null;
  }
}

// Keyword → skill rules. 'disk|speicher' → disk-health, 'research|recherche'
// → web-research, 'briefing' → briefing; a few close synonyms included for
// robustness. Matching is lowercase substring matching only.
const SKILL_RULES = [
  { skill: 'disk-health', keywords: ['disk', 'speicher', 'storage', 'platz', 'festplatte', 'partition', 'laufwerk'] },
  { skill: 'web-research', keywords: ['research', 'recherche', 'web', 'suche', 'suchen', 'internet', 'online', 'quellen'] },
  { skill: 'briefing', keywords: ['briefing', 'zusammenfassung', 'summary', 'ueberblick', 'überblick', 'morning'] },
];

/**
 * Suggest skills for a task via keyword matching.
 * @param {string} taskText — task description (untrusted text).
 * @param {string[]} [skillsList] — enabled skills; when provided and
 *   non-empty, only those skills can be suggested.
 * @returns {string[]} suggested skill names (may be empty).
 */
export function suggestSkills(taskText, skillsList) {
  try {
    const text = String(taskText || '').toLowerCase();
    const available = new Set(
      Array.isArray(skillsList) ? skillsList.map((s) => String(s)) : []
    );
    const out = [];
    for (const rule of SKILL_RULES) {
      if (available.size && !available.has(rule.skill)) continue;
      if (rule.keywords.some((k) => text.includes(k))) out.push(rule.skill);
    }
    return out;
  } catch {
    return [];
  }
}
