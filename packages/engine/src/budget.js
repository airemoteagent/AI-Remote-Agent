// Budget governor: hard daily token/cost caps with automatic degradation.
//
// Levels (based on the tighter of the two caps, if set):
//   normal    < 50%   — full capability
//   eco       >= 50%  — cheap profile, fewer steps
//   critical  >= 85%  — minimal profile, verification off
//   exhausted >= 100% — no more tasks today
//
// State persists to ~/.remote-agent/budget.json so caps survive restarts.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DEFAULT_STORE = process.env.REMOTE_BUDGET_STORE || join(homedir(), '.remote-agent', 'budget.json');

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class Budget {
  constructor({ dailyTokens = 0, dailyCostUsd = 0, storePath = DEFAULT_STORE } = {}) {
    this.capTokens = dailyTokens;
    this.capCost = dailyCostUsd;
    this.storePath = storePath;
    this.state = { day: dayKey(), tokens: 0, costUsd: 0 };
    this.#load();
  }

  #load() {
    try {
      if (existsSync(this.storePath)) {
        const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
        if (raw && raw.day) this.state = raw;
      }
    } catch { /* corrupt state → reset */ }
    this.resetIfNewDay();
  }

  #save() {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    } catch { /* best-effort persistence */ }
  }

  resetIfNewDay() {
    if (this.state.day !== dayKey()) {
      this.state = { day: dayKey(), tokens: 0, costUsd: 0 };
      this.#save();
    }
  }

  /** Register usage. Returns the new level. */
  spend(tokens = 0, costUsd = 0) {
    this.resetIfNewDay();
    this.state.tokens += Math.max(0, tokens);
    this.state.costUsd += Math.max(0, costUsd);
    this.#save();
    return this.level();
  }

  /** 0..1 fraction used against the tighter cap (0 if no caps set). */
  fraction() {
    const fTok = this.capTokens > 0 ? this.state.tokens / this.capTokens : 0;
    const fCost = this.capCost > 0 ? this.state.costUsd / this.capCost : 0;
    return Math.max(fTok, fCost);
  }

  level() {
    const f = this.fraction();
    if (f >= 1) return 'exhausted';
    if (f >= 0.85) return 'critical';
    if (f >= 0.5) return 'eco';
    return 'normal';
  }

  canRun() {
    return this.level() !== 'exhausted';
  }

  summary() {
    return {
      day: this.state.day,
      tokens: this.state.tokens,
      costUsd: this.state.costUsd,
      capTokens: this.capTokens,
      capCostUsd: this.capCost,
      level: this.level(),
      fraction: this.fraction(),
    };
  }
}
