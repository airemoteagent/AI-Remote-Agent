// Workspace links — bind a workspace to a REAL directory on this device.
//
// WHY THIS EXISTS
// Without links, every workspace lives under <BASE>/.workspaces/<id>, so the
// files people actually work on (a project in ~/Projects, a repo checkout)
// could never be a workspace. A link makes an existing local directory THE
// workspace root, which is what "workspace with local directory sync" means.
//
// SECURITY MODEL (this is the important part)
//   - The link registry is written ONLY by a local action on this device
//     (the remote-agent CLI). The cloud can never create, change or read it,
//     so the control plane can never point an agent at an arbitrary path.
//     Local device policy stays authoritative; the cloud never widens it.
//   - Guarded targets: the filesystem root, the bare home directory, and the
//     agent's own state directory (or any ancestor of it, which would expose
//     credentials and the audit log) can never be linked.
//   - Unlinking removes the MAPPING only. It never deletes a single file.
//   - The file is written 0600 and every read is crash-proof: a missing or
//     corrupt registry degrades to "no links", never to a throw.

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

/** Agent state directory (credentials, audit log, index shards). */
export const STATE_DIR = process.env.REMOTE_AGENT_HOME || path.join(homedir(), '.remote-agent');
/** Managed workspace base (the non-linked workspaces live under here). */
const MANAGED_BASE = process.env.REMOTE_WORKSPACE || path.join(STATE_DIR, 'workspace');
/** Registry file. */
export const LINKS_FILE = process.env.REMOTE_WORKSPACE_LINKS || path.join(STATE_DIR, 'workspace-links.json');

const VALID_MODES = new Set(['read_write', 'read_only']);

/** Resolve through symlinks when possible (macOS /var -> /private/var), so the
 *  guard below compares the SAME physical path the walker would use. */
function realOrResolve(p) {
  const abs = path.resolve(String(p || ''));
  try { return fs.realpathSync(abs); } catch { return abs; }
}

function isInside(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

/** Read the registry. Never throws; unknown shapes degrade to empty. */
export function readLinks() {
  try {
    const raw = fs.readFileSync(LINKS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.links && typeof parsed.links === 'object') {
      return parsed.links;
    }
  } catch { /* missing or corrupt -> no links */ }
  return {};
}

function writeLinks(links) {
  fs.mkdirSync(path.dirname(LINKS_FILE), { recursive: true });
  const tmp = LINKS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, links }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, LINKS_FILE); // atomic replace, never a half-written registry
}

/**
 * Validate a candidate directory for linking.
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
export function validateLinkTarget(dir) {
  const raw = String(dir || '').trim();
  if (!raw) return { ok: false, error: 'A directory path is required' };
  let resolved = path.resolve(raw.startsWith('~') ? path.join(homedir(), raw.slice(1)) : raw);
  try { resolved = fs.realpathSync(resolved); } catch { return { ok: false, error: 'Directory not found: ' + resolved }; }
  let st;
  try { st = fs.statSync(resolved); } catch { return { ok: false, error: 'Directory not found: ' + resolved }; }
  if (!st.isDirectory()) return { ok: false, error: 'Not a directory: ' + resolved };
  if (resolved === path.parse(resolved).root) return { ok: false, error: 'Refusing to link the filesystem root' };
  if (resolved === path.resolve(homedir())) return { ok: false, error: 'Refusing to link the bare home directory — pick a project folder' };
  // The agent's own state dir holds credentials and the audit chain. Neither
  // it, nor anything containing it, may become an agent-writable workspace.
  const stateDir = realOrResolve(STATE_DIR);
  const managedBase = realOrResolve(MANAGED_BASE);
  if (isInside(stateDir, resolved) && !isInside(resolved, managedBase)) {
    return { ok: false, error: 'Refusing to link a directory that contains the agent state directory (' + stateDir + ')' };
  }
  if (isInside(resolved, stateDir) && !isInside(resolved, managedBase)) {
    return { ok: false, error: 'Refusing to link inside the agent state directory (' + stateDir + ')' };
  }
  return { ok: true, path: resolved };
}

/**
 * Link a workspace id to a local directory (local action only).
 * @param {{workspaceId: string, dir: string, name?: string, mode?: string}} opts
 */
export function linkWorkspace({ workspaceId, dir, name = '', mode = 'read_write' }) {
  const id = String(workspaceId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) throw new Error('workspaceId is required');
  const check = validateLinkTarget(dir);
  if (!check.ok) throw new Error(check.error);
  const links = readLinks();
  const existing = links[id] || {};
  links[id] = {
    path: check.path,
    name: String(name || existing.name || path.basename(check.path)),
    mode: VALID_MODES.has(mode) ? mode : 'read_write',
    addedAt: existing.addedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeLinks(links);
  return { workspaceId: id, ...links[id] };
}

/** Remove a link. Files are NEVER touched — only the mapping disappears. */
export function unlinkWorkspace(workspaceId) {
  const id = String(workspaceId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const links = readLinks();
  if (!links[id]) return false;
  delete links[id];
  writeLinks(links);
  return true;
}

/** Absolute linked root for a workspace id, or '' when it is not linked. */
export function resolveLinkedRoot(workspaceId) {
  const id = String(workspaceId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) return '';
  const entry = readLinks()[id];
  if (!entry || typeof entry.path !== 'string') return '';
  // Re-validate on every resolve: a link whose target vanished must not
  // silently resolve to a path the agent could then create.
  try { if (!fs.statSync(entry.path).isDirectory()) return ''; } catch { return ''; }
  return entry.path;
}

/** All links as a sorted array. */
export function listLinks() {
  const links = readLinks();
  return Object.keys(links).sort().map((id) => ({ workspaceId: id, ...links[id] }));
}
