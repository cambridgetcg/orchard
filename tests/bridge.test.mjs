// bridge/orchard-bridge.mjs against a fake Capacitor shaped like the one @capacitor/ios 8.5.3
// injects: window.Capacitor.Plugins[jsName] holds one promise-returning function per native
// method, and Capacitor.PluginHeaders lists them (JSExport.swift 73-109). The fake Filesystem
// follows the iOS plugin 8.1.5 / ion-ios-filesystem 2.0.1 behaviour the bridge depends on: a
// missing file rejects with code OS-PLUG-FILE-0008, and rename deletes the destination before
// moving. A fake proves the page's side of the contract, not the plugins' native code.
//
// Opt-in: ORCHARD_CAPACITOR_IOS=<path to an @capacitor/ios package> also runs the bridge through
// that package's real native-bridge.js in a vm context (see the last test).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import * as defaults from '../bridge/orchard-bridge.mjs';
import { createBridge, HAPTIC_KINDS, SaveCancelled } from '../bridge/orchard-bridge.mjs';
import { REPO } from './helpers.mjs';

const NOT_FOUND = 'OS-PLUG-FILE-0008';
const SOURCE = readFileSync(join(REPO, 'bridge', 'orchard-bridge.mjs'), 'utf8');

/** Native method lists as the plugins declare them (pluginMethods in each *Plugin.swift). */
const NATIVE_METHODS = {
  Filesystem: ['readFile', 'readFileInChunks', 'writeFile', 'appendFile', 'deleteFile', 'mkdir', 'rmdir', 'readdir', 'getUri', 'stat', 'rename', 'copy', 'checkPermissions', 'requestPermissions', 'downloadFile'],
  Share: ['canShare', 'share'],
  Haptics: ['impact', 'notification', 'selectionStart', 'selectionChanged', 'selectionEnd', 'vibrate'],
};

function notFound(method, path) {
  return Object.assign(new Error(`'${method}' failed because file at 'file:///app/${path}' does not exist.`), { code: NOT_FOUND });
}

/** In-memory native side: the plugin implementations plus a call log and fault switches. */
function nativeSide({ share = 'complete' } = {}) {
  const files = new Map(), calls = [], faults = {};
  const at = (directory, path) => `${directory}:${path}`;
  const Filesystem = {
    async readFile(o) {
      calls.push(['readFile', o]);
      if (faults.read) throw faults.read;
      if (!files.has(at(o.directory, o.path))) throw notFound('readFile', o.path);
      return { data: files.get(at(o.directory, o.path)) };
    },
    async writeFile(o) {
      calls.push(['writeFile', o]);
      if (faults.write) throw faults.write;
      // String.write(atomically: false) opens with O_TRUNC; on a full APFS volume Foundation left
      // a 0-byte file in every test, so a failed write empties the file it was writing.
      if (faults.tornWrite) { faults.tornWrite = false; files.set(at(o.directory, o.path), ''); throw new Error('disk full'); }
      files.set(at(o.directory, o.path), o.data);
      return { uri: `file:///app/${o.directory}/${o.path}` };
    },
    async rename(o) {
      calls.push(['rename', o]);
      const from = at(o.directory, o.from), to = at(o.toDirectory ?? o.directory, o.to);
      if (!files.has(from)) throw notFound('rename', o.from);
      files.delete(to); // ion-ios-filesystem deletes the destination, then moves
      if (faults.cutRename) { faults.cutRename = false; throw new Error('interrupted'); }
      files.set(to, files.get(from));
      files.delete(from);
    },
    async deleteFile(o) {
      calls.push(['deleteFile', o]);
      if (!files.delete(at(o.directory, o.path))) throw notFound('deleteFile', o.path);
    },
  };
  const Share = {
    async share(o) {
      calls.push(['share', o]);
      if (share === 'cancel') throw new Error('Share canceled');
      if (share === 'fail') throw new Error('Error sharing item');
      return { activityType: 'com.apple.DocumentManagerUICore.SaveToFiles' };
    },
  };
  const Haptics = Object.fromEntries(NATIVE_METHODS.Haptics.map(name => [name, async options => {
    calls.push([name, options]);
    if (faults.haptics) throw faults.haptics;
  }]));
  return { files, calls, faults, at, implementations: { Filesystem, Share, Haptics } };
}

/** A fake window.Capacitor as the iOS shell injects it, with only the named plugins synced. */
function fakeShell({ plugins = ['Filesystem', 'Share', 'Haptics'], headers = true, share } = {}) {
  const side = nativeSide({ share });
  const Plugins = {}, PluginHeaders = [];
  for (const name of plugins) {
    Plugins[name] = { ...side.implementations[name] };
    PluginHeaders.push({ name, methods: NATIVE_METHODS[name].map(method => ({ name: method, rtype: 'promise' })) });
  }
  const Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins };
  if (headers) Capacitor.PluginHeaders = PluginHeaders;
  return { ...side, scope: { Capacitor } };
}

/** A minimal page for the web path: createElement('a'), URL.createObjectURL and Blob. */
function fakePage() {
  const events = [], timers = [];
  const document = {
    createElement(tag) {
      events.push(['createElement', tag]);
      return { click() { events.push(['click', this.href, this.download]); } };
    },
  };
  const URL = {
    createObjectURL(blob) { events.push(['createObjectURL', blob]); return 'blob:fixture'; },
    revokeObjectURL(href) { events.push(['revokeObjectURL', href]); },
  };
  return { events, timers, scope: { Capacitor: undefined, document, URL, Blob, setTimeout: (fn, ms) => timers.push([fn, ms]) } };
}

test('the file is vendorable: the stamp line comes first and nothing is imported', () => {
  assert.equal(SOURCE.split('\n')[0], '// vendored from orchard <commit>; edit upstream');
  assert.doesNotMatch(SOURCE, /^\s*import\b|\bimport\s*\(|\brequire\s*\(|^\s*export\s.*\bfrom\s/m);
  for (const source of ['CapacitorBridge.swift', 'JSExport.swift', 'native-bridge.js', 'bridge/README.md']) {
    assert.ok(SOURCE.slice(0, SOURCE.indexOf('*/')).includes(source), `the header names its evidence: ${source}`);
  }
});

test('isNative is true only when Capacitor reports a native platform', () => {
  assert.equal(createBridge({ scope: {} }).isNative(), false, 'a browser or Node: no bridge');
  assert.equal(createBridge({ scope: { Capacitor: { isNativePlatform: () => false, Plugins: {} } } }).isNative(), false, 'a web page that bundles @capacitor/core');
  assert.equal(createBridge({ scope: { Capacitor: { isNativePlatform() { throw new Error('x'); } } } }).isNative(), false);
  assert.equal(createBridge({ scope: { Capacitor: { isNativePlatform: () => 'yes' } } }).isNative(), false, 'only a literal true counts');
  assert.equal(createBridge(fakeShell()).isNative(), true);
});

test('the default exports read window.Capacitor when called, not when imported', async () => {
  assert.equal(defaults.isNative(), false);
  const shell = fakeShell();
  globalThis.Capacitor = shell.scope.Capacitor;
  try {
    assert.equal(defaults.isNative(), true);
    assert.equal(await defaults.durable.set('k', { a: 1 }), true);
    assert.equal(shell.files.get(shell.at('LIBRARY', 'orchard/k.json')), '{"a":1}', 'default folder is Library/orchard');
    assert.equal(await defaults.haptic('light'), true);
  } finally {
    delete globalThis.Capacitor;
  }
  assert.equal(defaults.isNative(), false);
});

test('plugin() returns the injected object, only in the native shell and only with its methods', () => {
  const shell = fakeShell();
  const bridge = createBridge(shell);
  assert.equal(bridge.plugin('Filesystem', ['writeFile', 'rename']), shell.scope.Capacitor.Plugins.Filesystem);
  assert.equal(bridge.plugin('Filesystem', ['noSuchMethod']), null);
  assert.equal(bridge.plugin('Camera'), null);
  assert.equal(createBridge({ scope: { Capacitor: { isNativePlatform: () => false, Plugins: shell.scope.Capacitor.Plugins } } }).plugin('Filesystem'), null);
  // @capacitor/core's registerPlugin() puts a Proxy in Plugins that answers every property with a
  // function, synced or not. The native header list is what says the plugin is really there.
  const anything = new Proxy({}, { get: () => () => Promise.reject(new Error('"Haptics" plugin is not implemented on ios')) });
  const withCore = fakeShell({ plugins: ['Filesystem', 'Share'] });
  withCore.scope.Capacitor.Plugins.Haptics = anything;
  assert.equal(createBridge(withCore).plugin('Haptics', ['impact']), null);
  // A runtime without PluginHeaders falls back to the method check alone.
  const bare = fakeShell({ headers: false });
  assert.equal(createBridge(bare).plugin('Share', ['share']), bare.scope.Capacitor.Plugins.Share);
});

test('on the web saveFile downloads a Blob, clicked before the first await', async () => {
  const page = fakePage();
  const pending = createBridge(page).saveFile({ name: 'journey.json', mime: 'application/json', text: '{"a":1}' });
  assert.deepEqual(page.events.map(([kind]) => kind), ['createObjectURL', 'createElement', 'click'], 'all before saveFile awaited anything');
  const blob = page.events[0][1];
  assert.equal(blob.type, 'application/json');
  assert.equal(await blob.text(), '{"a":1}');
  assert.deepEqual(page.events[2], ['click', 'blob:fixture', 'journey.json']);
  assert.deepEqual(await pending, { via: 'download' });
  assert.equal(page.timers.length, 1, 'the object URL is revoked later, not before the download starts');
  page.timers[0][0]();
  assert.deepEqual(page.events.at(-1), ['revokeObjectURL', 'blob:fixture']);
});

test('on the web bytes download as they are, with a sensible default type', async () => {
  const page = fakePage();
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  await createBridge(page).saveFile({ name: 'a.bin', bytes });
  const blob = page.events[0][1];
  assert.equal(blob.type, 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  await createBridge(page).saveFile({ name: 'a.txt', text: 'hi' });
  assert.equal(page.events.filter(([kind]) => kind === 'createObjectURL')[1][1].type, 'text/plain;charset=utf-8');
});

test('without a document (a worker, or Node) the web path says unavailable', async () => {
  await assert.rejects(createBridge({ scope: {} }).saveFile({ name: 'a.json', text: '{}' }), error => error.code === 'unavailable');
});

test('in the app saveFile writes to Cache and opens the share sheet', async () => {
  const shell = fakeShell();
  const result = await createBridge(shell).saveFile({ name: 'journey.json', mime: 'application/json', text: '{"a":1}' });
  assert.deepEqual(shell.calls, [
    ['writeFile', { path: 'exports/journey.json', directory: 'CACHE', recursive: true, data: '{"a":1}', encoding: 'utf8' }],
    ['share', { title: 'journey.json', files: ['file:///app/CACHE/exports/journey.json'] }],
  ]);
  assert.deepEqual(result, { via: 'share', activityType: 'com.apple.DocumentManagerUICore.SaveToFiles', uri: 'file:///app/CACHE/exports/journey.json' });
});

test('in the app bytes travel as base64 with no encoding, as the Filesystem plugin expects', async () => {
  const shell = fakeShell();
  const bytes = new Uint8Array(20_000).map((_, i) => (i * 7) % 256); // more than one base64 chunk
  await createBridge(shell).saveFile({ name: 'pic.png', bytes: bytes.buffer });
  const [, options] = shell.calls[0];
  assert.equal('encoding' in options, false);
  assert.deepEqual(new Uint8Array(Buffer.from(options.data, 'base64')), bytes);
  // A view into a larger buffer sends only its own bytes.
  const view = new Uint8Array([9, 8, 7, 6, 5]).subarray(1, 3);
  await createBridge(shell).saveFile({ name: 'v.bin', bytes: view });
  assert.equal(shell.calls.at(-2)[1].data, Buffer.from([8, 7]).toString('base64'));
});

test('a dismissed sheet is SaveCancelled, a broken one its own error, missing plugins unavailable', async () => {
  await assert.rejects(createBridge(fakeShell({ share: 'cancel' })).saveFile({ name: 'a.json', text: '{}' }),
    error => error instanceof SaveCancelled && error.code === 'cancelled');
  await assert.rejects(createBridge(fakeShell({ share: 'fail' })).saveFile({ name: 'a.json', text: '{}' }), /Error sharing item/);
  await assert.rejects(createBridge(fakeShell({ plugins: ['Filesystem'] })).saveFile({ name: 'a.json', text: '{}' }),
    error => error.code === 'unavailable');
});

test('a file name cannot leave the exports folder', async () => {
  const shell = fakeShell();
  const bridge = createBridge(shell);
  for (const [name, path] of [['../x/y.json', 'exports/.._x_y.json'], ['..', 'exports/file'], ['a:b?.json', 'exports/a_b_.json'], [`${'n'.repeat(300)}.json`, `exports/${'n'.repeat(195)}.json`]]) {
    await bridge.saveFile({ name, text: '{}' });
    assert.equal(shell.calls.filter(([method]) => method === 'writeFile').at(-1)[1].path, path, name);
  }
  assert.equal(shell.calls.filter(([method]) => method === 'share').at(-1)[1].title.length, 305, 'the share title keeps the name as given');
});

test('saveFile refuses unclear input before touching anything', async () => {
  const shell = fakeShell();
  const bridge = createBridge(shell);
  for (const input of [{ name: 'a', text: 'x', bytes: new Uint8Array(1) }, { name: 'a' }, { name: ' ', text: 'x' }, { name: 'a', text: 1 }, { name: 'a', bytes: [1, 2] }, undefined]) {
    await assert.rejects(bridge.saveFile(input), TypeError, JSON.stringify(input));
  }
  assert.deepEqual(shell.calls, []);
});

test('on the web durable is inert but still checks its input', async () => {
  const { durable } = createBridge(fakePage());
  assert.equal(durable.available(), false);
  assert.equal(await durable.get('save'), null);
  assert.equal(await durable.set('save', { a: 1 }), false);
  assert.equal(await durable.remove('save'), false);
  await assert.rejects(durable.set('save', undefined), TypeError);
  await assert.rejects(durable.get('../save'), TypeError);
});

test('durable stores JSON in Library through a .next file and a rename', async () => {
  const shell = fakeShell();
  const { durable } = createBridge({ ...shell, folder: 'mythseal' });
  assert.equal(durable.available(), true);
  assert.equal(await durable.get('journey.v5'), null, 'nothing stored yet');
  const value = { coins: 4321, deck: ['qingxiao', 'kongzi'], note: '旅程' };
  assert.equal(await durable.set('journey.v5', value), true);
  const writes = shell.calls.filter(([method]) => method !== 'readFile');
  assert.deepEqual(writes, [
    ['writeFile', { path: 'mythseal/journey.v5.json.next', data: JSON.stringify(value), directory: 'LIBRARY', encoding: 'utf8', recursive: true }],
    ['rename', { from: 'mythseal/journey.v5.json.next', to: 'mythseal/journey.v5.json', directory: 'LIBRARY', toDirectory: 'LIBRARY' }],
  ]);
  assert.deepEqual([...shell.files.keys()], ['LIBRARY:mythseal/journey.v5.json']);
  assert.deepEqual(await durable.get('journey.v5'), value);
  assert.equal(await durable.remove('journey.v5'), true);
  assert.equal(shell.files.size, 0);
  assert.equal(await durable.get('journey.v5'), null);
  assert.equal(await durable.remove('journey.v5'), true, 'removing what is not there is fine');
});

test('back-to-back sets coalesce: the latest value is the one written', async () => {
  const shell = fakeShell();
  const { durable } = createBridge(shell);
  const results = await Promise.all([durable.set('k', 1), durable.set('k', 2), durable.set('k', 3)]);
  assert.deepEqual(results, [true, true, true]);
  assert.deepEqual(shell.calls.filter(([method]) => method === 'writeFile').map(([, o]) => o.data), ['3']);
  assert.equal(await durable.get('k'), 3);
});

test('operations on one key keep their call order', async () => {
  const shell = fakeShell();
  const { durable } = createBridge(shell);
  const order = [durable.set('k', 'a'), durable.remove('k'), durable.set('k', 'b'), durable.get('k'), durable.remove('k'), durable.get('k')];
  const results = await Promise.all(order);
  assert.deepEqual(results, [true, true, true, 'b', true, null]);
  // A set after a remove is never folded into a set before it.
  assert.deepEqual(shell.calls.filter(([method]) => method === 'writeFile').map(([, o]) => o.data), ['"a"', '"b"']);
  // Different keys do not wait for each other's files.
  await Promise.all([durable.set('x', 1), durable.set('y', 2)]);
  assert.deepEqual([await durable.get('x'), await durable.get('y')], [1, 2]);
});

test('a rename cut short leaves .next, and get still finds the value (and moves it into place)', async () => {
  const shell = fakeShell();
  const { durable } = createBridge(shell);
  await durable.set('k', { v: 1 });
  shell.faults.cutRename = true;
  await assert.rejects(durable.set('k', { v: 2 }), /interrupted/);
  assert.deepEqual([...shell.files.keys()], ['LIBRARY:orchard/k.json.next'], 'old file deleted, new one not yet moved');
  assert.deepEqual(await durable.get('k'), { v: 2 });
  assert.deepEqual([...shell.files.keys()], ['LIBRARY:orchard/k.json'], 'the read finished the commit');
  assert.equal(await durable.set('k', { v: 3 }), true, 'the queue keeps going after a failure');
  assert.deepEqual(await durable.get('k'), { v: 3 });
});

test('after a cut rename, the next set commits the old .next before writing, so a failed write loses nothing', async () => {
  const shell = fakeShell();
  // A fresh bridge stands for the next launch: nothing in memory says what is on disk.
  await createBridge(shell).durable.set('k', { coins: 5000, note: '三' });
  shell.faults.cutRename = true;
  await assert.rejects(createBridge(shell).durable.set('k', { coins: 5100 }), /interrupted/);
  assert.deepEqual([...shell.files.keys()], ['LIBRARY:orchard/k.json.next'], 'the only committed copy is .next');
  const { durable } = createBridge(shell);
  shell.faults.tornWrite = true;
  await assert.rejects(durable.set('k', { coins: 5200 }), /disk full/);
  assert.deepEqual(await durable.get('k'), { coins: 5100 }, 'the value from before the failed write survives');
  assert.deepEqual(await createBridge(shell).durable.get('k'), { coins: 5100 }, 'and after a relaunch');
  const renames = shell.calls.filter(([method]) => method === 'rename').map(([, o]) => [o.from, o.to]);
  assert.deepEqual(renames.at(-1), ['orchard/k.json.next', 'orchard/k.json'], 'committed by a rename, not rewritten');
});

test('when the old .next cannot be moved into place, set stops before writing over it', async () => {
  const shell = fakeShell();
  await createBridge(shell).durable.set('k', { coins: 5000 });
  shell.faults.cutRename = true;
  await assert.rejects(createBridge(shell).durable.set('k', { coins: 5100 }), /interrupted/);
  const { durable } = createBridge(shell);
  shell.faults.cutRename = true; // the promotion rename fails this time
  shell.faults.tornWrite = true; // and a write would have torn .next
  await assert.rejects(durable.set('k', { coins: 5200 }), error => error.code === 'unfinished');
  assert.equal(shell.faults.tornWrite, true, 'nothing was written');
  shell.faults.tornWrite = false;
  assert.deepEqual(await createBridge(shell).durable.get('k'), { coins: 5100 }, 'the only copy survives');
});

test('a first set that never finished writing commits nothing, and the next set works', async () => {
  const shell = fakeShell();
  shell.faults.tornWrite = true;
  await assert.rejects(createBridge(shell).durable.set('k', 1), /disk full/);
  const { durable } = createBridge(shell);
  assert.equal(await durable.get('k'), null);
  assert.equal(await durable.set('k', 2), true);
  assert.equal(await durable.get('k'), 2);
});

test('a .next whose write never finished is not a value; a torn main file is loud', async () => {
  const shell = fakeShell();
  const { durable } = createBridge(shell);
  shell.files.set(shell.at('LIBRARY', 'orchard/k.json.next'), '{"v":');
  assert.equal(await durable.get('k'), null);
  shell.files.set(shell.at('LIBRARY', 'orchard/k.json'), 'not json');
  await assert.rejects(durable.get('k'), error => error.code === 'corrupt' && error.key === 'k' && error.text === 'not json');
  assert.equal(shell.files.get(shell.at('LIBRARY', 'orchard/k.json')), 'not json', 'left as it was, for the app to set aside');
});

test('a remove cut short never brings back an older .next', async () => {
  const shell = fakeShell();
  const { durable } = createBridge(shell);
  shell.files.set(shell.at('LIBRARY', 'orchard/k.json'), '"new"');
  shell.files.set(shell.at('LIBRARY', 'orchard/k.json.next'), '"old"');
  const deletes = [];
  const original = shell.scope.Capacitor.Plugins.Filesystem.deleteFile;
  shell.scope.Capacitor.Plugins.Filesystem.deleteFile = async o => { deletes.push(o.path); return original(o); };
  await durable.remove('k');
  assert.deepEqual(deletes, ['orchard/k.json.next', 'orchard/k.json']);
});

test('durable surfaces real failures and refuses keys that are not plain names', async () => {
  const shell = fakeShell();
  const { durable } = createBridge(shell);
  shell.faults.write = new Error('disk full');
  await assert.rejects(durable.set('k', 1), /disk full/);
  shell.faults.write = null;
  shell.faults.read = Object.assign(new Error('no permission'), { code: 'OS-PLUG-FILE-0013' });
  await assert.rejects(durable.get('k'), /no permission/, 'only a missing file reads as null');
  // A missing file is known by the iOS code alone, or by the message alone (no code).
  shell.faults.read = Object.assign(new Error('gone'), { code: NOT_FOUND });
  assert.equal(await durable.get('k'), null);
  shell.faults.read = new Error('File does not exist.');
  assert.equal(await durable.get('k'), null);
  shell.faults.read = null;
  for (const key of ['', '.hidden', 'a/b', '../k', 'k k', 'x'.repeat(101), 7]) await assert.rejects(durable.set(key, 1), TypeError, String(key));
  await assert.rejects(durable.set('k', 10n), TypeError);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(durable.set('k', cyclic), TypeError);
  assert.throws(() => createBridge({ folder: '../up' }), TypeError);
  assert.equal(createBridge(fakeShell({ plugins: ['Share'] })).durable.available(), false, 'no Filesystem plugin, no store');
});

test('haptic maps each kind to the plugin call, and does nothing without the plugin', async () => {
  const shell = fakeShell();
  const { haptic } = createBridge(shell);
  for (const kind of HAPTIC_KINDS) assert.equal(await haptic(kind), true, kind);
  assert.deepEqual(shell.calls, [
    ['impact', { style: 'LIGHT' }], ['impact', { style: 'MEDIUM' }], ['impact', { style: 'HEAVY' }],
    ['notification', { type: 'SUCCESS' }], ['notification', { type: 'WARNING' }], ['notification', { type: 'ERROR' }],
    ['selectionStart', {}], ['selectionChanged', {}], ['selectionEnd', {}],
  ]);
  // The iOS plugin plays an unknown style as HEAVY, so an unknown kind never reaches it.
  for (const kind of ['thud', 'LIGHT', 'toString', '__proto__', undefined]) assert.equal(await haptic(kind), false, String(kind));
  assert.equal(shell.calls.length, 9);
  shell.faults.haptics = new Error('engine stopped');
  assert.equal(await haptic('light'), false, 'a plugin error is swallowed, never thrown into the app');
  assert.equal(await createBridge(fakePage()).haptic('light'), false, 'web');
  assert.equal(await createBridge(fakeShell({ plugins: ['Filesystem', 'Share'] })).haptic('light'), false, 'app without the Haptics plugin');
});

// ---- opt-in: the real native-bridge.js ------------------------------------------------------

/** JSExport.exportJS's user script for one plugin, reproduced from JSExport.swift 76-104 and
 * generateMethod (159-183) for promise-returning methods. */
function exportedPluginJS(jsName, methods) {
  const lines = [`(function(w) {
var a = (w.Capacitor = w.Capacitor || {});
var p = (a.Plugins = a.Plugins || {});
var t = (p['${jsName}'] = {});
t.addListener = function(eventName, callback) {
return w.Capacitor.addListener('${jsName}', eventName, callback);
}
t.removeAllListeners = function() {
return w.Capacitor.nativePromise('${jsName}', 'removeAllListeners');
}`];
  for (const method of methods) lines.push(`t['${method}'] = function(_options) {\nreturn w.Capacitor.nativePromise('${jsName}', '${method}', _options);\n}`);
  lines.push('})(window);');
  const fixed = ['addListener', 'removeListener', 'removeAllListeners', 'checkPermissions', 'requestPermissions'];
  const header = { name: jsName, methods: [...fixed.map(name => ({ name, rtype: ['addListener', 'removeListener'].includes(name) ? undefined : 'promise' })), ...methods.map(name => ({ name, rtype: 'promise' }))] };
  lines.push(`(function(w) {\nvar a = (w.Capacitor = w.Capacitor || {});\nvar h = (a.PluginHeaders = a.PluginHeaders || []);\nh.push(${JSON.stringify(header)});\n})(window);`);
  return lines.join('\n');
}

const CAP_IOS = process.env.ORCHARD_CAPACITOR_IOS;
test('through the real native-bridge.js (opt-in: ORCHARD_CAPACITOR_IOS)', { skip: !CAP_IOS && 'set ORCHARD_CAPACITOR_IOS to an @capacitor/ios package to run' }, async () => {
  const nativeBridgeJS = readFileSync(join(CAP_IOS, 'Capacitor', 'Capacitor', 'assets', 'native-bridge.js'), 'utf8');
  const side = nativeSide();
  const posted = [];
  const quiet = Object.fromEntries(['log', 'debug', 'error', 'info', 'trace', 'warn', 'groupCollapsed', 'groupEnd', 'dir'].map(name => [name, () => {}]));
  class Document { get cookie() { return ''; } set cookie(_) {} }
  class XMLHttpRequest { abort() {} getAllResponseHeaders() {} getResponseHeader() {} open() {} send() {} setRequestHeader() {} }
  const context = vm.createContext({
    console: quiet, Document, HTMLDocument: Document, XMLHttpRequest, navigator: {}, URL,
    document: Object.assign(new Document(), { addEventListener() {} }),
    fetch: async () => { throw new Error('no network in this test'); },
    prompt: () => 'false', // CapacitorCookies / CapacitorHttp disabled: nothing gets patched
    webkit: { messageHandlers: { bridge: { postMessage: message => posted.push(structuredClone(message)) } } },
  });
  // CapacitorBridge.init order: exportCapacitorGlobalJS, native-bridge.js, then each plugin's exportJS.
  vm.runInContext('var window = globalThis;', context);
  vm.runInContext("window.Capacitor = { DEBUG: false, isLoggingEnabled: false, Plugins: {} }; window.WEBVIEW_SERVER_URL = 'capacitor://localhost';", context);
  vm.runInContext(nativeBridgeJS, context);
  for (const name of ['Filesystem', 'Share', 'Haptics']) vm.runInContext(exportedPluginJS(name, NATIVE_METHODS[name]), context);

  // The native side: answer each posted call the way CapacitorBridge.toJs / toJsError do.
  let answering = true;
  (async () => {
    while (answering) {
      await new Promise(resolve => setImmediate(resolve));
      for (const call of posted.splice(0)) {
        if (call.pluginId === 'Console') continue;
        const reply = { callbackId: call.callbackId, pluginId: call.pluginId, methodName: call.methodName, save: false };
        try {
          const data = await side.implementations[call.pluginId][call.methodName](call.options);
          Object.assign(reply, { success: true, data: data ?? {} });
        } catch (error) {
          Object.assign(reply, { success: false, error: { message: error.message, errorMessage: error.message, ...(error.code ? { code: error.code } : {}) } });
        }
        vm.runInContext(`window.Capacitor.fromNative(${JSON.stringify(reply)})`, context);
      }
    }
  })();

  try {
    const bridge = createBridge({ scope: context, folder: 'mythseal' });
    assert.equal(bridge.isNative(), true, "native-bridge.js's isNativePlatform()");
    assert.equal(vm.runInContext("window.Capacitor.getPlatform()", context), 'ios');
    assert.equal(bridge.durable.available(), true);
    assert.equal(await bridge.durable.get('journey.v5'), null, 'a missing file comes back as a Capacitor exception with code OS-PLUG-FILE-0008');
    assert.equal(await bridge.durable.set('journey.v5', { coins: 1 }), true);
    assert.deepEqual(await bridge.durable.get('journey.v5'), { coins: 1 });
    assert.deepEqual([...side.files.keys()], ['LIBRARY:mythseal/journey.v5.json']);
    const saved = await bridge.saveFile({ name: 'journey.json', text: '{}' });
    assert.equal(saved.via, 'share');
    assert.equal(saved.uri, 'file:///app/CACHE/exports/journey.json');
    assert.equal(await bridge.haptic('success'), true);
    assert.deepEqual(side.calls.map(([method]) => method), ['readFile', 'readFile', 'writeFile', 'rename', 'readFile', 'writeFile', 'share', 'notification']);
  } finally {
    answering = false;
  }
});
