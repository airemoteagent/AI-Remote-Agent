// device — deep-dive + control tool. Hands the machine back to its owner, and
// makes every process (and agent) on it transparent.
//
// Read-only by default (census). Actions are policy-gated like every other tool,
// and pause/resume/kill can never touch pid 1, this process, a control-surface
// port owner, or the core GUI/system daemons.
import { formatBudget, selectGroup, BUCKETS } from '@remote-agent/engine';
import * as sampler from '../device-sampler.js';

export const device = {
  name: 'device',
  description:
    'Deep-dive and control THIS computer: real CPU per process (cputime deltas, never ps %cpu), ' +
    'where the CPU goes (agents / control / apps / browser / system / other), the agent fleet, and ' +
    'actions — pause (SIGSTOP) / resume (SIGCONT) / renice / kill / set a focus mode. Census is read-only.',
  args: {
    action: 'census | top | paused | pause | resume | renice | kill | mode (default: census)',
    target: 'agents | openclaw | all-agents (for pause/resume group actions)',
    pid: 'process id (for pause/resume/renice/kill)',
    nice: 'target nice for renice (0-20; raising priority needs root)',
    signal: 'SIGTERM (default) or SIGKILL (for kill)',
    mode: 'agents | balanced | gaming | pause | resume',
    n: 'how many top processes to return (default 15)',
  },
  timeoutMs: 20000,

  async run(input = {}) {
    const action = String(input.action || 'census').toLowerCase();
    const census = sampler.sample({ minCpu: action === 'census' || action === 'top' ? 0.5 : 0.3 });
    const pausedList = [...sampler.paused.entries()].map(([pid, v]) => ({ pid: Number(pid), at: v.at }));

    switch (action) {
      case 'census':
      case 'status':
        return {
          busyPercent: census.busy,
          cores: (await import('node:os')).cpus().length,
          budget: census.budget,
          budgetText: formatBudget(census.budget),
          groups: census.groups,
          top: census.rows.slice(0, Number(input.n) || 15),
          load: sampler.readLoad(),
          swap: sampler.readSwap(),
          gate: sampler.readGate(),
          paused: pausedList,
        };
      case 'top':
        return { busyPercent: census.busy, top: census.rows.slice(0, Number(input.n) || 20) };
      case 'paused':
        return { paused: pausedList };
      case 'pause':
        return input.pid ? sampler.pausePids([input.pid]) : sampler.pausePids(selectGroup(input.target || 'agents', census.rows));
      case 'resume':
        return input.pid ? sampler.resumePids([input.pid]) : sampler.resumeAll();
      case 'renice':
        if (!input.pid) return { error: 'renice needs a pid' };
        return sampler.renicePid(input.pid, input.nice ?? 20);
      case 'kill':
        if (!input.pid) return { error: 'kill needs a pid' };
        return sampler.killPid(input.pid, input.signal || 'SIGTERM');
      case 'mode':
        if (!input.mode) return { error: `mode needs one of ${['agents', 'balanced', 'gaming', 'pause', 'resume'].join(', ')}` };
        return sampler.applyMode(String(input.mode), census);
      default:
        return { error: `unknown action "${input.action}"`, actions: ['census', 'top', 'paused', 'pause', 'resume', 'renice', 'kill', 'mode'] };
    }
  },
};
