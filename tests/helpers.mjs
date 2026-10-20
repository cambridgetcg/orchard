// Shared test scaffolding: a throwaway orchard root, a fixture app copy, and a command runner that
// passes plutil/PlistBuddy/git/sh through to the real tools and stubs everything else (security,
// xcodebuild, xcrun, gh, npx), recording every call.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../lib/cli.mjs';
import { run as realRun } from '../lib/run.mjs';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = join(REPO, 'tests', 'fixtures', 'capacitor-8.5.3-spm');

const tmpRoots = [];
export function tmp(prefix = 'orchard-test-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
export function cleanup() {
  while (tmpRoots.length) rmSync(tmpRoots.pop(), { recursive: true, force: true });
}

export const FIXTURE_MANIFEST = {
  name: 'fixture',
  displayName: 'Fixture',
  status: 'test',
  repo: 'example/fixture',
  localPath: null,
  bundleId: 'com.example.orchard.fixture',
  web: { install: 'true', build: 'true', dir: 'dist', test: 'true' },
  ios: {
    project: 'ios/App/App.xcodeproj',
    scheme: 'App',
    minIOS: '16.0',
    deviceFamily: [1],
    orientations: ['UIInterfaceOrientationPortrait'],
    usesNonExemptEncryption: false,
  },
  release: { versionFrom: 'package.json', preflight: ['true'], primary: 'xcode-cloud', backup: null },
  store: { privacyUrl: 'https://example.invalid/privacy.html' },
};

/** A temporary orchard root: the real orchard.json and templates, plus the given manifests. */
export function makeRoot({ manifests = [FIXTURE_MANIFEST], teamId = null } = {}) {
  const root = tmp('orchard-root-');
  const orchard = JSON.parse(readFileSync(join(REPO, 'orchard.json'), 'utf8'));
  orchard.team.teamId = teamId;
  writeFileSync(join(root, 'orchard.json'), JSON.stringify(orchard, null, 2));
  mkdirSync(join(root, 'apps'));
  for (const m of manifests) writeFileSync(join(root, 'apps', `${m.name}.json`), JSON.stringify(m, null, 2));
  cpSync(join(REPO, 'templates'), join(root, 'templates'), { recursive: true });
  return root;
}

const GIT = ['-c', 'user.name=orchard-test', '-c', 'user.email=orchard-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];

export function git(repo, ...args) {
  const r = realRun('git', [...GIT, '-C', repo, ...args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A copy of the fixture app, optionally committed to a fresh git repo. */
export function fixtureApp({ gitInit = true } = {}) {
  const dir = join(tmp('orchard-app-'), 'app');
  cpSync(FIXTURE, dir, { recursive: true });
  if (gitInit) {
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'fixture');
  }
  return dir;
}

export function commitAll(dir, msg = 'update') {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

const PASS_THROUGH = new Set(['plutil', '/usr/bin/plutil', '/usr/libexec/PlistBuddy', 'git', '/bin/sh']);

/**
 * handlers: { [cmd]: (args, opts) => partial result }. Unhandled stubbed commands behave as
 * "command not found". `calls` records { cmd, args, opts } for every call, real or stubbed.
 */
export function stubRunner(handlers = {}) {
  const calls = [];
  const fn = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    const h = handlers[cmd];
    if (h) {
      const r = h(args, opts) ?? {};
      return { code: 0, stdout: '', stderr: '', timedOut: false, error: null, ...r };
    }
    if (PASS_THROUGH.has(cmd)) return realRun(cmd, args, { ...opts, stream: false });
    return { code: null, stdout: '', stderr: '', timedOut: false, error: 'ENOENT' };
  };
  fn.calls = calls;
  return fn;
}

/** Runs the CLI in-process with an injected context; returns { code, out, err }. */
export async function cli(argv, overrides = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    now: () => new Date('2026-10-20T12:00:00Z'),
    env: {},
    ...overrides,
  });
  return { code, out, err };
}

/** An /Applications stand-in, empty or holding a fake Xcode.app with a version.plist. */
export function applicationsDir({ xcode = null } = {}) {
  const dir = tmp('orchard-apps-');
  if (xcode) {
    const app = join(dir, 'Xcode.app');
    mkdirSync(join(app, 'Contents', 'Developer', 'usr', 'bin'), { recursive: true });
    writeFileSync(join(app, 'Contents', 'Developer', 'usr', 'bin', 'xcodebuild'), '');
    writeFileSync(join(app, 'Contents', 'version.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>${xcode.version}</string>\n\t<key>ProductBuildVersion</key>\n\t<string>${xcode.build}</string>\n</dict>\n</plist>\n`);
  }
  return dir;
}

/** Stub handlers for a healthy Xcode with one iPhone simulator. */
export function xcodeHandlers({ license = 0, firstLaunch = 0, booted = false, onBuild } = {}) {
  const runtimeId = 'com.apple.CoreSimulator.SimRuntime.iOS-27-1';
  return {
    xcodebuild: (args) => {
      if (args[0] === '-version') return { stdout: 'Xcode 27.1\nBuild version 27A9275\n' };
      if (args[0] === '-license') return { code: license, stderr: license ? 'You have not agreed to the Xcode license agreements.' : '' };
      if (args[0] === '-checkFirstLaunchStatus') return { code: firstLaunch };
      if (args[0] === '-showsdks') return { stdout: JSON.stringify([{ platform: 'iphoneos', sdkVersion: '27.1' }, { platform: 'iphonesimulator', sdkVersion: '27.1' }]) };
      if (args.at(-1) === 'build') {
        onBuild?.(args);
        return { code: 0 };
      }
      return { code: 64, stderr: 'unexpected xcodebuild call' };
    },
    xcrun: (args) => {
      if (args.join(' ') === 'simctl list runtimes -j') {
        return { stdout: JSON.stringify({ runtimes: [{ identifier: runtimeId, name: 'iOS 27.1', version: '27.1', isAvailable: true, platform: 'iOS' }] }) };
      }
      if (args.join(' ') === 'simctl list devices available -j') {
        return { stdout: JSON.stringify({ devices: { [runtimeId]: [{ name: 'iPhone 17', udid: 'UDID-17', state: 'Shutdown', isAvailable: true }, { name: 'iPad Air', udid: 'UDID-PAD', state: 'Shutdown', isAvailable: true }] } }) };
      }
      if (args[1] === 'boot') return booted ? { code: 149, stderr: 'Unable to boot device in current state: Booted' } : { code: 0 };
      if (args[1] === 'install' || args[1] === 'io') return { code: 0 };
      if (args[1] === 'launch') return { stdout: `${args[3]}: 4242\n` };
      return { code: 64, stderr: 'unexpected xcrun call' };
    },
    'xcode-select': () => ({ stdout: '/Library/Developer/CommandLineTools\n' }),
    npx: () => ({ code: 0 }),
  };
}

export function byId(checks, id) {
  return checks.find((c) => c.id === id);
}
