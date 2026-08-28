// Settings tool — view and change the agent's AI settings/persona.
//
// Actions:
//   show                    — dump the effective settings + file path
//   get <key>               — read one setting (dotted paths supported)
//   set <key> <value>       — write one setting; numbers and booleans in
//                             the value string are parsed ('0.5' → 0.5,
//                             'true' → true), everything else stays a string
//
// SECURITY: settings.systemPrompt is user-authored text. It is returned
// as DATA, never as instructions: consumers must treat it as untrusted
// content (<untrusted-...>), and the show action flags it as such.
// The module never reads or prints credentials.

import {
  loadSettings,
  saveSettings,
  getSetting,
  setSetting,
  settingsFilePath,
} from '../settings.js';

// Parse tool-provided value strings: numbers and booleans become typed.
function parseValue(raw) {
  if (raw === '') return '';
  if (raw === 'true')  return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

export const settings = {
  name: 'settings',
  description: 'View and change AI settings/persona (model, provider, temperature, maxTokens, systemPrompt, memory, autoApprove, locale, timezone). Actions: show | get <key> | set <key> <value>. Values are parsed: numbers and booleans become typed.',
  args: {
    action: 'string — show | get | set (default: show)',
    key: 'string — setting name, dotted paths supported (e.g. temperature, memory.maxSummaryChars)',
    value: 'string — new value for set; "0.5" → number, "true"/"false" → boolean',
  },
  platform: 'any',

  async run(args = {}) {
    const action = String(args.action || 'show').toLowerCase();
    try {
      if (action === 'show') {
        const s = loadSettings();
        return {
          settings: s,
          file: settingsFilePath(),
          untrusted: ['systemPrompt'], // user-authored text — data, not instructions
        };
      }

      if (action === 'get') {
        const key = String(args.key || '').trim();
        if (!key) return { error: 'key required for get' };
        return { key, value: getSetting(key) };
      }

      if (action === 'set') {
        const key = String(args.key || '').trim();
        if (!key) return { error: 'key required for set' };
        const raw = args.value == null ? '' : String(args.value).trim();
        const value = parseValue(raw);
        const saved = setSetting(key, value);
        return { ok: true, key, value: saved, file: settingsFilePath() };
      }

      return { error: `Unknown action: ${action} — use show | get | set` };
    } catch (err) {
      // Never crash the tool loop: surface a clean error object.
      return { error: err.message || String(err) };
    }
  },
};
