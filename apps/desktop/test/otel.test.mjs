// OTel shim — no-op when @opentelemetry/api is absent (the default).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const otel = await import('../src/otel.js');

describe('otel shim', () => {
  it('reports disabled without @opentelemetry/api', async () => {
    const ok = await otel.initOtel();
    assert.equal(ok, false);
    assert.equal(otel.isOtelEnabled(), false);
  });

  it('startSpan/endSpan/setSpanAttrs are safe no-ops', () => {
    const span = otel.startSpan('task.run', { runId: 'x' });
    assert.equal(span, null);
    otel.endSpan(span, false);
    otel.setSpanAttrs(span, { tokens: 3 });
    // reaching here without throwing is the assertion
  });
});
