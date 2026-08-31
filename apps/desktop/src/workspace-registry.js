// Workspace registry — canonical mapping from a cloud workspace id to a
// local device root. This is the single source of truth used by BOTH the
// typed workspace-ops channel and the agent task loop, so an agent bound to a
// workspace and the dashboard file browser always touch the SAME folder.
//
// Invariants (preserve these):
//   - Every workspace_id maps to <BASE>/.workspaces/<workspace_id>. The folder
//     name IS the canonical id, so device-created and cloud-created workspaces
//     converge on the same path without a separate id registry.
//   - UNLESS the device owner linked that id to a real local directory (see
//     workspace-links.js). A link is created only by a local CLI action, never
//     by the cloud, and it wins over the managed path so people can work on
//     their actual project folders.
//   - A legacy root_label of "current"/"default" maps to BASE itself (the
//     daemon's unscoped home). New workspaces never use this; it only keeps
//     older bindings working.
//   - No path ever escapes BASE: the id is sanitized to [A-Za-z0-9_-].
//   - Everything is crash-proof and read-only: missing dirs degrade to empty.

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolveLinkedRoot, listLinks } from './workspace-links.js';
import { isIgnoredDir } from './workspace-map.js';

export const BASE = process.env.REMOTE_WORKSPACE || path.join(homedir(), '.remote-agent', 'workspace');

const MAX_SCAN_FILES = 5000; // bound the discovery walk so it never hangs

/** Canonicalize a workspace id to a safe folder name. Never throws. */
export function sanitizeWorkspaceId(id) {
  return String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Resolve the absolute local root for a workspace.
 * @param {string} workspaceId cloud workspace id
 * @param {string} [rootLabel] binding root label (legacy "current"/"default" escape hatch)
 */
export function resolveWorkspaceRoot(workspaceId, rootLabel = '') {
  const id = sanitizeWorkspaceId(workspaceId);
  if (!id) return BASE;
  // A device-owner link to a real local directory always wins: that folder IS
  // the workspace. Links are local-only, so this cannot widen device policy.
  const linked = resolveLinkedRoot(id);
  if (linked) return linked;
  const label = String(rootLabel || '').toLowerCase();
  if (label.includes('current') || label.includes('default')) return BASE;
  return path.join(BASE, '.workspaces', id);
}

/** The on-disk folder name for a workspace root (its canonical id). */
export function workspaceFolderName(workspaceId) {
  return sanitizeWorkspaceId(workspaceId);
}

/**
 * Stable, device-scoped identity hash for a workspace root. This is what the
 * cloud records as local_identity_hash so a binding is provably to THIS device
 * and THIS folder — not just a matching name. An optional REMOTE_IDENTITY_SALT
 * (per-device secret) makes the hash unforgeable by name alone.
 */
export function workspaceIdentityHash(deviceId, root) {
  const salt = String(process.env.REMOTE_IDENTITY_SALT || '');
  return createHash('sha256')
    .update(String(deviceId || '') + '|' + path.resolve(String(root || '')) + '|' + salt)
    .digest('hex');
}

/**
 * Bounded recursive count + byte sum for a directory. Crash-proof.
 *
 * Dependency, VCS and build directories are skipped: a linked project folder
 * can hold 100k node_modules files, and walking them every sync round would be
 * slow and would report a file count that has nothing to do with the work.
 * The reported numbers describe the files a workspace actually works on.
 */
export function scanDir(dir, cap = MAX_SCAN_FILES) {
  let count = 0;
  let bytes = 0;
  let truncated = false;
  const stack = [dir];
  try {
    while (stack.length && !truncated) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (count >= cap) { truncated = true; break; }
        const full = path.join(cur, e.name);
        if (e.isDirectory()) {
          if (!isIgnoredDir(e.name)) stack.push(full);
        } else if (e.isFile()) {
          count++;
          try { bytes += fs.statSync(full).size; } catch { /* unreadable */ }
        }
      }
    }
  } catch { /* unreadable root */ }
  return { count, bytes, truncated };
}

/**
 * Discover local workspace roots: each subfolder of <BASE>/.workspaces/<id>
 * whose name is a canonical id is a local workspace. Used by the device to
 * report its workspaces to the cloud (sync) without any cloud round-trip.
 */
export function discoverLocalWorkspaces(baseDir = BASE) {
  const wsDir = path.join(baseDir, '.workspaces');
  const out = [];
  const seen = new Set();

  // Linked workspaces first: a real local directory the owner bound to an id.
  for (const link of listLinks()) {
    let ok = false;
    try { ok = fs.statSync(link.path).isDirectory(); } catch { ok = false; }
    if (!ok) continue; // a vanished target is reported as nothing, never invented
    const scan = scanDir(link.path);
    seen.add(link.workspaceId);
    out.push({
      workspaceId: link.workspaceId,
      root: link.path,
      rootLabel: link.name || link.workspaceId,
      fileCount: scan.count,
      bytes: scan.bytes,
      truncated: scan.truncated,
      linked: true,
      accessMode: link.mode || 'read_write',
    });
  }

  let entries;
  try { entries = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const id = sanitizeWorkspaceId(e.name);
    if (!id || id !== e.name) continue; // only canonical ids
    if (seen.has(id)) continue;         // a link already reported this id
    const root = path.join(wsDir, e.name);
    const scan = scanDir(root);
    out.push({
      workspaceId: id,
      root,
      rootLabel: id,
      fileCount: scan.count,
      bytes: scan.bytes,
      truncated: scan.truncated,
      linked: false,
    });
  }
  out.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
  return out;
}

/** Resolve the vector store path for a workspace (separate index shard per
 *  workspace). The global store honours REMOTE_VECTOR_STORE; per-workspace
 *  shards are siblings named vector-index-<id>.json. */
export function workspaceVectorStorePath(workspaceId) {
  const global = process.env.REMOTE_VECTOR_STORE || path.join(homedir(), '.remote-agent', 'vector-index.json');
  const id = sanitizeWorkspaceId(workspaceId);
  if (!id) return global;
  return path.join(path.dirname(global), 'vector-index-' + id + path.extname(global));
}
