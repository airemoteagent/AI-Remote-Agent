import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  serviceScriptPath, serviceBinaryPath, buildServiceArgs, parseServiceOutput,
  WINDOWS_SERVICE, WINDOWS_SERVICE_ACCOUNTS,
} from '../src/windows-service.js';
import { dpapiScope, dpapiProtectScript, dpapiUnprotectScript } from '../src/credentials.js';
import { winBuiltin } from '../src/tools/shell.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

describe('windows-service adapter (portable unit tests)', () => {
  it('requires absolute service paths and quotes them safely', () => {
    const binary = serviceBinaryPath({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', entrypoint: 'C:\\Program Files\\mona-agent\\bin\\mona-agent.js' });
    assert.equal(binary, '\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Program Files\\mona-agent\\bin\\mona-agent.js\" start --force');
    assert.throws(() => serviceBinaryPath({ nodePath: 'relative.exe' }), /absolute/);
  });

  it('builds argument vectors with validated service accounts', () => {
    const args = buildServiceArgs('install', { nodePath: 'C:\\node.exe', entrypoint: 'C:\\app\\bin\\mona-agent.js', cwd: 'C:\\app', serviceAccount: 'LocalSystem' });
    assert.ok(args.includes('-File'));
    assert.ok(args.includes('install'));
    assert.equal(args.at(-1), 'LocalSystem');
    assert.throws(() => buildServiceArgs('install', { nodePath: 'C:\\node.exe', entrypoint: 'C:\\app\\bin\\mona-agent.js', serviceAccount: 'rm -rf /' }), /Unsupported service account/);
  });

  it('accepts LocalSystem, built-in service identities, and named accounts', () => {
    for (const account of [...WINDOWS_SERVICE_ACCOUNTS, 'CONTOSO\\svc_mona']) {
      const args = buildServiceArgs('install', { nodePath: 'C:\\node.exe', entrypoint: 'C:\\app\\bin\\mona-agent.js', serviceAccount: account });
      assert.equal(args.at(-1), account);
    }
  });

  it('parses service script JSON output and failures', () => {
    const good = parseServiceOutput('{"ok":true,"action":"status","installed":true,"running":true,"state":"Running","serviceAccount":"LocalSystem"}', 0);
    assert.equal(good.ok, true);
    assert.equal(good.data.running, true);
    assert.equal(good.data.serviceAccount, 'LocalSystem');
    const bad = parseServiceOutput('garbage', 1);
    assert.equal(bad.ok, false);
    assert.equal(bad.data, null);
  });

  it('resolves the service script inside this repository', () => {
    const script = serviceScriptPath();
    assert.equal(script, path.join(ROOT, 'src', 'windows-service.ps1'));
    assert.equal(WINDOWS_SERVICE.name, 'MonaAgent');
  });
});

describe('Windows credential scope (DPAPI)', () => {
  it('selects CurrentUser for interactive runs and LocalMachine for the service', () => {
    assert.equal(dpapiScope({}), 'CurrentUser');
    assert.equal(dpapiScope({ service: true }), 'LocalMachine');
    assert.equal(dpapiScope({ scope: 'CurrentUser' }), 'CurrentUser');
  });

  it('embeds only the configured scope into the PowerShell scripts', () => {
    assert.match(dpapiProtectScript('LocalMachine'), /DataProtectionScope\]::LocalMachine/);
    assert.doesNotMatch(dpapiProtectScript('LocalMachine'), /CurrentUser/);
    assert.match(dpapiUnprotectScript('CurrentUser'), /DataProtectionScope\]::CurrentUser/);
  });
});

describe('Windows shell builtins (in-process, no shell string)', () => {
  it('echo returns joined argv output', () => {
    const out = winBuiltin(['echo', 'hello', 'world'], { cwd: 'C:\\tmp', allow: true });
    assert.equal(out.stdout, 'hello world\n');
  });

  it('type is confined to the working directory', () => {
    const denied = winBuiltin(['type', 'C:\\Windows\\win.ini'], { cwd: 'C:\\tmp', allow: true });
    assert.equal(denied.exitCode, 1);
    assert.match(denied.error, /inside the working directory/);
  });

  it('builtins are allowlist-gated', () => {
    const denied = winBuiltin(['echo', 'hi'], { cwd: 'C:\\tmp', allow: false });
    assert.equal(denied.exitCode, 1);
    assert.match(denied.error, /allowlist/);
  });
});
