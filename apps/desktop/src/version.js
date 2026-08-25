// Version — single source of truth for the agent version.
//
// The monorepo root package.json carries the product version (2.x).
// Everything else (desktop app, engine, protocol) reports through here
// so the CLI, the metrics stream, and the dashboard all agree on one
// number. No hardcoded copies.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function readVersion(candidate) {
  try {
    const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
    return typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version) ? pkg.version : null;
  } catch {
    return null;
  }
}

// apps/desktop/src → apps/desktop/package.json → root package.json
const CANDIDATES = [
  join(here, '..', '..', '..', 'package.json'), // apps/desktop/src -> repo root
  join(here, '..', '..', 'package.json'),       // apps/desktop/src -> apps/desktop
  join(here, '..', 'package.json'),             // apps/desktop/src -> src
];

export const VERSION =
  readVersion(CANDIDATES[0]) ??
  readVersion(CANDIDATES[1]) ??
  readVersion(CANDIDATES[2]) ??
  '0.0.0';

/** Compare two semver strings. Returns -1, 0, or 1. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** True when `installed` is older than `latest`. */
export function isUpdateAvailable(installed, latest) {
  if (!latest) return false;
  return compareVersions(installed, latest) < 0;
}
