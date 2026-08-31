import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-wslink-'));
process.env.REMOTE_AGENT_HOME = path.join(tmp, 'state');
process.env.REMOTE_WORKSPACE = path.join(tmp, 'state', 'workspace');
process.env.REMOTE_WORKSPACE_LINKS = path.join(tmp, 'state', 'workspace-links.json');

const {
  linkWorkspace, unlinkWorkspace, resolveLinkedRoot, listLinks, readLinks, validateLinkTarget, LINKS_FILE, STATE_DIR,
} = await import('../src/workspace-links.js');
const { resolveWorkspaceRoot, discoverLocalWorkspaces, BASE } = await import('../src/workspace-registry.js');

const project = path.join(tmp, 'Projects', 'my-app');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'app.js'), 'export function main() {}');

after(() => {
  delete process.env.REMOTE_AGENT_HOME;
  delete process.env.REMOTE_WORKSPACE;
  delete process.env.REMOTE_WORKSPACE_LINKS;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a missing registry reads as no links instead of throwing', () => {
  assert.deepEqual(readLinks(), {});
  assert.deepEqual(listLinks(), []);
  assert.equal(resolveLinkedRoot('ws_nothing'), '');
});

test('linking binds a workspace id to a real local directory', () => {
  const link = linkWorkspace({ workspaceId: 'ws_app', dir: project, name: 'My App' });
  assert.equal(link.path, fs.realpathSync(project));
  assert.equal(link.name, 'My App');
  assert.equal(link.mode, 'read_write');
  assert.equal(resolveLinkedRoot('ws_app'), fs.realpathSync(project));
  assert.equal(fs.existsSync(LINKS_FILE), true);
});

test('the registry file is owner-only', () => {
  const mode = fs.statSync(LINKS_FILE).mode & 0o777;
  assert.equal(mode, 0o600, 'workspace links must not be world-readable, got ' + mode.toString(8));
});

test('a linked workspace resolves to the real directory, not the managed path', () => {
  assert.equal(resolveWorkspaceRoot('ws_app'), fs.realpathSync(project));
  // an unlinked id still resolves to the managed location
  assert.equal(resolveWorkspaceRoot('ws_other'), path.join(BASE, '.workspaces', 'ws_other'));
});

test('a link wins over the legacy current/default label', () => {
  assert.equal(resolveWorkspaceRoot('ws_app', 'current'), fs.realpathSync(project));
});

test('dangerous link targets are refused', () => {
  assert.equal(validateLinkTarget('').ok, false);
  assert.equal(validateLinkTarget(path.join(tmp, 'nope')).ok, false);
  assert.equal(validateLinkTarget(path.parse(process.cwd()).root).ok, false);
  assert.equal(validateLinkTarget(os.homedir()).ok, false);
  // a file is not a directory
  const file = path.join(project, 'app.js');
  assert.equal(validateLinkTarget(file).ok, false);
  // the agent state directory holds credentials and the audit chain
  fs.mkdirSync(STATE_DIR, { recursive: true });
  assert.equal(validateLinkTarget(STATE_DIR).ok, false);
  // ...and so does anything containing it
  assert.equal(validateLinkTarget(path.dirname(STATE_DIR)).ok, false);
  assert.throws(() => linkWorkspace({ workspaceId: 'ws_evil', dir: STATE_DIR }), /state directory/);
});

test('discovery reports linked workspaces alongside managed ones', () => {
  fs.mkdirSync(path.join(BASE, '.workspaces', 'ws_managed'), { recursive: true });
  fs.writeFileSync(path.join(BASE, '.workspaces', 'ws_managed', 'a.txt'), 'hi');
  const found = discoverLocalWorkspaces(BASE);
  const app = found.find((w) => w.workspaceId === 'ws_app');
  const managed = found.find((w) => w.workspaceId === 'ws_managed');
  assert.ok(app, 'linked workspace must be discoverable for cloud sync');
  assert.equal(app.linked, true);
  assert.equal(app.root, fs.realpathSync(project));
  assert.equal(app.fileCount, 1);
  assert.ok(managed);
  assert.equal(managed.linked, false);
});

test('unlinking removes the mapping and never deletes files', () => {
  assert.equal(unlinkWorkspace('ws_app'), true);
  assert.equal(resolveLinkedRoot('ws_app'), '');
  assert.equal(fs.existsSync(path.join(project, 'app.js')), true, 'unlink must never touch user files');
  assert.equal(unlinkWorkspace('ws_app'), false, 'unlinking twice is a no-op');
});

test('a link whose target disappeared resolves to nothing', () => {
  const gone = path.join(tmp, 'temporary');
  fs.mkdirSync(gone, { recursive: true });
  linkWorkspace({ workspaceId: 'ws_gone', dir: gone });
  fs.rmSync(gone, { recursive: true, force: true });
  assert.equal(resolveLinkedRoot('ws_gone'), '', 'a vanished target must not resolve');
  assert.equal(discoverLocalWorkspaces(BASE).some((w) => w.workspaceId === 'ws_gone'), false);
});

test('a corrupt registry degrades to no links', () => {
  fs.writeFileSync(LINKS_FILE, 'not json at all');
  assert.deepEqual(readLinks(), {});
});
