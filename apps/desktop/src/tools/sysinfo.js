// System information tool — multi-OS device telemetry.
// Works on macOS, Linux, and Windows. Read-only.
//
// P4: PII gating — hostname, username and network interfaces are
// fingerprintable identifiers. Default output is coarse (no hostname,
// no network map); callers must explicitly ask for detail:"full" to get
// them. A policy rule can gate detail:"full" separately.

import os from 'node:os';

const PLATFORM = os.platform();
const PLATFORM_LABEL = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

export const sysinfo = {
  name: 'sysinfo',
  description: `Get device system information (OS, CPU, memory, load, uptime) — running on ${PLATFORM_LABEL[PLATFORM] || PLATFORM}. Pass { detail: "full" } for hostname + network interfaces (fingerprintable — gated by policy).`,
  args: {},
  platform: PLATFORM,

  async run(input = {}) {
    const detail = input.detail === 'full' ? 'full' : 'coarse';
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const loadavg = os.loadavg();

    const base = {
      detail,
      platform:   PLATFORM,
      platformName: PLATFORM_LABEL[PLATFORM] || PLATFORM,
      arch:       os.arch(),
      release:    os.release(),
      cpus:       cpus.length,
      cpuModel:   cpus[0]?.model || 'unknown',
      cpuSpeed:   cpus[0]?.speed || 0,
      mem: {
        total:    totalMem,
        free:     freeMem,
        used:     totalMem - freeMem,
        percent:  Math.round((1 - freeMem / totalMem) * 100),
      },
      loadavg: loadavg.map(v => Math.round(v * 100) / 100),
      uptime:  Math.round(os.uptime()),
    };

    // PII: only included when explicitly requested (detail:"full").
    if (detail === 'full') {
      base.host = os.hostname();
      base.username = os.userInfo?.()?.username ?? null;
      base.network = Object.entries(os.networkInterfaces())
        .filter(([k]) => !k.startsWith('lo') && !k.startsWith('Loopback'))
        .flatMap(([iface, addrs]) =>
          (addrs || []).filter(a => a.family === 'IPv4' && !a.internal)
            .map(a => ({ iface, address: a.address }))
        )
        .slice(0, 8);
    }

    return base;
  },
};
