// process-census runtime adapter — what is actually RUNNING and LISTENING on this
// Mac, so a live agent or an open port cannot escape the dashboard just because no
// session store mentions it. Read-only, native tools only (ps, lsof, launchctl, ls):
// no npm dependency, and a missing tool degrades to fewer rows instead of an error.
//
// Everything below was observed on this Mac (2026-10-06) — no invented formats:
//
//   ps -Ao pid,ppid,user,etime,%cpu,rss,command
//     "  PID  PPID USER                 ELAPSED  %CPU    RSS COMMAND"
//     "    1     0 root             13-04:54:45   0,6  15240 /sbin/launchd"
//     "  285     1 mona             13-04:54:12   0,2 137244 /usr/local/opt/node@24/bin/node /usr/local/lib/node_mod…"
//     RSS is KB, %CPU is locale-formatted ("0,6" on this German Mac) → parse both.
//     717 rows live. ps does not truncate when stdout is a pipe (longest row 330 chars).
//
//   lsof -nP -iTCP -sTCP:LISTEN
//     "COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME"
//     "node      525 mona   20u  IPv4 0x24353d3b646d2efe      0t0  TCP 127.0.0.1:18789 (LISTEN)"
//     "mysqld    726 mona   31u  IPv4  0x3910a3581fd5850      0t0  TCP 127.0.0.1:3306 (LISTEN)"
//
//   lsof -nP -iUDP
//     "loginwind   164 mona    4u  IPv4 0xc10190355caa131a      0t0  UDP *:*"      ← no port → skipped
//     "mDNSRespo   187 root    …                                       UDP *:5353"  ← port 5353
//     A UDP name containing "->" is connected, not bound → skipped.
//
//   launchctl list                        → TAB separated, header "PID\tStatus\tLabel"
//     "-	0	com.apple.SafariHistoryServiceAgent"   ← "-" = loaded but not running
//     "16879	0	com.apple.cloudphotod"                ← a pid here maps pid → label
//
//   ls -1 ~/Library/LaunchAgents /Library/LaunchAgents /Library/LaunchDaemons
//     "ai.openclaw.gateway.plist"
//     "com.remoteagent.agent.plist"
//     "homebrew.mxcl.mysql.plist"
//     (…/Library/LaunchAgents is empty here, and a missing directory must not throw)
//
// VERDICT RULES — first match wins, in this order:
//   1. 'agent' — the row carries an agent-ish signature: one of llm, agent, assistant,
//      model, mcp, gateway, copilot, dsh, openclaw, claude, codex, ollama, tui as a
//      whole word — in the executable path, in the script path of an interpreter launch
//      (node/python/bun/…), in an argument that is not a filesystem path, or in the
//      launchd label of a plist found in a LaunchAgents/LaunchDaemons directory.
//      A signature inside a PATH argument is data, not an agent — measured here:
//        "49497 mona /usr/local/bin/zstd -dc /Users/mona/.dsh/sessions/--Users-mona-…"
//      is a decompressor reading a DSH session archive, not an agent; likewise an inline
//      `node -e "…openclaw…"` one-liner only names things. It is also NOT an agent when
//      the executable is a shell/search tool (bash sh zsh dash ksh fish grep egrep fgrep
//      rg find) or is system-owned — /usr/sbin/distnoted "agent" and /usr/bin/ssh-agent
//      merely have the word in their name.
//   2. 'server-on-device' — the row owns ≥1 bound local socket (TCP LISTEN or unbound
//      UDP) and its executable is not system-owned. A wildcard bind includes 127.0.0.1,
//      so any listener counts as reachable locally. Measured: /usr/libexec/sharingd runs
//      as user mona yet is a macOS daemon, so "system daemon" is the executable's path
//      and not its owner.
//   3. 'system' — everything else.
//
// rows() is capped at 300 of the 717 live processes, so it sorts the interesting ones
// first: verdict (agent → server-on-device → system), then %CPU, then pid.
// launchd labels come only from the calling user's `launchctl list` domain (system
// daemons need root), so `launchd` is null for most root rows.
//
// ponytail: system/agent and system/listener splits are path-based only — a genuine
// agent or web server launched from /usr/bin/python3 is reported 'system'. Upgrade path:
// let a LaunchAgents/LaunchDaemons plist label override the path rule.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const id = 'process-census';
export const label = 'Process census';
export const verified = true; // ps, lsof, launchctl and ls ship with every macOS

const MAX_ROWS = 300;
const CMD_MAX = 200;
const TTL_MS = 1000; // one census per second, not one per caller

const AGENT_WORDS = /\b(?:llm|agent|assistant|model|mcp|gateway|copilot|dsh|openclaw|claude|codex|ollama|tui)\b/i;
const NEVER_AGENT = /^(?:ba|da|k|z|fi)?sh$|^(?:e?grep|fgrep|rg|find)$/;
const INTERPRETER = /^(?:node|nodejs|bun|deno|python[\d.]*|ruby|perl|php|java|tsx)$/;
const SYSTEM_EXEC = /^(?:\/System\/|\/usr\/libexec\/|\/usr\/sbin\/|\/usr\/bin\/|\/sbin\/|\/bin\/|\/Library\/Apple\/)/;
const RANK = { agent: 0, 'server-on-device': 1, system: 2 };

const execOf = (cmd) => (String(cmd).match(/^\S+/)?.[0] ?? '').replace(/^["']|["']$/g, '');
const num = (s) => { const n = Number.parseFloat(String(s).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const portOf = (name) => { const m = String(name).match(/:(\d+)$/); return m ? Number(m[1]) : null; };
// A macOS executable is a system daemon whoever it runs as (sharingd runs as mona).
const isSystem = (row) => SYSTEM_EXEC.test(execOf(row.command));

/** Does the command line name an agent, rather than merely contain the word in data? */
function agentish(row, plists) {
  const exec = execOf(row.command);
  const byLabel = row.launchd !== null && plists.has(row.launchd) && AGENT_WORDS.test(row.launchd);
  if (NEVER_AGENT.test(basename(exec)) || SYSTEM_EXEC.test(exec)) return false;
  if (AGENT_WORDS.test(exec)) return true;
  const args = String(row.command).slice(exec.length).trim().split(/\s+/).filter(Boolean);
  if (INTERPRETER.test(basename(exec))) {
    // `node -e …` / `python3 -c …` is a throwaway one-liner: it names things, it is not one.
    if (['-', '-e', '-c', '--eval'].includes(args[0])) return byLabel;
    if (AGENT_WORDS.test(args[0] ?? '')) return true; // the script it was handed is the program
  }
  // Any other token holding a "/" is a path argument — data the process works on.
  return byLabel || args.some((a) => !a.includes('/') && AGENT_WORDS.test(a));
}

/** Native tool → stdout; a missing tool or a non-zero exit yields '' and never throws. */
function read(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, maxBuffer: 8 << 20 });
  } catch { return ''; }
}

/** One row per process. Columns are fixed-width, so match them and drop the header. */
function processes() {
  const out = [];
  for (const line of read('ps', ['-Ao', 'pid,ppid,user,etime,%cpu,rss,command']).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.,]+)\s+(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      user: m[3],
      etime: m[4],
      cpu: num(m[5]),
      rssMB: Number((Number(m[6]) / 1024).toFixed(1)),
      command: m[7].slice(0, CMD_MAX),
      ports: [],
      launchd: null,
      verdict: 'system',
    });
  }
  return out;
}

/** pid → the ports that pid is bound to, from TCP LISTEN plus unconnected UDP. */
function portsByPid() {
  const map = new Map();
  const add = (pid, name) => {
    const port = portOf(String(name).replace(/\s*\(LISTEN\)$/, ''));
    if (!port) return; // "*:*" — a UDP socket with no concrete port
    if (!map.has(pid)) map.set(pid, new Set());
    map.get(pid).add(port);
  };
  for (const line of read('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || !/^\d+$/.test(f[1])) continue; // header
    add(Number(f[1]), f.at(-1) === '(LISTEN)' ? f.at(-2) : f.at(-1));
  }
  for (const line of read('lsof', ['-nP', '-iUDP']).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || !/^\d+$/.test(f[1])) continue;
    const name = f.at(-1);
    if (name.includes('->')) continue; // connected, not a service socket
    add(Number(f[1]), name);
  }
  return map;
}

/** pid → launchd label, for the rows launchd actually reports a pid for. */
function labelsByPid() {
  const map = new Map();
  for (const line of read('launchctl', ['list']).split('\n')) {
    const [pid, , name] = line.split('\t');
    if (/^\d+$/.test(pid ?? '') && name?.trim()) map.set(Number(pid), name.trim());
  }
  return map;
}

/** label → plist path, over the three LaunchAgents/LaunchDaemons directories. */
function plistsByLabel() {
  const map = new Map();
  for (const dir of [join(homedir(), 'Library/LaunchAgents'), '/Library/LaunchAgents', '/Library/LaunchDaemons']) {
    for (const line of read('ls', ['-1', dir]).split('\n')) {
      const name = line.trim();
      if (name.endsWith('.plist')) map.set(name.slice(0, -'.plist'.length), join(dir, name));
    }
  }
  return map;
}

function build() {
  const rows = [];
  try {
    const procs = processes();
    const ports = portsByPid();
    const labels = labelsByPid();
    const plists = plistsByLabel();
    for (const row of procs) {
      const port = ports.get(row.pid);
      if (port) row.ports = [...port].sort((a, b) => a - b);
      row.launchd = labels.get(row.pid) ?? null;
      row.verdict = agentish(row, plists) ? 'agent' : (row.ports.length && !isSystem(row) ? 'server-on-device' : 'system');
      rows.push(row);
    }
  } catch { /* a census of nothing beats a dashboard that throws */ }
  return rows
    .sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || b.cpu - a.cpu || a.pid - b.pid)
    .slice(0, MAX_ROWS);
}

let cache = null;

/** The whole census, memoized for one tick so rows()/sessions()/summary() agree. */
function census() {
  const now = Date.now();
  if (!cache || now - cache.at >= TTL_MS) cache = { at: now, rows: build() };
  return cache;
}

/** Every process row on this Mac, most relevant first, capped at 300. */
export function rows() {
  try { return census().rows; } catch { return []; }
}

/** The rows that look like a live agent, as session records the dashboard understands. */
export function sessions({ limit = 20 } = {}) {
  try {
    const now = Date.now();
    return rows()
      .filter((r) => r.verdict === 'agent')
      .slice(0, limit)
      .map((r) => ({
        id: `proc:${r.pid}`,
        agent: 'process',
        title: (r.launchd || `${basename(execOf(r.command)) || 'process'} · pid ${r.pid}`).slice(0, 120),
        objective: null,
        status: 'running',
        cwd: null,
        updatedAt: now,
        todos: [], // a process has no todo store; do not invent one
        action: r.command,
        files: [],
        source: 'ps',
      }));
  } catch { return []; }
}

export function summary() {
  const c = (() => { try { return census(); } catch { return { at: Date.now(), rows: [] }; } })();
  const agents = c.rows.filter((r) => r.verdict === 'agent').length;
  return { sessions: agents, running: agents, todos: 0, lastAt: c.at };
}
