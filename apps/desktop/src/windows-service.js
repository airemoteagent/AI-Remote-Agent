import { spawnSync } from 'node:child_process';
import { dirname, join, isAbsolute, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WINDOWS_SERVICE = Object.freeze({ name: 'RemoteAgent', displayName: 'Remote Agent', description: 'Policy-governed Remote AI execution agent' });
const ROOT = dirname(fileURLToPath(import.meta.url));

/** Windows-absolute regardless of the host platform (unit-testable on POSIX). */
function isWindowsAbsolute(p) {
  return win32.isAbsolute(String(p)) && !isAbsolute(String(p));
}

// Allowed service identities. A credential prompt is intentionally NOT
// supported here: passwords must never travel through a command line. The
// script itself refuses every other account value.
export const WINDOWS_SERVICE_ACCOUNTS = Object.freeze(['LocalSystem', 'NT AUTHORITY\\LocalService', 'NT AUTHORITY\\NetworkService']);

export function serviceScriptPath() { return join(ROOT, 'windows-service.ps1'); }
export function serviceBinaryPath({ nodePath = process.execPath, entrypoint = join(ROOT, '..', 'bin', 'remote-agent.js') } = {}) {
  const valid = (p) => isAbsolute(p) || isWindowsAbsolute(p);
  if (!valid(nodePath) || !valid(entrypoint)) throw new Error('Windows service paths must be absolute');
  return `\"${nodePath}\" \"${entrypoint}\" start --force`;
}

function validateAccount(account) {
  if (!account) return 'LocalSystem';
  if (WINDOWS_SERVICE_ACCOUNTS.includes(account) || /^[.\w-]+\\([\w .-]+)$/.test(account)) return account;
  throw new Error(`Unsupported service account '${account}' — use LocalSystem or a named DOMAIN\\User account`);
}

/** Pure: build the PowerShell argument vector for an action. Testable everywhere. */
export function buildServiceArgs(action, { scriptPath = serviceScriptPath(), nodePath, entrypoint, cwd = process.cwd(), serviceAccount = 'LocalSystem' } = {}) {
  const binaryPath = serviceBinaryPath({ nodePath, entrypoint });
  const account = validateAccount(serviceAccount);
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', scriptPath, '-Action', action, '-ServiceName', WINDOWS_SERVICE.name, '-DisplayName', WINDOWS_SERVICE.displayName, '-Description', WINDOWS_SERVICE.description, '-BinaryPath', binaryPath, '-WorkingDirectory', cwd, '-ServiceAccount', account];
}

/** Pure: parse the final JSON line of the service script output. Testable everywhere. */
export function parseServiceOutput(stdout, status) {
  let data = null;
  try { data = JSON.parse(String(stdout || '').trim().split(/\r?\n/).at(-1)); } catch {}
  return { data, ok: status === 0 && data?.ok !== false, code: status, error: status === 0 ? null : 'Windows service operation failed' };
}

function invoke(action, { runner = spawnSync, ...options } = {}) {
  if (process.platform !== 'win32') return { ok: false, supported: false, action, error: 'Windows Service Control Manager is available only on Windows' };
  const args = buildServiceArgs(action, options);
  const result = runner('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, REMOTE_SERVICE: 'windows-scm' } });
  const parsed = parseServiceOutput(result.stdout, result.status);
  return { ok: parsed.ok, supported: true, action, code: parsed.code, state: parsed.data?.state, installed: parsed.data?.installed, running: parsed.data?.running, serviceAccount: parsed.data?.serviceAccount || options.serviceAccount || 'LocalSystem', output: parsed.data, error: parsed.error };
}
export function invokeWindowsService(action, options) { return invoke(action, options); }
export function installWindowsService(options) { return invoke('install', options); }
export const windowsServiceInstall = installWindowsService;
export function uninstallWindowsService(options) { return invoke('uninstall', options); }
export const windowsServiceUninstall = uninstallWindowsService;
export function startWindowsService(options) { return invoke('start', options); }
export function stopWindowsService(options) { return invoke('stop', options); }
export const windowsServiceStop = stopWindowsService;
export function statusWindowsService(options) { return invoke('status', options); }
export const windowsServiceStatus = statusWindowsService;
