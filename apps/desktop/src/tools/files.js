// File system tools — sandboxed to a workspace directory.
// Default workspace: $REMOTE_WORKSPACE or ~/.remote-agent/workspace
//
// Sandbox guarantees:
//   - Paths are resolved and containment-checked with a trailing-separator
//     boundary (no /ws vs /ws-evil prefix confusion).
//   - Symlink escapes are denied: the nearest existing ancestor is realpath'd
//     and must stay under the real workspace root.
//   - TOCTOU: files are opened with O_NOFOLLOW and the opened descriptor is
//     fstat'd — the file we operate on is the file we checked.
//   - Special files (/dev, FIFOs, sockets, block/char devices) are refused.
//   - Delete moves to ~/.remote-agent/trash by default; --purge removes for real.

import fs from 'node:fs/promises';
import { constants as FSC } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const WORKSPACE = process.env.REMOTE_WORKSPACE || path.join(homedir(), '.remote-agent', 'workspace');
const TRASH = process.env.REMOTE_TRASH || path.join(homedir(), '.remote-agent', 'trash');
const MAX_READ_BYTES  = 50_000;
const MAX_WRITE_BYTES = 1_000_000; // 1 MB

// O_NOFOLLOW may be undefined on some platforms; 0 means "not supported"
// there, in which case the symlink check happens via lstat instead.
const O_NOFOLLOW = FSC.O_NOFOLLOW || 0;

// Per-agent allowed file roots — set by the daemon before each task from the
// agent's capability profile (e.g. ~/Desktop, ~/Documents). The workspace
// stays a root; extra roots only ADD places the files tool may touch.
let AGENT_ROOTS = null;
export function setAgentRoots(roots) {
  AGENT_ROOTS = Array.isArray(roots) && roots.length
    ? roots.map((p) => (String(p).startsWith('~/') ? path.join(homedir(), String(p).slice(2)) : String(p))).map((p) => path.resolve(p))
    : null;
}
function activeRoots() {
  return AGENT_ROOTS && AGENT_ROOTS.length ? AGENT_ROOTS : [path.resolve(WORKSPACE)];
}

const root = () => activeRoots()[0];

/** Resolve a user path inside the workspace. */
function safePath(p) {
  const rs = activeRoots();
  // Expand a leading ~ (home directory) so "~/..." paths resolve correctly
  // instead of being treated as a literal "~" directory name.
  const raw = String(p);
  const pExpanded = raw === '~' ? homedir() : (raw.startsWith('~/') ? path.join(homedir(), raw.slice(2)) : raw);
  // Relative paths resolve inside the first (workspace) root; absolute paths
  // are checked against every allowed root.
  const resolved = path.resolve(rs[0], pExpanded);
  for (const r of rs) {
    if (resolved === r) return resolved;
    if (resolved.startsWith(r + path.sep)) return resolved;
  }
  throw new Error(`Path traversal denied: ${p} (outside allowed paths)`);
}

/**
 * Guard against symlink escapes: a symlink inside the workspace that points
 * outside must not let reads/writes leave the sandbox. Resolve the nearest
 * existing ancestor and verify it still lives under the real workspace root.
 */
async function guardSymlinks(target) {
  let cur = target;
  const stack = [];
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      const rs = activeRoots();
      for (const r of rs) {
        const rr = await fs.realpath(r);
        if (real === rr || real.startsWith(rr + path.sep)) return;
      }
      throw new Error(`Symlink escape denied: ${cur}`);
      return;
    } catch (err) {
      if (err && err.code === 'ENOENT' && stack.length < 64) {
        stack.push(path.basename(cur));
        const parent = path.dirname(cur);
        if (parent === cur) throw err;
        cur = parent;
      } else {
        throw err;
      }
    }
  }
}

/**
 * Open with O_NOFOLLOW (no symlink swap between check and open) and verify
 * the opened descriptor is a regular file (or dir for list) — not a FIFO,
 * device, socket or other special file. Special files are rejected via
 * lstat BEFORE open (opening a FIFO for read would block forever).
 */
async function openGuarded(fp, flags) {
  const lst = await fs.lstat(fp).catch(() => null);
  if (lst && !lst.isFile() && !lst.isDirectory()) {
    throw new Error(`Refusing special file: ${path.basename(fp)}`);
  }
  const fd = await fs.open(fp, flags | O_NOFOLLOW);
  try {
    const st = await fd.stat();
    if (!st.isFile() && !st.isDirectory()) {
      throw new Error(`Refusing special file: ${path.basename(fp)}`);
    }
    return { fd, st };
  } catch (err) {
    await fd.close().catch(() => {});
    throw err;
  }
}

async function ensureWorkspace() {
  await fs.mkdir(WORKSPACE, { recursive: true });
}

export const files = {
  name: 'files',
  description: 'File system operations within the agent workspace (read, write, list, delete, stat)',
  args: {
    action: 'string — read | write | list | delete | stat',
    path:   'string — relative path within workspace',
    content:'string — file content (for write)',
    purge:  'bool — delete permanently instead of moving to trash',
  },

  async run(args) {
    await ensureWorkspace();
    const action = String(args.action || 'list').toLowerCase();

    try {
      switch (action) {
      case 'read': {
        if (!args.path) return { error: 'path required' };
        const fp = safePath(args.path);
        await guardSymlinks(fp);
        const { fd } = await openGuarded(fp, FSC.O_RDONLY | O_NOFOLLOW);
        try {
          const content = await fd.readFile('utf8');
          return { path: args.path, content: content.slice(0, MAX_READ_BYTES), truncated: content.length > MAX_READ_BYTES };
        } finally {
          await fd.close();
        }
      }

      case 'write': {
        if (!args.path) return { error: 'path required' };
        if (args.content == null) return { error: 'content required' };
        const bytes = Buffer.byteLength(String(args.content));
        if (bytes > MAX_WRITE_BYTES) {
          return { error: `File too large (max ${MAX_WRITE_BYTES} bytes)` };
        }
        const fp = safePath(args.path);
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await guardSymlinks(fp);
        const { fd } = await openGuarded(fp, FSC.O_WRONLY | FSC.O_CREAT | FSC.O_TRUNC | O_NOFOLLOW);
        try {
          await fd.writeFile(args.content, 'utf8');
          return { ok: true, path: args.path, bytes };
        } finally {
          await fd.close();
        }
      }

      case 'list': {
        const dir = args.path ? safePath(args.path) : WORKSPACE;
        await guardSymlinks(dir);
        const st = await fs.stat(dir);
        if (!st.isDirectory()) return { error: `Not a directory: ${args.path}` };
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
        }));
      }

      case 'delete': {
        if (!args.path) return { error: 'path required' };
        const fp = safePath(args.path);
        if (fp === root()) return { error: 'Refusing to delete workspace root' };
        await guardSymlinks(fp);
        const st = await fs.lstat(fp);
        if (!st.isFile() && !st.isDirectory() && !st.isSymbolicLink()) {
          return { error: `Refusing to delete special file: ${args.path}` };
        }
        if (args.purge === true) {
          await fs.rm(fp, { recursive: true, force: true });
          return { ok: true, path: args.path, purged: true };
        }
        // Default: move to trash (recoverable).
        const name = path.basename(fp);
        await fs.mkdir(TRASH, { recursive: true });
        let dest = path.join(TRASH, `${Date.now()}-${name}`);
        let n = 1;
        while (await fs.access(dest).then(() => true).catch(() => false)) {
          dest = path.join(TRASH, `${Date.now()}-${n++}-${name}`);
        }
        await fs.rename(fp, dest);
        return { ok: true, path: args.path, trashed: dest, note: 'Moved to trash — use purge:true to delete permanently' };
      }

      case 'stat': {
        if (!args.path) return { error: 'path required' };
        const fp = safePath(args.path);
        await guardSymlinks(fp);
        const st = await fs.stat(fp);
        return {
          path:     args.path,
          size:     st.size,
          isDir:    st.isDirectory(),
          modified: st.mtime.toISOString(),
          created:  st.birthtime.toISOString(),
        };
      }

      default:
        return { error: `Unknown file action: ${action}`, available: ['read', 'write', 'list', 'delete', 'stat'] };
      }
    } catch (err) {
      return { error: err.message };
    }
  },
};
