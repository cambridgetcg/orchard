import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadApp, loadOrchard } from '../lib/config.mjs';
import { run } from '../lib/run.mjs';
import { ciPostCloneVars, render, renderCiPostClone } from '../lib/templates.mjs';
import { cleanup, cli, FIXTURE_MANIFEST, makeRoot, tmp } from './helpers.mjs';

after(cleanup);

test('render is strict about placeholders both ways', () => {
  assert.equal(render('a {{x}} b {{ y }}', { x: 1, y: null }), 'a 1 b ');
  assert.throws(() => render('{{x}} {{z}}', { x: 1 }), /no value: z/);
  assert.throws(() => render('{{x}}', { x: 1, extra: 2 }), /does not use: extra/);
});

test('mythseal renders with its preflight, node@24 and no leftover placeholders', () => {
  const { manifest } = loadApp('mythseal');
  const s = renderCiPostClone(manifest, loadOrchard());
  assert.ok(s.startsWith('#!/bin/sh\n'));
  assert.match(s, /^git merge-base --is-ancestor 7a7d03e HEAD$/m);
  assert.match(s, /^brew install node@24$/m);
  assert.match(s, /^npm ci$/m);
  assert.match(s, /^npm run build:native$/m);
  assert.match(s, /ORCHARD_PBXPROJ="ios\/App\/App\.xcodeproj\/project\.pbxproj"/);
  assert.match(s, /Rendered by orchard for Mythseal \(com\.mythseal\.game\)/);
  assert.doesNotMatch(s, /\{\{|\}\}|null|undefined/);
  const f = join(tmp(), 'ci_post_clone.sh');
  writeFileSync(f, s);
  assert.equal(run('/bin/sh', ['-n', f]).code, 0, 'rendered script parses under sh -n');
});

test('preflight renders one command per line; null fields render as nothing', () => {
  const m = structuredClone(FIXTURE_MANIFEST);
  m.release.preflight = ['echo one', 'echo two'];
  m.web = { install: null, build: null, dir: null, test: null };
  const vars = ciPostCloneVars(m, loadOrchard());
  assert.equal(vars.preflight, 'echo one\necho two');
  const s = renderCiPostClone(m, loadOrchard());
  assert.match(s, /\necho one\necho two\n/);
  assert.doesNotMatch(s, /null/);
});

test('taxsorted (null bundleId, null web) renders without "null"', () => {
  const { manifest } = loadApp('taxsorted');
  const s = renderCiPostClone(manifest, loadOrchard());
  assert.doesNotMatch(s, /null|undefined|\{\{/);
  assert.match(s, /Rendered by orchard for TaxSorted \(\)/);
});

test('orchard template ci-post-clone prints the rendered script', async () => {
  const root = makeRoot();
  const r = await cli(['template', 'ci-post-clone', 'fixture'], { root });
  assert.equal(r.code, 0);
  assert.equal(r.out, renderCiPostClone(FIXTURE_MANIFEST, loadOrchard(root), root));
  assert.equal((await cli(['template', 'nope', 'fixture'], { root })).code, 2);
  assert.equal((await cli(['template', 'ci-post-clone'], { root })).code, 2);
});
