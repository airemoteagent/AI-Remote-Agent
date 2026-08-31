// Workspace manifest — bounded, deterministic, symlink-safe file walk.
//
// This module reports RAW FACTS only: for each work file, its relative path,
// byte size and mtime. It deliberately contains NO language detection, NO
// entry-point ranking, NO symbol outlining and NO digest rendering — the
// "what does this project mean" layer lives on the server-side brain, not in
// this open-source runtime. Keeping this file mechanical is what stops the
// brain from being reverse-engineered from the public client.
//
// INVARIANTS (preserve these)
//   - Deterministic: same tree in, same manifest out (sorted, stable).
//   - Crash-proof and read-only: every I/O call is guarded; unreadable entries
//     degrade to "skipped", never to a throw.
//   - Bounded: file count and depth are capped so a huge repository cannot
//     blow up memory or the report.
//   - Symlinks are never followed (lstat + skip), so a link can never walk the
//     manifest outside the workspace root.

import fs from 'node:fs';
import path from 'node:path';

/** Directories that never contribute work files (dependency/VCS/build noise). */
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', 'target', 'vendor',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
  '.gradle', '.idea', '.vscode', 'Pods', 'DerivedData', '.terraform',
  '.remoteagent-index',
]);

/** Files that carry no work signal (noise, lockfiles, binaries). */
const IGNORED_FILES = new Set([
  '.DS_Store', 'Thumbs.db', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'composer.lock', 'Cargo.lock', 'poetry.lock', 'Gemfile.lock',
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.pdf',
  '.zip', '.gz', '.tar', '.tgz', '.bz2', '.7z', '.rar', '.mp3', '.mp4', '.mov',
  '.avi', '.wav', '.ogg', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.so',
  '.dylib', '.dll', '.exe', '.bin', '.class', '.jar', '.pyc', '.wasm',
]);

const DEFAULTS = { maxFiles: 4000, maxDepth: 8 };

/** True when a directory segment should be skipped entirely. */
export function isIgnoredDir(name) {
  return IGNORED_DIRS.has(name) || (name.startsWith('.') && name !== '.remoteagent');
}

function isIgnoredFile(name) {
  if (IGNORED_FILES.has(name)) return true;
  if (BINARY_EXT.has(path.extname(name).toLowerCase())) return true;
  return false;
}

/**
 * Bounded, deterministic, symlink-safe walk of a workspace root.
 * @returns {{files: Array<{rel:string,size:number,mtimeMs:number}>, dirs: string[], truncated: boolean, skipped: number, missing?: boolean}}
 */
export function walkWorkspace(root, opts = {}) {
  const maxFiles = Number(opts.maxFiles) || DEFAULTS.maxFiles;
  const maxDepth = Number(opts.maxDepth) || DEFAULTS.maxDepth;
  const files = [];
  const dirs = [];
  let truncated = false;
  let skipped = 0;

  const visit = (abs, rel, depth) => {
    if (truncated || depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { skipped++; return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (truncated) return;
      const childRel = rel ? rel + '/' + e.name : e.name;
      const childAbs = path.join(abs, e.name);
      let st;
      try { st = fs.lstatSync(childAbs); } catch { skipped++; continue; }
      if (st.isSymbolicLink()) { skipped++; continue; } // never follow links out
      if (st.isDirectory()) {
        if (isIgnoredDir(e.name)) { skipped++; continue; }
        dirs.push(childRel);
        visit(childAbs, childRel, depth + 1);
      } else if (st.isFile()) {
        if (isIgnoredFile(e.name)) { skipped++; continue; }
        if (files.length >= maxFiles) { truncated = true; return; }
        files.push({ rel: childRel, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };

  try {
    const st = fs.statSync(root);
    if (!st.isDirectory()) return { files, dirs, truncated, skipped, missing: true };
  } catch {
    return { files, dirs, truncated, skipped, missing: true };
  }
  visit(path.resolve(root), '', 0);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  dirs.sort((a, b) => a.localeCompare(b));
  return { files, dirs, truncated, skipped, missing: false };
}

/**
 * Build the RAW workspace manifest the device reports to the cloud: relative
 * path + size + mtime for each work file. Facts only — the server-side brain
 * derives every piece of structure from this.
 */
export function buildWorkspaceManifest(root, opts = {}) {
  const walk = walkWorkspace(root, { maxFiles: opts.maxFiles || DEFAULTS.maxFiles, maxDepth: opts.maxDepth || DEFAULTS.maxDepth });
  return {
    root: path.resolve(root),
    truncated: walk.truncated,
    missing: !!walk.missing,
    files: walk.files.map((f) => ({ rel: f.rel, size: f.size, mtime: Math.round(f.mtimeMs) })),
  };
}
