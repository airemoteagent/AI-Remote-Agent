// device-control — the deep-dive + control logic, unit-tested offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProcess, bucketOf, parseCpuTime, parsePsOutput, parseLoadAvg, parseSwapUsage,
  cpuFromDelta, buildCensus, selectGroup, planMode, isProtectedPid, formatBudget, BUCKETS,
} from '../src/device-control.js';

test('control surfaces are not mistaken for the work they observe', () => {
  assert.equal(classifyProcess('node /Users/x/.dsh/bin/cpu-guard.mjs'), 'control');
  assert.equal(classifyProcess('node /Users/x/.remote-agent/agent/apps/desktop/bin/remote-agent.js start --force'), 'control');
  assert.equal(classifyProcess('node /x/deepdive.mjs'), 'control');
  assert.equal(classifyProcess('node /x/focus.js'), 'control');
});

test('agent brains and automation lanes classify as agent', () => {
  assert.equal(classifyProcess('node /x/@deepseek-ai/dsh/lib/bin.js web --no-open'), 'agent');
  assert.equal(classifyProcess('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --type=renderer'), 'agent');
  assert.equal(classifyProcess('node /x/openclaw/dist/index.js gateway --port 18789'), 'openclaw');
});

test('apps, browser, system and other', () => {
  assert.equal(classifyProcess('/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'), 'apps');
  assert.equal(classifyProcess('/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent'), 'browser');
  assert.equal(classifyProcess('/usr/libexec/logd'), 'system');
  assert.equal(classifyProcess('/opt/weird/bin/thing'), 'other');
});

test('bucketOf folds agent-ish categories into agents', () => {
  assert.equal(bucketOf('agent'), 'agents');
  assert.equal(bucketOf('openclaw'), 'agents');
  assert.equal(bucketOf('agent-browser'), 'agents');
  assert.equal(bucketOf('system'), 'system');
  assert.equal(bucketOf('nope'), 'other');
  assert.deepEqual(BUCKETS, ['agents', 'control', 'apps', 'browser', 'system', 'other']);
});

test('parseCpuTime handles mm:ss, hh:mm:ss, days and locale commas', () => {
  assert.equal(parseCpuTime('1:02.50').toFixed(2), '62.50');
  assert.equal(parseCpuTime('2:03:04'), 7384);
  assert.equal(Math.round(parseCpuTime('1-00:00:01')), 86401);
  assert.equal(parseCpuTime('12,5'), 12.5);
});

test('parsePsOutput reads fields and classifies', () => {
  const txt = '  501     1 mona 20 SN  0:05.00  12345 /usr/local/bin/node /x/.dsh/bin/cpu-guard.mjs\n';
  const [r] = parsePsOutput(txt);
  assert.equal(r.pid, 501);
  assert.equal(r.ppid, 1);
  assert.equal(r.nice, 20);
  assert.equal(r.category, 'control');
  assert.equal(r.rssMB, 12);
});

test('parseLoadAvg accepts braces and comma decimals', () => {
  assert.deepEqual(parseLoadAvg('{ 4,20 8,08 33,05 }'), [4.2, 8.08, 33.05]);
});

test('parseSwapUsage reads mac and generic forms', () => {
  assert.deepEqual(parseSwapUsage('total = 3072,00M  used = 2160,00M  free = 912,00M'), { total: 3072, used: 2160, free: 912 });
});

test('cpuFromDelta never goes negative and clamps the window', () => {
  assert.equal(cpuFromDelta(0, 2, 2), 100);
  assert.equal(cpuFromDelta(5, 5, 2), 0);
  assert.equal(cpuFromDelta(5, 4, 2), 0);
  assert.equal(cpuFromDelta(0, 2, 0), 2000);
});

test('buildCensus buckets cpu and marks protected rows', () => {
  const mk = (pid, cpuSeconds, args, category, rssMB = 300) => ({ pid, ppid: 1, user: 'u', nice: 0, state: 'S', cpuSeconds, rssMB, args, comm: args.split('/').pop(), category });
  const prev = [mk(10, 0, '/System/x/WebKit.WebContent.xpc/x', 'browser'), mk(20, 0, 'node /x/.dsh/bin/dsh-priority.mjs', 'control')];
  const cur = [mk(10, 2, '/System/x/WebKit.WebContent.xpc/x', 'browser'), mk(20, 1, 'node /x/.dsh/bin/dsh-priority.mjs', 'control')];
  const c = buildCensus(prev, cur, 2, { selfPid: 999, portOwners: [20] });
  assert.equal(c.busy, 150);
  assert.equal(c.budget.browser, 100);
  assert.equal(c.budget.control, 50);
  assert.equal(c.rows.find((r) => r.pid === 20).protected, true);
});

test('selectGroup targets the fleet and skips protected', () => {
  const rows = [
    { pid: 1, category: 'agent', protected: false },
    { pid: 2, category: 'agent-browser', protected: true },
    { pid: 3, category: 'control', protected: false },
    { pid: 4, category: 'openclaw', protected: false },
  ];
  assert.deepEqual(selectGroup('agents', rows), [1]);
  assert.deepEqual(selectGroup('all-agents', rows), [1, 4]);
  assert.deepEqual(selectGroup('control', rows), [3]);
  assert.deepEqual(selectGroup('bogus', rows), []);
});

test('planMode is declarative and side-effect free', () => {
  const rows = [{ pid: 7, category: 'agent', protected: false }];
  const g = planMode('gaming', { rows, paused: [] });
  assert.equal(g.gate.cpuGuard, false);
  assert.equal(g.gate.priority, false);
  assert.deepEqual(g.pause, [7]);
  assert.equal(g.noAutoRestart, true);
  const a = planMode('agents', {});
  assert.equal(a.gate.cpuGuard, false);
  assert.equal(a.resume, 'all');
  assert.ok(planMode('nope', {}).error);
});

test('isProtectedPid guards pid 1, self, port owners and core daemons', () => {
  assert.equal(isProtectedPid(1, {}), true);
  assert.equal(isProtectedPid(5, { selfPid: 5 }), true);
  assert.equal(isProtectedPid(9, { portOwners: [9] }), true);
  assert.equal(isProtectedPid(9, { comm: 'WindowServer' }), true);
  assert.equal(isProtectedPid(9, { comm: 'node' }), false);
});

test('formatBudget lists only non-zero buckets', () => {
  assert.equal(formatBudget({ agents: 12, system: 3, apps: 0 }), 'agents 12% · system 3%');
});
