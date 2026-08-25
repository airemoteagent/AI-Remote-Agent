import { spawnSync } from 'node:child_process';

export function spawnFileSync(file, args, options = {}) {
  return spawnSync(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
}
