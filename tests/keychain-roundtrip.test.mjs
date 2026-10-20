// Opt-in: ORCHARD_KEYCHAIN_TEST=1 node --test tests/keychain-roundtrip.test.mjs
// Writes a dummy (random, not a key) value to the real login Keychain through `security -i`,
// reads it back, compares SHA-256, and always deletes the item, then confirms it is gone.
// It proves the stdin path keeps more than getpass's 128 characters.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { deleteItem, itemExists, sha256, storeAndVerify } from '../lib/keychain.mjs';
import { run } from '../lib/run.mjs';

const SERVICE = 'orchard.test.roundtrip';
const ACCOUNT = 'TESTKEY';
const enabled = process.env.ORCHARD_KEYCHAIN_TEST === '1';

test('real Keychain round trip through security -i (opt-in)', { skip: !enabled && 'set ORCHARD_KEYCHAIN_TEST=1 to run' }, (t) => {
  assert.equal(itemExists({ service: SERVICE, account: ACCOUNT, run }), false, 'start from no item');
  // 254 random bytes → 340 base64 characters with one "=" of padding; retry until "+" and "/" appear too.
  let bytes;
  do bytes = randomBytes(254); while (!/[+]/.test(bytes.toString('base64')) || !/[/]/.test(bytes.toString('base64')));
  const b64 = bytes.toString('base64');
  assert.equal(b64.length, 340);
  try {
    const res = storeAndVerify({ service: SERVICE, account: ACCOUNT, label: `orchard App Store Connect key ${ACCOUNT}`, bytes, run });
    t.diagnostic(res.detail);
    assert.ok(res.ok, res.detail);
    assert.equal(res.storedLength, 340);
    assert.equal(res.bytes, 254);
    // The label carries spaces inside quotes: check security -i kept it whole.
    const attrs = run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT], { timeoutMs: 30_000 });
    // macOS prints the label attribute as "labl" or as its raw id 0x00000007.
    assert.match(attrs.stdout, /(?:"labl"|0x00000007) ?<blob>="orchard App Store Connect key TESTKEY"/);
    t.diagnostic(`sha256 prefix of the dummy bytes: ${sha256(bytes).slice(0, 12)} (dummy data, not a key)`);
  } finally {
    const d = deleteItem({ service: SERVICE, account: ACCOUNT, run });
    t.diagnostic(`cleanup: ${d}`);
  }
  assert.equal(itemExists({ service: SERVICE, account: ACCOUNT, run }), false, 'item deleted');
});
