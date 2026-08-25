#!/usr/bin/env node
// ── remote-agent CLI ────────────────────────────────────────────────
// Commands:
//   gui          Terminal dashboard (default when TTY)
//   start        Headless daemon
//   login        Save API key
//   connect      Test / force connection to control plane
//   chat <msg>   Send a message via API
//   exec <tool>  Execute a tool locally
//   provider     BYO-key local brain (anthropic | openai | ollama)
//   mcp          Model Context Protocol server (stdio)
//   debug        Debug mode — verbose logging
//   status       Show connection info
//   help         Show usage

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCreds, saveCreds, requireCreds, CLOUD, DEFAULTS, PATHS } from '../src/config.js';
import { pingPresence, startPresence, stopPresence } from '../src/presence.js';
import { VERSION, isUpdateAvailable } from '../src/version.js';
import { checkForUpdates, applyUpdate } from '../src/update.js';
import { verifyKey } from '../src/cloud.js';
import { testConnection, sendChat } from '../src/api.js';
import { tools } from '../src/tools/index.js';
import { AgentDaemon } from '../src/agent.js';
import { Dashboard } from '../src/tui.js';
import { log } from '../src/log.js';
import { Policy, auditVerify } from '@remote-agent/engine';
import { MODES, MODE_NAMES, applyMode, modeSummary, currentMode, POLICY_PATH } from '../src/modes.js';
import { daemonStatus, daemonInstall, daemonUninstall, alreadyRunning, stopRunningDaemon, DAEMON_PATHS, writePid, clearPid } from '../src/daemon.js';
import { SkillsManager } from '../src/skills.js';
import { loadProviderConfig, saveProviderConfig, removeProviderConfig, PROVIDERS, providerTest, pricesFor } from '../src/transport/local.js';
import { runMcpServer, runMcpHttpServer } from '../src/transport/mcp.js';
import { runDoctor, formatDoctor, formatDoctorJson } from '../src/doctor.js';

const [cmd, ...args] = process.argv.slice(2);

// Anonymous install-presence heartbeat: register this install on the very
// first run and keep the "waiting to pair" signal fresh while unpaired.
// Fire-and-forget — never blocks a command, never logs.
void pingPresence();

// ── ANSI constants ────────────────────────────────────────────────
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN  = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED   = '\x1b[31m';
const MAGENTA = '\x1b[35m';

// ── login ─────────────────────────────────────────────────────────
async function login() {
  const rl = createInterface({ input: stdin, output: stdout });
  const existing = loadCreds();

  console.log(`\n  ${BOLD}remote-agent login${RESET}\n`);

  if (existing?.apiKey) {
    console.log(`  ${DIM}An API key is already saved. This will replace it.${RESET}\n`);
  }

  const apiKey = (await rl.question('  remoteagent.online API key: ')).trim();

  if (!apiKey) {
    console.error('\n  No key entered.\n');
    rl.close();
    process.exit(1);
  }

  process.stdout.write(`\n  Verifying with ${CLOUD.base}... `);

  try {
    const info = await verifyKey(apiKey);
    const path = saveCreds({ apiKey, agentId: info.agentId });
    stopPresence(); // paired — stop the anonymous heartbeat

    console.log(`${GREEN}OK${RESET}`);
    console.log(`\n  ${DIM}Agent:${RESET}  ${info.agentId || '(pending)'}`);
    console.log(`  ${DIM}Saved:${RESET}  ${path}`);
    console.log(`  ${DIM}Cloud:${RESET}  ${CLOUD.base}`);
    console.log(`\n  Start the daemon:\n`);
    console.log(`    ${CYAN}remote-agent gui${RESET}       ${DIM}# terminal dashboard${RESET}`);
    console.log(`    ${CYAN}remote-agent start${RESET}     ${DIM}# headless daemon${RESET}`);
    console.log(`    ${CYAN}remote-agent connect${RESET}   ${DIM}# test connection${RESET}`);
    console.log(`\n  ${DIM}Enjoying it?  Star the repo:${RESET} https://github.com/remoteagent-online/remote-agent`);
    console.log();
    rl.close();
  } catch (e) {
    console.log(`${RED}FAILED${RESET}`);
    console.error(`\n  ${e.message}\n`);

    // Still allow saving if user wants to save anyway (e.g. offline setup)
    const saveAnyway = await rl.question('  Save anyway? (y/N): ');
    if (saveAnyway.toLowerCase() === 'y') {
      const path = saveCreds({ apiKey });
      console.log(`\n  ${YELLOW}Saved unverified key to ${path}${RESET}\n`);
    }
    rl.close();
    process.exit(1);
  }
}

// ── connect (force connection test) ───────────────────────────────
async function connect() {
  const creds = requireCreds();

  const targetUrl = args[0] || CLOUD.base;
  const force = args.includes('--force') || args.includes('-f');

  console.log(`\n  ${BOLD}${CYAN}remote-agent connect${RESET}\n`);
  console.log(`  ${DIM}Target:${RESET}    ${targetUrl}`);
  console.log(`  ${DIM}API Key:${RESET}   ${creds.apiKey.slice(0, 8)}...`);
  console.log(`  ${DIM}Agent ID:${RESET}  ${creds.agentId || '(pending)'}`);
  console.log();

  if (force) {
    console.log(`  ${YELLOW}Force mode — bypassing cert checks${RESET}\n`);
  }

  const results = await testConnection(creds.apiKey, targetUrl);

  // Health
  if (results.health?.ok) {
    console.log(`  ${GREEN}●${RESET} Health    ${GREEN}OK${RESET}  (uptime ${results.health.uptime}s)`);
  } else {
    console.log(`  ${RED}●${RESET} Health    ${RED}FAILED${RESET}  ${results.health?.error || 'unreachable'}`);
  }

  // Auth
  if (results.auth && !results.auth.error) {
    console.log(`  ${GREEN}●${RESET} Auth      ${GREEN}OK${RESET}  (${results.auth.agentId || 'verified'})`);
  } else {
    console.log(`  ${RED}●${RESET} Auth      ${RED}FAILED${RESET}  ${results.auth?.error || ''}`);
  }

  // Agents
  if (results.agents && !results.agents.error) {
    const count = Array.isArray(results.agents) ? results.agents.length : results.agents.agents?.length || 0;
    console.log(`  ${GREEN}●${RESET} Agents    ${GREEN}${count} connected${RESET}`);
  } else if (results.agents?.error) {
    console.log(`  ${YELLOW}●${RESET} Agents    ${YELLOW}unavailable${RESET}  ${results.agents.error}`);
  }

  // Summary
  const allOk = results.health?.ok && results.auth && !results.auth.error;
  console.log();
  console.log(`  ${allOk ? GREEN + 'Connection successful!' : RED + 'Connection issues detected'}${RESET}`);
  console.log(`  ${DIM}Run ${CYAN}remote-agent debug${RESET}${DIM} for verbose output${RESET}`);
  console.log();
}

// ── chat (send a message via API) ─────────────────────────────────
async function chat() {
  const creds = requireCreds();
  const message = args.join(' ');

  if (!message) {
    console.log(`\n  ${BOLD}remote-agent chat${RESET}\n`);
    console.log(`  ${DIM}Usage:${RESET} remote-agent chat ${CYAN}<message>${RESET}`);
    console.log(`  ${DIM}Send a chat message to the connected agent.${RESET}\n`);
    process.exit(1);
  }

  const agentId = creds.agentId || 'default';

  console.log(`\n  ${BOLD}remote-agent chat${RESET}\n`);
  console.log(`  ${DIM}Agent:${RESET}  ${agentId}`);
  console.log(`  ${DIM}Cloud:${RESET}  ${CLOUD.base}`);
  console.log(`\n  ${CYAN}▸${RESET} ${message}\n`);

  try {
    process.stdout.write(`  ${MAGENTA}Thinking...${RESET}`);
    const reply = await sendChat(creds.apiKey, agentId, message);
    process.stdout.write(`\r  ${GREEN}Response:${RESET}\n\n`);
    console.log(`  ${reply.reply || reply.text || JSON.stringify(reply, null, 2)}`);
    console.log();
  } catch (err) {
    console.log(`\r  ${RED}Failed:${RESET} ${err.message}\n`);
    process.exit(1);
  }
}

// ── exec (run a tool directly) ────────────────────────────────────
async function execTool() {
  const toolName = args[0];
  const toolArgs = {};

  // Parse key=value args
  for (let i = 1; i < args.length; i++) {
    const eq = args[i].indexOf('=');
    if (eq > 0) {
      toolArgs[args[i].slice(0, eq)] = args[i].slice(eq + 1);
    }
  }

  if (!toolName) {
    console.log(`\n  ${BOLD}remote-agent exec${RESET}\n`);
    console.log(`  ${DIM}Usage:${RESET} remote-agent exec ${CYAN}<tool> [key=value...]${RESET}\n`);
    console.log(`  ${DIM}Available tools:${RESET}`);
    for (const t of tools.list()) {
      console.log(`    ${CYAN}${t.name.padEnd(14)}${RESET} ${DIM}${t.description}${RESET}`);
    }
    console.log();
    return;
  }

  console.log(`\n  ${BOLD}remote-agent exec${RESET}\n`);
  console.log(`  ${DIM}Tool:${RESET}  ${toolName}`);
  if (Object.keys(toolArgs).length > 0) {
    console.log(`  ${DIM}Args:${RESET}  ${JSON.stringify(toolArgs)}`);
  }
  console.log();

  const t0 = Date.now();
  const result = await tools.run(toolName, toolArgs);
  const elapsed = Date.now() - t0;

  if (result.error) {
    console.log(`  ${RED}Error (${elapsed}ms):${RESET}`);
    console.log(`  ${result.error}`);
    if (result.available) {
      console.log(`  ${DIM}Available: ${result.available.join(', ')}${RESET}`);
    }
    if (result.allowed) {
      console.log(`  ${DIM}Allowlist: ${result.allowed.join(', ')}${RESET}`);
    }
  } else {
    console.log(`  ${GREEN}OK${RESET} ${DIM}(${elapsed}ms)${RESET}\n`);
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.log(`${YELLOW}${result.stderr}${RESET}`);
    console.log(JSON.stringify(result, null, 2).length > 200
      ? JSON.stringify({ ...result, stdout: result.stdout?.slice(0, 200) + '...' }, null, 2)
      : JSON.stringify(result, null, 2));
  }
  console.log();
}

// ── debug (verbose logging mode) ──────────────────────────────────
async function debug() {
  const creds = loadCreds();

  console.log(`\n  ${BOLD}${MAGENTA}remote-agent debug${RESET}\n`);

  // Environment
  console.log(`  ${BOLD}Environment${RESET}`);
  console.log(`  ${DIM}Cloud:${RESET}     ${CLOUD.base}`);
  console.log(`  ${DIM}WS URL:${RESET}    ${CLOUD.wsUrl}`);
  console.log(`  ${DIM}Version:${RESET}   ${DEFAULTS.version}`);
  console.log(`  ${DIM}Node:${RESET}      ${process.version}`);
  console.log(`  ${DIM}Platform:${RESET}  ${process.platform} ${process.arch}`);
  console.log(`  ${DIM}PID:${RESET}       ${process.pid}`);

  // Creds
  console.log(`\n  ${BOLD}Credentials${RESET}`);
  if (creds?.apiKey) {
    console.log(`  ${DIM}API Key:${RESET}   ${GREEN}present${RESET} (${creds.apiKey.slice(0, 8)}...)`);
    console.log(`  ${DIM}Agent ID:${RESET}  ${creds.agentId || '(pending)'}`);
    console.log(`  ${DIM}File:${RESET}      ${PATHS.creds}`);
  } else {
    console.log(`  ${DIM}API Key:${RESET}   ${RED}not set${RESET}`);
    console.log(`  ${DIM}Run:${RESET}       ${CYAN}remote-agent login${RESET}`);
  }

  // Tools
  console.log(`\n  ${BOLD}Registered Tools${RESET}`);
  for (const t of tools.list()) {
    console.log(`  ${CYAN}${t.name.padEnd(14)}${RESET} ${DIM}${t.description}${RESET}`);
  }

  // Config
  console.log(`\n  ${BOLD}Config${RESET}`);
  console.log(`  ${DIM}REMOTE_CLOUD:${RESET}       ${process.env.REMOTE_CLOUD || '(default)'}`);
  console.log(`  ${DIM}REMOTE_CLOUD_WS:${RESET}    ${process.env.REMOTE_CLOUD_WS || '(auto)'}`);
  console.log(`  ${DIM}REMOTE_ALLOW_CMDS:${RESET}  ${process.env.REMOTE_ALLOW_CMDS || '(default)'}`);
  console.log(`  ${DIM}REMOTE_SHELL_UNSAFE:${RESET} ${process.env.REMOTE_SHELL_UNSAFE || '0'} ${process.env.REMOTE_SHELL_UNSAFE ? YELLOW + '(deprecated — use policy shell.unsafe)' + RESET : ''}`);
  console.log(`  ${DIM}REMOTE_POLICY:${RESET}      ${process.env.REMOTE_POLICY || '~/.remote-agent/policy.json'}`);
  console.log(`  ${DIM}REMOTE_WORKSPACE:${RESET}   ${process.env.REMOTE_WORKSPACE || '(default)'}`);

  // Connection test
  if (creds?.apiKey) {
    console.log(`\n  ${BOLD}Connection Test${RESET}`);
    console.log(`  ${DIM}Testing ${CLOUD.base}...${RESET}\n`);

    try {
      const results = await testConnection(creds.apiKey);
      for (const [name, result] of Object.entries(results)) {
        const ok = result?.ok || (!result?.error && result !== undefined);
        const icon = ok ? GREEN + '●' : RED + '●';
        const detail = result?.error
          ? `${RED}${result.error}${RESET}`
          : result?.uptime
            ? `${GREEN}uptime ${result.uptime}s${RESET}`
            : result?.agentId
              ? `${GREEN}${result.agentId}${RESET}`
              : '';
        console.log(`  ${icon} ${name.padEnd(12)} ${detail}${RESET}`);
      }
    } catch (err) {
      console.log(`  ${RED}Connection test failed: ${err.message}${RESET}`);
    }
  }

  console.log();
}

// ── policy (inspect / explain / presets) ─────────────────────────
async function policyCmd() {
  const sub = args[0] || 'status';
  const p = Policy.load();
  const policyPath = process.env.REMOTE_POLICY || join(homedir(), '.remote-agent', 'policy.json');

  if (sub === 'status') {
    console.log(`\n  ${BOLD}remote-agent policy${RESET}\n`);
    console.log(`  ${DIM}File:${RESET}    ${policyPath}${existsSync(policyPath) ? '' : ` ${YELLOW}(not created — defaults in use)${RESET}`}`);
    console.log(`  ${DIM}Unsafe:${RESET}  ${p.shellUnsafe ? YELLOW + 'true' + RESET + (p.unsafeSource === 'env' ? ` ${DIM}(deprecated REMOTE_SHELL_UNSAFE env — move to policy)${RESET}` : '') : GREEN + 'false' + RESET}`);
    console.log(`  ${DIM}Budget:${RESET}  ${p.dailyTokens || '∞'} tokens/day, ${p.dailyCostUsd ? '$' + p.dailyCostUsd : '∞'} USD/day`);
    console.log(`  ${DIM}Max steps:${RESET} ${p.maxSteps}`);
    console.log(`  ${DIM}Audit:${RESET}   ${p.auditEnabled ? GREEN + 'on' + RESET : 'off'} (${p.auditPath})`);
    console.log(`\n  ${BOLD}Tool rules${RESET}`);
    for (const t of tools.names()) {
      console.log(`    ${CYAN}${t.padEnd(10)}${RESET} ${p.toolTier(t)}`);
    }
    console.log(`\n  ${DIM}Presets:${RESET} ${CYAN}remote-agent policy preset strict|standard|permissive${RESET}`);
    console.log(`  ${DIM}Explain:${RESET} ${CYAN}remote-agent policy explain <tool> [key=value...]${RESET}\n`);
    return;
  }

  if (sub === 'explain') {
    const toolName = args[1];
    if (!toolName) {
      console.log(`\n  ${DIM}Usage:${RESET} remote-agent policy explain ${CYAN}<tool> [key=value...]${RESET}\n`);
      return;
    }
    const toolArgs = {};
    for (let i = 2; i < args.length; i++) {
      const eq = args[i].indexOf('=');
      if (eq > 0) toolArgs[args[i].slice(0, eq)] = args[i].slice(eq + 1);
    }
    const e = p.explain(toolName, toolArgs);
    if (args.includes('--json')) {
      console.log(JSON.stringify({ tool: toolName, tier: e.tier, matchedRule: e.matchedRule, decision: e.decision, rateLimited: Boolean(e.rateLimited) }, null, 2));
      return;
    }
    console.log(`\n  ${BOLD}remote-agent policy explain${RESET}\n`);
    console.log(`  ${DIM}Tool:${RESET}      ${toolName}`);
    console.log(`  ${DIM}Decision:${RESET}  ${e.tier === 'allow' ? GREEN + 'allow' : e.tier === 'confirm' ? YELLOW + 'confirm' : RED + 'deny'}${RESET}`);
    console.log(`  ${DIM}Matched:${RESET}   ${e.matchedRule}`);
    console.log(`  ${DIM}Details:${RESET}   ${e.decision}`);
    if (e.rateLimited) console.log(`  ${RED}Rate limit:${RESET} exceeded — wait or raise rateLimits in policy`);
    console.log();
    return;
  }

  if (sub === 'preset') {
    const name = args[1];
    if (!name) {
      console.log(`\n  ${DIM}Usage:${RESET} remote-agent policy preset ${CYAN}<strict|standard|permissive>${RESET}\n`);
      return;
    }
    try {
      const preset = Policy.preset(name);
      mkdirSync(join(homedir(), '.remote-agent'), { recursive: true });
      writeFileSync(policyPath, JSON.stringify(preset.raw, null, 2) + '\n', { mode: 0o600 });
      console.log(`\n  ${GREEN}Wrote ${name} preset${RESET} → ${policyPath}`);
      console.log(`  ${DIM}Restart the daemon for it to take effect.${RESET}\n`);
    } catch (err) {
      console.error(`\n  ${RED}${err.message}${RESET}\n`);
      process.exit(1);
    }
    return;
  }

  console.error(`\n  Unknown policy subcommand: ${sub}\n  Run ${CYAN}remote-agent policy help${RESET}\n`);
}

// ── audit (tamper-evident decision log) ───────────────────────────
async function auditCmd() {
  const sub = args[0] || 'tail';
  const auditPath = process.env.REMOTE_AUDIT || join(homedir(), '.remote-agent', 'audit.jsonl');

  if (sub === 'tail') {
    if (!existsSync(auditPath)) {
      console.log(`\n  ${YELLOW}No audit log yet: ${auditPath}${RESET}\n`);
      return;
    }
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).slice(-20);
    console.log(`\n  ${BOLD}remote-agent audit${RESET} ${DIM}(${auditPath})${RESET}\n`);
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        const verdict = r.verdict === 'allow' ? GREEN + 'allow' : r.verdict === 'confirm' ? YELLOW + 'confirm' : RED + r.verdict;
        console.log(`  ${DIM}${r.seq}${RESET} ${r.ts}  ${CYAN}${(r.tool || '').padEnd(8)}${RESET} ${verdict}${RESET}  ${DIM}${r.reason}${RESET}`);
      } catch { console.log(`  ${DIM}${line.slice(0, 120)}${RESET}`); }
    }
    console.log();
    return;
  }

  if (sub === 'verify') {
    const v = auditVerify(auditPath);
    if (v.ok) {
      console.log(`\n  ${GREEN}Audit chain OK${RESET} — ${v.checked} entries verified, no tampering detected.\n`);
    } else {
      console.log(`\n  ${RED}Audit chain BROKEN${RESET} at entry ${v.brokenAt} (${v.reason || 'hash mismatch'}).\n`);
      process.exit(1);
    }
    return;
  }

  console.error(`\n  Unknown audit subcommand: ${sub}\n  Run ${CYAN}remote-agent audit help${RESET}\n`);
}

// ── gui (terminal dashboard) ──────────────────────────────────────
async function gui() {
  const creds = loadCreds();
  log.quiet(true); // Suppress console output; TUI handles display

  // No API key yet? Start the dashboard in setup mode — it shows the
  // connect guide and supports inline login (press l).
  const daemon = creds ? new AgentDaemon(creds) : null;
  const dashboard = new Dashboard(daemon, { setup: !creds });

  // Unpaired → keep the anonymous "waiting to pair" heartbeat alive.
  if (!creds) startPresence();

  const stop = () => {
    stopPresence();
    dashboard.stop();
    daemon?.close();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  daemon?.start();
  dashboard.start();
}

// ── start (headless) ──────────────────────────────────────────────
async function start() {
  // Fail is never allowed: the daemon logs and survives unexpected errors.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`  ${YELLOW} uncaught: ${err?.message || err}${RESET}\n`);
  });
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`  ${YELLOW} unhandled rejection: ${String(err?.message || err)}${RESET}\n`);
  });

  const creds = requireCreds();
  const force = args.includes('--force');

  console.log(`\n  ${BOLD}${CYAN}remote-agent${RESET} ${DIM}v${DEFAULTS.version}${RESET}`);
  console.log(`  ${DIM}Headless daemon — controlled from ${CLOUD.base}${RESET}`);
  console.log(`  ${DIM}Log level: ${log.level || 'info'}${RESET}`);
  console.log(`  ${DIM} ${RESET}${DIM}Star on GitHub:${RESET} https://github.com/remoteagent-online/remote-agent`);
  console.log();

  const daemon = new AgentDaemon(creds);

  try {
    daemon.start({ force });
  } catch (e) {
    if (e?.code === 'EALREADYRUNNING') {
      console.error(`  ${RED}${e.message}${RESET}\n`);
      process.exit(1);
    }
    throw e;
  }

  daemon.on('connected', () => {
    process.stderr.write(`  ${GREEN}● Connected to ${CLOUD.base}${RESET}\n`);
  });

  daemon.on('disconnected', (code) => {
    process.stderr.write(`  ${YELLOW}○ Disconnected (code ${code}), reconnecting...${RESET}\n`);
  });

  daemon.on('auth-failed', () => {
    process.stderr.write(`  ${RED} Authentication rejected by ${CLOUD.base}${RESET}\n`);
    process.stderr.write(`  ${YELLOW}  Run ${CYAN}remote-agent login${RESET}${YELLOW} with a valid key, then retry.${RESET}\n`);
    process.exit(1);
  });

  daemon.on('task:done', (result) => {
    process.stderr.write(`  ${GREEN} Done (${result.tokens} tokens)${RESET}\n`);
  });

  daemon.on('error', (err) => {
    process.stderr.write(`  ${RED} ${err.message}${RESET}\n`);
  });

  const stop = () => {
    process.stderr.write(`\n  ${DIM}Shutting down...${RESET}\n`);
    daemon.close();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // (start already invoked above in the try block — single call only)

  // Keep process alive; all work is driven by inbound commands.
  setInterval(() => {}, 1 << 30);
}

// ── mode ──────────────────────────────────────────────────────────
async function modeCmd() {
  const sub = args[0];

  if (sub === 'set') {
    const name = args[1];
    if (!name) {
      console.error(`\n  Usage: remote-agent mode set <${MODE_NAMES.join('|')}>\n`);
      process.exit(2);
    }
    try {
      const r = applyMode(name);
      console.log(`\n  ${BOLD}Mode set: ${r.mode}${RESET}`);
      console.log(`  ${DIM}${r.label}${RESET}`);
      console.log(`  ${DIM}Policy:${RESET}    ${r.policy} → ${r.policyPath}`);
      console.log(`  ${DIM}Skills:${RESET}    ${r.skills.length ? r.skills.join(', ') : '(none)'}`);
      console.log(`  ${DIM}Daemon:${RESET}    ${r.daemon ? 'auto-start installed' : 'manual (remote-agent start)'}`);
      console.log(`\n  ${DIM}Next:${RESET} ${CYAN}remote-agent daemon status${RESET}  ·  ${CYAN}remote-agent mode show${RESET}\n`);
    } catch (e) {
      console.error(`\n  ${RED}${e.message}${RESET}\n`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'show' || sub === 'status' || !sub) {
    const s = modeSummary();
    console.log(`\n  ${BOLD}remote-agent mode${RESET}  ${DIM}· ${s.label}${RESET}`);
    console.log(`  ${DIM}${s.description}${RESET}`);
    console.log(`  ${DIM}Policy:${RESET}  ${s.policy}${s.policyTiers ? '  (' + Object.entries(s.policyTiers).map(([k, v]) => `${k}=${v}`).join(', ') + ')' : ''}`);
    console.log(`  ${DIM}Skills:${RESET}  ${s.skills.length ? s.skills.join(', ') : '(none)'}`);
    console.log(`  ${DIM}Daemon:${RESET}  ${s.daemon ? 'installed' : 'not installed'}`);
    console.log(`\n  ${DIM}Set a mode:${RESET} ${CYAN}remote-agent mode set <${MODE_NAMES.join('|')}>${RESET}\n`);
    return;
  }

  if (sub === 'list') {
    console.log(`\n  ${BOLD}Available modes${RESET}\n`);
    for (const name of MODE_NAMES) {
      const m = MODES[name];
      const active = name === currentMode() ? '  ← active' : '';
      console.log(`  ${CYAN}${name.padEnd(9)}${RESET} ${m.label}${active}`);
      console.log(`             ${DIM}${m.description}${RESET}`);
    }
    console.log();
    return;
  }

  console.error(`\n  Unknown mode subcommand: ${sub}\n  Run ${CYAN}remote-agent mode help${RESET}\n`);
  process.exit(2);
}

// ── daemon ────────────────────────────────────────────────────────
async function daemonCmd() {
  const sub = args[0] || 'status';

  if (sub === 'install') {
    const r = daemonInstall();
    if (!r.ok) {
      console.error(`\n  ${RED}Failed to install daemon:${RESET}\n  ${r.output || 'unknown error'}\n`);
      process.exit(1);
    }
    const cfg = (await import('../src/config.js')).loadConfig();
    cfg.daemon = 'installed';
    (await import('../src/config.js')).saveConfig(cfg);
    console.log(`\n  ${GREEN}Daemon installed & started.${RESET}`);
    console.log(`  ${DIM}It will auto-start on login (KeepAlive on crash).${RESET}`);
    console.log(`  ${DIM}Log:${RESET} ${DAEMON_PATHS.log}\n`);
    return;
  }

  if (sub === 'uninstall') {
    daemonUninstall();
    const cfg = (await import('../src/config.js')).loadConfig();
    delete cfg.daemon;
    (await import('../src/config.js')).saveConfig(cfg);
    console.log(`\n  ${YELLOW}Daemon stopped & removed.${RESET}\n`);
    return;
  }

  if (sub === 'stop') {
    const stopped = stopRunningDaemon();
    console.log(stopped
      ? `\n  ${YELLOW}Stop signal sent to running daemon.${RESET}\n`
      : `\n  ${DIM}No running daemon (no PID file).${RESET}\n`);
    return;
  }

  if (sub === 'status') {
    const st = daemonStatus();
    console.log(`\n  ${BOLD}remote-agent daemon${RESET}  ${DIM}· ${st.platform}${RESET}`);
    console.log(`  ${DIM}Service:${RESET}    ${st.serviceInstalled ? GREEN + 'installed' + RESET : DIM + 'not installed' + RESET}  ${st.serviceRunning ? GREEN + '· running' + RESET : st.serviceLoaded ? YELLOW + '· loaded' + RESET : ''}`);
    console.log(`  ${DIM}PID file:${RESET}   ${st.pid ? st.pid + (st.pidAlive ? ' (alive)' : YELLOW + ' (stale)' + RESET) : '(none)'}`);
    console.log(`  ${DIM}Unit:${RESET}      ${isMacPath()}`);
    console.log(`  ${DIM}Log:${RESET}       ${DAEMON_PATHS.log}\n`);
    if (st.serviceInstalled && !st.serviceRunning) {
      console.log(`  ${YELLOW}Service installed but not running. Start it:${RESET} ${CYAN}remote-agent daemon install${RESET}\n`);
    }
    return;
  }

  console.error(`\n  Unknown daemon subcommand: ${sub}\n  Run ${CYAN}remote-agent daemon help${RESET}\n`);
  process.exit(2);
}

function isMacPath() {
  return platform() === 'darwin' ? DAEMON_PATHS.launchd : DAEMON_PATHS.systemd;
}

// ── skills ────────────────────────────────────────────────────────
async function skillsCmd() {
  const sub = args[0];
  const manager = new SkillsManager();

  if (sub === 'list') {
    const items = manager.list();
    if (!items.length) {
      console.log(`\n  No skills installed. Run: ${CYAN}remote-agent skills install${RESET}\n`);
      return;
    }
    console.log(`\n  ${BOLD}Installed skills${RESET}  (mode: ${CYAN}${currentMode()}${RESET})\n`);
    for (const s of items) {
      const mark = s.enabled ? GREEN + '✓' + RESET : DIM + '·' + RESET;
      console.log(`  ${mark} ${s.name} — ${s.description || 'no description'}`);
    }
    console.log(`\n  Enable: ${CYAN}remote-agent skills enable <name>${RESET}  ·  Disable: ${CYAN}remote-agent skills disable <name>${RESET}\n`);
    return;
  }

  if (sub === 'install') {
    const r = manager.install();
    console.log(`\n  ${GREEN}Installed ${r.installed} bundled skill(s)${RESET} into ${r.dir}\n`);
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const name = args[1];
    if (!name) { console.error(`\n  Usage: remote-agent skills ${sub} <name>\n`); process.exit(2); }
    if (sub === 'enable') {
      const r = manager.enable(name);
      if (!r.ok) { console.error(`\n  ${RED}${r.error}${RESET}\n`); process.exit(1); }
      console.log(`\n  ${GREEN}Enabled ${name}.${RESET} Active: ${r.enabled.join(', ') || '(none)'}\n`);
    } else {
      manager.disable(name);
      console.log(`\n  ${YELLOW}Disabled ${name}.${RESET}\n`);
    }
    return;
  }

  console.error(`\n  Unknown skills subcommand: ${sub}\n  Run ${CYAN}remote-agent skills help${RESET}\n`);
  process.exit(2);
}

// ── update ────────────────────────────────────────────────────────
async function updateCmd() {
  const sub = args[0];

  if (sub === 'check' || sub === 'status') {
    const r = await checkForUpdates();
    console.log(`\n  ${BOLD}remote-agent update check${RESET}`);
    console.log(`  ${DIM}Installed:${RESET}  v${r.installed}`);
    console.log(`  ${DIM}Latest:${RESET}     ${r.latest ? 'v' + r.latest : '(unreachable)'}`);
    if (r.available) console.log(`  ${GREEN}→ Update available. Run: remote-agent update${RESET}`);
    else if (r.latest) console.log(`  ${DIM}→ You're on the latest release.${RESET}`);
    else console.log(`  ${YELLOW}→ Could not reach the release feed (offline or rate-limited).${RESET}`);
    console.log();
    return;
  }

  if (sub === 'version' || sub === '-v' || sub === '--version') {
    console.log(`v${VERSION}`);
    return;
  }

  // default: apply the update
  console.log(`\n  Checking for updates...`);
  const r = await applyUpdate();
  if (!r.ok) {
    console.error(`  ${RED}Update failed: ${r.error}${RESET}\n`);
    process.exit(1);
  }
  if (r.upToDate) {
    console.log(`  ${DIM}Already on the latest release (v${r.version}).${RESET}\n`);
    return;
  }
  console.log(`  ${GREEN}Updated ${r.from} → v${r.version}.${RESET}`);
  console.log(`  ${DIM}Restart the daemon to pick it up: remote-agent daemon status → start${RESET}\n`);
}

// ── version ───────────────────────────────────────────────────────
function versionCmd() {
  console.log(`v${VERSION}`);
}

// ── tools ────────────────────────────────────────────────────────
async function toolsCmd() {
  const sub = args[0] || 'list';
  const { ToolRegistry, discoverExternalTools } = await import('../src/tools/registry.js');

  if (sub === 'list') {
    const reg = new ToolRegistry();
    const external = await discoverExternalTools();
    for (const t of external) reg.register(t);
    const items = reg.list();
    console.log(`\n  ${BOLD}Registered tools${RESET}  (${items.length})`);
    for (const t of items) {
      console.log(`  ${CYAN}${t.name.padEnd(16)}${RESET} ${t.description || ''}`);
      console.log(`             ${DIM}v${t.version} · ${t.sideEffects}${t.sideEffects === 'none' ? '' : ' · non-idempotent'}`);
    }
    console.log();
    return;
  }

  if (sub === 'inspect') {
    const name = args[1];
    if (!name) { console.error(`\n  Usage: remote-agent tools inspect <name>\n`); process.exit(2); }
    const reg = new ToolRegistry();
    const external = await discoverExternalTools();
    for (const t of external) reg.register(t);
    const found = reg.list().find((t) => t.name === name);
    if (!found) { console.error(`\n  ${RED}Tool "${name}" not found.${RESET}\n`); process.exit(1); }
    console.log(`\n  ${BOLD}${found.name}${RESET}  v${found.version}`);
    console.log(`  ${found.description}\n`);
    console.log(`  ${DIM}sideEffects:${RESET}  ${found.sideEffects}`);
    return;
  }

  if (sub === 'validate') {
    const path = args[1];
    if (!path) { console.error(`\n  Usage: remote-agent tools validate <path-to-tool-module>\n`); process.exit(2); }
    try {
      const resolved = path.startsWith('/') || path.startsWith('file:') ? path : join(process.cwd(), path);
      const mod = await import(pathToFileURL(resolved).href);
      const { isTool } = await import('../src/tools/define.js');
      const t = mod.default || mod;
      if (isTool(t)) {
        console.log(`\n  ${GREEN}Valid tool: ${t.name} v${t.version}${RESET} (${t.description})\n`);
      } else {
        console.error(`\n  ${RED}Not a tool descriptor. Use defineTool() and export it as default.${RESET}\n`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`\n  ${RED}Could not load ${path}: ${e.message}${RESET}\n`);
      process.exit(1);
    }
    return;
  }

  console.error(`\n  Unknown tools subcommand: ${sub}\n  Run ${CYAN}remote-agent tools help${RESET}\n`);
  process.exit(2);
}

// ── status ────────────────────────────────────────────────────────
function status() {
  const c = loadCreds();

  console.log(`\n  ${BOLD}remote-agent status${RESET}\n`);

  if (!c?.apiKey) {
    console.log(`  ${RED}Not logged in.${RESET} Run: ${CYAN}remote-agent login${RESET}\n`);
    return;
  }

  console.log(`  ${DIM}Agent:${RESET}   ${c.agentId || '(pending)'}`);
  console.log(`  ${DIM}Version:${RESET} v${VERSION}`);
  console.log(`  ${DIM}Cloud:${RESET}   ${CLOUD.base}`);
  console.log(`  ${DIM}WS URL:${RESET}  ${CLOUD.wsUrl}`);
  console.log(`  ${DIM}Creds:${RESET}   ${PATHS.creds}`);
  console.log(`  ${DIM}Config:${RESET}  ${PATHS.dir}`);
  console.log(`  ${DIM}Tools:${RESET}   ${tools.names().join(', ')}`);
  console.log(`  ${DIM}Mode:${RESET}    ${currentMode()}`);
  const pol = Policy.load();
  console.log(`  ${DIM}Shell:${RESET}   ${pol.shellUnsafe ? `${GREEN}unrestricted — every authenticated command runs${RESET}` : 'allowlist (safe defaults)'}`);
  console.log(`  ${DIM}Audit:${RESET}   ${pol.auditEnabled ? 'on' : `${RED}off${RESET}`}`);
  const ds = daemonStatus();
  console.log(`  ${DIM}Daemon:${RESET}  ${ds.serviceInstalled ? 'installed' : 'not installed'}${ds.serviceRunning ? ' · running' : ds.pidAlive ? ' · running (pid)' : ''}`);
  console.log();
}

// ── help ──────────────────────────────────────────────────────────
function help() {
  console.log(`
  ${BOLD}remote-agent${RESET} ${DIM}v${DEFAULTS.version}${RESET}
  Cloud-brained device agent. No local LLM keys.

  ${BOLD}USAGE${RESET}

    remote-agent ${CYAN}<command>${RESET} ${DIM}[options]${RESET}

  ${BOLD}COMMANDS${RESET}

    ${CYAN}gui${RESET}               Terminal dashboard with live metrics   ${DIM}(default)${RESET}
                             (no key saved? press ${CYAN}l${RESET} inside to log in)
    ${CYAN}start${RESET}             Headless daemon (no UI)
    ${CYAN}login${RESET}             Save your remoteagent.online API key
    ${CYAN}connect${RESET} ${DIM}[url]${RESET}   Test / force connection to control plane
    ${CYAN}chat${RESET} ${DIM}<msg>${RESET}      Send a chat message via API
    ${CYAN}exec${RESET} ${DIM}<tool>${RESET}     Execute a tool directly (sysinfo, shell, files, net)
    ${CYAN}policy${RESET}            Inspect policy, explain decisions, apply presets
    ${CYAN}audit${RESET}             Tail or verify the tamper-evident audit log
    ${CYAN}mode${RESET}              Set the capability dial: minimal · standard · full
    ${CYAN}daemon${RESET}            Install / manage auto-start background service
    ${CYAN}skills${RESET}            List / install / enable / disable skills
    ${CYAN}tools${RESET}             List / inspect / validate tools (SDK)
    ${CYAN}update${RESET}            Check for updates / self-update
    ${CYAN}version${RESET}           Print the installed version
    ${CYAN}debug${RESET}             Debug mode — verbose system + connection info
    ${CYAN}status${RESET}            Show login and connection info
    ${CYAN}help${RESET}              Show this help

  ${BOLD}EXAMPLES${RESET}

    ${DIM}# Login to your control plane${RESET}
    remote-agent login

    ${DIM}# Start the terminal dashboard${RESET}
    remote-agent gui

    ${DIM}# Test connection to custom endpoint${RESET}
    remote-agent connect http://localhost:4300

    ${DIM}# Send a chat message${RESET}
    remote-agent chat "What is the system status?"

    ${DIM}# Execute a local tool${RESET}
    remote-agent exec sysinfo
    remote-agent exec shell cmd=uptime
    remote-agent exec files action=list path=/tmp

    ${DIM}# Security: policy + audit${RESET}
    remote-agent policy status
    remote-agent policy explain shell cmd=df
    remote-agent policy preset standard
    remote-agent audit tail
    remote-agent audit verify

    ${DIM}# Debug mode${RESET}
    remote-agent debug

    ${DIM}# Capability dial: from zero skills to full daemon${RESET}
    remote-agent mode list
    remote-agent mode set standard
    remote-agent mode set full     ${DIM}# also installs auto-start daemon${RESET}
    remote-agent daemon status
    remote-agent daemon install
    remote-agent daemon uninstall

    ${DIM}# Version lifecycle${RESET}
    remote-agent version          ${DIM}# installed version${RESET}
    remote-agent update check     ${DIM}# latest available?${RESET}
    remote-agent update           ${DIM}# self-update from GitHub${RESET}

    ${DIM}# Bring your own LLM (BYO keys — prompts stay on this device)${RESET}
    remote-agent provider set anthropic ${DIM}# or: openai / ollama${RESET}
    remote-agent provider set openai --url http://localhost:1234/v1 --model llama-3
    remote-agent provider test
    REMOTE_TRANSPORT=local remote-agent start

    ${DIM}# Model Context Protocol — expose the tools to other agents${RESET}
    remote-agent mcp

  ${BOLD}ENVIRONMENT${RESET}

    REMOTE_CLOUD        Cloud base URL     ${DIM}(default: ${CLOUD.base})${RESET}
    REMOTE_CLOUD_WS     WebSocket URL      ${DIM}(auto-derived from REMOTE_CLOUD)${RESET}
    REMOTE_ALLOW_CMDS   Shell allowlist    ${DIM}(comma-separated command names)${RESET}
    REMOTE_POLICY       Policy file path   ${DIM}(default: ~/.remote-agent/policy.json)${RESET}
    REMOTE_WORKSPACE    File tool sandbox  ${DIM}(default: ~/.remote-agent/workspace)${RESET}
    REMOTE_SHELL_UNSAFE ${YELLOW}DEPRECATED${RESET}        ${DIM}— set "shell": {"unsafe": true} in policy.json instead${RESET}
    REMOTE_TRANSPORT    ${DIM}local | auto${RESET}   ${DIM}(local = BYO provider only, fail fast when unset)${RESET}
    REMOTE_PROVIDER     ${DIM}anthropic | openai | ollama${RESET}
    REMOTE_PROVIDER_KEY ${DIM}provider API key${RESET}        ${DIM}(never leaves the device)${RESET}
    REMOTE_PROVIDER_URL ${DIM}provider base URL${RESET}       ${DIM}(OpenAI-compatible endpoints, Ollama, …)${RESET}
    REMOTE_PROVIDER_MODEL ${DIM}model name override${RESET}

  ${BOLD}QUICK START${RESET}

    ${DIM}# 1. Login${RESET}
    remote-agent login

    ${DIM}# 2. Verify connection${RESET}
    remote-agent connect

    ${DIM}# 3. Start the dashboard${RESET}
    remote-agent gui

  ${DIM}Cloud reasoning runs on ${BOLD}${CLOUD.base}${RESET}${DIM}; BYO providers run on-device.${RESET}
`);
}

// ── provider (BYO-key local brain management) ─────────────────────
async function providerCmd() {
  const sub = (args[0] || 'status').toLowerCase();

  if (sub === 'status') {
    const cfg = loadProviderConfig();
    console.log(`\n  ${BOLD}remote-agent provider${RESET}\n`);
    if (!cfg) {
      console.log(`  ${DIM}No BYO provider configured — the cloud brain is in use.${RESET}`);
      console.log(`  ${DIM}Bring your own keys:${RESET} ${CYAN}remote-agent provider set <anthropic|openai|ollama>${RESET}\n`);
      return;
    }
    console.log(`  ${DIM}Provider:${RESET} ${cfg.provider}`);
    console.log(`  ${DIM}Model:${RESET}    ${cfg.model}`);
    console.log(`  ${DIM}Base URL:${RESET} ${cfg.baseUrl}`);
    console.log(`  ${DIM}API key:${RESET}  ${cfg.apiKey ? cfg.apiKey.slice(0, 8) + '…' : '(none — local provider)'}`);
    const p = pricesFor(cfg.provider, cfg.model, cfg.prices);
    console.log(`  ${DIM}Pricing:${RESET}  $${p.input}/M in · $${p.output}/M out`);
    console.log(`  ${DIM}Brain:${RESET}    ${cfg.enabled === false ? 'disabled (cloud in use)' : 'BYO local — prompts stay on this device'}\n`);
    return;
  }

  if (sub === 'unset') {
    const removed = removeProviderConfig();
    console.log(`\n  ${removed ? GREEN + 'BYO provider removed — cloud brain restored.' : DIM + 'Nothing to remove.'}${RESET}\n`);
    return;
  }

  if (sub === 'test') {
    const cfg = loadProviderConfig();
    if (!cfg) {
      console.log(`\n  ${RED}No provider configured.${RESET} Run: ${CYAN}remote-agent provider set <provider>${RESET}\n`);
      process.exit(1);
    }
    const prompt = args.slice(1).join(' ') || 'Reply with exactly: OK';
    console.log(`\n  ${BOLD}remote-agent provider test${RESET}\n`);
    console.log(`  ${DIM}Provider:${RESET} ${cfg.provider} · ${DIM}Model:${RESET} ${cfg.model}\n`);
    process.stdout.write(`  ${MAGENTA}Calling…${RESET}`);
    try {
      const r = await providerTest(cfg, prompt);
      process.stdout.write(`\r  ${GREEN}OK${RESET} (${r.durationMs}ms, ${r.usage?.total || 0} tokens, $${(r.usage?.costUsd || 0).toFixed(6)})\n\n`);
      console.log(`  ${r.text}\n`);
    } catch (err) {
      process.stdout.write(`\r  ${RED}Failed:${RESET} ${err.message}\n\n`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'set') {
    const provider = (args[1] || '').toLowerCase();
    if (!PROVIDERS.includes(provider)) {
      console.log(`\n  ${BOLD}remote-agent provider set${RESET}\n`);
      console.log(`  ${DIM}Usage:${RESET} remote-agent provider set ${CYAN}<anthropic|openai|ollama>${RESET} ${DIM}[--key KEY] [--url URL] [--model MODEL]${RESET}\n`);
      console.log(`  ${DIM}Providers:${RESET}`);
      console.log(`    ${CYAN}anthropic${RESET}  Claude (api.anthropic.com)`);
      console.log(`    ${CYAN}openai${RESET}     OpenAI or any compatible endpoint (OpenRouter, Groq, LM Studio, vLLM…)`);
      console.log(`    ${CYAN}ollama${RESET}     local models at http://127.0.0.1:11434 — fully offline, $0\n`);
      console.log(`  ${DIM}Key comes from --key or REMOTE_PROVIDER_KEY. Prompts stay on this device.${RESET}\n`);
      return;
    }
    const opt = (name) => {
      const i = args.indexOf(name);
      return i >= 0 && args[i + 1] ? args[i + 1] : null;
    };
    let apiKey = opt('--key') || process.env.REMOTE_PROVIDER_KEY || null;
    if (provider !== 'ollama' && !apiKey) {
      const rl = createInterface({ input: stdin, output: stdout });
      apiKey = (await rl.question(`  API key for ${provider}: `)).trim();
      rl.close();
    }
    if (provider !== 'ollama' && !apiKey) {
      console.log(`\n  ${RED}No key given.${RESET}\n`);
      process.exit(1);
    }
    const cfg = saveProviderConfig({
      provider,
      ...(apiKey ? { apiKey } : {}),
      ...(opt('--url') ? { baseUrl: opt('--url') } : {}),
      ...(opt('--model') ? { model: opt('--model') } : {}),
    });
    console.log(`\n  ${GREEN}BYO brain configured.${RESET}`);
    console.log(`  ${DIM}Provider:${RESET} ${cfg.provider}`);
    console.log(`  ${DIM}Model:${RESET}    ${cfg.model}`);
    console.log(`  ${DIM}Base URL:${RESET} ${cfg.baseUrl}`);
    console.log(`  ${DIM}Saved:${RESET}    ${cfg.file} ${DIM}(0600)${RESET}`);
    console.log(`\n  ${DIM}Test it:${RESET}   ${CYAN}remote-agent provider test${RESET}`);
    console.log(`  ${DIM}Apply:${RESET}    stop/start the daemon — the provider is read at start`);
    console.log(`  ${DIM}Force local:${RESET} ${CYAN}REMOTE_TRANSPORT=local remote-agent start${RESET}\n`);
    return;
  }

  console.log(`\n  ${DIM}Unknown subcommand "${sub}". Try: ${CYAN}remote-agent provider [status|set|unset|test]${RESET}\n`);
}

// ── mcp (Model Context Protocol server over stdio) ────────────────
async function mcpCmd() {
  if (args.includes('--http')) {
    const portIdx = args.indexOf('--port');
    const port = portIdx >= 0 && args[portIdx + 1] ? Number(args[portIdx + 1]) : 4301;
    const stop = await runMcpHttpServer({ registry: tools, port, log: (m) => log.info(m) });
    process.on('SIGINT', () => stop().then(() => process.exit(0)));
    process.on('SIGTERM', () => stop().then(() => process.exit(0)));
    return;
  }
  log.info('MCP server starting (stdio)');
  await runMcpServer({ registry: tools, log });
}

// ── doctor (diagnose the local install) ───────────────────────────
async function doctorCmd() {
  const report = await runDoctor();
  if (args.includes('--json')) {
    console.log(JSON.stringify(formatDoctorJson(report), null, 2));
    if (!report.healthy) process.exitCode = 1;
    return;
  }
  console.log(`\n  ${BOLD}remote-agent doctor${RESET}\n`);
  console.log(`  ${report.checks.map((c) => `${c.ok ? GREEN + '●' : RED + '✖'}${RESET} ${c.name.padEnd(12)} ${DIM}${c.detail}${RESET}`).join('\n  ')}`);
  console.log(`\n  ${report.healthy ? GREEN + 'All checks passed.' : RED + 'Some checks failed — see above.'}${RESET}\n`);
  if (!report.healthy) process.exitCode = 1;
}

// ── Dispatch ──────────────────────────────────────────────────────
switch (cmd) {
  case 'login':               await login(); break;
  case 'gui':                 await gui(); break;
  case 'start':               await start(); break;
  case 'connect':             await connect(); break;
  case 'chat':                await chat(); break;
  case 'exec':                await execTool(); break;
  case 'debug':               await debug(); break;
  case 'status':              status(); break;
  case 'policy':              await policyCmd(); break;
  case 'audit':               await auditCmd(); break;
  case 'mode':                await modeCmd(); break;
  case 'daemon':              await daemonCmd(); break;
  case 'skills':              await skillsCmd(); break;
  case 'provider':            await providerCmd(); break;
  case 'mcp':                 await mcpCmd(); break;
  case 'doctor':              await doctorCmd(); break;
  case 'tools':               await toolsCmd(); break;
  case 'update':              await updateCmd(); break;
  case 'version':             versionCmd(); break;
  case undefined:
    // Default: GUI if TTY, headless otherwise
    if (process.stdout.isTTY) await gui();
    else                      await start();
    break;
  case 'help': case '-h': case '--help':
    help();
    break;
  default:
    console.error(`\n  Unknown command: ${cmd}\n  Run ${CYAN}remote-agent help${RESET} for usage.\n`);
    process.exit(1);
}
