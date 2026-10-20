// vendored from orchard <commit>; edit upstream
/**
 * orchard-bridge: the native seam for web apps that orchard carries to iOS (DESIGN.md §6).
 *
 * No imports and no build step, so an app can copy this file as it is, load it from any module
 * (even a startup-recovery script that runs when the rest of the app failed to load), and still
 * run it in a plain browser, where everything falls back to web behaviour or does nothing.
 *
 *   isNative()                               true only inside a Capacitor native shell
 *   saveFile({ name, mime, text | bytes })   web: Blob + anchor download; native: Cache file + share sheet
 *   durable.get / set / remove (key)         JSON in Library/<folder>/<key>.json on native; inert on web
 *   durable.available()                      whether durable writes go anywhere
 *   haptic(kind)                             the Haptics plugin when the app ships it; otherwise nothing
 *   plugin(name, methods)                    a native plugin object, or null (the one access path)
 *   createBridge(options)                    the same API for another scope, folder or directory
 *
 * How plugins are reached (read from @capacitor/ios 8.5.3 source; not yet run in a WKWebView):
 * CapacitorBridge.init calls exportCoreJS() then registerPlugins() (CapacitorBridge.swift
 * 218-219). Both add WKUserScripts at document start, so they run before any page script:
 * `window.Capacitor = { …, Plugins: {} }` (JSExport.swift 18-22), then native-bridge.js, which
 * keeps that object (`const cap = win.Capacitor || {}`, line 821) and adds isNativePlatform()
 * (836) and nativePromise() (999), then, for each plugin in the capacitor.config.json that
 * `cap sync` writes, JSExport.exportJS (73-109), which sets `Capacitor.Plugins[jsName]` to one
 * function per native method, each `return w.Capacitor.nativePromise(jsName, method, _options)`,
 * and pushes a matching entry onto `Capacitor.PluginHeaders`. So this file calls
 * `window.Capacitor.Plugins.Filesystem.writeFile({…})` directly and vendors nothing from
 * @capacitor/core. The plugins' npm packages are still needed in the app's package.json, because
 * that is where `cap sync` finds them. bridge/README.md has the full evidence and its limits.
 */

/** iOS Filesystem plugin 8.1.5: FilesystemError.fileNotFound → "OS-PLUG-FILE-0008". */
const NOT_FOUND = 'OS-PLUG-FILE-0008';
/** Durable keys and folders become file names, so they stay plain: no slashes, no leading dot. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Haptics plugin 8.0.2 (iOS): an unknown impact style plays as HEAVY, so only these kinds pass. */
const HAPTICS = {
  light: [['impact', { style: 'LIGHT' }]],
  medium: [['impact', { style: 'MEDIUM' }]],
  heavy: [['impact', { style: 'HEAVY' }]],
  success: [['notification', { type: 'SUCCESS' }]],
  warning: [['notification', { type: 'WARNING' }]],
  error: [['notification', { type: 'ERROR' }]],
  // selectionChanged plays only between selectionStart and selectionEnd (Haptics.swift).
  selection: [['selectionStart'], ['selectionChanged'], ['selectionEnd']],
};
export const HAPTIC_KINDS = Object.freeze(Object.keys(HAPTICS));

/** The player closed the share sheet without choosing anything: nothing was saved, nothing broke. */
export class SaveCancelled extends Error {
  constructor() {
    super('The share sheet was closed without saving the file.');
    this.name = 'SaveCancelled';
    this.code = 'cancelled';
  }
}

function failure(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

const isNotFound = error => error?.code === NOT_FOUND || /does not exist/i.test(String(error?.message ?? ''));
// SharePlugin.swift (8.0.3) rejects "Share canceled" when the sheet closes without an activity.
const isCancel = error => /cancel/i.test(String(error?.message ?? error ?? ''));

function plainName(value, what) {
  if (typeof value !== 'string' || !PLAIN_NAME.test(value)) {
    throw new TypeError(`${what} must be 1-100 letters, digits, '.', '_' or '-', starting with a letter or digit`);
  }
  return value;
}

/** A user-facing file name made safe as one path component inside the exports folder. */
function exportName(name) {
  let safe = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim();
  if (/^\.*$/.test(safe)) safe = 'file';
  return safe.length > 200 ? safe.slice(-200) : safe;
}

function fileBody(name, text, bytes) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('saveFile needs a file name');
  if ((text === undefined) === (bytes === undefined)) throw new TypeError('saveFile needs exactly one of text or bytes');
  if (text !== undefined) {
    if (typeof text !== 'string') throw new TypeError('saveFile text must be a string');
    return text;
  }
  if (Object.prototype.toString.call(bytes) === '[object ArrayBuffer]') return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('saveFile bytes must be an ArrayBuffer or a typed array');
}

/** The Filesystem plugin takes binary data as base64 when no encoding is given. */
function toBase64(bytes, btoa) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(binary);
}

function toJson(value) {
  const text = JSON.stringify(value); // throws TypeError on cycles and BigInt
  if (typeof text !== 'string') throw new TypeError('durable.set needs a JSON-serialisable value');
  return text;
}

/**
 * The bridge for one scope. `scope` is where `Capacitor`, `document`, `URL`, `Blob`, `setTimeout`
 * and `btoa` live (globalThis in a page); anything missing there is taken from globalThis.
 * `folder` and `directory` place the durable store (Library/<folder>/ by default); `exportFolder`
 * is the Cache subfolder saveFile writes into. One bridge per folder: writes to the same key are
 * ordered within a bridge, not across two bridges.
 */
export function createBridge({
  scope = globalThis,
  folder = 'orchard',
  directory = 'LIBRARY',
  exportFolder = 'exports',
  revokeAfterMs = 1000,
} = {}) {
  plainName(folder, 'folder');
  plainName(exportFolder, 'exportFolder');
  const env = name => scope?.[name] ?? globalThis[name];

  /** True only when Capacitor reports a native platform. Browsers, previews and Node say false,
   * and so does a web page that bundles @capacitor/core (its isNativePlatform() is false there). */
  function isNative() {
    try { return scope?.Capacitor?.isNativePlatform?.() === true; }
    catch { return false; }
  }

  /** `Capacitor.Plugins[name]` when the native shell has it with every named method, else null.
   * When the runtime publishes PluginHeaders (iOS and Android both do), the native header must list
   * the methods too: @capacitor/core's registerPlugin() puts a Proxy in Plugins that answers every
   * property with a function, even for a plugin `cap sync` never installed. */
  function plugin(name, methods = []) {
    if (!isNative()) return null;
    try {
      const cap = scope.Capacitor;
      const found = cap.Plugins?.[name];
      if (!found || !methods.every(method => typeof found[method] === 'function')) return null;
      if (Array.isArray(cap.PluginHeaders)) {
        const header = cap.PluginHeaders.find(entry => entry?.name === name);
        const listed = new Set((header?.methods ?? []).map(entry => entry?.name));
        if (!header || !methods.every(method => listed.has(method))) return null;
      }
      return found;
    } catch {
      return null;
    }
  }

  /** The web path: a Blob and an anchor download, clicked before saveFile first awaits so the
   * browser still counts it as part of the tap. */
  function download(name, mime, body) {
    const doc = env('document'), urls = env('URL'), BlobType = env('Blob'), later = env('setTimeout');
    if (typeof doc?.createElement !== 'function' || typeof urls?.createObjectURL !== 'function' || typeof BlobType !== 'function') {
      throw failure('unavailable', 'saveFile has no document to download from');
    }
    const type = mime || (typeof body === 'string' ? 'text/plain;charset=utf-8' : 'application/octet-stream');
    const href = urls.createObjectURL(new BlobType([body], { type }));
    const link = doc.createElement('a');
    link.href = href;
    link.download = name;
    link.rel = 'noopener';
    link.click();
    if (typeof later === 'function') later(() => urls.revokeObjectURL(href), revokeAfterMs);
    return { via: 'download' };
  }

  /**
   * Give the player a file. Web: `{ via: 'download' }`. Native: the file is written to
   * Cache/<exportFolder>/<name> and offered through the share sheet (Save to Files, AirDrop, …),
   * because a Blob download does nothing inside the app's WKWebView; resolves
   * `{ via: 'share', activityType, uri }`. A dismissed sheet rejects with SaveCancelled; a native
   * shell without the Filesystem or Share plugin rejects with code 'unavailable'. On iOS the
   * name's extension, not `mime`, decides how the share sheet treats the file.
   */
  async function saveFile({ name, mime, text, bytes } = {}) {
    const body = fileBody(name, text, bytes);
    if (!isNative()) return download(name, mime, body);
    const files = plugin('Filesystem', ['writeFile']), share = plugin('Share', ['share']);
    if (!files || !share) throw failure('unavailable', 'saveFile needs the Filesystem and Share plugins in the native app');
    const options = { path: `${exportFolder}/${exportName(name)}`, directory: 'CACHE', recursive: true };
    if (typeof body === 'string') Object.assign(options, { data: body, encoding: 'utf8' });
    else options.data = toBase64(body, env('btoa'));
    const { uri } = await files.writeFile(options);
    try {
      const shared = await share.share({ title: name, files: [uri] });
      return { via: 'share', activityType: typeof shared?.activityType === 'string' ? shared.activityType : '', uri };
    } catch (error) {
      if (isCancel(error)) throw new SaveCancelled();
      throw error;
    }
  }

  // ---- durable: a key → JSON mirror in the app's own files -------------------------------------
  // iOS may reclaim a WKWebView's localStorage and IndexedDB under storage pressure; files in
  // Library stay (and are included in device backups). Each set writes <key>.json.next and then
  // renames it over <key>.json, because the plugin writes strings non-atomically and its rename
  // deletes the old file before moving the new one (ion-ios-filesystem 2.0.1). A rename cut short
  // between those two steps leaves .next as the only committed copy, so before anything writes
  // .next again, a .next that holds valid JSON with no <key>.json beside it is renamed into place
  // first (on the first set of a key, and on a get that had to read .next). A read falls back to
  // .next while that is pending. Operations on one key run in call order; back-to-back sets
  // coalesce, so only the latest value is written.
  const FILE_METHODS = ['readFile', 'writeFile', 'rename', 'deleteFile'];
  const store = () => plugin('Filesystem', FILE_METHODS);
  const lanes = new Map();

  function locate(key) {
    plainName(key, 'durable key');
    const file = `${folder}/${key}.json`;
    return { file, next: `${file}.next` };
  }

  function lane(key) {
    let entry = lanes.get(key);
    // `settled`: this session has seen <key>.json in place (or nothing at all), so no .next holds
    // the only copy of a committed value.
    if (!entry) lanes.set(key, entry = { tail: Promise.resolve(), pendingSet: null, settled: false });
    return entry;
  }

  function enqueue(entry, job) {
    const run = entry.tail.then(job);
    entry.tail = run.catch(() => {});
    return run;
  }

  async function readText(fs, path) {
    const { data } = await fs.readFile({ path, directory, encoding: 'utf8' });
    if (typeof data !== 'string') throw new TypeError(`durable read of ${path} returned no text`);
    return data;
  }

  /** The committed value: <key>.json, or a .next whose rename was cut short (moved into place
   * when `promote` is set, so the next write of .next cannot clobber the only copy). */
  async function readValue(fs, where, key, entry, { promote = true } = {}) {
    let text;
    try {
      text = await readText(fs, where.file);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      let value;
      try { value = JSON.parse(await readText(fs, where.next)); }
      // No .next, or a .next whose write never finished: nothing was committed.
      catch (nextError) {
        if (nextError instanceof SyntaxError || isNotFound(nextError)) { entry.settled = true; return null; }
        throw nextError;
      }
      if (promote) {
        try {
          await fs.rename({ from: where.next, to: where.file, directory, toDirectory: directory });
          entry.settled = true;
        } catch { /* still readable through .next; the next set tries again before it writes */ }
      }
      return value;
    }
    entry.settled = true;
    try { return JSON.parse(text); }
    catch { throw failure('corrupt', `durable value "${key}" is not valid JSON; the file was left as it is`, { key, text }); }
  }

  const durable = Object.freeze({
    /** True when durable writes reach a file: the native shell with the Filesystem plugin. */
    available: () => store() !== null,

    /** The stored value, or null when nothing is stored (or on the web). Rejects with code
     * 'corrupt' (and the raw `text`) when the file is not JSON, leaving the file untouched. */
    async get(key) {
      const where = locate(key), fs = store();
      if (!fs) return null;
      const entry = lane(key);
      entry.pendingSet = null;
      return enqueue(entry, () => readValue(fs, where, key, entry));
    },

    /** Store `value` as JSON. Resolves true once this value, or a later one for the same key, is
     * in place; false on the web, where nothing is stored. Rejects if the write fails. */
    async set(key, value) {
      const where = locate(key), text = toJson(value), fs = store();
      if (!fs) return false;
      const entry = lane(key);
      if (entry.pendingSet) {
        entry.pendingSet.text = text;
        return entry.pendingSet.done;
      }
      const slot = { text, done: null };
      entry.pendingSet = slot;
      slot.done = enqueue(entry, async () => {
        if (entry.pendingSet === slot) entry.pendingSet = null;
        // Finish an interrupted commit before .next is overwritten. A corrupt <key>.json is left
        // for get() to report; this set replaces it, as a set always has.
        if (!entry.settled) {
          try { await readValue(fs, where, key, entry); }
          catch (error) { if (error?.code !== 'corrupt') throw error; entry.settled = true; }
          // Still unsettled means .next holds the only committed copy and could not be moved into
          // place. Writing .next now could tear it, so this set stops and the next call retries.
          if (!entry.settled) throw failure('unfinished', `durable value "${key}" has a commit that could not be finished; nothing was written`, { key });
        }
        entry.settled = false;
        await fs.writeFile({ path: where.next, data: slot.text, directory, encoding: 'utf8', recursive: true });
        await fs.rename({ from: where.next, to: where.file, directory, toDirectory: directory });
        entry.settled = true;
        return true;
      });
      return slot.done;
    },

    /** Delete the value (both files). Resolves true when the key is gone, false on the web. */
    async remove(key) {
      const where = locate(key), fs = store();
      if (!fs) return false;
      const entry = lane(key);
      entry.pendingSet = null;
      return enqueue(entry, async () => {
        // .next first: a remove cut short must never leave an older .next to be read back.
        for (const path of [where.next, where.file]) {
          try { await fs.deleteFile({ path, directory }); }
          catch (error) { if (!isNotFound(error)) throw error; }
        }
        entry.settled = true;
        return true;
      });
    },
  });

  /** Play a haptic: one of HAPTIC_KINDS. Resolves true when the plugin accepted it, false
   * otherwise (web, no Haptics plugin, unknown kind, or a plugin error). Never rejects: haptics
   * are decoration, and a failure must not reach the app's logic. */
  async function haptic(kind) {
    const steps = typeof kind === 'string' && Object.prototype.hasOwnProperty.call(HAPTICS, kind) ? HAPTICS[kind] : null;
    if (!steps) return false;
    const haptics = plugin('Haptics', [...new Set(steps.map(([method]) => method))]);
    if (!haptics) return false;
    try {
      for (const [method, options] of steps) await haptics[method]({ ...options });
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({ isNative, plugin, saveFile, durable, haptic });
}

const shared = createBridge();
export const { isNative, plugin, saveFile, durable, haptic } = shared;
