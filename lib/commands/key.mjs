// App Store Connect team key handling (DESIGN §5). Only the GitHub Actions backup route and API
// scripting need a key; Xcode Cloud signs without one.
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { appName, parseArgs } from '../args.mjs';
import { expandHome, loadApp, loadOrchard, tildify, UsageError } from '../config.mjs';
import { APPROVAL_TIMEOUT_MS, deleteItem, itemExists, readBase64, redact, storeAndVerify, validateP8, writeLocalConfig } from '../keychain.mjs';
import { describeFailure } from '../run.mjs';

export const help = `orchard key import <AuthKey_XXXX.p8> --key-id <id> --issuer-id <id> [--replace] [--require-approval]
orchard key check
orchard key gh-secret <app> [--env mobile-stores] [--gh-repo owner/name] --yes

Only the GitHub Actions backup route (and API scripting) needs an App Store Connect team
key. Xcode Cloud signs in Apple's cloud without one.

import     Checks the file is a PEM PKCS#8 EC (P-256) key, stores it base64-encoded in the
           login Keychain (service from orchard.json, account = key ID) by feeding
           \`add-generic-password … -w <base64>\` to \`security -i\` over stdin, so the key
           is never in argv or a 128-character getpass prompt. Reads it back and compares
           SHA-256 of the decoded bytes. Writes key ID, issuer ID and service to
           ~/.config/orchard/asc.json (0600). Never prints the key; leaves the downloaded
           file for you to delete.
           Refuses when an item for that key ID already exists, and when the file is named
           AuthKey_<other id>.p8: Apple key IDs are unique, so either is almost always a
           wrong --key-id, and the old bytes cannot be downloaded again.
  --replace           delete the existing item for this key ID, then store this file in
                      its place. The bytes that were there are gone from this Mac (Apple
                      keeps no copy). A rotation never needs it: a new key has a new ID.
  --require-approval  create the item with an empty trusted-app list (security -T ""),
                      so every read (this import's own check, key check, gh-secret) raises
                      a Keychain dialog. Click Allow, never Always Allow: Always Allow puts
                      /usr/bin/security back on the list and reads go silent again.
                      Without it, any process running as you can read the key silently.
check      Reports whether the config and Keychain item exist, the key ID and whether the
           stored value decodes to a sane .p8. It reads the value inside this process to
           measure it, and never prints it.
gh-secret  Sends ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8_B64 to the app repo's GitHub
           environment through \`gh secret set NAME --env … --repo …\` on stdin (never argv).
           This sends a secret off the machine, so it refuses without --yes.

Exit: 0 ok, 1 failed or missing, 2 usage error, 3 refused (gh-secret without --yes).
`;

function localConfigPath(orchard, home) {
  return expandHome(orchard.appStoreConnect.localConfig, home);
}

function readLocalConfig(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { invalid: true };
  }
}

function keyImport(p, ctx, orchard) {
  const [file] = p.positionals;
  const keyId = p.flags['key-id'];
  const issuerId = p.flags['issuer-id'];
  if (!file) throw new UsageError('which .p8 file? orchard key import <AuthKey_XXXX.p8> --key-id <id> --issuer-id <id>');
  if (p.positionals.length > 1) throw new UsageError(`unexpected argument: ${p.positionals[1]}`);
  if (!keyId || !/^[A-Za-z0-9]{4,32}$/.test(keyId)) throw new UsageError('--key-id must be the key ID (letters and digits, as App Store Connect shows it)');
  if (!issuerId || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(issuerId)) {
    throw new UsageError('--issuer-id must be the issuer UUID from App Store Connect → Users and Access → Integrations');
  }
  const path = resolve(ctx.cwd, expandHome(file, ctx.home));
  if (!existsSync(path)) {
    ctx.err(`${file}: not found\n`);
    return 1;
  }
  const bytes = readFileSync(path);
  const v = validateP8(bytes);
  if (!v.ok) {
    ctx.err(`${file} does not look like an App Store Connect key: ${v.problems.join('; ')}. Nothing was stored.\n`);
    return 1;
  }
  // App Store Connect names the download AuthKey_<key ID>.p8. A different ID in the name and in
  // --key-id is almost always a command edited from history, and would store one key's bytes
  // under another key's ID.
  const named = /^AuthKey_([A-Za-z0-9]+)\.p8$/.exec(basename(path))?.[1];
  if (named && named !== keyId) {
    ctx.err(`${file} is named for key ${named}, but --key-id is ${keyId}. Nothing was stored. Fix --key-id (or the file name, if it is wrong).\n`);
    return 1;
  }
  const service = orchard.appStoreConnect.keychainService;
  const requireApproval = Boolean(p.flags['require-approval']);
  const existing = itemExists({ service, account: keyId, run: ctx.run });
  if (existing === null) {
    ctx.err(`Could not tell whether the Keychain already holds a key ${keyId} (security failed). Nothing was stored.\n`);
    return 1;
  }
  if (existing && !p.flags.replace) {
    ctx.err(
      `The login Keychain already holds an item for key ${keyId} (service ${service}). Nothing was stored.\n` +
        'Apple key IDs are unique, so a second file for the same ID is almost always a wrong --key-id; `orchard key check` shows what is stored.\n' +
        `To overwrite it on purpose, add --replace: the item is deleted and this file stored in its place, and the bytes that were there are gone from this Mac (Apple keeps no copy).\n`,
    );
    return 1;
  }
  if (existing) {
    const d = deleteItem({ service, account: keyId, run: ctx.run });
    if (d !== 'deleted') {
      ctx.err(`--replace: the existing item could not be deleted (${d}). Nothing was stored.\n`);
      return 1;
    }
  }
  if (requireApproval) ctx.out('A Keychain dialog will ask to let "security" read the new item (this import checks what it stored). Click Allow, not Always Allow.\n');
  const res = storeAndVerify({ service, account: keyId, label: `orchard App Store Connect key ${keyId}`, bytes, requireApproval, run: ctx.run });
  if (!res.ok) {
    ctx.err(`Keychain import failed: ${res.detail}. Nothing was written to the local config.${existing ? ` The old item for ${keyId} was already deleted (--replace); ${file} is still on disk.` : ''}\n`);
    return 1;
  }
  const cfgFile = localConfigPath(orchard, ctx.home);
  writeLocalConfig(cfgFile, { keyId, issuerId, service, requireApproval, importedAt: ctx.now().toISOString() });
  ctx.out(
    `Stored in the login Keychain${existing ? ' (replacing the item that was there)' : ''}: service ${service}, account ${keyId}; ${res.detail}.\n` +
      (requireApproval
        ? 'Every read of this item now raises a Keychain dialog. Allow it only when you started the read (key check, gh-secret), and never click Always Allow.\n'
        : 'Any process running as you can read this item without a prompt; see docs/KEYS.md for what that means and for --require-approval.\n') +
      `Wrote ${tildify(cfgFile, ctx.home)} (0600): key ID, issuer ID, service.\n` +
      `orchard did not delete ${file}. Once you are sure, delete it yourself; Apple lets you download a key only once, so the Keychain copy is now the one to keep.\n`,
  );
  return 0;
}

function keyCheck(p, ctx, orchard) {
  if (p.positionals.length) throw new UsageError(`unexpected argument: ${p.positionals[0]}`);
  const cfgFile = localConfigPath(orchard, ctx.home);
  const cfg = readLocalConfig(cfgFile);
  const service = cfg?.service ?? orchard.appStoreConnect.keychainService;
  const lines = [];
  let ok = true;
  if (!cfg) {
    lines.push(`config   ${tildify(cfgFile, ctx.home)}: absent`);
    ok = false;
  } else if (cfg.invalid) {
    lines.push(`config   ${tildify(cfgFile, ctx.home)}: unreadable JSON`);
    ok = false;
  } else lines.push(`config   ${tildify(cfgFile, ctx.home)}: key ID ${cfg.keyId}, issuer ID ${cfg.issuerId}, imported ${cfg.importedAt ?? '?'}`);
  const account = cfg && !cfg.invalid ? cfg.keyId : undefined;
  const exists = itemExists({ service, account, run: ctx.run });
  if (exists !== true) {
    lines.push(`keychain service ${service}${account ? `, account ${account}` : ''}: ${exists === false ? 'no item' : 'could not be read'}`);
    ok = false;
  } else {
    if (cfg?.requireApproval) ctx.out('A Keychain dialog will ask to let "security" read the key. Click Allow, not Always Allow.\n');
    const back = readBase64({ service, account, run: ctx.run, timeoutMs: cfg?.requireApproval ? APPROVAL_TIMEOUT_MS : 30_000 });
    if (!back.found) {
      lines.push(`keychain item found but its value could not be read${back.error ? ` (${back.error})` : ''}`);
      ok = false;
    } else {
      const bytes = Buffer.from(back.b64, 'base64');
      const v = validateP8(bytes);
      lines.push(`keychain service ${service}, account ${account ?? '(any: with no config this is whichever item the Keychain returns first)'}: ${back.b64.length} base64 characters → ${bytes.length} bytes; ${v.ok ? `PEM PKCS#8 EC ${v.curve}` : v.problems.join('; ')}`);
      if (!v.ok) ok = false;
    }
  }
  if (!cfg && exists === false) lines.push('No App Store Connect key on this Mac. Only the GitHub Actions backup route needs one; Xcode Cloud signs without it.');
  ctx.out(lines.join('\n') + '\n');
  return ok ? 0 : 1;
}

function keyGhSecret(p, ctx, orchard) {
  const name = appName(p);
  const { manifest } = loadApp(name, { root: ctx.root, home: ctx.home, cwd: ctx.cwd });
  const repo = p.flags['gh-repo'] ?? manifest.repo;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new UsageError(`no GitHub repo for ${name} (manifest repo is ${manifest.repo ?? 'null'})`);
  const env = p.flags.env ?? 'mobile-stores';
  if (!/^[A-Za-z0-9_.-]+$/.test(env)) throw new UsageError(`bad environment name: ${env}`);
  const cfgFile = localConfigPath(orchard, ctx.home);
  const cfg = readLocalConfig(cfgFile);
  if (!cfg || cfg.invalid || !cfg.keyId || !cfg.issuerId) {
    ctx.err(`No usable ${tildify(cfgFile, ctx.home)}; run orchard key import first.\n`);
    return 1;
  }
  const names = ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8_B64'];
  if (!p.flags.yes) {
    ctx.err(
      `Refused: this would send ${names.join(', ')} for key ${cfg.keyId} to the GitHub environment "${env}" on ${repo}.\n` +
        'A secret that leaves the machine is slow to undo, so it needs an explicit --yes, given only after Yu has said so for this route.\n',
    );
    return 3;
  }
  if (cfg.requireApproval) ctx.out('A Keychain dialog will ask to let "security" read the key. Click Allow, not Always Allow.\n');
  const back = readBase64({ service: cfg.service ?? orchard.appStoreConnect.keychainService, account: cfg.keyId, run: ctx.run, timeoutMs: cfg.requireApproval ? APPROVAL_TIMEOUT_MS : 30_000 });
  if (!back.found) {
    ctx.err(`The Keychain item for ${cfg.keyId} could not be read${back.error ? ` (${back.error})` : ''}.\n`);
    return 1;
  }
  const v = validateP8(Buffer.from(back.b64, 'base64'));
  if (!v.ok) {
    ctx.err(`The stored key does not decode to a valid .p8 (${v.problems.join('; ')}); nothing sent.\n`);
    return 1;
  }
  const values = { ASC_KEY_ID: cfg.keyId, ASC_ISSUER_ID: cfg.issuerId, ASC_KEY_P8_B64: back.b64 };
  for (const n of names) {
    const res = ctx.run('gh', ['secret', 'set', n, '--env', env, '--repo', repo], { input: values[n], timeoutMs: 60_000 });
    if (res.code !== 0) {
      ctx.err(`gh secret set ${n} failed: ${redact(describeFailure(res), [back.b64])}. Secrets set before it stay set.\n`);
      return 1;
    }
    ctx.out(`set ${n} on ${repo} environment ${env} (${values[n].length} characters, sent on stdin)\n`);
  }
  return 0;
}

export function key(argv, ctx) {
  const p = parseArgs(argv, { app: 'string', 'key-id': 'string', 'issuer-id': 'string', env: 'string', 'gh-repo': 'string', yes: 'bool', replace: 'bool', 'require-approval': 'bool' });
  const [sub, ...rest] = p.positionals;
  if (p.flags.help || !sub) {
    ctx.out(help);
    return sub || p.flags.help ? 0 : 2;
  }
  const orchard = loadOrchard(ctx.root);
  const q = { ...p, positionals: rest };
  if (sub === 'import') return keyImport(q, ctx, orchard);
  if (sub === 'check') return keyCheck(q, ctx, orchard);
  if (sub === 'gh-secret') return keyGhSecret(q, ctx, orchard);
  throw new UsageError(`unknown key command "${sub}" (import, check, gh-secret)`);
}
