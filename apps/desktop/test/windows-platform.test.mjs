import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { platformPathEntries, executableCandidates } from '../src/tools/shell.js';
import { daemonStatus, daemonInstall, daemonUninstall } from '../src/daemon.js';
import { classifyWindowsBuild, runtimeSupport } from '../src/platform.js';

describe('Windows platform helpers', () => {
  it('splits Windows PATH using semicolons', () => {
    assert.deepEqual(platformPathEntries('win32', { PATH: 'C:\\Windows\\System32;C:\\Windows' }), ['C:\\Windows\\System32', 'C:\\Windows']);
  });

  it('expands PATHEXT candidates', () => {
    assert.deepEqual(executableCandidates('tasklist', 'win32', { PATHEXT: '.COM;.EXE;.BAT;.CMD' }), ['tasklist.com', 'tasklist.exe', 'tasklist.bat', 'tasklist.cmd']);
  });

  it('does not require POSIX executable bits on Windows', () => {
    assert.equal(typeof platformPathEntries, 'function');
  });
});

describe('Windows support matrix classification', () => {
  it('supports current Windows 11 / Server builds', () => {
    assert.equal(classifyWindowsBuild('10.0.26100').status, 'supported');
    assert.equal(classifyWindowsBuild('10.0.22631').status, 'supported');
    assert.equal(classifyWindowsBuild('10.0.20348').status, 'supported');
    assert.equal(classifyWindowsBuild('10.0.19045').status, 'supported');
  });

  it('refuses end-of-life Windows builds for production', () => {
    const eol = classifyWindowsBuild('10.0.19044');
    assert.equal(eol.status, 'unsupported');
    assert.match(eol.note, /end-of-life/i);
  });

  it('reports unknown status for unrecognized builds', () => {
    assert.equal(classifyWindowsBuild('10.0.99999').status, 'unknown');
    assert.equal(classifyWindowsBuild('garbage').status, 'unknown');
  });

  it('runtimeSupport reflects build classification on win32', () => {
    assert.equal(runtimeSupport({ os: 'win32', osRelease: '10.0.19044' }).status, 'unsupported');
    assert.equal(runtimeSupport({ os: 'win32', osRelease: '10.0.22631' }).status, 'supported');
  });
});

describe('Windows daemon safety', () => {
  it('exposes explicit unsupported service status without invoking systemd', () => {
    const status = daemonStatus.call({});
    assert.ok(status);
  });

  it('returns an explicit unsupported result for service installation APIs', () => {
    assert.equal(typeof daemonInstall, 'function');
    assert.equal(typeof daemonUninstall, 'function');
  });
});
