// Update — check for and apply mona-agent updates.
//
//   mona-agent update          fetch latest release and self-update
//   mona-agent update check    only report what's available
//
// Update mechanics:
//   - Latest version is read from the GitHub releases API of
//     MONAEXPERT/agent (public repo, no auth needed).
//   - The install lives in ~/.mona-agent/agent/ as a full copy of the
//     repo. Self-update replaces it with the release tarball, re-runs
//     `npm install`, and restarts the daemon if it was running.
//   - A version lifecycle record (~/.mona-agent/update.json) tracks
//     when we last checked, what we saw, and what we installed — so
//     the dashboard can show "update available" per agent.
//
// The control plane can trigger an update over the command channel;
// the actual download + swap always happens on the device.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { VERSION, isUpdateAvailable, compareVersions } from './version.js';
import { PATHS } from './config.js';

export const REPO = 'MONAEXPERT/agent';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const TAGS_URL = `https://api.github.com/repos/${REPO}/tags?per_page=20`;
const TARBALL = (tag) => `https://github.com/${REPO}/releases/download/${tag}/mona-agent-${tag}.tar.gz`;
const CHECKSUMS = (tag) => `https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS`;

export function verifyChecksum(bytes, manifest, filename) {
  const matches = String(manifest || '').split(/\r?\n/).filter((item) => {
    const fields = item.trim().split(/\s+/);
    return fields.length === 2 && fields[1].replace(/^\*/, '') === filename;
  });
  if (matches.length !== 1) return { ok: false, error: 'Release SHA256SUMS must contain exactly one entry for the archive.' };
  const expected = matches[0].trim().split(/\s+/)[0]?.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected || '')) return { ok: false, error: 'Release SHA256SUMS has no valid entry for the archive.' };
  const actual = createHash('sha256').update(bytes).digest('hex');
  return actual === expected ? { ok: true } : { ok: false, error: `Release checksum mismatch (expected ${expected}, got ${actual}).` };
}

export const UPDATE_FILE = join(PATHS.dir, 'update.json');

function readUpdateState() {
  try {
    if (existsSync(UPDATE_FILE)) return JSON.parse(readFileSync(UPDATE_FILE, 'utf8'));
  } catch { /* corrupt state — start fresh */ }
  return { installed: VERSION, checkedAt: null, latest: null, latestTag: null, installedAt: null };
}

function writeUpdateState(state) {
  try {
    mkdirSync(PATHS.dir, { recursive: true });
    writeFileSync(UPDATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch { /* best effort */ }
}

/** Fetch latest release info from GitHub. Falls back to the tag list
 *  when no formal GitHub Release exists yet. Returns null on failure. */
export async function fetchLatest() {
  // 1) Try the formal latest release
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { 'user-agent': `mona-agent/${VERSION}`, accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const data = await res.json();
      const tag = String(data.tag_name || '').replace(/^v/, '');
      if (/^\d+\.\d+\.\d+/.test(tag)) {
        return {
          version: tag,
          tag: data.tag_name,
          name: data.name || tag,
          publishedAt: data.published_at || null,
          body: (data.body || '').slice(0, 2000),
        };
      }
    }
  } catch { /* fall through to tags */ }

  // 2) Fallback: newest semver tag (releases aren't published yet)
  try {
    const res = await fetch(TAGS_URL, {
      headers: { 'user-agent': `mona-agent/${VERSION}`, accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const tags = await res.json();
      if (Array.isArray(tags) && tags.length) {
        const semver = tags
          .map((t) => String(t.name || '').replace(/^v/, ''))
          .filter((t) => /^\d+\.\d+\.\d+$/.test(t))
          .sort((a, b) => compareVersions(b, a));
        if (semver.length) {
          const tag = semver[0];
          return { version: tag, tag: `v${tag}`, name: `v${tag}`, publishedAt: null, body: '' };
        }
      }
    }
  } catch { /* unreachable */ }

  return null;
}

/** Refresh update state against GitHub (used by `update check` + status). */
export async function checkForUpdates() {
  const state = readUpdateState();
  const latest = await fetchLatest();
  if (latest) {
    state.latest = latest.version;
    state.latestTag = latest.tag;
    state.checkedAt = new Date().toISOString();
    writeUpdateState(state);
  }
  return {
    installed: VERSION,
    latest: latest?.version ?? state.latest ?? null,
    available: latest ? isUpdateAvailable(VERSION, latest.version) : false,
    info: latest,
    state,
  };
}

/** Actually apply the update: download tarball, swap, npm install, restart. */
export async function applyUpdate() {
  const { latest, available, info } = await checkForUpdates();
  if (!latest) return { ok: false, error: 'Could not reach the release feed (offline or rate-limited).' };
  if (!available) return { ok: true, upToDate: true, version: VERSION, latest };

  const installDir = join(homedir(), '.mona-agent', 'agent');
  if (!existsSync(join(installDir, 'package.json'))) {
    return { ok: false, error: `Install dir not found at ${installDir}. Re-run the installer.` };
  }

  const tmpDir = join(homedir(), '.mona-agent', '.update-tmp');
  const tarball = join(tmpDir, 'release.tar.gz');
  const extracted = join(tmpDir, 'extracted');

  try {
    mkdirSync(tmpDir, { recursive: true });
    // 1) Download the release tarball
    const dl = await fetch(TARBALL(info.tag));
    if (!dl.ok) return { ok: false, error: `Download failed (HTTP ${dl.status}).` };
    const buf = Buffer.from(await dl.arrayBuffer());
    const sums = await fetch(CHECKSUMS(info.tag));
    if (!sums.ok) return { ok: false, error: `Release checksum manifest unavailable (HTTP ${sums.status}); refusing update.` };
    const integrity = verifyChecksum(buf, await sums.text(), `mona-agent-${info.tag}.tar.gz`);
    if (!integrity.ok) return { ok: false, error: integrity.error };
    writeFileSync(tarball, buf);

    // 2) Extract
    rmSync(extracted, { recursive: true, force: true });
    mkdirSync(extracted, { recursive: true });
    const tar = spawnSync('tar', ['-xzf', tarball, '-C', extracted], { encoding: 'utf8' });
    if (tar.status !== 0) return { ok: false, error: `Extract failed: ${(tar.stderr || '').slice(0, 300)}` };

    // The archive extracts to <name>-<tag>/ — find the single dir.
    const inner = readdirOne(extracted);
    if (!inner) return { ok: false, error: 'Release archive had no content.' };
    const newTree = join(extracted, inner);

    // 2b) Integrity: the extracted tree must actually carry the requested
    // version (guards against stale CDN archives for re-pointed tags).
    try {
      const pkg = JSON.parse(readFileSync(join(newTree, 'package.json'), 'utf8'));
      const actual = String(pkg.version || '').replace(/^v/, '');
      if (actual !== latest) {
        return { ok: false, error: `Release integrity check failed: tag says v${latest}, archive contains v${actual}. Try again in a minute (CDN cache).` };
      }
    } catch (e) {
      return { ok: false, error: `Release integrity check failed: ${e.message}` };
    }

    // 3) Preserve the user's local state, swap the tree
    const backup = join(homedir(), '.mona-agent', `.agent.bak-${VERSION}`);
    rmSync(backup, { recursive: true, force: true });
    renameSync(installDir, backup);
    try {
      renameSync(newTree, installDir);
    } catch (e) {
      // roll back
      renameSync(backup, installDir);
      return { ok: false, error: `Swap failed: ${e.message}` };
    }

    // 4) Install deps (workspace root install; @mona/* are symlinked)
    const ni = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: installDir, encoding: 'utf8', timeout: 120_000 });
    if (ni.status !== 0) {
      // Deps failed — restore backup so the device keeps working
      rmSync(installDir, { recursive: true, force: true });
      renameSync(backup, installDir);
      return { ok: false, error: `npm install failed (${(ni.stderr || '').slice(0, 300)}). Rolled back.` };
    }
    rmSync(backup, { recursive: true, force: true });

    // 5) Record the lifecycle event
    const state = readUpdateState();
    state.installed = latest;
    state.installedAt = new Date().toISOString();
    writeUpdateState(state);

    return { ok: true, version: latest, from: VERSION, info };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readdirOne(dir) {
  try {
    const entries = readdirSync(dir);
    return entries.find((e) => e !== '.' && e !== '..' && existsSync(join(dir, e, 'package.json'))) || entries[0] || null;
  } catch { return null; }
}
