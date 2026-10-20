import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadOrchard } from '../lib/config.mjs';
import { appendToArray, insertObject, parsePbxproj } from '../lib/pbxproj.mjs';
import { run } from '../lib/run.mjs';
import { renderCiPostClone } from '../lib/templates.mjs';
import { cleanup, cli, FIXTURE_MANIFEST, fixtureApp, makeRoot, stubRunner } from './helpers.mjs';

after(cleanup);

const PBX = 'ios/App/App.xcodeproj/project.pbxproj';
const PLIST = 'ios/App/App/Info.plist';
const CI = 'ios/App/ci_scripts/ci_post_clone.sh';
const PRIVACY = 'ios/App/App/PrivacyInfo.xcprivacy';
const SPM = 'ios/App/CapApp-SPM/Package.swift';

function snapshot(dir) {
  const h = createHash('sha256');
  for (const f of [PBX, PLIST, CI, PRIVACY, SPM]) h.update(f + (existsSync(join(dir, f)) ? readFileSync(join(dir, f)) : '<none>'));
  return h.digest('hex');
}

/** Adds dependencies to the fixture's package.json, the way an app lists its Capacitor plugins. */
function addDeps(app, deps) {
  const f = join(app, 'package.json');
  const pkg = JSON.parse(readFileSync(f, 'utf8'));
  pkg.devDependencies = { ...pkg.devDependencies, ...deps };
  writeFileSync(f, JSON.stringify(pkg, null, 2));
}

function plist(file) {
  return JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', file]).stdout);
}

async function conform(app, mode, extra = {}) {
  const root = extra.root ?? makeRoot();
  return cli(['conform', 'fixture', `--${mode}`, '--repo', app], { root, run: extra.run ?? stubRunner() });
}

test('--check prints the plan, exits 1 and changes nothing', async () => {
  const app = fixtureApp();
  const before = snapshot(app);
  const r = await conform(app, 'check');
  assert.equal(r.code, 1);
  assert.equal(snapshot(app), before);
  for (const line of [
    '  + ITSAppUsesNonExemptEncryption = false',
    '  - UISupportedInterfaceOrientations = (UIInterfaceOrientationPortrait, UIInterfaceOrientationLandscapeLeft, UIInterfaceOrientationLandscapeRight)',
    '  + UISupportedInterfaceOrientations = (UIInterfaceOrientationPortrait)',
    '  - UIRequiredDeviceCapabilities = (armv7)',
    '  + UIRequiredDeviceCapabilities = (arm64)',
    '  - IPHONEOS_DEPLOYMENT_TARGET = 15.0;   [Debug, Release, project Debug, project Release]',
    '  + IPHONEOS_DEPLOYMENT_TARGET = 16.0;   [Debug, Release, project Debug, project Release]',
    '  - TARGETED_DEVICE_FAMILY = "1,2";   [Debug, Release]',
    '  + TARGETED_DEVICE_FAMILY = 1;   [Debug, Release]',
    '  - platforms: [.iOS(.v15)]',
    '  + platforms: [.iOS(.v16)]',
  ]) assert.ok(r.out.includes(line), `plan has: ${line}\n---\n${r.out}`);
  assert.match(r.out, /\+ PBXFileReference [0-9A-F]{24} \/\* PrivacyInfo\.xcprivacy \*\/ path = PrivacyInfo\.xcprivacy/);
  assert.match(r.out, /\+ Resources phase 504EC3021FED79650016851F: [0-9A-F]{24}/);
  assert.match(r.out, /ios\/App\/ci_scripts\/ci_post_clone\.sh\n {2}\+ new file, mode 0755/);
  assert.match(r.out, /16 change\(s\) planned/);
});

test('--write applies everything, verifies it, and a rerun is a no-op', async () => {
  const app = fixtureApp();
  const root = makeRoot();
  const r = await conform(app, 'write', { root });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Verified: a second pass finds nothing to change/);
  // valid files
  for (const f of [PBX, PLIST, PRIVACY]) assert.equal(run('plutil', ['-lint', join(app, f)]).code, 0, `${f} lints`);
  // Info.plist
  const pl = plist(join(app, PLIST));
  assert.equal(pl.ITSAppUsesNonExemptEncryption, false);
  assert.deepEqual(pl.UISupportedInterfaceOrientations, ['UIInterfaceOrientationPortrait']);
  assert.deepEqual(pl.UIRequiredDeviceCapabilities, ['arm64']);
  assert.equal(pl.CFBundleDisplayName, 'Fixture', 'untouched keys survive');
  // pbxproj: app target only
  const p = parsePbxproj(readFileSync(join(app, PBX), 'utf8'));
  const t = p.appTarget('App');
  for (const c of p.configs(t)) {
    assert.equal(c.settings.IPHONEOS_DEPLOYMENT_TARGET, '16.0');
    assert.equal(c.settings.TARGETED_DEVICE_FAMILY, '1');
  }
  // cap sync writes CapApp-SPM's platform from the first deployment target in the file, a project-level one
  for (const c of p.projectConfigs()) assert.equal(c.settings.IPHONEOS_DEPLOYMENT_TARGET, '16.0', 'project level raised too');
  assert.match(readFileSync(join(app, SPM), 'utf8'), /platforms: \[\.iOS\(\.v16\)\]/);
  // PrivacyInfo: file reference, group child, build file, Resources phase
  const ref = Object.entries(p.objects).find(([, o]) => o.isa === 'PBXFileReference' && o.path === 'PrivacyInfo.xcprivacy');
  assert.ok(ref, 'file reference');
  assert.equal(ref[1].lastKnownFileType, 'text.xml');
  assert.ok(p.objects['504EC3061FED79650016851F'].children.includes(ref[0]), 'in the App group');
  const bf = Object.entries(p.objects).find(([, o]) => o.isa === 'PBXBuildFile' && o.fileRef === ref[0]);
  assert.ok(bf, 'build file');
  assert.ok(p.objects['504EC3021FED79650016851F'].files.includes(bf[0]), 'in Resources');
  // ci script
  const ci = join(app, CI);
  assert.equal(readFileSync(ci, 'utf8'), renderCiPostClone(FIXTURE_MANIFEST, loadOrchard(root), root));
  assert.equal(statSync(ci).mode & 0o777, 0o755);
  // idempotent
  const once = snapshot(app);
  const again = await conform(app, 'write', { root });
  assert.equal(again.code, 0);
  assert.match(again.out, /Nothing to write/);
  assert.equal(snapshot(app), once);
  const check = await conform(app, 'check', { root });
  assert.equal(check.code, 0);
  assert.match(check.out, /No changes needed/);
});

test('privacy reference ids are derived, so two copies get the same ids', async () => {
  const a = fixtureApp({ gitInit: false });
  const b = fixtureApp({ gitInit: false });
  await conform(a, 'write');
  await conform(b, 'write');
  assert.equal(readFileSync(join(a, PBX), 'utf8'), readFileSync(join(b, PBX), 'utf8'));
});

test('an existing privacy manifest is the app\'s own: kept, only referenced', async () => {
  const app = fixtureApp({ gitInit: false });
  const own = readFileSync(join(makeRoot(), 'templates/ios/PrivacyInfo.xcprivacy'), 'utf8').replace('<false/>', '<false/>\n\t<!-- app wording -->');
  writeFileSync(join(app, PRIVACY), own);
  const r = await conform(app, 'write');
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(app, PRIVACY), 'utf8'), own);
});

test('a deployment target above the minimum is not lowered, and CapApp-SPM follows the first one', async () => {
  const app = fixtureApp({ gitInit: false });
  const f = join(app, PBX);
  writeFileSync(f, readFileSync(f, 'utf8').replaceAll('IPHONEOS_DEPLOYMENT_TARGET = 15.0;', 'IPHONEOS_DEPLOYMENT_TARGET = 17.2;'));
  const r = await conform(app, 'check');
  assert.doesNotMatch(r.out, /[-+] IPHONEOS_DEPLOYMENT_TARGET/);
  assert.ok(r.out.includes('  + platforms: [.iOS(.v17)]'), r.out);
});

test('an Info.plist reference relative to SOURCE_ROOT: the privacy reference resolves, a second pass is clean', async () => {
  const app = fixtureApp({ gitInit: false });
  const f = join(app, PBX);
  const text = readFileSync(f, 'utf8');
  const edited = text.replace('path = Info.plist; sourceTree = "<group>";', 'path = App/Info.plist; sourceTree = SOURCE_ROOT;');
  assert.notEqual(edited, text);
  writeFileSync(f, edited);
  const root = makeRoot();
  const r = await conform(app, 'write', { root });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Verified: a second pass finds nothing to change/);
  const p = parsePbxproj(readFileSync(f, 'utf8'));
  const refs = Object.entries(p.objects).filter(([, o]) => o.isa === 'PBXFileReference' && /PrivacyInfo\.xcprivacy$/.test(o.path ?? ''));
  assert.equal(refs.length, 1, 'one reference');
  assert.equal(p.resolvedPaths().get(refs[0][0]), 'App/PrivacyInfo.xcprivacy', 'it resolves to the file conform created');
  assert.match((await conform(app, 'write', { root })).out, /Nothing to write/);
});

test('a write that a second pass does not accept is undone, file by file', async () => {
  const app = fixtureApp({ gitInit: false });
  const before = snapshot(app);
  // PlistBuddy that reports success and changes nothing: the Info.plist edits never land, so the
  // second pass still finds them pending, which is what a bug in conform would look like.
  const runner = stubRunner({ '/usr/libexec/PlistBuddy': () => ({ code: 0 }) });
  const r = await conform(app, 'write', { run: runner });
  assert.equal(r.code, 1);
  assert.match(r.err, /still show as pending; this is a bug in orchard conform\. Every file conform touched was put back/);
  assert.equal(snapshot(app), before, 'pbxproj, Package.swift, Info.plist restored; created files removed');
  assert.ok(!existsSync(join(app, 'ios/App/ci_scripts')), 'a directory conform created is gone too');
});

test('a manifest the app target already ships elsewhere is the app\'s: no second one, only missing wiring', async () => {
  const app = fixtureApp({ gitInit: false });
  const root = makeRoot();
  await conform(app, 'write', { root });
  // Move the manifest to ios/App/ and its reference to the main group, as an app might keep it.
  const f = join(app, PBX);
  let text = readFileSync(f, 'utf8');
  const id = Object.entries(parsePbxproj(text).objects).find(([, o]) => o.isa === 'PBXFileReference' && o.path === 'PrivacyInfo.xcprivacy')[0];
  const child = `\t\t\t\t${id} /* PrivacyInfo.xcprivacy */,\n`;
  assert.ok(text.includes(child));
  text = appendToArray(text.replace(child, ''), '504EC2FB1FED79650016851F', 'children', `${id} /* PrivacyInfo.xcprivacy */`);
  writeFileSync(f, text);
  renameSync(join(app, PRIVACY), join(app, 'ios/App/PrivacyInfo.xcprivacy'));
  let r = await conform(app, 'check', { root });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /No changes needed/);
  // Still referenced but no longer copied: conform finishes that reference, it does not mint one.
  const bf = Object.entries(parsePbxproj(text).objects).find(([, o]) => o.isa === 'PBXBuildFile' && o.fileRef === id)[0];
  const entry = `\t\t\t\t${bf} /* PrivacyInfo.xcprivacy in Resources */,\n`;
  assert.ok(text.includes(entry));
  writeFileSync(f, text.replace(entry, ''));
  r = await conform(app, 'check', { root });
  assert.match(r.out, /1 change\(s\) planned/, r.out);
  assert.match(r.out, new RegExp(`\\+ Resources phase 504EC3021FED79650016851F: ${bf}`));
  assert.doesNotMatch(r.out, /PBXFileReference|new file from templates/);
  assert.equal((await conform(app, 'write', { root })).code, 0);
  assert.ok(!existsSync(join(app, PRIVACY)), 'no second manifest next to Info.plist');
});

test('two manifests in the app target are reported, never added to', async () => {
  const app = fixtureApp({ gitInit: false });
  const root = makeRoot();
  await conform(app, 'write', { root });
  const f = join(app, PBX);
  let text = readFileSync(f, 'utf8');
  text = insertObject(text, 'PBXFileReference', 'AAAAAAAAAAAAAAAAAAAAAAA1', '/* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };');
  text = appendToArray(text, '504EC2FB1FED79650016851F', 'children', 'AAAAAAAAAAAAAAAAAAAAAAA1 /* PrivacyInfo.xcprivacy */');
  text = insertObject(text, 'PBXBuildFile', 'AAAAAAAAAAAAAAAAAAAAAAA2', '/* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = AAAAAAAAAAAAAAAAAAAAAAA1 /* PrivacyInfo.xcprivacy */; };');
  text = appendToArray(text, '504EC3021FED79650016851F', 'files', 'AAAAAAAAAAAAAAAAAAAAAAA2 /* PrivacyInfo.xcprivacy in Resources */');
  writeFileSync(f, text);
  const r = await conform(app, 'check', { root });
  assert.equal(r.code, 1);
  assert.match(r.out, /copies 2 files named PrivacyInfo\.xcprivacy[\s\S]*Multiple commands produce/);
  assert.doesNotMatch(r.out, /change\(s\) planned/);
});

test('required-reason categories the plugins need are added; the app\'s own entries stay', async () => {
  // A new manifest: the template plus what the plugins need.
  let app = fixtureApp({ gitInit: false });
  addDeps(app, { '@capacitor/filesystem': '8.1.5', '@capacitor/preferences': '8.0.1', '@capacitor/share': '8.0.3' });
  const root = makeRoot();
  let r = await conform(app, 'check', { root });
  assert.match(r.out, /\+ NSPrivacyAccessedAPITypes: NSPrivacyAccessedAPICategoryFileTimestamp, reason C617\.1 {3}\(@capacitor\/filesystem needs it/);
  assert.match(r.out, /\+ NSPrivacyAccessedAPITypes: NSPrivacyAccessedAPICategoryUserDefaults, reason CA92\.1/);
  r = await conform(app, 'write', { root });
  assert.equal(r.code, 0, r.out + r.err);
  let types = plist(join(app, PRIVACY)).NSPrivacyAccessedAPITypes;
  assert.deepEqual(types.map((t) => [t.NSPrivacyAccessedAPIType, t.NSPrivacyAccessedAPITypeReasons]), [
    ['NSPrivacyAccessedAPICategoryFileTimestamp', ['C617.1']],
    ['NSPrivacyAccessedAPICategoryUserDefaults', ['CA92.1']],
  ]);
  assert.match((await conform(app, 'check', { root })).out, /No changes needed/);
  // An existing manifest: its own declarations (another reason, another category) are kept.
  app = fixtureApp({ gitInit: false });
  addDeps(app, { '@capacitor/filesystem': '8.1.5', '@capacitor/preferences': '8.0.1' });
  const own = readFileSync(join(root, 'templates/ios/PrivacyInfo.xcprivacy'), 'utf8').replace('<key>NSPrivacyAccessedAPITypes</key>\n\t<array/>',
    '<key>NSPrivacyAccessedAPITypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>NSPrivacyAccessedAPIType</key>\n\t\t\t<string>NSPrivacyAccessedAPICategoryDiskSpace</string>\n\t\t\t<key>NSPrivacyAccessedAPITypeReasons</key>\n\t\t\t<array><string>E174.1</string></array>\n\t\t</dict>\n\t\t<dict>\n\t\t\t<key>NSPrivacyAccessedAPIType</key>\n\t\t\t<string>NSPrivacyAccessedAPICategoryFileTimestamp</string>\n\t\t\t<key>NSPrivacyAccessedAPITypeReasons</key>\n\t\t\t<array><string>3B52.1</string></array>\n\t\t</dict>\n\t</array>');
  writeFileSync(join(app, PRIVACY), own);
  r = await conform(app, 'write', { root });
  assert.equal(r.code, 0, r.out + r.err);
  types = plist(join(app, PRIVACY)).NSPrivacyAccessedAPITypes;
  assert.deepEqual(types.map((t) => [t.NSPrivacyAccessedAPIType, t.NSPrivacyAccessedAPITypeReasons]), [
    ['NSPrivacyAccessedAPICategoryDiskSpace', ['E174.1']],
    ['NSPrivacyAccessedAPICategoryFileTimestamp', ['3B52.1']],
    ['NSPrivacyAccessedAPICategoryUserDefaults', ['CA92.1']],
  ], 'the app\'s reason for file timestamps is its own; only the missing category was added');
});

test('a capacitor.config.ts beside the JSON one: the JSON is not trusted', async () => {
  const app = fixtureApp({ gitInit: false });
  writeFileSync(join(app, 'capacitor.config.ts'), "export default { appId: 'com.example.orchard.fixture', webDir: 'www', server: { url: 'https://live.example.com' } };\n");
  const r = await conform(app, 'check');
  assert.equal(r.code, 1);
  assert.match(r.out, /! capacitor\.config\.json is ignored: Capacitor loads capacitor\.config\.ts first/);
});

test('drift in ci_post_clone.sh shows as a diff and --write puts the template back', async () => {
  const app = fixtureApp({ gitInit: false });
  const root = makeRoot();
  await conform(app, 'write', { root });
  const ci = join(app, CI);
  writeFileSync(ci, readFileSync(ci, 'utf8').replace('./node_modules/.bin/cap sync ios', './node_modules/.bin/cap copy ios'));
  const r = await conform(app, 'check', { root });
  assert.equal(r.code, 1);
  assert.match(r.out, /drifted from the rendered template/);
  assert.match(r.out, /-\.\/node_modules\/\.bin\/cap copy ios\n\s+\+\.\/node_modules\/\.bin\/cap sync ios/);
  assert.equal((await conform(app, 'write', { root })).code, 0);
  assert.match(readFileSync(ci, 'utf8'), /\.\/node_modules\/\.bin\/cap sync ios/);
});

test('refuses (exit 3, nothing written) when capacitor config sets server.url', async () => {
  const app = fixtureApp({ gitInit: false });
  writeFileSync(join(app, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.orchard.fixture', webDir: 'dist', server: { url: 'https://live.example' } }));
  const before = snapshot(app);
  const r = await conform(app, 'write');
  assert.equal(r.code, 3);
  assert.match(r.out, /REFUSED[\s\S]*server\.url \(https:\/\/live\.example\)/);
  assert.equal(snapshot(app), before);
});

test('refuses a JSON .xcproj project and never converts it', async () => {
  const app = fixtureApp({ gitInit: false });
  mkdirSync(join(app, 'ios/App/App.xcproj'));
  const r = await conform(app, 'write');
  assert.equal(r.code, 3);
  assert.match(r.out, /JSON \.xcproj[\s\S]*#8607/);
});

test('app-owned identifiers are reported as manual, not changed', async () => {
  const app = fixtureApp({ gitInit: false });
  writeFileSync(join(app, 'capacitor.config.json'), JSON.stringify({ appId: 'com.other.app', webDir: 'dist' }));
  const r = await conform(app, 'write');
  assert.equal(r.code, 1);
  assert.match(r.out, /! capacitor\.config\.json appId is com\.other\.app, manifest bundleId is com\.example\.orchard\.fixture/);
  assert.equal(JSON.parse(readFileSync(join(app, 'capacitor.config.json'), 'utf8')).appId, 'com.other.app');
});

test('a pbxproj write that fails plutil -lint is rolled back', async () => {
  const app = fixtureApp({ gitInit: false });
  const original = readFileSync(join(app, PBX), 'utf8');
  const runner = stubRunner({
    plutil: (args) => (args[0] === '-lint' && args[1].endsWith('project.pbxproj')
      ? { code: 1, stderr: 'simulated lint failure' }
      : run('plutil', args)),
  });
  const r = await conform(app, 'write', { run: runner });
  assert.equal(r.code, 1);
  assert.match(r.err, /project\.pbxproj failed verification[\s\S]*original restored/);
  assert.equal(readFileSync(join(app, PBX), 'utf8'), original);
});

test('usage errors exit 2', async () => {
  const root = makeRoot();
  assert.equal((await cli(['conform', 'fixture', '--check', '--write', '--repo', '/x'], { root })).code, 2);
  assert.equal((await cli(['conform'], { root })).code, 2);
  assert.equal((await cli(['conform', 'fixture', '--bogus'], { root })).code, 2);
});
