// Finds Xcode and reads its state. Selection is by DEVELOPER_DIR per command: orchard never runs
// `xcode-select -s`, which needs sudo and changes the machine for every session.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describeFailure } from './run.mjs';
import { versionCmp } from './ios-project.mjs';

export const INSTALL_XCODE_NEXT =
  'Yu installs Xcode 27.1 from the Mac App Store, then sudo xcodebuild -license accept and sudo xcodebuild -runFirstLaunch';

function readVersionPlist(app) {
  const f = join(app, 'Contents', 'version.plist');
  if (!existsSync(f)) return { version: null, build: null };
  const t = readFileSync(f, 'utf8');
  const get = (k) => t.match(new RegExp(`<key>${k}</key>\\s*<string>([^<]+)</string>`))?.[1] ?? null;
  return { version: get('CFBundleShortVersionString'), build: get('ProductBuildVersion') };
}

function asXcode(app) {
  const developerDir = join(app, 'Contents', 'Developer');
  if (!existsSync(join(developerDir, 'usr', 'bin', 'xcodebuild'))) return null;
  return { app, developerDir, ...readVersionPlist(app) };
}

/**
 * Lists installed Xcodes and picks one: an Xcode named by DEVELOPER_DIR wins, then the version
 * orchard.json pins, then the newest.
 */
export function findXcode({ env = process.env, applicationsDir = '/Applications', want = null } = {}) {
  const found = [];
  let fromEnv = null;
  if (env.DEVELOPER_DIR && /\.app\/Contents\/Developer\/?$/.test(env.DEVELOPER_DIR)) {
    fromEnv = asXcode(env.DEVELOPER_DIR.replace(/\/Contents\/Developer\/?$/, ''));
    if (fromEnv) found.push(fromEnv);
  }
  let names = [];
  try {
    names = readdirSync(applicationsDir).filter((n) => /^Xcode.*\.app$/.test(n));
  } catch {
    /* no applications dir */
  }
  for (const n of names.sort()) {
    const x = asXcode(join(applicationsDir, n));
    if (x && !found.some((f) => f.app === x.app)) found.push(x);
  }
  let selected = fromEnv;
  let reason = fromEnv ? 'DEVELOPER_DIR' : null;
  if (!selected && want) {
    selected = found.find((x) => x.version === want) ?? null;
    if (selected) reason = `matches orchard.json toolchain.xcode ${want}`;
  }
  if (!selected && found.length) {
    selected = [...found].sort((a, b) => versionCmp(b.version ?? '0', a.version ?? '0'))[0];
    reason = 'newest installed';
  }
  return { found, selected, reason };
}

export function devEnv(xcode) {
  return { DEVELOPER_DIR: xcode.developerDir };
}

/** The developer directory xcode-select points at, for context only. */
export function activeDeveloperDir(run) {
  const res = run('xcode-select', ['-p'], { timeoutMs: 10_000 });
  return res.code === 0 ? res.stdout.trim() : null;
}

export function xcodeState(xcode, run) {
  const env = devEnv(xcode);
  const out = {};
  const v = run('xcodebuild', ['-version'], { env, timeoutMs: 60_000 });
  out.version = v.code === 0
    ? { ok: true, text: v.stdout.trim().replace(/\n/g, ', ') }
    : { ok: false, text: describeFailure(v) };
  const lic = run('xcodebuild', ['-license', 'check'], { env, timeoutMs: 60_000 });
  out.license = lic.timedOut ? { ok: null, text: 'timed out' } : { ok: lic.code === 0, text: lic.code === 0 ? 'accepted' : describeFailure(lic) };
  const fl = run('xcodebuild', ['-checkFirstLaunchStatus'], { env, timeoutMs: 60_000 });
  out.firstLaunch = fl.timedOut ? { ok: null, text: 'timed out' } : { ok: fl.code === 0, text: fl.code === 0 ? 'done' : describeFailure(fl) };
  const sdk = run('xcodebuild', ['-showsdks', '-json'], { env, timeoutMs: 60_000 });
  if (sdk.code === 0) {
    try {
      const list = JSON.parse(sdk.stdout);
      out.sdks = { ok: true, list: list.map((x) => ({ platform: x.platform, version: x.sdkVersion ?? x.platformVersion })) };
    } catch {
      out.sdks = { ok: null, text: 'unreadable -showsdks output' };
    }
  } else out.sdks = { ok: null, text: describeFailure(sdk) };
  return out;
}

export function listSimulators(xcode, run) {
  const env = devEnv(xcode);
  const rt = run('xcrun', ['simctl', 'list', 'runtimes', '-j'], { env, timeoutMs: 60_000 });
  const dv = run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { env, timeoutMs: 60_000 });
  if (rt.code !== 0 || dv.code !== 0) return { ok: false, text: describeFailure(rt.code !== 0 ? rt : dv) };
  try {
    const runtimes = (JSON.parse(rt.stdout).runtimes ?? []).filter((r) => r.isAvailable !== false && (r.platform === 'iOS' || /iOS/.test(r.identifier ?? '')));
    const devices = JSON.parse(dv.stdout).devices ?? {};
    return { ok: true, runtimes, devices };
  } catch {
    return { ok: false, text: 'unreadable simctl JSON' };
  }
}

/** Picks a simulator: the named one, else the first iPhone on the newest iOS runtime. */
export function pickDevice(sims, wanted) {
  const runtimes = [...sims.runtimes].sort((a, b) => versionCmp(b.version ?? '0', a.version ?? '0'));
  for (const r of runtimes) {
    const devs = (sims.devices[r.identifier] ?? []).filter((d) => d.isAvailable !== false);
    const d = wanted ? devs.find((x) => x.name === wanted) : devs.find((x) => /^iPhone/.test(x.name));
    if (d) return { name: d.name, udid: d.udid, state: d.state, runtime: r.name ?? r.identifier };
  }
  return null;
}
