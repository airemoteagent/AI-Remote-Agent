import { platform, release, arch } from 'node:os';
import { VERSION } from './version.js';

// Product support is intentionally conservative: exact Windows lifecycle
// eligibility is maintained by release metadata, not guessed from a label.
export const WINDOWS_SUPPORT_POLICY = Object.freeze({
  requiresNodeMajor: 20,
  lifecycle: 'active-security-support-required',
  eolProduction: false,
  // NT build thresholds (os.release()). EOL builds are refused production use.
  supported: [
    { min: 26100, windows: 'Windows Server 2025 / Windows 11 24H2' },
    { min: 22621, windows: 'Windows 11 23H2+' },
    { min: 20348, windows: 'Windows Server 2022' },
    { min: 19045, windows: 'Windows 10 22H2' },
  ],
  eolBelow: 19045, // Windows 10 builds older than 22H2 are end-of-life
  // Future builds above the highest known release are reported as unknown,
  // never assumed supported: they must be verified against lifecycle data.
  maxKnown: 26200,
});

/** Classify a Windows NT build number against the support matrix. */
export function classifyWindowsBuild(releaseString) {
  const build = Number.parseInt(String(releaseString || '').split('.')[2], 10);
  if (!Number.isFinite(build) || build <= 0) return { status: 'unknown', build: null, note: 'unrecognized Windows build' };
  if (build < WINDOWS_SUPPORT_POLICY.eolBelow) {
    return { status: 'unsupported', build, windows: 'end-of-life Windows release', note: 'end-of-life: refuse production deployment; upgrade to a supported release' };
  }
  if (build > WINDOWS_SUPPORT_POLICY.maxKnown) {
    return { status: 'unknown', build, note: 'newer than the known support matrix; verify against Microsoft lifecycle data and docs/WINDOWS.md' };
  }
  const hit = WINDOWS_SUPPORT_POLICY.supported.find((r) => build >= r.min);
  if (hit) return { status: 'supported', build, windows: hit.windows, note: 'within active security support' };
  return { status: 'unknown', build, note: 'verify against Microsoft lifecycle data and docs/WINDOWS.md' };
}

export function runtimeSupport({ os = platform(), node = process.versions.node, osRelease = release() } = {}) {
  const nodeMajor = Number.parseInt(String(node).split('.')[0], 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < WINDOWS_SUPPORT_POLICY.requiresNodeMajor) {
    return { status: 'unsupported', reason: `Node.js ${WINDOWS_SUPPORT_POLICY.requiresNodeMajor}+ is required` };
  }
  if (os === 'win32') {
    const build = classifyWindowsBuild(osRelease);
    return {
      status: build.status === 'unsupported' ? 'unsupported' : (build.status === 'supported' ? 'supported' : 'unknown'),
      reason: build.status === 'supported' ? `Windows build ${build.build} (${build.windows})` : build.note,
      lifecycle: WINDOWS_SUPPORT_POLICY.lifecycle,
      windows: build.windows || null,
    };
  }
  if (os === 'darwin' || os === 'linux') return { status: 'supported', reason: 'Supported runtime family' };
  return { status: 'unknown', reason: `Platform ${os} is not in the validated matrix` };
}

export function platformInfo() {
  return {
    os: platform(),
    release: release(),
    arch: arch(),
    version: VERSION,
    support: runtimeSupport(),
  };
}
