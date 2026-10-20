import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { expandHome, loadApp, loadApps, loadOrchard, REPO_ROOT, UsageError, validateManifest } from '../lib/config.mjs';
import { cleanup, FIXTURE_MANIFEST, makeRoot, REPO } from './helpers.mjs';

after(cleanup);

test('REPO_ROOT is the orchard checkout, wherever the CLI runs from', () => {
  assert.equal(REPO_ROOT, REPO);
});

test('the real orchard.json and manifests load and validate', () => {
  const o = loadOrchard();
  assert.equal(o.team.entity, 'Mindicraft Limited');
  assert.match(o.team.teamId, /^[A-Z0-9]{10}$/);
  const { apps, errors } = loadApps();
  assert.deepEqual(errors, []);
  const names = apps.map((a) => a.name);
  assert.ok(names.includes('mythseal'));
  assert.ok(names.includes('taxsorted'));
});

test('validateManifest names each problem', () => {
  assert.deepEqual(validateManifest(FIXTURE_MANIFEST, 'fixture'), []);
  const bad = structuredClone(FIXTURE_MANIFEST);
  bad.bundleId = null;
  bad.ios.orientations = ['Portrait'];
  bad.ios.deviceFamily = [3];
  bad.ios.minIOS = 16;
  bad.release.preflight = ['a\nb'];
  const p = validateManifest(bad, 'fixture');
  assert.ok(p.some((x) => x.includes('bundleId may be null only while status is "blocked"')));
  assert.ok(p.some((x) => x.includes('ios.orientations')));
  assert.ok(p.some((x) => x.includes('ios.deviceFamily')));
  assert.ok(p.some((x) => x.includes('ios.minIOS')));
  assert.ok(p.some((x) => x.includes('single-line')));
  assert.ok(validateManifest(FIXTURE_MANIFEST, 'other').some((x) => x.includes('does not match file name')));
});

test('loadApp resolves --repo against cwd and ~ against home', () => {
  const root = makeRoot({ manifests: [{ ...FIXTURE_MANIFEST, localPath: '~/apps/fixture' }] });
  assert.equal(loadApp('fixture', { root, home: '/h' }).repo, '/h/apps/fixture');
  assert.equal(loadApp('fixture', { root, home: '/h', repoOverride: 'x/y', cwd: '/w' }).repo, '/w/x/y');
  assert.equal(loadApp('fixture', { root, home: '/h', repoOverride: '~/z' }).repo, '/h/z');
  assert.equal(loadApp('fixture', { root, home: '/h', repoOverride: '/abs' }).repo, '/abs');
  assert.equal(expandHome('~', '/h'), '/h');
});

test('an unknown app is a usage error that lists the known ones', () => {
  const root = makeRoot();
  assert.throws(() => loadApp('nope', { root }), (e) => e instanceof UsageError && /known: fixture/.test(e.message));
});

test('loadApps reports an invalid manifest instead of throwing', () => {
  const root = makeRoot({ manifests: [FIXTURE_MANIFEST, { ...FIXTURE_MANIFEST, name: 'broken', ios: null }] });
  const { apps, errors } = loadApps(root);
  assert.deepEqual(apps.map((a) => a.name), ['fixture']);
  assert.equal(errors[0].name, 'broken');
  assert.throws(() => loadApp('broken', { root }), /not usable/);
});
