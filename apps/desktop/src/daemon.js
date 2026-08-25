// Daemon — run the agent as a background service, OpenClaw-style.
//
//   macOS:  LaunchAgent  ~/Library/LaunchAgents/com.remoteagent.agent.plist
//   Linux:  systemd user unit  ~/.config/systemd/user/remote-agent.service
//
// `remote-agent daemon install` writes the unit, (re)loads it, and starts it.
// `remote-agent daemon uninstall` stops + removes it.
// `remote-agent daemon status` reports service + single-instance state.
//
// Single-instance guard: a PID file (~/.remote-agent/daemon.pid) prevents two
// daemons racing for the same control-plane connection. `start` refuses to
// run twice (unless --force is given, e.g. after a crash with a stale PID).

import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { PATHS } from './config.js';
import { runtimeSupport } from './platform.js';
import { windowsServiceInstall, windowsServiceUninstall, windowsServiceStatus, windowsServiceStop } from './windows-service.js';

export const PID_FILE = join(PATHS.dir, 'daemon.pid');

const LAUNCHD_LABEL = 'com.remoteagent.agent';
const LAUNCHD_PATH  = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_PATH  = join(homedir(), '.config', 'systemd', 'user', 'remote-agent.service');

function agentBin() {
  // The `remote-agent` shim on PATH; fall back to the repo bin.
  return process.env.REMOTE_AGENT_BIN || 'remote-agent';
}

// ── launchd (macOS) ──────────────────────────────────────────────
function launchdPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-lc</string>
        <string>exec ${agentBin()} start --force</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${PATHS.dir}/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>${PATHS.dir}/daemon.log</string>
</dict>
</plist>
`;
}

function launchdInstalled() {
  return existsSync(LAUNCHD_PATH);
}

function launchdInstall() {
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(LAUNCHD_PATH, launchdPlist(), { mode: 0o644 });
  spawnSync('launchctl', ['unload', LAUNCHD_PATH], { stdio: 'ignore' });
  const r = spawnSync('launchctl', ['load', LAUNCHD_PATH], { encoding: 'utf8' });
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') };
}

function launchdUninstall() {
  spawnSync('launchctl', ['unload', LAUNCHD_PATH], { stdio: 'ignore' });
  try { if (existsSync(LAUNCHD_PATH)) unlinkSync(LAUNCHD_PATH); } catch { /* best effort */ }
}

function launchdStatus() {
  const r = spawnSync('launchctl', ['print', `gui/${process.getuid?.() ?? process.env.UID ?? '501'}/${LAUNCHD_LABEL}`], { encoding: 'utf8' });
  const loaded = r.status === 0;
  let running = false;
  if (loaded) {
    running = /state = running/.test(r.stdout || '') || /pid = \d+/.test(r.stdout || '');
  }
  return { installed: launchdInstalled(), loaded, running };
}

// ── systemd (Linux) ──────────────────────────────────────────────
function systemdUnit() {
  return `[Unit]
Description=remote-agent — cloud-brained AI agent for this device
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${agentBin()} start --force
Restart=on-failure
RestartSec=10
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.remote-agent
MemoryMax=1G

[Install]
WantedBy=default.target
`;
}

function systemdInstalled() {
  return existsSync(SYSTEMD_PATH);
}

function systemdInstall() {
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(SYSTEMD_PATH, systemdUnit(), { mode: 0o644 });
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  const r = spawnSync('systemctl', ['--user', 'enable', '--now', 'remote-agent.service'], { encoding: 'utf8' });
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') };
}

function systemdUninstall() {
  spawnSync('systemctl', ['--user', 'disable', '--now', 'remote-agent.service'], { stdio: 'ignore' });
  try { if (existsSync(SYSTEMD_PATH)) unlinkSync(SYSTEMD_PATH); } catch { /* best effort */ }
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
}

function systemdStatus() {
  const r = spawnSync('systemctl', ['--user', 'is-active', 'remote-agent.service'], { encoding: 'utf8' });
  return {
    installed: systemdInstalled(),
    loaded: r.status === 0 || (r.stdout || '').trim() !== 'inactive',
    running: (r.stdout || '').trim() === 'active',
  };
}

// ── Public API ───────────────────────────────────────────────────
export function isMac() { return platform() === 'darwin'; }
export function isWindows() { return platform() === 'win32'; }

function windowsStatus() {
  return windowsServiceStatus();
}

export function daemonStatus() {
  const st = isWindows() ? windowsStatus() : (isMac() ? launchdStatus() : systemdStatus());
  const pid = readPid();
  return {
    platform: platform(),
    serviceInstalled: st.installed,
    serviceLoaded: st.loaded,
    serviceRunning: st.running,
    serviceSupported: st.supported !== false,
    serviceReason: st.reason || null,
    runtimeSupport: runtimeSupport(),
    pid: pid?.pid ?? null,
    pidAlive: pid ? pidAlive(pid.pid) : false,
  };
}

export function daemonInstall() {
  if (isWindows()) return windowsServiceInstall();
  return isMac() ? launchdInstall() : systemdInstall();
}

export function daemonUninstall() {
  if (isWindows()) { const result = windowsServiceUninstall(); clearPid(); return result; }
  if (isMac()) launchdUninstall(); else systemdUninstall();
  clearPid();
}

// ── Single-instance guard (PID file) ─────────────────────────────
export function writePid() {
  mkdirSync(PATHS.dir, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }), { mode: 0o600 });
}

export function clearPid() {
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch { /* best effort */ }
}

export function readPid() {
  try {
    if (!existsSync(PID_FILE)) return null;
    return JSON.parse(readFileSync(PID_FILE, 'utf8'));
  } catch { return null; }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

/**
 * Guard: return true when another daemon instance is already running.
 * A stale PID file (process no longer alive) is cleaned up automatically.
 */
export function alreadyRunning() {
  const pid = readPid();
  if (!pid) return false;
  if (pidAlive(pid.pid)) return true;
  clearPid();
  return false;
}

/** Kill the running daemon (used by `daemon uninstall` + `stop`). */
export function stopRunningDaemon() {
  if (isWindows()) return windowsServiceStop();
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid.pid, 'SIGTERM');
    return true;
  } catch { return false; }
}

// Re-export paths so the CLI can print them.
export const DAEMON_PATHS = Object.freeze({
  launchd: LAUNCHD_PATH,
  systemd: SYSTEMD_PATH,
  pid: PID_FILE,
  log: join(PATHS.dir, 'daemon.log'),
});
