// M5 Context Manager tests — budget + compression for the system prompt.
// Verifies: total budget cap, per-block caps, back-cut truncation,
// budgetLog accounting, untrusted markers surviving compression, and the
// fixed first-fit order (most important first).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_BUDGETS, buildContext, summarizeBudget } from '../src/context.js';

const TOTAL_BUDGET = Object.values(CONTEXT_BUDGETS).reduce((a, b) => a + b, 0);

// Fixed first-fit order from the spec (most important first).
// workspaceMap is the locally-built structure digest: it sits directly after
// env so the model is oriented before it spends tokens exploring.
const PRIORITY_ORDER = ['systemRules', 'env', 'workspaceMap', 'persona', 'policy', 'skills', 'vector', 'sessions', 'memory'];

const INPUT_KEYS = {
  systemRules: 'systemRules',
  env: 'envSnapshot',
  workspaceMap: 'workspaceMap',
  persona: 'persona',
  policy: 'policySummary',
  skills: 'skills',
  vector: 'vectorContext',
  sessions: 'sessionContext',
  memory: 'memoryContext',
};

// Build a realistic untrusted block: heading + markers + body + footer,
// exactly the shape the existing context producers emit.
function untrustedBlock(name, body) {
  return `\n\n## ${name} block\n<untrusted-${name}>\n${body}\n</untrusted-${name}>\n(Reference only.)`;
}

function allInputs(makeBlock) {
  const inputs = {};
  for (const name of PRIORITY_ORDER) inputs[INPUT_KEYS[name]] = makeBlock(name);
  return inputs;
}

describe('buildContext budget', () => {
  test('all nine blocks fit under the total budget, untruncated, in priority order', () => {
    const inputs = allInputs((name) => untrustedBlock(name, `content ${name} `.repeat(20)));
    const { prompt, budgetLog } = buildContext(inputs);

    assert.ok(budgetLog.totalChars <= TOTAL_BUDGET, `total ${budgetLog.totalChars} <= ${TOTAL_BUDGET}`);
    assert.equal(budgetLog.totalChars, prompt.length, 'totalChars is the real prompt length');
    assert.deepEqual(budgetLog.truncated, []);
    assert.equal(
      Object.values(budgetLog.perBlock).reduce((a, b) => a + b, 0),
      budgetLog.totalChars,
      'perBlock sums to totalChars when nothing is cut'
    );
    for (const name of PRIORITY_ORDER) {
      assert.equal(budgetLog.perBlock[name], inputs[INPUT_KEYS[name]].length, `${name} kept whole`);
    }
    // Fixed order: systemRules first, memory last.
    let prev = -1;
    for (const name of PRIORITY_ORDER) {
      const at = prompt.indexOf(`<untrusted-${name}>`);
      assert.ok(at > prev, `${name} appears after the previous block`);
      prev = at;
    }
  });

  test('huge memory is truncated to its budget while systemRules stays full', () => {
    const sysRules = 'system rule line\n'.repeat(50); // ~850 chars, under its 2500 budget
    const inputs = {
      systemRules: sysRules,
      envSnapshot: untrustedBlock('env', 'E'.repeat(100)),
      workspaceMap: untrustedBlock('workspaceMap', 'W'.repeat(100)),
      persona: untrustedBlock('persona', 'P'.repeat(100)),
      policySummary: untrustedBlock('policy', 'POL'.repeat(100)),
      skills: untrustedBlock('skills', 'S'.repeat(100)),
      vectorContext: untrustedBlock('vector', 'V'.repeat(100)),
      sessionContext: untrustedBlock('sessions', 'SE'.repeat(100)),
      memoryContext: untrustedBlock('memory', 'M'.repeat(100000)),
    };
    const { prompt, budgetLog } = buildContext(inputs);

    assert.ok(budgetLog.totalChars <= TOTAL_BUDGET);
    assert.ok(budgetLog.perBlock.memory <= CONTEXT_BUDGETS.memory, `memory ${budgetLog.perBlock.memory} <= ${CONTEXT_BUDGETS.memory}`);
    assert.ok(budgetLog.truncated.includes('memory'), 'memory is reported as truncated');
    assert.equal(budgetLog.perBlock.systemRules, sysRules.length, 'systemRules kept in full');
    assert.ok(prompt.includes(sysRules), 'systemRules content present verbatim');
    assert.ok(prompt.includes('<untrusted-memory>'), 'memory open marker survives');
    assert.ok(prompt.includes('</untrusted-memory>'), 'memory close marker survives');
  });

  test('every oversized block is capped to its own budget and keeps its markers', () => {
    const inputs = allInputs((name) => untrustedBlock(name, 'y'.repeat(CONTEXT_BUDGETS[name] * 3)));
    const { prompt, budgetLog } = buildContext(inputs);

    assert.ok(budgetLog.totalChars <= TOTAL_BUDGET, `total ${budgetLog.totalChars} <= ${TOTAL_BUDGET}`);
    for (const name of PRIORITY_ORDER) {
      assert.ok(
        budgetLog.perBlock[name] <= CONTEXT_BUDGETS[name],
        `${name} ${budgetLog.perBlock[name]} <= ${CONTEXT_BUDGETS[name]}`
      );
      assert.ok(budgetLog.truncated.includes(name), `${name} reported truncated`);
      assert.ok(prompt.includes(`<untrusted-${name}>`), `${name} open marker survives`);
      assert.ok(prompt.includes(`</untrusted-${name}>`), `${name} close marker survives`);
    }
    assert.equal(
      Object.values(budgetLog.perBlock).reduce((a, b) => a + b, 0),
      TOTAL_BUDGET,
      'all capped blocks fill exactly the total budget'
    );
  });

  test('plain (unmarkered) oversized block is truncated plainly', () => {
    const big = 'rule-'.repeat(2000); // 10000 chars, no markers
    const { prompt, budgetLog } = buildContext({ systemRules: big });
    assert.ok(budgetLog.perBlock.systemRules <= CONTEXT_BUDGETS.systemRules);
    assert.deepEqual(budgetLog.truncated, ['systemRules']);
    assert.ok(prompt.length <= CONTEXT_BUDGETS.systemRules);
    assert.ok(prompt.startsWith(big.slice(0, 50)), 'keeps the head of the rules');
  });

  test('back-cut drops the right block when earlier blocks are empty', () => {
    // Regression: the back-cut used to address `parts` by BLOCK_ORDER index,
    // which points at the WRONG block as soon as any earlier block is empty —
    // it could delete a high-priority block instead of the low-priority one.
    const inputs = {
      // systemRules, env, workspaceMap, persona, policy, skills all empty
      vectorContext: untrustedBlock('vector', 'V'.repeat(CONTEXT_BUDGETS.vector * 2)),
      sessionContext: untrustedBlock('sessions', 'SE'.repeat(CONTEXT_BUDGETS.sessions)),
      memoryContext: untrustedBlock('memory', 'M'.repeat(CONTEXT_BUDGETS.memory * 2)),
    };
    const { prompt, budgetLog } = buildContext(inputs);
    assert.ok(budgetLog.totalChars <= TOTAL_BUDGET);
    for (const name of ['vector', 'sessions', 'memory']) {
      assert.ok(prompt.includes(`<untrusted-${name}>`), `${name} block must survive the back-cut`);
      assert.ok(budgetLog.perBlock[name] <= CONTEXT_BUDGETS[name]);
    }
    // Order is preserved: vector before sessions before memory.
    assert.ok(prompt.indexOf('<untrusted-vector>') < prompt.indexOf('<untrusted-sessions>'));
    assert.ok(prompt.indexOf('<untrusted-sessions>') < prompt.indexOf('<untrusted-memory>'));
  });

  test('empty and missing inputs never crash and produce an empty prompt', () => {
    const empty = buildContext({});
    assert.equal(empty.prompt, '');
    assert.equal(empty.budgetLog.totalChars, 0);
    assert.deepEqual(empty.budgetLog.truncated, []);
    assert.deepEqual(
      Object.values(empty.budgetLog.perBlock).every((v) => v === 0),
      true
    );

    const nul = buildContext(null);
    assert.equal(nul.prompt, '');

    const partial = buildContext({ systemRules: 'SR', memoryContext: '' });
    assert.equal(partial.prompt, 'SR');
    assert.equal(partial.budgetLog.perBlock.memory, 0);
  });
});

describe('budgetLog + summarizeBudget', () => {
  test('budgetLog is precise and summarizeBudget returns one line', () => {
    const inputs = {
      systemRules: 'rule one\nrule two',
      envSnapshot: untrustedBlock('env', 'E1'),
      workspaceMap: untrustedBlock('workspaceMap', 'W1'),
      persona: untrustedBlock('persona', 'P1'),
      policySummary: untrustedBlock('policy', 'POL1'),
      skills: untrustedBlock('skills', 'S1'),
      vectorContext: untrustedBlock('vector', 'V1'),
      sessionContext: untrustedBlock('sessions', 'SE1'),
      memoryContext: untrustedBlock('memory', 'M1'),
    };
    const { prompt, budgetLog } = buildContext(inputs);
    assert.equal(budgetLog.totalChars, prompt.length);
    assert.equal(budgetLog.perBlock.systemRules, inputs.systemRules.length);
    assert.equal(budgetLog.perBlock.env, inputs.envSnapshot.length);
    assert.equal(budgetLog.perBlock.memory, inputs.memoryContext.length);
    assert.deepEqual(budgetLog.truncated, []);

    const s = summarizeBudget(budgetLog);
    assert.equal(typeof s, 'string');
    assert.ok(!s.includes('\n'), 'summary is a single line');
    assert.ok(s.includes(String(budgetLog.totalChars)), 'summary carries total chars');
    assert.ok(s.includes('truncated: none'), 'summary carries truncated state');

    const cut = buildContext({ memoryContext: untrustedBlock('memory', 'M'.repeat(50000)) });
    const scut = summarizeBudget(cut.budgetLog);
    assert.ok(scut.includes('memory'), 'summary names the truncated block');
    assert.ok(!scut.includes('\n'), 'still one line after a cut');
  });

  test('summarizeBudget never crashes on junk', () => {
    assert.equal(typeof summarizeBudget(), 'string');
    assert.equal(typeof summarizeBudget(null), 'string');
    assert.equal(typeof summarizeBudget({ totalChars: 42, perBlock: {}, truncated: [] }), 'string');
  });
});
