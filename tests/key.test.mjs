import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { addCommandLine, APPROVAL_TIMEOUT_MS, materializeKey, redact, validateP8 } from '../lib/keychain.mjs';
import { cleanup, cli, FIXTURE_MANIFEST, makeRoot, REPO, stubRunner, tmp } from './helpers.mjs';

after(cleanup);

// Throwaway keys generated per run; nothing here is a real credential.
const P8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const P8_OTHER = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const RSA = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const B64 = Buffer.from(P8).toString('base64');
const KEY_ID = 'ABC123DEFG';
const ISSUER = '69a6de7e-1111-2222-3333-444455556666';

/**
 * A fake Keychain behind a stubbed /usr/bin/security that parses the `security -i` line. Like the
 * real one, adding an item that exists fails with "already exists" (security -i still exits 0).
 */
function fakeKeychain({ truncateTo = null } = {}) {
  const items = new Map();
  const run = stubRunner({
    '/usr/bin/security': (args, opts) => {
      if (args[0] === '-i') {
        const m = /^add-generic-password -s (\S+) -a (\S+) -l "([^"]+)"( -T "")? -w (\S+)\n$/.exec(opts.input);
        if (!m) return { code: 0, stderr: 'security: unparsed line' };
        if (items.has(`${m[1]}/${m[2]}`)) return { code: 0, stderr: 'security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.' };
        items.set(`${m[1]}/${m[2]}`, { label: m[3], requireApproval: Boolean(m[4]), value: truncateTo ? m[5].slice(0, truncateTo) : m[5] });
        return { code: 0, stdout: 'security> ' };
      }
      const s = args[args.indexOf('-s') + 1];
      const a = args.includes('-a') ? args[args.indexOf('-a') + 1] : null;
      const hit = [...items].find(([k]) => k.startsWith(`${s}/`) && (!a || k === `${s}/${a}`));
      if (args[0] === 'find-generic-password') {
        if (!hit) return { code: 44, stderr: 'The specified item could not be found in the keychain.' };
        return args.includes('-w') ? { stdout: `${hit[1].value}\n` } : { stdout: 'keychain: "login.keychain-db"\n' };
      }
      if (args[0] === 'delete-generic-password') {
        if (!hit) return { code: 44 };
        items.delete(hit[0]);
        return { code: 0 };
      }
      return { code: 1 };
    },
  });
  return { run, items };
}

function p8File(content = P8, keyId = KEY_ID) {
  const f = join(tmp(), `AuthKey_${keyId}.p8`);
  writeFileSync(f, content);
  return f;
}

test('the security -i line: base64 last, label quoted, no -U, nothing unsafe allowed through', () => {
  assert.equal(
    addCommandLine({ service: 'orchard.asc.p8', account: KEY_ID, label: `orchard App Store Connect key ${KEY_ID}`, b64: 'QUJD+/9=' }),
    `add-generic-password -s orchard.asc.p8 -a ${KEY_ID} -l "orchard App Store Connect key ${KEY_ID}" -w QUJD+/9=\n`,
  );
  // --require-approval: an empty trusted-application list, so each read asks. Only the line is
  // tested; a real -T "" item would raise a dialog on screen.
  assert.equal(
    addCommandLine({ service: 'orchard.asc.p8', account: KEY_ID, label: 'l', b64: 'QQ==', requireApproval: true }),
    `add-generic-password -s orchard.asc.p8 -a ${KEY_ID} -l "l" -T "" -w QQ==\n`,
  );
  assert.throws(() => addCommandLine({ service: 'a b', account: 'x', label: 'l', b64: 'QQ==' }), /service/);
  assert.throws(() => addCommandLine({ service: 's', account: 'x"y', label: 'l', b64: 'QQ==' }), /account/);
  assert.throws(() => addCommandLine({ service: 's', account: 'x', label: 'l"', b64: 'QQ==' }), /label/);
  assert.throws(() => addCommandLine({ service: 's', account: 'x', label: 'l', b64: 'not base64!' }), /base64/);
});

test('import feeds the key over stdin, never argv, verifies by hash and writes asc.json 0600', async () => {
  const home = tmp('orchard-home-');
  const { run, items } = fakeKeychain();
  const r = await cli(['key', 'import', p8File(), '--key-id', KEY_ID, '--issuer-id', ISSUER], { root: makeRoot(), run, home });
  assert.equal(r.code, 0, r.err);
  const sec = run.calls.filter((c) => c.cmd === '/usr/bin/security');
  const add = sec.find((c) => c.args[0] === '-i');
  assert.deepEqual(add.args, ['-i'], 'only -i in argv');
  assert.equal(add.opts.input, `add-generic-password -s orchard.asc.p8 -a ${KEY_ID} -l "orchard App Store Connect key ${KEY_ID}" -w ${B64}\n`);
  assert.ok(B64.length > 128, 'longer than getpass would keep');
  for (const c of run.calls) assert.ok(!c.args.join(' ').includes(B64.slice(0, 40)), 'key never in argv');
  assert.deepEqual(sec.find((c) => c.args.includes('-w')).args, ['find-generic-password', '-s', 'orchard.asc.p8', '-a', KEY_ID, '-w']);
  assert.equal(items.get(`orchard.asc.p8/${KEY_ID}`).value, B64);
  const cfgFile = join(home, '.config/orchard/asc.json');
  assert.equal(statSync(cfgFile).mode & 0o777, 0o600);
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  assert.deepEqual(Object.keys(cfg).sort(), ['importedAt', 'issuerId', 'keyId', 'requireApproval', 'service']);
  assert.equal(cfg.keyId, KEY_ID);
  assert.equal(cfg.requireApproval, false);
  assert.match(r.out, /Any process running as you can read this item without a prompt/);
  assert.match(r.out, /SHA-256 match/);
  assert.match(r.out, /did not delete/);
  for (const s of [r.out, r.err]) {
    assert.ok(!s.includes(B64.slice(0, 40)));
    assert.ok(!s.includes(P8.split('\n')[1]));
  }
});

test('import never overwrites a key silently: an existing item needs --replace', async () => {
  const home = tmp('orchard-home-');
  const { run, items } = fakeKeychain();
  const root = makeRoot();
  assert.equal((await cli(['key', 'import', p8File(), '--key-id', KEY_ID, '--issuer-id', ISSUER], { root, run, home })).code, 0);
  const other = Buffer.from(P8_OTHER).toString('base64');
  let r = await cli(['key', 'import', p8File(P8_OTHER), '--key-id', KEY_ID, '--issuer-id', ISSUER], { root, run, home });
  assert.equal(r.code, 1);
  assert.match(r.err, /already holds an item for key ABC123DEFG[\s\S]*--replace: the item is deleted and this file stored in its place/);
  assert.equal(items.get(`orchard.asc.p8/${KEY_ID}`).value, B64, 'the first key is untouched');
  r = await cli(['key', 'import', p8File(P8_OTHER), '--key-id', KEY_ID, '--issuer-id', ISSUER, '--replace'], { root, run, home });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /replacing the item that was there/);
  assert.equal(items.get(`orchard.asc.p8/${KEY_ID}`).value, other);
  const order = run.calls.filter((c) => c.cmd === '/usr/bin/security' && ['delete-generic-password', '-i'].includes(c.args[0])).map((c) => c.args[0]);
  assert.deepEqual(order.slice(-2), ['delete-generic-password', '-i'], 'replace deletes, then adds');
});

test('import refuses a file named for another key ID', async () => {
  const { run } = fakeKeychain();
  const r = await cli(['key', 'import', p8File(P8, 'ZZZ999YYYX'), '--key-id', KEY_ID, '--issuer-id', ISSUER], { root: makeRoot(), run, home: tmp() });
  assert.equal(r.code, 1);
  assert.match(r.err, /named for key ZZZ999YYYX, but --key-id is ABC123DEFG/);
  assert.ok(!run.calls.some((c) => c.args[0] === '-i'), 'nothing stored');
});

test('--require-approval: an empty trusted-app list, a longer wait for the read-back, and the Allow caveat', async () => {
  const home = tmp('orchard-home-');
  const { run, items } = fakeKeychain();
  const root = makeRoot();
  const r = await cli(['key', 'import', p8File(), '--key-id', KEY_ID, '--issuer-id', ISSUER, '--require-approval'], { root, run, home });
  assert.equal(r.code, 0, r.err);
  const add = run.calls.find((c) => c.args[0] === '-i');
  assert.match(add.opts.input, / -T "" -w /);
  assert.equal(items.get(`orchard.asc.p8/${KEY_ID}`).requireApproval, true);
  const read = run.calls.find((c) => c.args.includes('-w') && c.args[0] === 'find-generic-password');
  assert.equal(read.opts.timeoutMs, APPROVAL_TIMEOUT_MS, 'time to find the dialog and click Allow');
  assert.match(r.out, /Click Allow, not Always Allow/);
  assert.equal(JSON.parse(readFileSync(join(home, '.config/orchard/asc.json'), 'utf8')).requireApproval, true);
  const c = await cli(['key', 'check'], { root, run, home });
  assert.match(c.out, /Click Allow, not Always Allow/);
});

test('a truncated round trip fails and writes no config', async () => {
  const home = tmp('orchard-home-');
  const { run } = fakeKeychain({ truncateTo: 128 });
  const r = await cli(['key', 'import', p8File(), '--key-id', KEY_ID, '--issuer-id', ISSUER], { root: makeRoot(), run, home });
  assert.equal(r.code, 1);
  assert.match(r.err, /MISMATCH: wrote \d+ base64 characters, read back 128/);
  assert.ok(!existsSync(join(home, '.config/orchard/asc.json')));
});

test('import refuses files that are not an EC P-256 PKCS#8 key, and bad ids', async () => {
  const { run } = fakeKeychain();
  const root = makeRoot();
  let r = await cli(['key', 'import', p8File(RSA), '--key-id', KEY_ID, '--issuer-id', ISSUER], { root, run, home: tmp() });
  assert.equal(r.code, 1);
  assert.match(r.err, /key type is rsa/);
  r = await cli(['key', 'import', p8File('hello'), '--key-id', KEY_ID, '--issuer-id', ISSUER], { root, run, home: tmp() });
  assert.match(r.err, /not a PEM PKCS#8/);
  assert.equal((await cli(['key', 'import', p8File(), '--key-id', 'A B', '--issuer-id', ISSUER], { root, run })).code, 2);
  assert.equal((await cli(['key', 'import', p8File(), '--key-id', KEY_ID, '--issuer-id', 'nope'], { root, run })).code, 2);
  assert.ok(!run.calls.some((c) => c.args[0] === '-i'), 'nothing stored');
  assert.deepEqual(validateP8(Buffer.from(P8)), { ok: true, problems: [], curve: 'prime256v1' });
});

test('check reports sizes and type, never the key', async () => {
  const home = tmp('orchard-home-');
  const { run } = fakeKeychain();
  const root = makeRoot();
  let r = await cli(['key', 'check'], { root, run, home });
  assert.equal(r.code, 1);
  assert.match(r.out, /absent/);
  await cli(['key', 'import', p8File(), '--key-id', KEY_ID, '--issuer-id', ISSUER], { root, run, home });
  r = await cli(['key', 'check'], { root, run, home });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`${B64.length} base64 characters → ${Buffer.byteLength(P8)} bytes; PEM PKCS#8 EC prime256v1`));
  assert.ok(!r.out.includes(B64.slice(0, 40)));
});

test('gh-secret refuses without --yes, then pipes each value on stdin', async () => {
  const home = tmp('orchard-home-');
  const { run } = fakeKeychain();
  const root = makeRoot({ manifests: [{ ...FIXTURE_MANIFEST, repo: 'example/fixture' }] });
  await cli(['key', 'import', p8File(), '--key-id', KEY_ID, '--issuer-id', ISSUER], { root, run, home });
  let r = await cli(['key', 'gh-secret', 'fixture'], { root, run, home });
  assert.equal(r.code, 3);
  assert.match(r.err, /Refused/);
  assert.ok(!run.calls.some((c) => c.cmd === 'gh'));
  const gh = [];
  const run2 = (cmd, args, opts) => (cmd === 'gh' ? (gh.push({ args, input: opts.input }), { code: 0, stdout: '', stderr: '' }) : run(cmd, args, opts));
  r = await cli(['key', 'gh-secret', 'fixture', '--env', 'mobile-stores', '--yes'], { root, run: run2, home });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(gh.map((g) => g.args), ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8_B64'].map((n) => ['secret', 'set', n, '--env', 'mobile-stores', '--repo', 'example/fixture']));
  assert.deepEqual(gh.map((g) => g.input), [KEY_ID, ISSUER, B64]);
  assert.ok(!r.out.includes(B64.slice(0, 40)));
});

test('materializeKey: 0700 dir, 0600 file, removed afterwards, also when fn throws', async () => {
  const base = tmp();
  let seen;
  await materializeKey({ keyId: KEY_ID, b64: B64 }, async (file) => {
    seen = file;
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(file, '..')).mode & 0o777, 0o700);
    assert.equal(readFileSync(file, 'utf8'), P8);
    assert.match(file, /AuthKey_ABC123DEFG\.p8$/);
  }, { baseDir: base });
  assert.ok(!existsSync(seen));
  await assert.rejects(materializeKey({ keyId: KEY_ID, b64: B64 }, async (file) => {
    seen = file;
    throw new Error('boom');
  }, { baseDir: base }), /boom/);
  assert.ok(!existsSync(join(seen, '..')));
});

/** Runs materializeKey in a child node process whose `fn` sleeps in a spawnSync child, as orchard's commands do. */
function keyChild(base, body) {
  const src = `
    import { materializeKey } from ${JSON.stringify(join(REPO, 'lib/keychain.mjs'))};
    import { run } from ${JSON.stringify(join(REPO, 'lib/run.mjs'))};
    await materializeKey({ keyId: 'DUMMY12345', b64: Buffer.from('dummy, not a key').toString('base64') }, async (file) => {
      console.log(file);
      ${body}
    }, { baseDir: ${JSON.stringify(base)} });
  `;
  // detached: its own process group, so a group signal reaches the sleeping child too (like Ctrl-C).
  return spawn(process.execPath, ['--input-type=module', '-e', src], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function exitOf(child) {
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  test(`materializeKey removes the key on ${sig} and still ends with that signal`, async () => {
    const base = tmp();
    const child = keyChild(base, "run('/bin/sleep', ['10'], { timeoutMs: 30_000 });");
    const done = exitOf(child);
    const file = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(String(d).trim())));
    assert.ok(existsSync(file), 'the key file exists while fn runs');
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the sleep start, so the signal lands mid-command
    process.kill(-child.pid, sig);
    const { code, signal } = await done;
    assert.ok(signal === sig || code === 128 + { SIGINT: 2, SIGTERM: 15 }[sig], `ended by ${sig} (code ${code}, signal ${signal})`);
    assert.deepEqual(readdirSync(base), [], 'no orchard-key-* directory left');
  });
}

test('materializeKey removes the key when fn calls process.exit', async () => {
  const base = tmp();
  const child = keyChild(base, 'process.exit(3);');
  const { code } = await exitOf(child);
  assert.equal(code, 3);
  assert.deepEqual(readdirSync(base), []);
});

test('redact removes given secrets and long base64 runs', () => {
  assert.equal(redact('x SECRETVALUE y', ['SECRETVALUE']), 'x [redacted] y');
  assert.equal(redact(`e ${B64} f`), 'e [redacted] f');
});

test('key without a subcommand prints help and exits 2', async () => {
  const r = await cli(['key'], { root: makeRoot() });
  assert.equal(r.code, 2);
  assert.match(r.out, /orchard key import/);
});
