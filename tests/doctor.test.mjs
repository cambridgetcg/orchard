import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { appendToArray, insertObject, parsePbxproj } from '../lib/pbxproj.mjs';
import { INSTALL_XCODE_NEXT } from '../lib/xcode.mjs';
import {
  applicationsDir, byId, cleanup, cli, commitAll, FIXTURE_MANIFEST, fixtureApp, makeRoot, stubRunner, tmp, xcodeHandlers,
} from './helpers.mjs';

after(cleanup);

const noKey = { '/usr/bin/security': () => ({ code: 44 }) };

async function doctorJson(argv, { root, run, apps, home = tmp('orchard-home-'), fetch } = {}) {
  const r = await cli(['doctor', ...argv, '--json'], {
    root, run, home, fetch,
    applicationsDir: apps ?? applicationsDir(),
  });
  return { ...r, json: JSON.parse(r.out) };
}

test('no Xcode on the Mac: BLOCKED with the install step, Team ID null: BLOCKED, exit 1', async () => {
  const run = stubRunner({ 'xcode-select': () => ({ stdout: '/Library/Developer/CommandLineTools\n' }) });
  const { code, json } = await doctorJson([], { root: makeRoot(), run });
  assert.equal(code, 1);
  assert.equal(json.exitCode, 1);
  const x = byId(json.checks, 'toolchain.xcode');
  assert.equal(x.status, 'BLOCKED');
  assert.equal(x.rung, 'simulator');
  assert.equal(x.next, INSTALL_XCODE_NEXT);
  assert.equal(INSTALL_XCODE_NEXT, 'Yu installs Xcode 27.1 from the Mac App Store, then sudo xcodebuild -license accept and sudo xcodebuild -runFirstLaunch');
  assert.match(x.detail, /Command Line Tools only/);
  for (const id of ['toolchain.xcode-license', 'toolchain.xcode-first-launch', 'toolchain.ios-simulator']) assert.equal(byId(json.checks, id).status, 'UNKNOWN');
  const t = byId(json.checks, 'team.id');
  assert.equal(t.status, 'BLOCKED');
  assert.match(t.next, /developer\.apple\.com.*Membership details/);
  assert.ok(!run.calls.some((c) => c.cmd === 'xcodebuild'), 'no xcodebuild without Xcode');
});

test('a healthy Xcode is READY, each command gets DEVELOPER_DIR, and a Team ID clears team.id', async () => {
  const apps = applicationsDir({ xcode: { version: '27.1', build: '27A9275' } });
  const run = stubRunner(xcodeHandlers());
  const { code, json } = await doctorJson([], { root: makeRoot({ teamId: 'ABCDE12345' }), run, apps });
  assert.equal(code, 0, JSON.stringify(json.checks.filter((c) => c.status !== 'READY'), null, 1));
  for (const id of ['toolchain.xcode', 'toolchain.xcode-license', 'toolchain.xcode-first-launch', 'toolchain.ios-simulator', 'team.id']) {
    assert.equal(byId(json.checks, id).status, 'READY', id);
  }
  assert.match(byId(json.checks, 'toolchain.ios-simulator').detail, /iPhone 17/);
  const xc = run.calls.filter((c) => c.cmd === 'xcodebuild' || c.cmd === 'xcrun');
  assert.ok(xc.length >= 5);
  for (const c of xc) assert.equal(c.opts.env.DEVELOPER_DIR, join(apps, 'Xcode.app', 'Contents', 'Developer'));
  for (const c of run.calls) assert.ok(typeof c.opts.timeoutMs === 'number', `${c.cmd} has a timeout`);
  assert.ok(!run.calls.some((c) => c.cmd === 'xcode-select' && c.args.includes('-s')), 'never xcode-select -s');
});

test('licence not accepted is BLOCKED with the sudo step', async () => {
  const apps = applicationsDir({ xcode: { version: '27.1', build: '27A9275' } });
  const { json } = await doctorJson([], { root: makeRoot(), run: stubRunner(xcodeHandlers({ license: 1 })), apps });
  const c = byId(json.checks, 'toolchain.xcode-license');
  assert.equal(c.status, 'BLOCKED');
  assert.match(c.next, /sudo xcodebuild -license accept/);
});

test('the raw Capacitor template fails the native checks with conform as the next step', async () => {
  const app = fixtureApp();
  const { json } = await doctorJson(['fixture', '--repo', app], { root: makeRoot(), run: stubRunner(noKey) });
  const want = {
    'native.capacitor-config': 'READY',
    'native.project': 'READY',
    'native.format': 'READY',
    'native.bundle-id': 'READY',
    'native.deployment-target': 'BLOCKED',
    'native.device-family': 'BLOCKED',
    'native.encryption': 'BLOCKED',
    'native.orientations': 'BLOCKED',
    'native.device-capabilities': 'BLOCKED',
    'native.privacy-manifest': 'BLOCKED',
    'xcode-cloud.ci-post-clone': 'BLOCKED',
    'xcode-cloud.package-resolved': 'BLOCKED',
    'xcode-cloud.scheme': 'UNKNOWN',
    'xcode-cloud.marketing-version': 'READY',
    'xcode-cloud.preflight': 'READY',
    'xcode-cloud.committed': 'READY',
    'xcode-cloud.workflow': 'UNKNOWN',
    'web.repo': 'READY',
    'web.commands': 'READY',
    'web.bundle': 'UNKNOWN',
    'web.tests': 'UNKNOWN',
    'store.privacy-url': 'UNKNOWN',
    'backup.route': 'UNKNOWN',
  };
  for (const [id, status] of Object.entries(want)) assert.equal(byId(json.checks, id)?.status, status, id);
  assert.match(byId(json.checks, 'native.encryption').next, /orchard conform fixture --write/);
  assert.equal(byId(json.checks, 'xcode-cloud.package-resolved').next, 'run orchard sim once after Xcode is installed, then commit Package.resolved');
  for (const c of json.checks) assert.ok(['READY', 'BLOCKED', 'UNKNOWN'].includes(c.status) && c.rung && c.detail, c.id);
  for (const c of json.checks) if (c.status !== 'READY') assert.ok(c.next, `${c.id} has a next step`);
});

test('after conform --write, a commit and a Package.resolved, the native and cloud checks pass', async () => {
  const app = fixtureApp();
  const root = makeRoot();
  assert.equal((await cli(['conform', 'fixture', '--write', '--repo', app], { root, run: stubRunner() })).code, 0);
  const resolved = join(app, 'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm');
  mkdirSync(resolved, { recursive: true });
  writeFileSync(join(resolved, 'Package.resolved'), '{"pins":[],"version":3}\n');
  mkdirSync(join(app, 'ios/App/App.xcodeproj/xcshareddata/xcschemes'), { recursive: true });
  writeFileSync(join(app, 'ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme'), '<Scheme><BuildActionEntry buildForArchiving = "YES"/></Scheme>\n');
  // before committing, the cloud checks see uncommitted work
  let { json } = await doctorJson(['fixture', '--repo', app], { root, run: stubRunner(noKey) });
  assert.equal(byId(json.checks, 'xcode-cloud.ci-post-clone').status, 'BLOCKED');
  assert.match(byId(json.checks, 'xcode-cloud.ci-post-clone').detail, /not committed/);
  assert.equal(byId(json.checks, 'xcode-cloud.committed').status, 'BLOCKED');
  commitAll(app);
  ({ json } = await doctorJson(['fixture', '--repo', app], { root, run: stubRunner(noKey) }));
  for (const id of ['native.deployment-target', 'native.device-family', 'native.encryption', 'native.orientations', 'native.device-capabilities', 'native.privacy-manifest',
    'xcode-cloud.ci-post-clone', 'xcode-cloud.package-resolved', 'xcode-cloud.scheme', 'xcode-cloud.committed']) {
    assert.equal(byId(json.checks, id).status, 'READY', `${id}: ${byId(json.checks, id).detail}`);
  }
  assert.match(byId(json.checks, 'xcode-cloud.ci-post-clone').detail, /committed as 100755/);
});

test('a missing checkout is UNKNOWN with a next step, not READY', async () => {
  const { json } = await doctorJson(['fixture', '--repo', '/nonexistent/orchard-fixture'], { root: makeRoot(), run: stubRunner(noKey) });
  for (const id of ['web.repo', 'native.repo', 'xcode-cloud.repo']) {
    const c = byId(json.checks, id);
    assert.equal(c.status, 'UNKNOWN', id);
    assert.match(c.next, /clone example\/fixture|--repo/);
  }
  assert.ok(!json.checks.some((c) => c.id.startsWith('native.') && c.id !== 'native.repo'));
});

test('server.url and a JSON .xcproj are BLOCKED', async () => {
  const app = fixtureApp({ gitInit: false });
  writeFileSync(join(app, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.orchard.fixture', webDir: 'dist', server: { url: 'https://live.example' } }));
  mkdirSync(join(app, 'ios/App/App.xcproj'));
  const { json } = await doctorJson(['fixture', '--repo', app], { root: makeRoot(), run: stubRunner(noKey) });
  assert.equal(byId(json.checks, 'native.capacitor-config').status, 'BLOCKED');
  assert.match(byId(json.checks, 'native.capacitor-config').detail, /server\.url/);
  assert.equal(byId(json.checks, 'native.format').status, 'BLOCKED');
  assert.match(byId(json.checks, 'native.format').detail, /#8607/);
  assert.equal(byId(json.checks, 'native.encryption').status, 'UNKNOWN', 'dependent checks are not guessed');
});

test('a failing release preflight is BLOCKED with the command named', async () => {
  const app = fixtureApp();
  const m = structuredClone(FIXTURE_MANIFEST);
  m.release.preflight = ['git merge-base --is-ancestor 0000000 HEAD'];
  const { json } = await doctorJson(['fixture', '--repo', app], { root: makeRoot({ manifests: [m] }), run: stubRunner(noKey) });
  const c = byId(json.checks, 'xcode-cloud.preflight');
  assert.equal(c.status, 'BLOCKED');
  assert.match(c.detail, /git merge-base --is-ancestor 0000000 HEAD/);
});

test('--online fetches the privacy URL with a generic User-Agent', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, ua: init.headers['user-agent'] });
    return { status: url.includes('missing') ? 404 : 200, url };
  };
  const m = structuredClone(FIXTURE_MANIFEST);
  const gh = { gh: () => ({ code: 1, stderr: 'HTTP 404: Not Found' }) };
  let { json } = await doctorJson(['fixture', '--repo', '/nonexistent', '--online'], { root: makeRoot({ manifests: [m] }), run: stubRunner({ ...noKey, ...gh }), fetch });
  assert.equal(byId(json.checks, 'store.privacy-url').status, 'READY');
  m.store.privacyUrl = 'https://example.invalid/missing.html';
  ({ json } = await doctorJson(['fixture', '--repo', '/nonexistent', '--online'], { root: makeRoot({ manifests: [m] }), run: stubRunner({ ...noKey, ...gh }), fetch }));
  assert.equal(byId(json.checks, 'store.privacy-url').status, 'BLOCKED');
  assert.match(byId(json.checks, 'store.privacy-url').detail, /HTTP 404/);
  for (const s of seen) {
    assert.equal(s.ua, 'orchard-doctor/0.1');
    assert.doesNotMatch(s.ua, /@/);
  }
});

test('the backup route: missing Xcode pin, offline environment, and read-only gh api when --online', async () => {
  const app = fixtureApp({ gitInit: false });
  mkdirSync(join(app, '.github/workflows'), { recursive: true });
  writeFileSync(join(app, '.github/workflows/mobile.yml'), 'jobs:\n  ios:\n    runs-on: macos-26\n    environment: mobile-stores\n    steps:\n      - run: xcodebuild -version\n');
  const m = structuredClone(FIXTURE_MANIFEST);
  m.release.backup = 'github-actions:.github/workflows/mobile.yml';
  const root = makeRoot({ manifests: [m] });
  let { json } = await doctorJson(['fixture', '--repo', app], { root, run: stubRunner(noKey) });
  assert.equal(byId(json.checks, 'backup.workflow').status, 'READY');
  assert.equal(byId(json.checks, 'backup.xcode-pin').status, 'BLOCKED');
  assert.equal(byId(json.checks, 'backup.environment').status, 'UNKNOWN');
  assert.equal(byId(json.checks, 'backup.key').status, 'BLOCKED');
  const run = stubRunner({
    ...noKey,
    gh: (args) => (args[1].endsWith('/secrets') ? { stdout: '["ASC_KEY_ID","ASC_ISSUER_ID"]\n' } : { stdout: 'mobile-stores\n' }),
  });
  ({ json } = await doctorJson(['fixture', '--repo', app, '--online'], { root, run, fetch: async (u) => ({ status: 200, url: u }) }));
  const env = byId(json.checks, 'backup.environment');
  assert.equal(env.status, 'BLOCKED');
  assert.match(env.detail, /missing: ASC_KEY_P8_B64/);
  for (const c of run.calls.filter((x) => x.cmd === 'gh')) assert.equal(c.args[0], 'api', 'gh is only used for reads');
});

test('text output groups by rung and says UNKNOWN is not a pass', async () => {
  const r = await cli(['doctor'], { root: makeRoot(), run: stubRunner(), applicationsDir: applicationsDir(), home: tmp() });
  assert.equal(r.code, 1);
  assert.match(r.out, /toolchain \(this Mac\) {2}\[rung: simulator/);
  assert.match(r.out, /BLOCKED toolchain\.xcode/);
  assert.match(r.out, /never a pass/);
  assert.equal((await cli(['doctor', 'nope'], { root: makeRoot() })).code, 2);
  assert.equal((await cli(['doctor', '--frobnicate'], { root: makeRoot() })).code, 2);
});

test('Capacitor config precedence: a .ts beside the JSON is BLOCKED, a lone .ts UNKNOWN, never READY', async () => {
  const app = fixtureApp({ gitInit: false });
  writeFileSync(join(app, 'capacitor.config.ts'), "export default { appId: 'com.example.orchard.fixture', webDir: 'www', server: { url: 'https://live.example.com' } };\n");
  let { json } = await doctorJson(['fixture', '--repo', app], { root: makeRoot(), run: stubRunner(noKey) });
  let c = byId(json.checks, 'native.capacitor-config');
  assert.equal(c.status, 'BLOCKED');
  assert.match(c.detail, /capacitor\.config\.json is ignored: Capacitor loads capacitor\.config\.ts first/);
  rmSync(join(app, 'capacitor.config.json'));
  ({ json } = await doctorJson(['fixture', '--repo', app], { root: makeRoot(), run: stubRunner(noKey) }));
  c = byId(json.checks, 'native.capacitor-config');
  assert.equal(c.status, 'UNKNOWN');
  assert.match(c.detail, /Capacitor uses capacitor\.config\.ts/);
  rmSync(join(app, 'capacitor.config.ts'));
  writeFileSync(join(app, 'capacitor.config.mjs'), 'export default {};\n');
  ({ json } = await doctorJson(['fixture', '--repo', app], { root: makeRoot(), run: stubRunner(noKey) }));
  assert.match(byId(json.checks, 'native.capacitor-config').detail, /capacitor\.config\.mjs is not a name Capacitor loads/);
});

test('an uncommitted lockfile is an uncommitted native input', async () => {
  const app = fixtureApp();
  writeFileSync(join(app, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const { json } = await doctorJson(['fixture', '--repo', app], { root: makeRoot(), run: stubRunner(noKey) });
  const c = byId(json.checks, 'xcode-cloud.committed');
  assert.equal(c.status, 'BLOCKED');
  assert.match(c.detail, /package-lock\.json/);
});

test('backup.xcode-pin: only an explicit number at or above the upload floor counts', async () => {
  const cases = [
    ['      - uses: maxim-lobanov/setup-xcode@v1\n        with:\n          xcode-version: latest-stable\n', 'BLOCKED'],
    ['      # - run: sudo xcode-select -s /Applications/Xcode_15.app\n      - run: xcodebuild -version\n', 'BLOCKED'],
    ['    env:\n      DEVELOPER_DIR: /Applications/Xcode_26.6.app/Contents/Developer\n', 'READY'],
    ["      - uses: maxim-lobanov/setup-xcode@v1\n        with:\n          xcode-version: '26.6'\n", 'READY'],
    ['    env:\n      DEVELOPER_DIR: /Applications/Xcode_16.4.app/Contents/Developer\n', 'BLOCKED'],
    ['      - uses: maxim-lobanov/setup-xcode@v1\n        with:\n          xcode-version: 26.x\n', 'UNKNOWN'],
  ];
  const m = structuredClone(FIXTURE_MANIFEST);
  m.release.backup = 'github-actions:.github/workflows/mobile.yml';
  const root = makeRoot({ manifests: [m] });
  for (const [body, want] of cases) {
    const app = fixtureApp({ gitInit: false });
    mkdirSync(join(app, '.github/workflows'), { recursive: true });
    writeFileSync(join(app, '.github/workflows/mobile.yml'), `jobs:\n  ios:\n    runs-on: macos-26\n${body}    steps:\n      - run: xcodebuild -version\n`);
    const { json } = await doctorJson(['fixture', '--repo', app], { root, run: stubRunner(noKey) });
    const c = byId(json.checks, 'backup.xcode-pin');
    assert.equal(c.status, want, `${body}→ ${c.detail}`);
    if (body.includes('26.6')) assert.match(c.detail, /pins Xcode 26\.6\. Xcode Cloud builds with 27\.1/);
  }
});

test('required-reason APIs: a plugin that needs one makes the template manifest BLOCKED; an unknown plugin is UNKNOWN', async () => {
  const app = fixtureApp({ gitInit: false });
  const root = makeRoot();
  const pkgFile = join(app, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  writeFileSync(pkgFile, JSON.stringify({ ...pkg, devDependencies: { '@capacitor/core': '8.5.3', '@capacitor/filesystem': '8.1.5' } }));
  // The bare template manifest (no required-reason APIs), as an earlier conform wrote it.
  mkdirSync(join(app, 'ios/App/App'), { recursive: true });
  writeFileSync(join(app, 'ios/App/App/PrivacyInfo.xcprivacy'), readFileSync(join(root, 'templates/ios/PrivacyInfo.xcprivacy'), 'utf8'));
  let { json } = await doctorJson(['fixture', '--repo', app], { root, run: stubRunner(noKey) });
  let c = byId(json.checks, 'native.privacy-reasons');
  assert.equal(c.status, 'BLOCKED');
  assert.match(c.detail, /missing: NSPrivacyAccessedAPICategoryFileTimestamp for @capacitor\/filesystem \(its README suggests C617\.1\)/);
  assert.match(c.detail, /ITMS-91053/);
  assert.equal((await cli(['conform', 'fixture', '--write', '--repo', app], { root, run: stubRunner() })).code, 0);
  ({ json } = await doctorJson(['fixture', '--repo', app], { root, run: stubRunner(noKey) }));
  c = byId(json.checks, 'native.privacy-reasons');
  assert.equal(c.status, 'READY', c.detail);
  assert.match(c.detail, /declared: FileTimestamp \(C617\.1\)/);
  writeFileSync(pkgFile, JSON.stringify({ ...pkg, devDependencies: { '@capacitor/filesystem': '8.1.5', '@capacitor/haptics': '8.0.2', '@capacitor/geolocation': '8.0.0' } }));
  ({ json } = await doctorJson(['fixture', '--repo', app], { root, run: stubRunner(noKey) }));
  c = byId(json.checks, 'native.privacy-reasons');
  assert.equal(c.status, 'UNKNOWN');
  assert.match(c.detail, /not checked \(orchard has no entry for @capacitor\/geolocation/);
});

test('a low project-level deployment target or CapApp-SPM platform is BLOCKED, with the reason', async () => {
  const app = fixtureApp({ gitInit: false });
  const root = makeRoot();
  await cli(['conform', 'fixture', '--write', '--repo', app], { root, run: stubRunner() });
  const f = join(app, 'ios/App/CapApp-SPM/Package.swift');
  writeFileSync(f, readFileSync(f, 'utf8').replace('.iOS(.v16)', '.iOS(.v15)'));
  const { json } = await doctorJson(['fixture', '--repo', app], { root, run: stubRunner(noKey) });
  const c = byId(json.checks, 'native.deployment-target');
  assert.equal(c.status, 'BLOCKED');
  assert.match(c.detail, /CapApp-SPM\/Package\.swift \.iOS\(\.v15\)[\s\S]*first deployment target/);
});

test('--online: a workflow that reads vars.APPLE_TEAM_ID needs the variable; an unset build offset is named', async () => {
  const app = fixtureApp({ gitInit: false });
  mkdirSync(join(app, '.github/workflows'), { recursive: true });
  writeFileSync(join(app, '.github/workflows/mobile.yml'), 'env:\n  MOBILE_BUILD_OFFSET: ${{ vars.MOBILE_BUILD_OFFSET }}\njobs:\n  ios:\n    runs-on: macos-26\n    environment: mobile-stores\n    env:\n      APPLE_TEAM_ID: ${{ vars.APPLE_TEAM_ID }}\n      DEVELOPER_DIR: /Applications/Xcode_26.6.app/Contents/Developer\n');
  const m = structuredClone(FIXTURE_MANIFEST);
  m.release.backup = 'github-actions:.github/workflows/mobile.yml';
  const root = makeRoot({ manifests: [m], teamId: 'ZXUWDK4J3C' });
  const gh = (vars) => stubRunner({
    ...noKey,
    gh: (args) => (args[1].endsWith('/secrets') ? { stdout: '["ASC_KEY_ID","ASC_ISSUER_ID","ASC_KEY_P8_B64"]\n' }
      : args[1].endsWith('/variables') ? { stdout: `${JSON.stringify(args[1].includes('/environments/') ? vars : [])}\n` }
        : { stdout: 'mobile-stores\n' }),
  });
  const fetch = async (u) => ({ status: 200, url: u });
  let { json } = await doctorJson(['fixture', '--repo', app, '--online'], { root, run: gh([]), fetch });
  let c = byId(json.checks, 'backup.environment');
  assert.equal(c.status, 'BLOCKED');
  assert.match(c.detail, /APPLE_TEAM_ID missing/);
  assert.match(c.detail, /MOBILE_BUILD_OFFSET unset/);
  assert.equal(c.next, 'gh variable set APPLE_TEAM_ID --env mobile-stores --repo example/fixture --body ZXUWDK4J3C (not secret; RUNBOOK step 8)');
  ({ json } = await doctorJson(['fixture', '--repo', app, '--online'], { root, run: gh(['APPLE_TEAM_ID', 'MOBILE_BUILD_OFFSET']), fetch }));
  c = byId(json.checks, 'backup.environment');
  assert.equal(c.status, 'READY', c.detail);
});

test('a privacy manifest the app keeps elsewhere is READY as the app\'s own; two in the target are BLOCKED', async () => {
  const app = fixtureApp({ gitInit: false });
  const root = makeRoot();
  await cli(['conform', 'fixture', '--write', '--repo', app], { root, run: stubRunner() });
  const f = join(app, 'ios/App/App.xcodeproj/project.pbxproj');
  let text = readFileSync(f, 'utf8');
  const id = Object.entries(parsePbxproj(text).objects).find(([, o]) => o.isa === 'PBXFileReference' && o.path === 'PrivacyInfo.xcprivacy')[0];
  text = appendToArray(text.replace(`\t\t\t\t${id} /* PrivacyInfo.xcprivacy */,\n`, ''), '504EC2FB1FED79650016851F', 'children', `${id} /* PrivacyInfo.xcprivacy */`);
  writeFileSync(f, text);
  renameSync(join(app, 'ios/App/App/PrivacyInfo.xcprivacy'), join(app, 'ios/App/PrivacyInfo.xcprivacy'));
  let { json } = await doctorJson(['fixture', '--repo', app], { root, run: stubRunner(noKey) });
  let c = byId(json.checks, 'native.privacy-manifest');
  assert.equal(c.status, 'READY', c.detail);
  assert.match(c.detail, /ios\/App\/PrivacyInfo\.xcprivacy \(the app's own, not next to Info\.plist\) exists/);
  text = insertObject(text, 'PBXFileReference', 'AAAAAAAAAAAAAAAAAAAAAAA1', '/* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };');
  text = appendToArray(text, '504EC3061FED79650016851F', 'children', 'AAAAAAAAAAAAAAAAAAAAAAA1 /* PrivacyInfo.xcprivacy */');
  text = insertObject(text, 'PBXBuildFile', 'AAAAAAAAAAAAAAAAAAAAAAA2', '/* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = AAAAAAAAAAAAAAAAAAAAAAA1 /* PrivacyInfo.xcprivacy */; };');
  text = appendToArray(text, '504EC3021FED79650016851F', 'files', 'AAAAAAAAAAAAAAAAAAAAAAA2 /* PrivacyInfo.xcprivacy in Resources */');
  writeFileSync(f, text);
  ({ json } = await doctorJson(['fixture', '--repo', app], { root, run: stubRunner(noKey) }));
  c = byId(json.checks, 'native.privacy-manifest');
  assert.equal(c.status, 'BLOCKED');
  assert.match(c.detail, /Multiple commands produce/);
});
