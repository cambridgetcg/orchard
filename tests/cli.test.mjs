import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { run } from '../lib/run.mjs';
import { cleanup, cli, makeRoot, REPO, tmp } from './helpers.mjs';

after(cleanup);
const BIN = join(REPO, 'bin', 'orchard');

test('bin/orchard runs from any working directory', () => {
  const r = run(BIN, ['--version'], { cwd: tmp() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
  const apps = run(BIN, ['apps', '--json'], { cwd: tmp() });
  assert.equal(apps.code, 0, apps.stderr);
  assert.ok(JSON.parse(apps.stdout).apps.some((a) => a.name === 'mythseal'));
});

test('every command has --help naming itself', async () => {
  for (const c of ['doctor', 'conform', 'sim', 'key', 'template', 'apps']) {
    const r = await cli([c, '--help'], { root: makeRoot() });
    assert.equal(r.code, 0, c);
    assert.match(r.out, new RegExp(`^orchard ${c}`), c);
    const h = await cli(['help', c], { root: makeRoot() });
    assert.equal(h.out, r.out);
  }
});

test('usage errors exit 2 with a pointer to --help', async () => {
  let r = await cli([], { root: makeRoot() });
  assert.equal(r.code, 2);
  assert.match(r.out, /usage: orchard <command>/);
  r = await cli(['frobnicate'], { root: makeRoot() });
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command "frobnicate"/);
  r = await cli(['apps', '--bogus'], { root: makeRoot() });
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option --bogus[\s\S]*orchard apps --help/);
  r = await cli(['doctor', 'fixture', '--app', 'other'], { root: makeRoot() });
  assert.equal(r.code, 2);
  assert.equal((await cli(['conform', 'fixture', '--repo'], { root: makeRoot() })).code, 2);
});

test('apps lists manifests with status and whether the checkout exists', async () => {
  const r = await cli(['apps'], { root: makeRoot(), home: tmp() });
  assert.equal(r.code, 0);
  assert.match(r.out, /fixture {2}\(Fixture\) {2}status: test/);
  assert.match(r.out, /checkout {3}none set/);
});
