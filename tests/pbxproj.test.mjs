import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  appendToArray, deterministicId, deviceFamilyValue, insertObject, parseDeviceFamily, parsePbxproj, pbxString, setBuildSetting,
} from '../lib/pbxproj.mjs';
import { run } from '../lib/run.mjs';
import { cleanup, FIXTURE, tmp } from './helpers.mjs';

after(cleanup);
const TEXT = readFileSync(join(FIXTURE, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');

function lint(text) {
  const f = join(tmp(), 'project.pbxproj');
  writeFileSync(f, text);
  return run('plutil', ['-lint', f]).code === 0;
}

test('parses the Capacitor 8.5.3 template: app target, its configs and inherited settings', () => {
  const p = parsePbxproj(TEXT);
  const t = p.appTarget('App');
  assert.equal(t.id, '504EC3031FED79650016851F');
  assert.deepEqual(p.configs(t).map((c) => c.name), ['Debug', 'Release']);
  assert.equal(p.effectiveSetting(t, 'Release', 'IPHONEOS_DEPLOYMENT_TARGET').level, 'target');
  assert.deepEqual(p.effectiveSetting(t, 'Release', 'SDKROOT'), { value: 'iphoneos', level: 'project' });
  assert.equal(p.resolvedPaths().get('504EC3131FED79650016851F'), 'App/Info.plist');
  assert.equal(p.phase(t, 'PBXResourcesBuildPhase').id, '504EC3021FED79650016851F');
});

test('setBuildSetting replaces in place and inserts new keys in alphabetical order', () => {
  const debug = '504EC3171FED79650016851F';
  let t = setBuildSetting(TEXT, debug, 'IPHONEOS_DEPLOYMENT_TARGET', '16.0');
  t = setBuildSetting(t, debug, 'DEVELOPMENT_TEAM', 'ABCDE12345');
  const p = parsePbxproj(t);
  assert.equal(p.objects[debug].buildSettings.IPHONEOS_DEPLOYMENT_TARGET, '16.0');
  assert.equal(p.objects[debug].buildSettings.DEVELOPMENT_TEAM, 'ABCDE12345');
  // project-level Debug (504EC3141…) keeps its own value
  assert.equal(p.objects['504EC3141FED79650016851F'].buildSettings.IPHONEOS_DEPLOYMENT_TARGET, '15.0');
  assert.match(t, /\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tDEVELOPMENT_TEAM = ABCDE12345;\n\t\t\t\tINFOPLIST_FILE/);
  assert.ok(lint(t));
  // only the touched lines differ
  const changed = t.split('\n').filter((l) => !TEXT.includes(l));
  assert.deepEqual(changed.map((l) => l.trim()).sort(), ['DEVELOPMENT_TEAM = ABCDE12345;', 'IPHONEOS_DEPLOYMENT_TARGET = 16.0;']);
});

test('insertObject keeps the section sorted; appendToArray adds to a list', () => {
  let t = insertObject(TEXT, 'PBXFileReference', '5000000000000000000000AA', '/* X.txt */ = {isa = PBXFileReference; path = X.txt; sourceTree = "<group>"; };');
  t = appendToArray(t, '504EC3061FED79650016851F', 'children', '5000000000000000000000AA /* X.txt */');
  const p = parsePbxproj(t);
  assert.equal(p.objects['5000000000000000000000AA'].path, 'X.txt');
  assert.equal(p.objects['504EC3061FED79650016851F'].children.at(-1), '5000000000000000000000AA');
  const sec = t.slice(t.indexOf('/* Begin PBXFileReference section */'), t.indexOf('/* End PBXFileReference section */'));
  const ids = [...sec.matchAll(/^\t\t([0-9A-F]{24}) /gm)].map((m) => m[1]);
  assert.deepEqual(ids, [...ids].sort());
  assert.ok(lint(t));
  assert.throws(() => insertObject(t, 'PBXFileReference', '5000000000000000000000AA', '= {};'), /already exists/);
});

test('appendToArray rewrites an empty inline list across lines', () => {
  const t = TEXT.replace(/buildRules = \(\n\t\t\t\);/, 'buildRules = ( );');
  const out = appendToArray(t, '504EC3031FED79650016851F', 'buildRules', 'AAAAAAAAAAAAAAAAAAAAAAAA /* r */');
  assert.match(out, /buildRules = \(\n\t\t\t\tAAAAAAAAAAAAAAAAAAAAAAAA \/\* r \*\/,\n\t\t\t\);/);
});

test('deterministicId is stable, 24 hex characters, and skips taken ids', () => {
  const a = deterministicId('seed', () => false);
  assert.match(a, /^[0-9A-F]{24}$/);
  assert.equal(deterministicId('seed', () => false), a);
  const b = deterministicId('seed', (id) => id === a);
  assert.notEqual(b, a);
  assert.match(b, /^[0-9A-F]{24}$/);
});

test('values are quoted the way Xcode writes them', () => {
  assert.equal(pbxString('16.0'), '16.0');
  assert.equal(pbxString('1,2'), '"1,2"');
  assert.equal(pbxString('App/Info.plist'), 'App/Info.plist');
  assert.equal(pbxString('dwarf-with-dsym'), '"dwarf-with-dsym"');
  assert.equal(pbxString('$(inherited)'), '"$(inherited)"');
  assert.equal(deviceFamilyValue([2, 1]), '1,2');
  assert.deepEqual(parseDeviceFamily('1,2'), [1, 2]);
  assert.deepEqual(parseDeviceFamily(1), [1]);
});

test('a broken file is a clear error, not a crash', () => {
  assert.throws(() => parsePbxproj(TEXT.replace('isa = PBXNativeTarget;', 'isa = PBXNativeTarget')), /expected ; at line \d+/);
});
