// Settings & persona — typical AI configuration for the agent.
//
// Standalone module (M4): does NOT touch config.js or credentials.js.
// Persisted as JSON at ~/.remote-agent/settings.json (chmod 0600, atomic
// tmp+rename write). Override the location with REMOTE_SETTINGS_FILE —
// used by tests to isolate state.
//
// Design notes:
//   - loadSettings() merges SETTINGS_DEFAULTS with the stored file and
//     VALIDATES the result: temperature must be in [0,1], autoApprove one
//     of confirm|prompt|never. Semantic violations reject with an Error;
//     I/O problems (missing/unreadable/corrupt file) degrade to defaults
//     and never crash the agent.
//   - saveSettings() rejects wrong-typed values (setSetting included),
//     merges with defaults, validates, then writes atomically
//     (tmp + rename) with mode 0600.
//   - No secrets live here: the API key stays in credentials.js.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Defaults ─────────────────────────────────────────────────────────
export const SETTINGS_DEFAULTS = Object.freeze({
  model:         '',
  provider:      'cloud',
  temperature:   0.2,
  maxTokens:     2048,
  systemPrompt:  '',
  memory: Object.freeze({
    enabled:        true,
    sessions:       true,
    maxSummaryChars: 4000,
  }),
  autoApprove:   'confirm',
  locale:        'en-US',
  timezone:      'UTC',
});

const AUTO_APPROVE = new Set(['confirm', 'prompt', 'never']);
const TOP_LEVEL_KEYS = Object.keys(SETTINGS_DEFAULTS);
const MEMORY_KEYS = Object.keys(SETTINGS_DEFAULTS.memory);

// ── Path resolution ──────────────────────────────────────────────────
export function settingsFilePath() {
  return process.env.REMOTE_SETTINGS_FILE
    || path.join(os.homedir(), '.remote-agent', 'settings.json');
}

// ── Validation ───────────────────────────────────────────────────────
// Returns a list of human-readable problems; empty array means valid.
export function validateSettings(s) {
  const errors = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    return ['settings must be an object'];
  }
  if (typeof s.model !== 'string')        errors.push('model must be a string');
  if (typeof s.provider !== 'string')     errors.push('provider must be a string');
  if (typeof s.temperature !== 'number' || !Number.isFinite(s.temperature)
      || s.temperature < 0 || s.temperature > 1) {
    errors.push('temperature must be a number in [0, 1]');
  }
  if (!Number.isInteger(s.maxTokens) || s.maxTokens <= 0) {
    errors.push('maxTokens must be a positive integer');
  }
  if (typeof s.systemPrompt !== 'string') errors.push('systemPrompt must be a string');
  if (typeof s.autoApprove !== 'string' || !AUTO_APPROVE.has(s.autoApprove)) {
    errors.push(`autoApprove must be one of ${[...AUTO_APPROVE].join(', ')}`);
  }
  if (typeof s.locale !== 'string')       errors.push('locale must be a string');
  if (typeof s.timezone !== 'string')     errors.push('timezone must be a string');
  const m = s.memory;
  if (!m || typeof m !== 'object') {
    errors.push('memory must be an object');
  } else {
    if (typeof m.enabled !== 'boolean')        errors.push('memory.enabled must be a boolean');
    if (typeof m.sessions !== 'boolean')       errors.push('memory.sessions must be a boolean');
    if (typeof m.maxSummaryChars !== 'number' || !Number.isFinite(m.maxSummaryChars)
        || m.maxSummaryChars < 0) {
      errors.push('memory.maxSummaryChars must be a non-negative number');
    }
  }
  return errors;
}

// ── Raw type check (write path) ─────────────────────────────────────
// Unlike loadSettings() (which sanitizes), the WRITE path rejects
// wrong-typed values loudly instead of silently coercing them. Only
// keys actually present in the input are checked; unknown keys are
// dropped by mergeSettings, not treated as errors.
function checkRawTypes(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    return ['settings must be an object'];
  }
  const errors = [];
  for (const [k, v] of Object.entries(s)) {
    if (k === 'memory') {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        errors.push('memory must be an object');
        continue;
      }
      for (const mk of MEMORY_KEYS) {
        if (mk in v && typeof v[mk] !== typeof SETTINGS_DEFAULTS.memory[mk]) {
          errors.push(`memory.${mk} must be a ${typeof SETTINGS_DEFAULTS.memory[mk]}`);
        }
      }
    } else if (k in SETTINGS_DEFAULTS && typeof v !== typeof SETTINGS_DEFAULTS[k]) {
      errors.push(`${k} must be a ${typeof SETTINGS_DEFAULTS[k]}`);
    }
  }
  return errors;
}

// ── Merge ────────────────────────────────────────────────────────────
// Deep-merge stored values over defaults. Wrong-typed / missing / null
// values fall back to the default per key (robust against hand-edited
// files); unknown keys are dropped.
function mergeSettings(stored) {
  const src = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const out = {};
  for (const key of TOP_LEVEL_KEYS) {
    const def = SETTINGS_DEFAULTS[key];
    const val = src[key];
    if (key === 'memory') {
      const m = val && typeof val === 'object' ? val : {};
      out.memory = {};
      for (const mk of MEMORY_KEYS) {
        const mv = m[mk];
        const md = def[mk];
        out.memory[mk] = (typeof mv === typeof md) ? mv : md;
      }
    } else if (val === undefined || val === null || typeof val !== typeof def) {
      out[key] = def;
    } else {
      out[key] = val;
    }
  }
  return out;
}

// ── Load ─────────────────────────────────────────────────────────────
// Returns merged + validated settings. Missing/corrupt file → defaults
// (I/O never crashes). Semantic violations in the file reject loudly.
export function loadSettings() {
  const file = settingsFilePath();
  let stored = {};
  try {
    if (fs.existsSync(file)) {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch {
    stored = {}; // unreadable / corrupt JSON → defaults
  }
  const merged = mergeSettings(stored);
  const errors = validateSettings(merged);
  if (errors.length) {
    throw new Error(`Invalid settings in ${file}: ${errors.join('; ')}`);
  }
  return merged;
}

// ── Save (atomic, 0600) ──────────────────────────────────────────────
// Merges with defaults, validates, then writes tmp + rename. Never
// persists invalid values. Returns the file path written.
export function saveSettings(s) {
  const rawErrors = checkRawTypes(s);
  if (rawErrors.length) {
    throw new Error(`Invalid settings: ${rawErrors.join('; ')}`);
  }
  const merged = mergeSettings(s);
  const errors = validateSettings(merged);
  if (errors.length) {
    throw new Error(`Invalid settings: ${errors.join('; ')}`);
  }
  const file = settingsFilePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
  // Belt-and-braces: rename preserves tmp mode, but enforce 0600 anyway
  // (no-op on platforms without POSIX modes).
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return file;
}

// ── Single-key accessors ─────────────────────────────────────────────
// Supports dotted paths for nested keys, e.g. 'memory.maxSummaryChars'.
export function getSetting(key) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('setting key required');
  }
  const s = loadSettings();
  return key.trim().split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), s);
}

export function setSetting(key, value) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('setting key required');
  }
  // Self-healing: if the on-disk file is broken, start from defaults so
  // the user can repair it with a single set.
  let current;
  try { current = loadSettings(); } catch { current = mergeSettings({}); }
  const next = structuredClone(current);
  const parts = key.trim().split('.');
  let node = next;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') {
      throw new Error(`Unknown setting: ${key}`);
    }
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
  saveSettings(next);
  return value;
}
