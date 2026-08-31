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
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

const WORKSPACE = process.env.REMOTE_WORKSPACE || path.join(homedir(), '.remote-agent', 'workspace');
const TRASH = process.env.REMOTE_TRASH || path.join(homedir(), '.remote-agent', 'trash');
const MAX_READ_BYTES  = 50_000;
const MAX_WRITE_BYTES = 1_000_000; // 1 MB

// O_NOFOLLOW may be undefined on some platforms; 0 means "not supported"
// there, in which case the symlink check happens via lstat instead.
const O_NOFOLLOW = FSC.O_NOFOLLOW || 0;

// Per-agent allowed file roots. AsyncLocalStorage keeps concurrent requests
// isolated while setAgentRoots() remains source-compatible with the daemon.
const ROOT_CONTEXT = new AsyncLocalStorage();
let LEGACY_ROOTS = null;
function normalizeRoots(roots) {
  return Array.isArray(roots) && roots.length
    ? Object.freeze(roots.map((p) => (String(p).startsWith('~/') ? path.join(homedir(), String(p).slice(2)) : String(p))).map((p) => path.resolve(p)))
    : null;
}
export function setAgentRoots(roots) {
  const normalized = normalizeRoots(roots);
  const store = ROOT_CONTEXT.getStore();
  if (store) store.roots = normalized;
  else LEGACY_ROOTS = normalized;
}
export function runWithAgentRoots(roots, fn) {
  if (typeof fn !== 'function') throw new TypeError('fn must be a function');
  return ROOT_CONTEXT.run({ roots: normalizeRoots(roots) }, fn);
}
function activeRoots() {
  const contextual = ROOT_CONTEXT.getStore();
  const roots = contextual ? contextual.roots : LEGACY_ROOTS;
  return roots && roots.length ? roots : [path.resolve(WORKSPACE)];
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
  await fs.mkdir(root(), { recursive: true });
}

async function sha256File(fp) {
  const { fd, st } = await openGuarded(fp, FSC.O_RDONLY | O_NOFOLLOW);
  try {
    if (!st.isFile()) return '';
    const data = await fd.readFile();
    return createHash('sha256').update(data).digest('hex');
  } finally { await fd.close(); }
}

function relativePath(fp) {
  return path.relative(root(), fp).split(path.sep).join('/');
}

export const files = {
  name: 'files',
  description: 'Secure workspace operations: read, write, tree, search, diff, rename, copy, trash/restore and metadata',
  args: {
    action: 'string — read | write | list | tree | search | diff | mkdir | rename | copy | delete | restore | stat',
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
          const raw = await fd.readFile();
          const offset = Math.max(0, Number(args.offset) || 0);
          const limit = Math.min(MAX_READ_BYTES, Math.max(1, Number(args.limit) || MAX_READ_BYTES));
          const part = raw.subarray(offset, offset + limit);
          const binary = args.encoding === 'base64' || raw.subarray(0, Math.min(raw.length, 8000)).includes(0);
          const hash = createHash('sha256').update(raw).digest('hex');
          return { path: args.path, content: binary ? part.toString('base64') : part.toString('utf8'), encoding: binary ? 'base64' : 'utf8', offset, bytes: part.length, size: raw.length, hash, etag: hash, truncated: offset + part.length < raw.length };
        } finally {
          await fd.close();
        }
      }

      case 'write': {
        if (!args.path) return { error: 'path required' };
        if (args.content == null) return { error: 'content required' };
        // Binary uploads arrive base64-encoded; text is UTF-8. The hash is
        // computed over the decoded bytes so it matches a later read.
        const isB64 = args.encoding === 'base64';
        const buf = isB64 ? Buffer.from(String(args.content), 'base64') : Buffer.from(String(args.content), 'utf8');
        const bytes = buf.length;
        if (bytes > MAX_WRITE_BYTES) {
          return { error: `File too large (max ${MAX_WRITE_BYTES} bytes)` };
        }
        const fp = safePath(args.path);
        if (args.expectedHash) {
          const exists = await fs.access(fp).then(() => true).catch(() => false);
          const current = exists ? await sha256File(fp) : '';
          if (String(args.expectedHash).toLowerCase() !== current) return { error: 'File changed since it was opened', code: 'hash_conflict', conflict: true, expectedHash: String(args.expectedHash), currentHash: current };
        }
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await guardSymlinks(fp);
        const { fd } = await openGuarded(fp, FSC.O_WRONLY | FSC.O_CREAT | FSC.O_TRUNC | O_NOFOLLOW);
        try {
          await fd.writeFile(buf);
          const hash = createHash('sha256').update(buf).digest('hex');
          return { ok: true, path: args.path, bytes, size: bytes, hash, etag: hash };
        } finally {
          await fd.close();
        }
      }

      case 'list': {
        const dir = args.path ? safePath(args.path) : root();
        await guardSymlinks(dir);
        const st = await fs.stat(dir);
        if (!st.isDirectory()) return { error: `Not a directory: ${args.path}` };
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
        }));
      }

      case 'tree': {
        const dir = args.path ? safePath(args.path) : root();
        await guardSymlinks(dir);
        const limit = Math.min(500, Math.max(1, Number(args.limit) || 200));
        const cursor = Math.max(0, Number(args.cursor) || 0);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
        const page = entries.slice(cursor, cursor + limit);
        const items = [];
        for (const entry of page) {
          if (entry.isSymbolicLink()) continue;
          const fp = path.join(dir, entry.name);
          const st = await fs.stat(fp);
          items.push({ name: entry.name, path: relativePath(fp), type: entry.isDirectory() ? 'dir' : 'file', size: st.size, modified: st.mtime.toISOString() });
        }
        return { path: args.path || '', entries: items, cursor, nextCursor: cursor + page.length < entries.length ? cursor + page.length : null, total: entries.length };
      }

      case 'mkdir': {
        if (!args.path) return { error: 'path required' };
        const fp = safePath(args.path);
        await guardSymlinks(path.dirname(fp));
        await fs.mkdir(fp, { recursive: true });
        return { ok: true, path: args.path, type: 'dir' };
      }

      case 'rename': {
        if (!args.from || !args.to) return { error: 'from and to required' };
        const from = safePath(args.from); const to = safePath(args.to);
        await guardSymlinks(from); await guardSymlinks(path.dirname(to));
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(from, to);
        return { ok: true, from: args.from, path: args.to };
      }

      case 'copy': {
        if (!args.from || !args.to) return { error: 'from and to required' };
        const from = safePath(args.from); const to = safePath(args.to);
        await guardSymlinks(from); await guardSymlinks(path.dirname(to));
        const st = await fs.lstat(from);
        if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) return { error: 'Refusing to copy special file' };
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.cp(from, to, { recursive: st.isDirectory(), errorOnExist: true, force: false });
        return { ok: true, from: args.from, path: args.to };
      }

      case 'search': {
        const start = args.path ? safePath(args.path) : root();
        await guardSymlinks(start);
        const needle = String(args.query || '').toLowerCase();
        if (!needle) return { error: 'query required' };
        const matches = []; const queue = [start]; let scanned = 0;
        while (queue.length && scanned < 500 && matches.length < 100) {
          const dir = queue.shift();
          const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const fp = path.join(dir, entry.name); scanned++;
            if (entry.isDirectory()) { if (queue.length < 200) queue.push(fp); continue; }
            if (!entry.isFile()) continue;
            if (entry.name.toLowerCase().includes(needle)) matches.push({ path: relativePath(fp), kind: 'name' });
            if (matches.length >= 100) break;
            const st = await fs.stat(fp);
            if (st.size <= MAX_READ_BYTES) {
              const text = await fs.readFile(fp, 'utf8').catch(() => '');
              const index = text.toLowerCase().indexOf(needle);
              if (index >= 0) matches.push({ path: relativePath(fp), kind: 'content', line: text.slice(0, index).split('\n').length, preview: text.slice(Math.max(0, index - 80), index + needle.length + 120) });
            }
          }
        }
        return { query: args.query, matches: matches.slice(0, 100), scanned, truncated: queue.length > 0 || matches.length >= 100 };
      }

      case 'diff': {
        if (!args.path || args.content == null) return { error: 'path and content required' };
        const fp = safePath(args.path); await guardSymlinks(fp);
        const before = await fs.readFile(fp, 'utf8').catch(() => '');
        const after = String(args.content);
        return { path: args.path, changed: before !== after, beforeHash: createHash('sha256').update(before).digest('hex'), afterHash: createHash('sha256').update(after).digest('hex'), before: before.slice(0, MAX_READ_BYTES), after: after.slice(0, MAX_READ_BYTES), truncated: before.length > MAX_READ_BYTES || after.length > MAX_READ_BYTES };
      }

      case 'restore': {
        if (!args.trashId || !args.path) return { error: 'trashId and path required' };
        const id = path.basename(String(args.trashId));
        if (id !== String(args.trashId)) return { error: 'invalid trashId' };
        const source = path.join(TRASH, id); const target = safePath(args.path);
        await guardSymlinks(path.dirname(target));
        if (await fs.access(target).then(() => true).catch(() => false)) return { error: 'restore target already exists', code: 'hash_conflict', conflict: true };
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(source, target);
        return { ok: true, trashId: id, path: args.path };
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
        return { ok: true, path: args.path, trashed: dest, trashId: path.basename(dest), note: 'Moved to trash — use purge:true to delete permanently' };
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
          ...(st.isFile() ? { hash: await sha256File(fp), etag: await sha256File(fp) } : {}),
        };
      }

      default:
        return { error: `Unknown file action: ${action}`, available: ['read','write','list','tree','search','diff','mkdir','rename','copy','delete','restore','stat'] };
      }
    } catch (err) {
      return { error: err.message };
    }
  },
};
