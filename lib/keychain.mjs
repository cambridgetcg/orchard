// The App Store Connect .p8 lives in the login Keychain as base64, nowhere else (DESIGN §5).
//
// Why `security -i` over stdin: `add-generic-password … -w` with no value prompts through
// getpass(3), which silently truncates at 128 characters (a base64 .p8 is about 340), and
// `-w <value>` as an argument puts the secret in argv where `ps` shows it. In interactive mode
// security reads whole command lines from stdin, so the value never touches argv or a prompt.
//
// Threat model, so nobody reads more into the Keychain than it gives. The item is created by
// /usr/bin/security itself, which the item then trusts, so later `find-generic-password -w` reads
// raise no prompt: any process running as Yu (an npm install script, a build step `orchard sim`
// runs, any agent shell) can read the key silently through /usr/bin/security. The Keychain keeps
// the key out of repos, argv, logs and other users' reach; it does not guard it from code running
// as Yu. `orchard key import --require-approval` creates the item with an empty trusted-app list
// (`-T ""`), so every read raises a Keychain dialog that Yu has to allow (docs/KEYS.md).
import { createHash, createPrivateKey } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;
const SAFE_LABEL = /^[A-Za-z0-9 ._-]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Removes any of `secrets` (and long base64 runs) from text before it is shown. */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[redacted]');
  return out.replace(/[A-Za-z0-9+/]{60,}={0,2}/g, '[redacted]');
}

/**
 * The exact line fed to `security -i`. Every token is checked so nothing needs quoting but the
 * label. There is no `-U`: adding over an existing item fails ("already exists") instead of
 * replacing it, so a key can't be overwritten by accident (`key import --replace` deletes first).
 * `requireApproval` adds `-T ""`, an empty trusted-application list, which `man security`
 * documents as removing the creating tool's silent access: each later read asks Yu.
 */
export function addCommandLine({ service, account, label, b64, requireApproval = false }) {
  if (!SAFE_TOKEN.test(service)) throw new Error(`unsafe keychain service name: ${service}`);
  if (!SAFE_TOKEN.test(account)) throw new Error(`unsafe keychain account name: ${account}`);
  if (!SAFE_LABEL.test(label)) throw new Error(`unsafe keychain label: ${label}`);
  if (!BASE64.test(b64)) throw new Error('value is not base64');
  return `add-generic-password -s ${service} -a ${account} -l "${label}"${requireApproval ? ' -T ""' : ''} -w ${b64}\n`;
}

export function storeBase64({ service, account, label, b64, requireApproval = false, run }) {
  const res = run('/usr/bin/security', ['-i'], { input: addCommandLine({ service, account, label, b64, requireApproval }), timeoutMs: 30_000 });
  return { ...res, stdout: redact(res.stdout, [b64]), stderr: redact(res.stderr, [b64]) };
}

/** How long a read waits when the item asks Yu first: long enough to find the dialog and click Allow. */
export const APPROVAL_TIMEOUT_MS = 180_000;

/** Reads the stored base64 value. The value stays in this process; callers must never print it. */
export function readBase64({ service, account, run, timeoutMs = 30_000 }) {
  const args = ['find-generic-password', '-s', service];
  if (account) args.push('-a', account);
  args.push('-w');
  const res = run('/usr/bin/security', args, { timeoutMs });
  if (res.code === 44) return { found: false, b64: null };
  if (res.code !== 0) return { found: null, b64: null, error: redact(res.stderr || `exit ${res.code}`) };
  return { found: true, b64: res.stdout.replace(/\r?\n$/, '') };
}

/** Whether the item exists, without reading the secret (attributes only, discarded). */
export function itemExists({ service, account, run }) {
  const args = ['find-generic-password', '-s', service];
  if (account) args.push('-a', account);
  const res = run('/usr/bin/security', args, { timeoutMs: 30_000 });
  if (res.code === 0) return true;
  if (res.code === 44) return false;
  return null;
}

export function deleteItem({ service, account, run }) {
  const res = run('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], { timeoutMs: 30_000 });
  return res.code === 0 ? 'deleted' : res.code === 44 ? 'absent' : `failed (exit ${res.code})`;
}

/**
 * Checks that the bytes are a PEM PKCS#8 EC private key, as App Store Connect issues them
 * (P-256). Returns problems without ever including key material.
 */
export function validateP8(bytes) {
  const problems = [];
  const text = Buffer.from(bytes).toString('utf8');
  if (!text.includes('-----BEGIN PRIVATE KEY-----') || !text.includes('-----END PRIVATE KEY-----')) {
    problems.push('not a PEM PKCS#8 private key (expected -----BEGIN PRIVATE KEY-----)');
  }
  if (bytes.length < 150 || bytes.length > 2000) problems.push(`unexpected size ${bytes.length} bytes (an App Store Connect .p8 is about 250)`);
  let curve = null;
  try {
    const k = createPrivateKey({ key: Buffer.from(bytes), format: 'pem' });
    if (k.asymmetricKeyType !== 'ec') problems.push(`key type is ${k.asymmetricKeyType}, expected ec`);
    curve = k.asymmetricKeyDetails?.namedCurve ?? null;
    if (curve && curve !== 'prime256v1') problems.push(`curve is ${curve}, expected P-256 (prime256v1)`);
  } catch {
    problems.push('could not be parsed as a private key');
  }
  return { ok: problems.length === 0, problems, curve };
}

/**
 * Stores bytes as base64, reads them back and compares SHA-256 of the decoded bytes.
 * Returns { ok, stored, detail } and never the value.
 */
export function storeAndVerify({ service, account, label, bytes, requireApproval = false, run }) {
  const b64 = Buffer.from(bytes).toString('base64');
  const st = storeBase64({ service, account, label, b64, requireApproval, run });
  if (st.code !== 0 || /error|usage|already exists/i.test(st.stderr)) {
    return { ok: false, detail: `security -i failed: ${st.timedOut ? 'timed out' : (st.stderr.trim() || `exit ${st.code}`)}` };
  }
  const back = readBase64({ service, account, run, timeoutMs: requireApproval ? APPROVAL_TIMEOUT_MS : 30_000 });
  if (!back.found) return { ok: false, detail: `read-back found no item${back.error ? `: ${back.error}` : ''}` };
  const decoded = Buffer.from(back.b64, 'base64');
  const same = back.b64 === b64 && sha256(decoded) === sha256(bytes);
  return {
    ok: same,
    base64Length: b64.length,
    storedLength: back.b64.length,
    bytes: decoded.length,
    detail: same
      ? `round trip verified: ${b64.length} base64 characters, ${decoded.length} bytes, SHA-256 match`
      : `round trip MISMATCH: wrote ${b64.length} base64 characters, read back ${back.b64.length}; the Keychain item may now hold a partial value (orchard key check shows it), so do not rely on it`,
  };
}

export function writeLocalConfig(file, data) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const CLEANUP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Writes the key to a private temporary file for the length of `fn`, then removes it:
 * mktemp-style directory 0700, AuthKey_<id>.p8 0600. Removed when `fn` returns or throws, when
 * it calls process.exit(), and on SIGINT, SIGTERM or SIGHUP, after which the signal is raised
 * again so the process still ends the way the user asked. Nothing can clean up after SIGKILL or
 * a crash; macOS purges the per-user $TMPDIR eventually.
 *
 * Commands run through spawnSync, which holds the event loop, so a signal that arrives during a
 * child is handled once `fn` returns: `finally` removes the file first, then yields one turn so the
 * pending signal is delivered before the handlers go away.
 */
export async function materializeKey({ keyId, b64 }, fn, { baseDir = tmpdir() } = {}) {
  if (!SAFE_TOKEN.test(keyId)) throw new Error('unsafe key id');
  const dir = mkdtempSync(join(baseDir, 'orchard-key-'));
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    rmSync(dir, { recursive: true, force: true });
  };
  const handlers = CLEANUP_SIGNALS.map((sig) => [sig, () => {
    cleanup();
    detach();
    process.kill(process.pid, sig);
  }]);
  function detach() {
    for (const [sig, h] of handlers) process.removeListener(sig, h);
    process.removeListener('exit', cleanup);
  }
  for (const [sig, h] of handlers) process.on(sig, h);
  process.on('exit', cleanup);
  try {
    chmodSync(dir, 0o700);
    const file = join(dir, `AuthKey_${keyId}.p8`);
    writeFileSync(file, Buffer.from(b64, 'base64'), { mode: 0o600, flag: 'wx' });
    return await fn(file);
  } finally {
    cleanup();
    await new Promise((r) => setImmediate(r));
    detach();
  }
}
