// Skills — user-enableable capabilities for the agent.
//
// A skill is a folder under the skills directory containing:
//   SKILL.md          — frontmatter (name, description) + instructions body
//   tools/*.mjs       — optional extra tools (default export { name, run })
//
// Enabled skills' instructions are injected into the brain's context so the
// agent knows the skill exists and how to use it; skill tools become
// callable through the tool registry.
//
// CLI: remote-agent skills list | enable <name> | disable <name> | install
// Dir: ~/.remote-agent/skills/  (override with REMOTE_SKILLS_DIR)

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig } from './config.js';

export const SKILLS_DIR = process.env.REMOTE_SKILLS_DIR || join(homedir(), '.remote-agent', 'skills');
// Skills bundled with the agent (installed on first run / `skills install`)
const BUNDLED = new URL('../skills/', import.meta.url);

/** Parse `---` frontmatter + body from a SKILL.md. */
export function parseSkillDoc(text) {
  const body = String(text || '');
  const m = body.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { name: '', description: '', instructions: body };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { name: meta.name || '', description: meta.description || '', instructions: (m[2] || '').trim() };
}

export class SkillsManager {
  constructor({ dir = SKILLS_DIR } = {}) {
    this.dir = dir;
    this.enabled = [];
    this.#loadEnabled();
  }

  #loadEnabled() {
    try {
      const cfg = loadConfig();
      if (Array.isArray(cfg.skills)) this.enabled = cfg.skills;
    } catch { /* default empty */ }
  }

  #saveEnabled() {
    const cfg = loadConfig();
    cfg.skills = this.enabled;
    saveConfig(cfg);
  }

  /** Persist an explicit enabled-list (used by `mode set`). */
  saveRaw(names) {
    this.enabled = Array.isArray(names) ? names.filter((n) => typeof n === 'string') : [];
    this.#saveEnabled();
    return this.enabled;
  }

  /** All installed skills with metadata + enabled state. */
  list() {
    const out = [];
    let names = [];
    try {
      if (existsSync(this.dir)) names = readdirSync(this.dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch { /* no skills dir yet */ }
    for (const name of names.sort()) {
      const mdPath = join(this.dir, name, 'SKILL.md');
      let description = '';
      let instructions = '';
      try {
        if (existsSync(mdPath)) {
          const parsed = parseSkillDoc(readFileSync(mdPath, 'utf8'));
          description = parsed.description;
          instructions = parsed.instructions;
        }
      } catch { /* unreadable skill */ }
      out.push({ name, description, enabled: this.enabled.includes(name), instructions: instructions.slice(0, 200) });
    }
    return out;
  }

  enable(name) {
    if (!this.#installed(name)) return { ok: false, error: `Skill "${name}" is not installed` };
    if (!this.enabled.includes(name)) this.enabled.push(name);
    this.#saveEnabled();
    return { ok: true, enabled: this.enabled };
  }

  disable(name) {
    this.enabled = this.enabled.filter((n) => n !== name);
    this.#saveEnabled();
    return { ok: true, enabled: this.enabled };
  }

  #installed(name) {
    try {
      return existsSync(join(this.dir, name, 'SKILL.md'));
    } catch { return false; }
  }

  /** Markdown instructions of all enabled skills (injected into brain context). */
  instructions() {
    const chunks = [];
    for (const name of this.enabled) {
      try {
        const mdPath = join(this.dir, name, 'SKILL.md');
        if (existsSync(mdPath)) {
          const parsed = parseSkillDoc(readFileSync(mdPath, 'utf8'));
          if (parsed.instructions) {
            chunks.push(`## Skill: ${parsed.name || name}\n${parsed.instructions}`);
          }
        }
      } catch { /* skip broken skill */ }
    }
    return chunks.join('\n\n');
  }

  /** Register skill-provided tools into a tool registry. */
  async registerTools(registry) {
    let count = 0;
    for (const name of this.enabled) {
      const toolsDir = join(this.dir, name, 'tools');
      let files = [];
      try {
        if (existsSync(toolsDir)) files = readdirSync(toolsDir).filter((f) => f.endsWith('.mjs'));
      } catch { continue; }
      for (const f of files) {
        try {
          const mod = await import(join(toolsDir, f));
          if (mod.default && typeof mod.default.run === 'function' && mod.default.name) {
            registry.register(mod.default);
            count++;
          }
        } catch { /* skip broken tool module */ }
      }
    }
    return count;
  }

  /** Install the bundled skills (idempotent). */
  install() {
    mkdirSync(this.dir, { recursive: true });
    let installed = 0;
    try {
      const bundled = readdirSync(BUNDLED).filter((n) => n !== 'index.js');
      for (const name of bundled) {
        const dest = join(this.dir, name);
        if (!existsSync(join(dest, 'SKILL.md'))) {
          cpSync(join(BUNDLED.pathname, name), dest, { recursive: true });
          installed++;
        }
      }
    } catch { /* bundled dir unavailable */ }
    return { installed, dir: this.dir };
  }
}

export const skills = new SkillsManager();
