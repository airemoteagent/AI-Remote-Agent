// M3 — indexer tests: Auto-Index + inkrementelles Indexing.
//
// Alle State wird unter einem tmp-HOME isoliert. Die Env-Variablen MÜSSEN vor
// dem Import von indexer.js gesetzt werden, weil die Modul-Konstanten
// (WORKSPACE, STORE_PATH, META_PATH) beim Import gelesen werden.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-indexer-'));
const HOME = path.join(TMP, 'home');
const WS = path.join(TMP, 'workspace');
const STORE = path.join(TMP, 'vector-index.json');
const META = path.join(HOME, '.remote-agent', 'vector-index-meta.json');

process.env.HOME = HOME;
process.env.REMOTE_WORKSPACE = WS;
process.env.REMOTE_VECTOR_STORE = STORE;

const { indexWorkspace, indexSessionSummary, indexerStatus } = await import('../src/indexer.js');

function seedWorkspace() {
  fs.mkdirSync(WS, { recursive: true });
  fs.mkdirSync(path.join(WS, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'a.txt'),
    '# Alpha notes\nDeploy uses port 65002 for ssh on the staging box, restart nginx after every config change.');
  fs.writeFileSync(path.join(WS, 'b.md'),
    '# Beta notes\nChocolate cake bakes at 180 degrees for 35 minutes, serve with vanilla ice cream.');
  fs.writeFileSync(path.join(WS, 'sub', 'c.js'),
    '// Gamma\nexport function gamma(x) { return x * 2; } // doubles any input value immediately');
  fs.writeFileSync(path.join(WS, 'empty.txt'), '');                                            // → skipped: empty
  fs.writeFileSync(path.join(WS, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x1f, 0x0b, 0x7f])); // → skipped: binary
}

before(() => seedWorkspace());

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.REMOTE_WORKSPACE;
  delete process.env.REMOTE_VECTOR_STORE;
  delete process.env.HOME;
});

describe('indexWorkspace — inkrementelles Indexing', () => {
  test('erster Lauf indexiert alle neuen Dateien, überspringt binary/empty', async () => {
    const r = await indexWorkspace();
    assert.equal(r.indexed, 3, JSON.stringify(r));
    assert.equal(r.newFiles, 3, JSON.stringify(r));
    assert.equal(r.updated, 0, JSON.stringify(r));
    assert.equal(r.skipped, 2, JSON.stringify(r)); // empty.txt + bin.dat
    assert.equal(r.errors, 0, JSON.stringify(r));

    assert.ok(fs.existsSync(META), 'meta cache geschrieben');
    const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
    assert.deepEqual(Object.keys(meta).sort(), ['a.txt', 'b.md', 'sub/c.js']);
  });

  test('unveränderter Workspace → zweiter Lauf indexiert 0 neue', async () => {
    const r = await indexWorkspace();
    assert.equal(r.indexed, 0, JSON.stringify(r));
    assert.equal(r.newFiles, 0, JSON.stringify(r));
    assert.equal(r.updated, 0, JSON.stringify(r));
    assert.equal(r.skipped, 2, JSON.stringify(r)); // skipped files werden erneut geprüft
  });

  test('force: true indexiert alles neu, zählt aber keine neuen Dateien', async () => {
    const r = await indexWorkspace({ force: true });
    assert.equal(r.indexed, 3, JSON.stringify(r));
    assert.equal(r.newFiles, 0, JSON.stringify(r));
    assert.equal(r.updated, 3, JSON.stringify(r));
  });

  test('mtime-Bump auf genau einer Datei → genau 1 neu indexiert', async () => {
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(WS, 'a.txt'), t, t);
    const r = await indexWorkspace();
    assert.equal(r.indexed, 1, JSON.stringify(r));
    assert.equal(r.updated, 1, JSON.stringify(r));
    assert.equal(r.newFiles, 0, JSON.stringify(r));
  });

  test('gelöschte Datei verschwindet aus Meta-Cache und Store', async () => {
    const beforeStatus = await indexerStatus();
    fs.rmSync(path.join(WS, 'sub', 'c.js'));
    const r = await indexWorkspace();
    assert.equal(r.indexed, 0, JSON.stringify(r));
    const st = await indexerStatus();
    assert.equal(st.cachedFiles, 2, JSON.stringify(st));
    assert.ok(st.entries < beforeStatus.entries, `Store geschrumpft: ${beforeStatus.entries} -> ${st.entries}`);
  });

  test('fehlender Workspace crasht nicht und lässt Cache unangetastet', async () => {
    const stBefore = await indexerStatus();
    const moved = WS + '-moved';
    fs.renameSync(WS, moved);
    try {
      const r = await indexWorkspace();
      assert.ok(r.error && r.error.includes('Workspace not found'), JSON.stringify(r));
      const stAfter = await indexerStatus();
      assert.equal(stAfter.cachedFiles, stBefore.cachedFiles, 'Cache darf nicht gelöscht werden');
    } finally {
      fs.renameSync(moved, WS);
    }
  });
});

describe('indexSessionSummary + indexerStatus', () => {
  test('Session-Zusammenfassung landet als source=session im Store', async () => {
    const beforeEntries = (await indexerStatus()).entries;
    const r = await indexSessionSummary('session note about the staging deploy', { session: 's-1' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(typeof r.id, 'string');
    const st = await indexerStatus();
    assert.equal(st.entries, beforeEntries + 1);
  });

  test('leere Zusammenfassung wird abgelehnt', async () => {
    const r = await indexSessionSummary('   ');
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });

  test('indexerStatus bleibt konsistent', async () => {
    const st = await indexerStatus();
    assert.equal(st.workspace, WS);
    assert.equal(st.cachedFiles, 2); // a.txt + b.md (c.js wurde gelöscht)
    assert.equal(typeof st.lastRun, 'number');
    assert.ok(st.entries > 0);
  });
});
