// Jobs tool — background command management (harness-style job lifecycle).
//
// Long-running work must never block the task loop or die with the 15s shell
// timeout. This tool gives the brain the same job model as a harness/agent
// runtime:
//
//   jobs start "cmd" [cwd]        → job id + pid (returns immediately)
//   jobs status <id>              → running | done | error | killed, exit code
//   jobs output <id> [tail]       → captured stdout/stderr (last N chars)
//   jobs list                     → every job, newest first
//   jobs wait <id> [timeoutS]     → poll until done (max 120s), then tail
//   jobs kill <id>                → SIGKILL the whole process group
//
// Security: `start` routes through the SAME surface as the shell tool —
// quote-aware argv parsing (never a shell string), allowlist + realpath
// binary resolution, blocked patterns, and scrubbed env. It also honours the
// shell policy tier: when the policy denies or requires approval for the
// `shell` tool, `jobs start` refuses the same way — a background command can
// never widen the device policy. Each job spawns its own process group
// (detached) so `kill` always takes the whole tree down.
//
// Jobs are in-memory and live for the daemon process lifetime; restarting the
// daemon clears them (documented in the tool description).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Policy } from '@mona/engine';
import { log } from '../log.js';
import {
  parseCommand, resolveBinary, blockedPatterns, safeEnvKeys, shellCfg,
} from './shell.js';

const POLICY = Policy.load();

const STREAM_CAP  = 256 * 1024; // per stream, in memory
const OUTPUT_TAIL = 4000;       // default chars returned by `output`
const MAX_WAIT_S  = 120;
const MAX_CMD_LEN = 2000;

const jobStore = new Map();
let seq = 0;

// ── process spawning (process-group detached, output teed) ────────
function spawnProc(job, bin, argv) {
  const env = {};
  for (const k of safeEnvKeys) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.PATH = shellCfg.path || env.PATH || '/usr/bin:/bin';
  let child;
  try {
    child = spawn(bin, argv, {
      env,
      cwd: job.cwd,
      detached: true, // own process group → kill() takes the whole tree
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    job.error = err.message;
    return null;
  }
  if (!child || child.pid === undefined) {
    job.error = `failed to start ${bin}`;
    return null;
  }
  job.pids.push(child.pid);
  child.stdout.on('data', (d) => {
    if (job.stdout.length < STREAM_CAP) {
      job.stdout += d.toString();
      if (job.stdout.length > STREAM_CAP) job.stdout = job.stdout.slice(0, STREAM_CAP);
    }
  });
  child.stderr.on('data', (d) => {
    if (job.stderr.length < STREAM_CAP) {
      job.stderr += d.toString();
      if (job.stderr.length > STREAM_CAP) job.stderr = job.stderr.slice(0, STREAM_CAP);
    }
  });
  child.on('error', () => { /* 'close' still fires */ });
  return child;
}

function tryKillGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** Run one pipeline group (single command or a | chain) to completion. */
function runGroup(job, group) {
  return new Promise((resolve) => {
    if (group.length === 1) {
      const r0 = resolveBinary(group[0].argv[0]);
      if (r0.error) return resolve({ error: r0.error, allowed: r0.allowed });
      const child = spawnProc(job, r0.bin, group[0].argv.slice(1));
      if (!child) return resolve({ error: job.error || 'failed to spawn process' });
      let spawnErr = null;
      child.on('error', (e) => { spawnErr = e.message; });
      child.on('close', () => {
        if (spawnErr) resolve({ error: spawnErr });
        else resolve({ exitCode: child.exitCode ?? child.signalCode ?? 1 });
      });
      return;
    }
    // Pipe chain: spawn concurrently, chain stdio (same semantics as shell).
    const children = [];
    for (const st of group) {
      const r0 = resolveBinary(st.argv[0]);
      if (r0.error) {
        for (const c of children) tryKillGroup(c.pid);
        return resolve({ error: r0.error, allowed: r0.allowed });
      }
      const ch = spawnProc(job, r0.bin, st.argv.slice(1));
      if (!ch) {
        for (const c of children) tryKillGroup(c.pid);
        return resolve({ error: job.error || 'failed to spawn process' });
      }
      children.push(ch);
    }
    let prevOut = null;
    for (const ch of children) {
      if (prevOut) prevOut.pipe(ch.stdin);
      else ch.stdin.end();
      prevOut = ch.stdout;
    }
    Promise.all(children.map((ch) => new Promise((r) => ch.on('close', () => r(ch.exitCode ?? 1)))))
      .then((codes) => resolve({ exitCode: codes[codes.length - 1] }));
  });
}

/** Group consecutive | stages; group[0].op is the operator preceding it. */
function groupStages(stages) {
  const groups = [];
  let i = 0;
  while (i < stages.length) {
    const g = [stages[i]];
    while (i + 1 < stages.length && stages[i + 1].op === '|') {
      g.push(stages[i + 1]);
      i++;
    }
    groups.push(g);
    i++;
  }
  return groups;
}

/** Async driver: run groups with && / || / ; semantics, then finalise. */
async function runJobAsync(job, stages) {
  let lastExit = 0;
  for (const group of groupStages(stages)) {
    if (job.killed) break;
    const op = group[0].op;
    if (op === '&&' && lastExit !== 0) continue;
    if (op === '||' && lastExit === 0) continue;
    const r = await runGroup(job, group);
    if (r.error) {
      job.status = 'error';
      job.error = r.error;
      job.allowed = r.allowed || null;
      job.exitCode = 1;
      job.endedAt = Date.now();
      cleanup(job);
      log.warn(`Job ${job.id} failed: ${r.error}`);
      return;
    }
    lastExit = r.exitCode === 0 ? 0 : 1;
  }
  if (job.killed) return; // a kill already finalised the job — never overwrite
  job.exitCode = lastExit;
  job.status = 'done';
  job.endedAt = Date.now();
  cleanup(job);
}

/** Reap finished process groups (children have exited by now). */
function cleanup(job) {
  for (const pid of job.pids) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* exited */ }
  }
  job.pids = [];
}

function killJob(id) {
  const job = jobStore.get(id);
  if (!job) return { error: `No such job: ${id}` };
  if (job.status === 'running') {
    for (const pid of job.pids) tryKillGroup(pid);
    job.pids = [];
    job.killed = true;
    job.status = 'killed';
    job.exitCode = null;
    job.endedAt = Date.now();
  }
  return { ok: true, id: job.id, status: job.status };
}

function outputOf(job, tail) {
  const t = Number.isInteger(tail) && tail > 0 ? Math.min(tail, STREAM_CAP) : OUTPUT_TAIL;
  return {
    id: job.id,
    status: job.status,
    exitCode: job.exitCode,
    error: job.error || null,
    bytesOut: job.stdout.length,
    bytesErr: job.stderr.length,
    stdout: job.stdout.slice(-t),
    stderr: job.stderr.slice(-t),
  };
}

async function waitJob(id, timeoutS, signal) {
  const job = jobStore.get(id);
  if (!job) return { error: `No such job: ${id}` };
  const cap = Math.min(Math.max(Number(timeoutS) || 30, 1), MAX_WAIT_S) * 1000;
  const start = Date.now();
  while (job.status === 'running' && Date.now() - start < cap) {
    if (signal && signal.aborted) {
      return { ...outputOf(job, OUTPUT_TAIL), waitedMs: Date.now() - start, note: 'wait interrupted by tool timeout — poll with jobs status/output' };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ...outputOf(job, OUTPUT_TAIL), waitedMs: Date.now() - start };
}

function listJobs() {
  const arr = [...jobStore.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((j) => ({
      id: j.id, status: j.status, exitCode: j.exitCode,
      cmd: j.cmd.slice(0, 140), bytesOut: j.stdout.length, bytesErr: j.stderr.length,
      pid: j.pids[0] || null, startedAt: j.startedAt, endedAt: j.endedAt,
    }));
  return { count: arr.length, jobs: arr };
}

// ── Tool definition ───────────────────────────────────────────────
export const jobs = {
  name: 'jobs',
  description: 'Run long commands in the background and manage them — the shell tool times out at 15s, jobs run for minutes. Actions: start <cmd> [cwd] (returns a job id immediately), status <id>, output <id> [tail chars], list, wait <id> [timeoutS up to 120], kill <id>. Jobs are gated by the same command allowlist and policy as the shell tool; they live until the daemon restarts.',
  args: {
    action: 'string — start | status | output | list | wait | kill',
    cmd: 'string — command to run (start only)',
    id: 'string — job id (status / output / wait / kill only)',
    cwd: 'string — optional working directory (start only)',
    tail: 'number — optional chars of captured output to return (output only)',
    timeoutS: 'number — optional seconds to wait for completion (wait only, max 120)',
  },
  timeoutMs: 130_000, // `wait` may legitimately run long; registry honours this

  async run(args, signal) {
    const action = String(args.action || '').trim();
    switch (action) {
      case 'start': {
        const cmd = String(args.cmd || '').trim();
        if (!cmd) return { error: 'start requires a cmd' };
        if (cmd.length > MAX_CMD_LEN) return { error: `Command too long (max ${MAX_CMD_LEN} chars)` };

        // Defence-in-depth pattern block (same as the shell tool).
        for (const pat of blockedPatterns) {
          if (pat.test(cmd)) return { error: 'Command blocked for security', cmd };
        }

        // Shell policy tier: a background command must never widen policy.
        if (POLICY.toolTier('shell') === 'deny') {
          return { error: 'shell commands are denied by policy — jobs start refused', policy: 'deny' };
        }
        const sv = POLICY.shellCheck(cmd);
        if (!sv.allowed) {
          return { error: sv.reason, policy: sv.tier };
        }

        let stages;
        try {
          stages = parseCommand(cmd);
        } catch (err) {
          return { error: err.message };
        }
        for (const st of stages) {
          const r0 = resolveBinary(st.argv[0]);
          if (r0.error) return { error: r0.error, allowed: r0.allowed };
        }

        let cwd = process.cwd();
        if (args.cwd) cwd = path.resolve(String(args.cwd));
        else if (process.env.MONA_WORKSPACE && fs.existsSync(process.env.MONA_WORKSPACE)) cwd = path.resolve(process.env.MONA_WORKSPACE);
        if (!fs.existsSync(cwd)) cwd = process.cwd(); // never spawn into a missing dir
        const id = `job-${++seq}`;
        const job = {
          id, cmd, cwd,
          status: 'running', pids: [], exitCode: null, error: null, allowed: null,
          stdout: '', stderr: '', killed: false,
          startedAt: Date.now(), endedAt: null,
        };
        jobStore.set(id, job);
        runJobAsync(job, stages); // fire-and-forget driver
        log.info(`Job ${id} started: ${cmd} (pid ${job.pids[0] || '-'})`);
        return {
          id, status: 'running', pid: job.pids[0] || null, cmd,
          note: 'Poll with jobs status/output, wait for completion, or kill. Jobs live until the daemon restarts.',
        };
      }
      case 'status': {
        const job = jobStore.get(String(args.id || ''));
        if (!job) return { error: `No such job: ${args.id || ''}` };
        return {
          id: job.id, status: job.status, exitCode: job.exitCode, error: job.error || null,
          cmd: job.cmd, pid: job.pids[0] || null,
          bytesOut: job.stdout.length, bytesErr: job.stderr.length,
          elapsedMs: Date.now() - job.startedAt, endedAt: job.endedAt,
        };
      }
      case 'output': {
        const job = jobStore.get(String(args.id || ''));
        if (!job) return { error: `No such job: ${args.id || ''}` };
        return outputOf(job, Number(args.tail));
      }
      case 'list':
        return listJobs();
      case 'wait':
        return await waitJob(String(args.id || ''), Number(args.timeoutS), signal);
      case 'kill':
        return killJob(String(args.id || ''));
      default:
        return {
          error: `Unknown action "${action}" — use start, status, output, list, wait or kill`,
          actions: ['start', 'status', 'output', 'list', 'wait', 'kill'],
        };
    }
  },
};
