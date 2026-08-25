import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyChecksum } from '../src/update.js';

const bytes = Buffer.from('release artifact');
const digest = createHash('sha256').update(bytes).digest('hex');
const filename = 'mona-agent-v2.11.0.tar.gz';

test('release checksum parser accepts one exact LF or CRLF entry', () => {
  assert.equal(verifyChecksum(bytes, `${'0'.repeat(64)}  other.tar.gz\n${digest}  ${filename}\n`, filename).ok, true);
  assert.equal(verifyChecksum(bytes, `${'0'.repeat(64)}  other.tar.gz\r\n${digest} *${filename}\r\n`, filename).ok, true);
});

test('release checksum parser rejects missing, malformed, duplicate, or suffix entries', () => {
  assert.equal(verifyChecksum(bytes, `${digest}  prefix-${filename}\n`, filename).ok, false);
  assert.equal(verifyChecksum(bytes, `not-a-digest  ${filename}\n`, filename).ok, false);
  assert.equal(verifyChecksum(bytes, `${digest}  ${filename}\n${digest}  ${filename}\n`, filename).ok, false);
  assert.equal(verifyChecksum(Buffer.from('tampered'), `${digest}  ${filename}\n`, filename).ok, false);
});
