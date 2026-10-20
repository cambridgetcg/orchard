import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildSimSteps, launchSteps } from '../lib/commands/sim.mjs';
import { applicationsDir, cleanup, cli, FIXTURE_MANIFEST, fixtureApp, makeRoot, stubRunner, xcodeHandlers } from './helpers.mjs';

after(cleanup);

const XC = { developerDir: '/Applications/Xcode.app/Contents/Developer' };
const DEVICE = { name: 'iPhone 17', udid: 'UDID-17' };

test('xcodebuild arguments are exact, with DEVELOPER_DIR on every step', () => {
  const { steps, derived, productsDir } = buildSimSteps({ manifest: FIXTURE_MANIFEST, repo: '/r', xcode: XC, device: DEVICE, buildWeb: true, needInstall: true });
  assert.deepEqual(steps.map((s) => s.label), ['web install', 'web build', 'cap sync', 'xcodebuild']);
  const xb = steps.at(-1);
  assert.equal(xb.cmd, 'xcodebuild');
  assert.deepEqual(xb.args, [
    '-project', '/r/ios/App/App.xcodeproj',
    '-scheme', 'App',
    '-configuration', 'Debug',
    '-sdk', 'iphonesimulator',
    '-destination', 'platform=iOS Simulator,name=iPhone 17',
    '-derivedDataPath', '/r/build/orchard-sim',
    'build',
  ]);
  assert.equal(derived, '/r/build/orchard-sim');
  assert.equal(productsDir, '/r/build/orchard-sim/Build/Products/Debug-iphonesimulator');
  // The app's own Capacitor CLI, never npx (which could fetch the unrelated npm package `cap`).
  assert.equal(steps[2].cmd, '/r/node_modules/.bin/cap');
  assert.deepEqual(steps[2].args, ['sync', 'ios']);
  assert.ok(!steps.some((s) => s.cmd === 'npx'), 'no npx');
  for (const s of steps) {
    assert.equal(s.env.DEVELOPER_DIR, XC.developerDir);
    assert.ok(s.timeoutMs > 0);
  }
  assert.ok(!steps.some((s) => s.args.join(' ').includes('cap run')), 'never npx cap run ios');
});

test('--no-build-web skips the web steps but still syncs; install only when node_modules is missing', () => {
  const a = buildSimSteps({ manifest: FIXTURE_MANIFEST, repo: '/r', xcode: XC, device: DEVICE, buildWeb: false, needInstall: true });
  assert.deepEqual(a.steps.map((s) => s.label), ['cap sync', 'xcodebuild']);
  const b = buildSimSteps({ manifest: FIXTURE_MANIFEST, repo: '/r', xcode: XC, device: DEVICE, buildWeb: true, needInstall: false });
  assert.deepEqual(b.steps.map((s) => s.label), ['web build', 'cap sync', 'xcodebuild']);
});

test('launch steps boot, install and launch the bundle id; a screenshot only when asked', () => {
  const s = launchSteps({ manifest: FIXTURE_MANIFEST, xcode: XC, device: DEVICE, appPath: '/p/App.app', screenshotPath: null });
  assert.deepEqual(s.map((x) => [x.cmd, ...x.args].join(' ')), [
    'xcrun simctl boot UDID-17',
    'xcrun simctl install UDID-17 /p/App.app',
    'xcrun simctl launch UDID-17 com.example.orchard.fixture',
  ]);
  const t = launchSteps({ manifest: FIXTURE_MANIFEST, xcode: XC, device: DEVICE, appPath: '/p/App.app', screenshotPath: '/p/s.png' });
  assert.equal(t.at(-1).args.join(' '), 'simctl io UDID-17 screenshot /p/s.png');
});

test('without Xcode, sim fails fast as BLOCKED and runs nothing', async () => {
  const run = stubRunner();
  const r = await cli(['sim', 'fixture', '--repo', fixtureApp({ gitInit: false })], { root: makeRoot(), run, applicationsDir: applicationsDir() });
  assert.equal(r.code, 1);
  assert.match(r.err, /^BLOCKED \(rung simulator\): no Xcode/);
  assert.match(r.err, /Yu installs Xcode 27\.1 from the Mac App Store/);
  assert.equal(run.calls.length, 0);
});

/** A fixture app with a stand-in for its locally installed Capacitor CLI. */
function appWithCap() {
  const app = fixtureApp({ gitInit: false });
  mkdirSync(join(app, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(app, 'node_modules/.bin/cap'), '#!/bin/sh\n', { mode: 0o755 });
  return { app, cap: join(app, 'node_modules/.bin/cap') };
}

test('end to end with stubs: build, find the .app, tolerate an already booted device, launch', async () => {
  const { app, cap } = appWithCap();
  const apps = applicationsDir({ xcode: { version: '27.1', build: '27A9275' } });
  const handlers = xcodeHandlers({
    booted: true,
    onBuild: (args) => {
      const derived = args[args.indexOf('-derivedDataPath') + 1];
      mkdirSync(join(derived, 'Build/Products/Debug-iphonesimulator/App.app'), { recursive: true });
    },
  });
  handlers[cap] = () => ({ code: 0 });
  const run = stubRunner(handlers);
  const r = await cli(['sim', 'fixture', '--repo', app], { root: makeRoot(), run, applicationsDir: apps });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\(already booted\)/);
  assert.match(r.out, /Rung reached: simulator/);
  const seq = run.calls.filter((c) => ['xcodebuild', 'xcrun', cap, '/bin/sh'].includes(c.cmd)).map((c) => `${c.cmd === cap ? 'cap' : c.cmd} ${c.args.slice(0, 2).join(' ')}`);
  assert.deepEqual(seq.filter((s) => !s.startsWith('xcrun simctl list')), [
    '/bin/sh -c true',
    'cap sync ios',
    'xcodebuild -project ' + join(app, 'ios/App/App.xcodeproj'),
    'xcrun simctl boot',
    'xcrun simctl install',
    'xcrun simctl launch',
  ]);
  assert.ok(!run.calls.some((c) => c.args.includes('screenshot')), 'no screenshot without --screenshot');
  const install = run.calls.find((c) => c.args[1] === 'install');
  assert.equal(install.args[3], join(app, 'build/orchard-sim/Build/Products/Debug-iphonesimulator/App.app'));
  for (const c of run.calls.filter((x) => ['xcodebuild', 'xcrun', cap].includes(x.cmd))) assert.equal(c.opts.env.DEVELOPER_DIR, join(apps, 'Xcode.app/Contents/Developer'));
});

test('without the app\'s own Capacitor CLI, sim is BLOCKED with the install step and runs no cap at all', async () => {
  const app = fixtureApp({ gitInit: false });
  mkdirSync(join(app, 'node_modules'));
  const apps = applicationsDir({ xcode: { version: '27.1', build: '27A9275' } });
  const run = stubRunner(xcodeHandlers());
  const r = await cli(['sim', 'fixture', '--repo', app, '--no-build-web'], { root: makeRoot(), run, applicationsDir: apps });
  assert.equal(r.code, 1);
  assert.match(r.err, /BLOCKED \(rung simulator\): the Capacitor CLI is not installed in the app repo \(node_modules\/\.bin\/cap is missing\)/);
  assert.match(r.err, /next: run true in the app repo/);
  assert.ok(!run.calls.some((c) => c.cmd === 'npx' || c.cmd.endsWith('/cap')), 'nothing named cap was run');
  assert.ok(!run.calls.some((c) => c.cmd === 'xcodebuild' && c.args.at(-1) === 'build'));
});

test('a server.url that cap sync resolved (from any config format) is BLOCKED before building', async () => {
  const { app, cap } = appWithCap();
  const apps = applicationsDir({ xcode: { version: '27.1', build: '27A9275' } });
  const handlers = xcodeHandlers();
  handlers[cap] = () => {
    writeFileSync(join(app, 'ios/App/App/capacitor.config.json'), JSON.stringify({ appId: 'com.example.orchard.fixture', server: { url: 'https://live.example.com' } }));
    return { code: 0 };
  };
  const run = stubRunner(handlers);
  const r = await cli(['sim', 'fixture', '--repo', app, '--no-build-web'], { root: makeRoot(), run, applicationsDir: apps });
  assert.equal(r.code, 1);
  assert.match(r.err, /cap sync wrote server\.url \(https:\/\/live\.example\.com\)/);
  assert.ok(!run.calls.some((c) => c.cmd === 'xcodebuild' && c.args.at(-1) === 'build'));
});

test('an unknown --device and a server.url are BLOCKED before building', async () => {
  const apps = applicationsDir({ xcode: { version: '27.1', build: '27A9275' } });
  const app = fixtureApp({ gitInit: false });
  let run = stubRunner(xcodeHandlers());
  let r = await cli(['sim', 'fixture', '--repo', app, '--device', 'iPhone 1'], { root: makeRoot(), run, applicationsDir: apps });
  assert.equal(r.code, 1);
  assert.match(r.err, /no available simulator named "iPhone 1"/);
  assert.ok(!run.calls.some((c) => c.cmd === 'xcodebuild' && c.args.at(-1) === 'build'));
  writeFileSync(join(app, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.orchard.fixture', webDir: 'dist', server: { url: 'http://localhost:3000' } }));
  run = stubRunner(xcodeHandlers());
  r = await cli(['sim', 'fixture', '--repo', app], { root: makeRoot(), run, applicationsDir: apps });
  assert.equal(r.code, 1);
  assert.match(r.err, /server\.url/);
});
