// Sandboxed shell tool — multi-OS (macOS, Linux, Windows).
// Executes commands as argv arrays via execFile/spawn with shell:false.
// NO string is ever passed to a shell on POSIX: command strings are parsed
// into argv (quote-aware), every executable is resolved to a realpath'd
// absolute path and checked against the allowlist, the child env is scrubbed
// to PATH/HOME/LANG (+ a few safe vars), and the whole process group is
// killed on timeout.
//
// Chains (&& || ;) and pipes (|) are supported: EVERY segment's argv[0] must
// pass the allowlist — pipe-to-shell (curl | sh) is denied because sh/bash
// are not allowlisted. Redirects (>, <), command substitution ($(...), `),
// globs and arbitrary $VAR expansion are NOT supported by design.
//
// Unrestricted execution is a policy decision (`shell.unsafe: true` in
// ~/.remote-agent/policy.json), never a one-word env flag. The deprecated
// REMOTE_SHELL_UNSAFE=1 still works for one minor version but logs a warning.
//
// Set REMOTE_ALLOW_CMDS to extend the allowlist.

import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Policy } from '@remote-agent/engine';

// ── Platform detection ────────────────────────────────────────────
const PLATFORM = os.platform(); // 'darwin' | 'linux' | 'win32'

const SHELL_CONFIG = {
  darwin: {
    path:  '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  },
  linux: {
    path:  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  },
  win32: {
    shell: 'powershell.exe',
    path:  '', // Windows uses system PATH
    // Only real executables + the small in-process builtins (echo/type/cd)
    // are allowed. cmd.exe builtins like dir/ver are intentionally absent:
    // execution must stay argv-only with no user string ever reaching a shell.
    builtins: new Set(['echo', 'type', 'cd']),
  },
};

const cfg = SHELL_CONFIG[PLATFORM] || SHELL_CONFIG.linux;

export function platformPathEntries(platform, env = process.env) {
  const delimiter = platform === 'win32' ? ';' : ':';
  return String(env.PATH || '').split(delimiter).filter(Boolean);
}

export function executableCandidates(name, platform, env = process.env) {
  if (platform !== 'win32') return [name];
  const ext = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  if (path.extname(name)) return [name];
  return ext.map((suffix) => `${name}${suffix.toLowerCase()}`);
}

export function isExecutableFile(filePath, platform) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    return platform === 'win32' || Boolean(st.mode & 0o111);
  } catch {
    return false;
  }
}

// ── OS-aware default allowlist ────────────────────────────────────
const DEFAULTS = {
  darwin: 'df,uptime,uname,whoami,date,hostname,vm_stat,top,cat,head,tail,wc,ls,pwd,echo,env,which,sw_vers,sysctl,open',
  linux:  'df,uptime,uname,whoami,date,hostname,free,ps,top,cat,head,tail,wc,ls,pwd,echo,env,which',
  win32:  'whoami,date,hostname,echo,type,cd,systeminfo,tasklist,where',
};

const ALLOW = new Set(
  (process.env.REMOTE_ALLOW_CMDS || DEFAULTS[PLATFORM] || DEFAULTS.linux)
    .split(',').map(s => s.trim()).filter(Boolean)
);

// Per-agent command allowlist — set by the daemon before each task from the
// agent's capability profile (cloud can only ever ADD commands for an agent;
// the base allowlist and the always-blocked patterns stay the device-side
// authority). Reset to null after the task.
let AGENT_ALLOW = null;
export function setAgentAllow(cmds) {
  AGENT_ALLOW = Array.isArray(cmds) && cmds.length
    ? new Set(cmds.map((s) => String(s).trim()).filter(Boolean))
    : null;
}
function allowHas(base) {
  return ALLOW.has(base) || Boolean(AGENT_ALLOW && AGENT_ALLOW.has(base));
}
export function effectiveAllowlist() {
  return [...ALLOW, ...(AGENT_ALLOW ? [...AGENT_ALLOW] : [])].sort();
}

// Unrestricted mode comes from policy (shell.unsafe) — never from a silent
// parent-process env flag. REMOTE_SHELL_UNSAFE=1 is a deprecated fallback.
const POLICY = Policy.load();
const UNSAFE = POLICY.shellUnsafe;
const UNSAFE_SOURCE = POLICY.unsafeSource;

if (UNSAFE && UNSAFE_SOURCE === 'env') {
  // Deprecation warning, printed once.
  process.stderr.write(
    'remote-agent: REMOTE_SHELL_UNSAFE=1 is deprecated — set "shell": {"unsafe": true} in ~/.remote-agent/policy.json instead\n'
  );
}

/** Shell security posture — advertised to the cloud in `hello` so the
 *  control plane can enforce agent_permissions without probing. */
export const security = {
  allowlist: [...ALLOW].sort(),
  unsafe: UNSAFE,
  platform: PLATFORM,
  mode: 'argv',
  audit: POLICY.auditEnabled,
  get effectiveAllowlist() { return effectiveAllowlist(); },
};

// ── Blocked patterns (always denied; defence-in-depth, NOT the primary
//    control — the allowlist + argv execution are) ─────────────────
const BLOCKED_PATTERNS = [
  /rm\s+(-[a-z]*[rf][a-z]*\s+)+\/s*$/i,
  /rm\s+(-[a-z]*[rf][a-z]*\s+)+\*\s*$/i,
  /mkfs\b/i,
  /dd\s+if=/i,
  /:\(\)\s*\{.*\}/,
  />\s*\/dev\/sd[a-z]/i,
  /chmod\s+777\s+\//i,
  /sudo\b/i,
  /shutdown\b/i,
  /poweroff\b|reboot\b|halt\b/i,
  // Pipe-to-shell: remote code execution via downloader
  /curl\s+.*\|\s*(ba|z)?sh/i,
  /wget\s+.*\|\s*(ba|z)?sh/i,
  // Windows
  /format\s+[a-z]:/i,
  /del\s+\/f\s+\/s\s+[a-z]:\\/i,
  /rmdir\s+\/s\s+[a-z]:\\/i,
  /diskpart\b/i,
];

const TIMEOUT_MS  = 15_000;
const STDOUT_CAP  = 64 * 1024;  // 64 KB internal cap per stream
const RESULT_STDOUT = 8_000;    // tool result truncation (compat)
const RESULT_STDERR = 2_000;
const MAX_CMD_LEN = 2_000;

// Environment variables allowed to leak into child processes. Everything
// else (API keys, tokens, secrets) is deliberately excluded.
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'USER', 'LOGNAME', 'USERNAME', 'SystemRoot', 'ComSpec', 'PATHEXT'];

// $VAR expansion inside double quotes / bare words: only these are expanded,
// so `echo $HOME` works but `echo $AWS_SECRET_ACCESS_KEY` stays literal.
const EXPANDABLE_VARS = new Set(['HOME', 'PATH', 'USER', 'LANG', 'PWD', 'TMPDIR']);

// ── Quote-aware command parser ────────────────────────────────────
// Splits a command string into pipeline stages. Each stage is an argv
// array. Operators: && || ; | (top-level only). `>`, `<`, `$(` and
// backticks are rejected — they are shell features we do not expose.
class CommandParseError extends Error {}

function parseCommand(cmd) {
  const stages = [];   // { argv: [], op: null | '&&' | '||' | ';' | '|' }
  let cur = { argv: [], op: null };
  let word = '';
  let quote = null;    // "'" | '"' | null
  let escaped = false;
  let expectOp = false; // after an operator we may start a new word

  const pushWord = () => {
    if (word !== '') {
      cur.argv.push(word);
      word = '';
    }
  };
  const pushStage = (op) => {
    pushWord();
    stages.push(cur);
    cur = { argv: [], op };
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (escaped) {
      word += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      if (ch === '$') {
        // expand allowlisted vars inside double quotes
        const m = cmd.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)/);
        if (m) {
          word += EXPANDABLE_VARS.has(m[1]) ? (process.env[m[1]] ?? '') : `$${m[1]}`;
          i += m[1].length;
          continue;
        }
        word += ch;
        continue;
      }
      word += ch;
      continue;
    }

    // unquoted
    switch (ch) {
      case ' ':
      case '\t':
      case '\n':
        pushWord();
        break;
      case "'":
      case '"':
        quote = ch;
        break;
      case '$': {
        if (cmd[i + 1] === '(') {
          throw new CommandParseError('Command substitution $(...) is not supported');
        }
        const m = cmd.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)/);
        if (m) {
          word += EXPANDABLE_VARS.has(m[1]) ? (process.env[m[1]] ?? '') : `$${m[1]}`;
          i += m[1].length;
        } else {
          word += ch;
        }
        break;
      }
      case '`':
        throw new CommandParseError('Command substitution (backticks) is not supported');
      case '&':
        if (cmd[i + 1] === '&') { pushStage('&&'); i++; }
        else throw new CommandParseError('Background operator "&" is not supported — use background:true');
        break;
      case '|':
        if (cmd[i + 1] === '|') { pushStage('||'); i++; }
        else pushStage('|');
        break;
      case ';':
        pushStage(';');
        break;
      case '>':
      case '<':
        throw new CommandParseError(`Redirection "${ch}" is not supported — use the files tool`);
      default:
        word += ch;
    }
  }
  if (escaped) throw new CommandParseError('Trailing backslash');
  if (quote) throw new CommandParseError('Unterminated quote');
  pushWord();
  stages.push(cur);

  const out = stages.filter((s) => s.argv.length > 0);
  if (out.length === 0) throw new CommandParseError('Empty command');
  return out;
}

// ── Binary resolution: realpath + allowlist ───────────────────────
function resolveBinary(name) {
  const base = name.split('/').pop().split('\\').pop();
  if (!allowHas(base) && !UNSAFE) {
    return { error: `Command '${base}' not in allowlist`, allowed: effectiveAllowlist() };
  }
  let candidates = [];
  if (name.includes('/') || (PLATFORM === 'win32' && name.includes('\\\\'))) {
    candidates = [path.resolve(name)];
  } else {
    const dirs = platformPathEntries(PLATFORM, { PATH: cfg.path || process.env.PATH });
    for (const dir of dirs) {
      for (const candidate of executableCandidates(name, PLATFORM, process.env)) {
        candidates.push(path.join(dir, candidate));
      }
    }
  }
  for (const c of candidates) {
    if (isExecutableFile(c, PLATFORM)) {
      try { return { bin: fs.realpathSync(c), base }; } catch { /* keep looking */ }
    }
  }
  return { error: `Command not found: ${name}` };
}

// ── Spawn one stage, collect capped output, kill group on timeout ─
function runStage(stage, { stdin = null, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const base = stage.argv[0].split('/').pop().split('\\').pop();
    const builtin = PLATFORM === 'win32' && cfg.builtins?.has(base)
      ? winBuiltin(stage.argv, { cwd, allow: allowHas(base) || UNSAFE })
      : null;
    if (builtin !== null) {
      return resolve(builtin);
    }
    const r0 = resolveBinary(stage.argv[0]);
    if (r0.error) {
      return resolve({ error: r0.error, allowed: r0.allowed, stage: stage.argv[0] });
    }
    const bin = r0.bin;
    const env = {};
    for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
    env.PATH = cfg.path || env.PATH || (PLATFORM === 'win32' ? process.env.PATH || '' : '/usr/bin:/bin');

    const child = spawn(bin, stage.argv.slice(1), {
      env,
      cwd,
      detached: true,   // own process group → we can kill the whole tree
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '', stderr = '';
    let stdoutCap = false, stderrCap = false;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    const done = () => {
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
      resolve({
        exitCode: killed ? null : (child.exitCode ?? child.signalCode ?? null),
        stdout: stdout.slice(0, RESULT_STDOUT),
        stderr: stderr.slice(0, RESULT_STDERR),
        timedOut: killed,
        capHit: stdoutCap || stderrCap,
      });
    };

    child.stdout.on('data', (d) => {
      if (stdout.length < STDOUT_CAP) {
        stdout += d.toString();
        if (stdout.length > STDOUT_CAP) { stdout = stdout.slice(0, STDOUT_CAP); stdoutCap = true; }
      } else stdoutCap = true;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < STDOUT_CAP) {
        stderr += d.toString();
        if (stderr.length > STDOUT_CAP) { stderr = stderr.slice(0, STDOUT_CAP); stderrCap = true; }
      } else stderrCap = true;
    });

    if (stdin) stdin.pipe(child.stdin);
    else child.stdin.end();

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: '', stderr: '', error: err.message });
    });
    child.on('close', done);
  });
}

/** Execute a parsed pipeline with chain semantics (&& || ; |). */
async function executeStages(stages, { cwd, timeoutMs }) {
  const results = [];
  let lastExit = 0;
  let accumulated = '';  // stdout across chain segments, like a real shell
  let lastStderr = '';
  let skipUntil = null; // '&&' → skip until a failure; '||' → skip until success

  const decide = (stage) => {
    const op = stage.op;
    if (op === '&&') return lastExit === 0;
    if (op === '||') return lastExit !== 0;
    return true; // ';' and pipe groups always run
  };

  const runOne = async (stage, stdin) => {
    const r = await runStage(stage, { stdin, cwd, timeoutMs });
    results.push(r);
    if (r.error) {
      lastExit = 1;
      lastStderr = r.error;
    } else {
      lastExit = r.exitCode === 0 ? 0 : 1;
      accumulated += r.stdout;
      lastStderr = r.stderr;
    }
    return r;
  };

  // Group consecutive pipe stages into one concurrent pipeline.
  // stage.op is the operator that PRECEDES the stage, so a pipe chain is
  // a run of stages whose ops are '|'.
  let i = 0;
  while (i < stages.length) {
    const group = [stages[i]];
    while (i + 1 < stages.length && stages[i + 1].op === '|') {
      group.push(stages[i + 1]);
      i++;
    }
    const groupOp = group[0].op; // operator that precedes this group

    if (decide({ op: groupOp })) {
      if (group.length === 1) {
        const r = await runOne(group[0], null);
        if (r.error) {
          // Denied/not-found stage: report and stop the chain.
          return { results, error: r.error, allowed: r.allowed, stdout: '', stderr: r.stderr || '' };
        }
      } else {
        // Pipe: spawn concurrently, chain stdio.
        const pipes = [];
        let prevOut = null;
        for (let k = 0; k < group.length; k++) {
          const { bin } = resolveBinary(group[k].argv[0]);
          if (!bin) {
            return { results, error: `Command '${group[k].argv[0]}' not in allowlist`, allowed: [...ALLOW].sort(), stdout: '', stderr: '' };
          }
          const env = {};
          for (const key of SAFE_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
          env.PATH = cfg.path || env.PATH || (PLATFORM === 'win32' ? process.env.PATH || '' : '/usr/bin:/bin');
          const child = spawn(bin, group[k].argv.slice(1), { env, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
          if (prevOut) prevOut.pipe(child.stdin);
          else child.stdin.end();
          pipes.push(child);
          prevOut = child.stdout;
        }
        const last = pipes[pipes.length - 1];
        let out = '', errs = '', outCap = false;
        const timer = setTimeout(() => {
          for (const p of pipes) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }
        }, timeoutMs);
        last.stdout.on('data', (d) => {
          if (!outCap) {
            out += d.toString();
            if (out.length > STDOUT_CAP) { out = out.slice(0, STDOUT_CAP); outCap = true; }
          }
        });
        for (const p of pipes) {
          p.stderr.on('data', (d) => {
            errs = (errs + d.toString()).slice(0, STDOUT_CAP);
          });
        }
        const exits = await Promise.all(pipes.map((p) => new Promise((r) => p.on('close', () => r(p.exitCode ?? 1)))));
        clearTimeout(timer);
        for (const p of pipes) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }
        lastExit = exits[exits.length - 1] === 0 ? 0 : 1;
        accumulated += out.slice(0, RESULT_STDOUT);
        lastStderr = errs.slice(0, RESULT_STDERR);
      }
    }
    i += group.length;
  }

  const failed = results.find((r) => r.error);
  return {
    exitCode: lastExit,
    stdout: accumulated,
    stderr: lastStderr,
    error: failed?.error || null,
    allowed: failed?.allowed || null,
  };
}

// ── Windows in-process builtins ────────────────────────────────────
// echo/type/cd run inside the agent process instead of a shell so no user
// string ever reaches cmd.exe or PowerShell. They are still allowlist-gated.
export function winBuiltin(argv, { cwd, allow } = {}) {
  const name = argv[0];
  if (!allow) {
    return { exitCode: 1, stdout: '', stderr: `Command '${name}' not in allowlist`, error: `Command '${name}' not in allowlist`, allowed: effectiveAllowlist() };
  }
  if (name === 'echo') {
    return { exitCode: 0, stdout: argv.slice(1).join(' ') + '\n', stderr: '' };
  }
  if (name === 'cd') {
    if (argv.length > 2) return { exitCode: 1, stdout: '', stderr: 'cd takes at most one argument' };
    const target = argv[1];
    if (!target || target === '..') return { exitCode: 0, stdout: (target ? '..' : cwd || '') + '\n', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: 'cd only supports the current directory and its parent', error: 'cd argument not permitted' };
  }
  if (name === 'type') {
    try {
      // Windows path semantics even when unit-tested from POSIX.
      const wp = path.win32;
      const baseDir = wp.normalize(String(cwd || process.cwd()));
      const requested = String(argv[1] || '');
      const file = wp.isAbsolute(requested) ? wp.normalize(requested) : wp.resolve(baseDir, requested);
      const inside = file.toLowerCase() === baseDir.toLowerCase() || file.toLowerCase().startsWith(baseDir.replace(/[\\/]+$/, '') + '\\');
      if (argv.length !== 2 || !inside) {
        return { exitCode: 1, stdout: '', stderr: 'type requires a file path inside the working directory', error: 'type requires a file path inside the working directory' };
      }
      const content = fs.readFileSync(file, 'utf8').slice(0, STDOUT_CAP);
      return { exitCode: 0, stdout: content, stderr: '' };
    } catch (err) {
      return { exitCode: 1, stdout: '', stderr: err.message, error: err.message };
    }
  }
  return null;
}

// ── Security surface exports ──────────────────────────────────────
// Sibling tools (the `jobs` tool) MUST reuse exactly these primitives so
// background commands get the same protection as foreground ones: argv
// parsing (no shell string), allowlist + realpath resolution, blocked
// patterns and scrubbed env. No background path may widen the surface.
export { parseCommand, resolveBinary };
export const winBuiltins = cfg.builtins || new Set();
export const blockedPatterns = BLOCKED_PATTERNS;
export const safeEnvKeys = SAFE_ENV_KEYS;
export const platformHelpers = { platformPathEntries, executableCandidates, isExecutableFile };
export const shellCfg = cfg;
export const allowSet = ALLOW;
export const unsafeMode = UNSAFE;

// ── Tool definition ───────────────────────────────────────────────
export const shell = {
  name: 'shell',
  description: `Execute a shell command (${PLATFORM}; argv-based, allowlisted by default; max 15s timeout; background:true for GUI/long-running processes)`,
  args: { cmd: 'string — the command to run', background: 'bool — optional, detach and return immediately (for GUI apps, servers, tkinter windows)' },
  platform: PLATFORM,

  async run(args) {
    let cmd = String(args.cmd || '').trim();
    if (!cmd) return { error: 'Empty command' };
    if (cmd.length > MAX_CMD_LEN) return { error: `Command too long (max ${MAX_CMD_LEN} chars)` };

    // Defence-in-depth pattern block (primary control = allowlist + argv).
    for (const pat of BLOCKED_PATTERNS) {
      if (pat.test(cmd)) {
        return { error: 'Command blocked for security', cmd };
      }
    }

    let stages;
    try {
      stages = parseCommand(cmd);
    } catch (err) {
      return { error: err.message };
    }

    // Windows intentionally follows the exact argv path below. In particular,
    // do not pass a user-controlled string to PowerShell -Command: that would
    // reintroduce substitutions, redirects, and pipe semantics outside the
    // parser/policy. Shell built-ins are therefore unsupported; use an allowed
    // executable (for example `cmd.exe` is not implicitly trusted either).

    // Background mode: GUI apps / long-running processes (e.g. tkinter
    // windows) must not block the task or die with the 15s timeout.
    if (args.background) {
      const first = stages[0];
      const resolved = resolveBinary(first.argv[0]);
      if (resolved.error) return { error: resolved.error, allowed: resolved.allowed };
      const logFile = path.join(os.homedir(), '.remote-agent', `bg-${Date.now()}.log`);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const out = fs.openSync(logFile, 'a');
      const env = {};
      for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
      env.PATH = cfg.path || env.PATH || (PLATFORM === 'win32' ? process.env.PATH || '' : '/usr/bin:/bin');
      const child = spawn(resolved.bin, first.argv.slice(1), {
        detached: true,
        stdio: ['ignore', out, out],
        env,
      });
      child.unref();
      fs.closeSync(out);
      return {
        exitCode: null,
        pid: child.pid,
        background: true,
        log: logFile,
        note: 'Process started in background and detached from the agent. Output: ' + logFile,
        policy: UNSAFE ? 'unrestricted' : 'allowlist',
        platform: PLATFORM,
      };
    }

    const cwd = args.cwd ? path.resolve(String(args.cwd)) : undefined;
    const result = await executeStages(stages, { cwd, timeoutMs: TIMEOUT_MS });

    if (result.error) {
      return { error: result.error, allowed: result.allowed, platform: PLATFORM };
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      timedOut: result.timedOut || false,
      truncated: result.capHit || false,
      policy: UNSAFE ? 'unrestricted' : 'allowlist',
      platform: PLATFORM,
    };
  },
};
