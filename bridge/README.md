# orchard bridge

`orchard-bridge.mjs` is the one file an app copies to reach native features from its own web code ([DESIGN.md §6](../DESIGN.md#6-native-bridge)). It has no imports and needs no build step. In a browser it behaves like the web; inside the Capacitor shell it talks to the native plugins through `window.Capacitor`.

**Rung:** below `simulator`. It has been tested only in Node: unit tests against a fake `window.Capacitor`, and an opt-in run through Capacitor's real `native-bridge.js` with simulated native replies. Nothing here has run in a WKWebView, the Simulator or on a device (2026-10-20).

## API

```js
import { isNative, saveFile, durable, haptic, SaveCancelled } from './vendor/orchard-bridge.mjs';
// or, with the app's own folder for durable files:
import { createBridge } from './vendor/orchard-bridge.mjs';
const bridge = createBridge({ folder: 'mythseal' });
```

| Call | Web | Native (iOS) |
|---|---|---|
| `isNative()` | `false` | `true` when `Capacitor.isNativePlatform()` returns `true` |
| `saveFile({ name, mime, text \| bytes })` | Blob plus `<a download>`, clicked before the first `await`, so it still counts as part of the tap. Resolves `{ via: 'download' }`. | Writes `Cache/exports/<name>` (text as UTF-8, bytes as base64), then opens the share sheet with that file. Resolves `{ via: 'share', activityType, uri }`. If the player closes the sheet, it rejects with `SaveCancelled` (`code: 'cancelled'`). Without the plugins it rejects with `code: 'unavailable'`. |
| `durable.get(key)` | `null` | The parsed JSON from `Library/<folder>/<key>.json`, or `null` if there is none (a stored `null` reads the same). A file that is not valid JSON rejects with `code: 'corrupt'` (with `key` and `text`) and is left where it is. If a rename was cut short and only a valid `<key>.json.next` is left, it returns that value and renames it into place. |
| `durable.set(key, value)` | `false` (the value is still checked for JSON) | Writes `<key>.json.next`, then renames it over `<key>.json`. The first set of a key in a session first checks for a `.next` left by a cut rename (no `<key>.json`, valid JSON in `.next`) and renames it into place, so a failed write can't destroy the only committed copy. Resolves `true` once this value, or a later one for the same key, is in place. Rejects if the write fails, or if a leftover `.next` can't be read for a reason other than "missing" or "not JSON" (rather than overwrite what may be the only copy; `durable.remove(key)` clears both files). |
| `durable.remove(key)` | `false` | Deletes `.next`, then the file. Resolves `true`. |
| `durable.available()` | `false` | `true` when the Filesystem plugin is present |
| `haptic(kind)` | `false` | Plays `light`, `medium`, `heavy`, `success`, `warning`, `error` or `selection` (`HAPTIC_KINDS`). Resolves `true`, or `false` when the Haptics plugin is missing. Never rejects. |
| `plugin(name, methods)` | `null` | `Capacitor.Plugins[name]` if the native shell has it with those methods, otherwise `null`. Every call above goes through it. |

Calls on one durable key run in the order they were made. Back-to-back `set`s are merged, so only the latest value is written. Durable keys are plain names (`[A-Za-z0-9][A-Za-z0-9._-]{0,99}`) because they become file names. A key that isn't one is refused with a `TypeError` rather than quietly cleaned up, because two keys cleaned up into the same file would overwrite each other.

On iOS, the share sheet decides how to treat a file by its extension, so `mime` matters only on the web.

## Principles, with reasons

- **The durable copy mirrors the app's state. It never replaces the app's own store.** iOS may clear a WKWebView's localStorage and IndexedDB when storage runs low, but files in Library stay (and go into device backups). So apps keep reading and writing their own store and copy the critical save here. A restore always goes through the app's own strict import path, because a copy that skipped validation could put a stale or tampered state into the app.
- **Loud where data is at stake, quiet where it isn't.** A corrupt durable file rejects and stays in place, so the app can set it aside and nothing overwrites it silently. `haptic` never rejects, because a missing buzz must not break a game turn. Apps should also offer players a way to turn haptics off. That is the app's decision, so the bridge leaves it out.
- **There is one way in: `plugin()`.** If a Capacitor release changes how plugins are injected, there is one function to fix and one test file to update.
- **Edit upstream.** An app's copy names the orchard commit it came from. A fix made only in one app's copy never reaches the other apps.

## Vendoring into an app

1. Add the plugin packages to the app's `package.json` with exact versions, then run `npx cap sync ios`. You need `@capacitor/filesystem` and `@capacitor/share` for `saveFile` and `durable`, and `@capacitor/haptics` if you want `haptic`. `cap sync` finds native plugins only through `package.json` (devDependencies count), so without these packages the shell has no plugin to call. Mythseal pins Filesystem 8.1.5 and Share 8.0.3 with Capacitor 8.5.3.
2. Copy the file and stamp the commit it came from:
   ```sh
   c=$(git -C ~/orchard rev-parse --short HEAD)
   sed "1s/<commit>/$c/" ~/orchard/bridge/orchard-bridge.mjs > vendor/orchard-bridge.mjs
   ```
   Stamp only when `git -C ~/orchard status --short bridge/` prints nothing. Otherwise the stamp names a commit that does not hold the bytes you copied, and the next reader goes to the wrong source.
3. Declare file timestamps in the app's privacy manifest. The Filesystem plugin's README asks apps to declare `NSPrivacyAccessedAPICategoryFileTimestamp` with reason `C617.1`. Filesystem 8.1.5, Share 8.0.3 and Haptics 8.0.2 ship no `PrivacyInfo.xcprivacy` of their own (checked in the packages). Mythseal's `ios/first-flight` branch already declares it. orchard's template manifest declares no required-reason APIs, so it is a minimum: `orchard doctor` reports `native.privacy-reasons` BLOCKED while a plugin's category is missing, and `orchard conform --write` adds it (with the README's suggested reason), never removing or second-guessing what the app already declares.
4. The bridge only works in the main frame: Capacitor injects its scripts with `forMainFrameOnly: true`.

Mythseal's `native-shell.mjs` (branch `ios/first-flight`) is where this file came from. Its export uses the same Cache path and share call. Its journey copy uses the same `Library/mythseal/<key>.json` + `.next` layout, so `createBridge({ folder: 'mythseal' }).durable` with key `journey.v5` addresses the same files. There are four differences:
- The bridge renames a `.next` left by a cut rename into place before it writes `.next` again; Mythseal's mirror does not yet. Its localStorage is still the primary copy, so the gap matters less there, and adopting the step is the mythseal repo's decision.
- Mythseal's mirror stores the raw localStorage text, never rejects and keeps a status. `durable.set` stores a JSON value and rejects on failure, so the app keeps its own status.
- Setting a refused copy aside (`.refused-<time>.json`) is app policy, so it stays in the app. An app can do it through `plugin('Filesystem', ['rename'])`.
- `SaveCancelled` carries the same `code: 'cancelled'`, but its message is in English. Apps show their own wording.

Whether and when Mythseal switches to the vendored copy is the Mythseal repo's decision.

## How the page reaches the plugins: evidence

**The mechanism used is `window.Capacitor.Plugins.<jsName>`**, the functions the iOS shell injects. The other candidate was a vendored `@capacitor/core` with `registerPlugin()`. It would add a dependency and a build step for un-bundled code, and its proxies call the same `Capacitor.nativePromise` underneath, so it buys nothing here.

The following was read from the `@capacitor/ios` 8.5.3 sources (in `~/Games/mythseal-orchard/node_modules`) on 2026-10-20. `JSExport.swift`, `CapacitorBridge.swift`, `WebViewDelegationHandler.swift` and `assets/native-bridge.js` are byte-identical in 8.5.2 (`cmp`, checked the same day).

- `CapacitorBridge.swift` 218–219: `init` calls `exportCoreJS(...)`, then `registerPlugins()`. `registerPlugins` (323–353) adds Capacitor's built-in plugins plus every class in the bundled `capacitor.config.json`'s `packageClassList`, which `cap sync` writes. `registerPlugin` (390–394) calls `JSExport.exportJS` for each one.
- `JSExport.swift` 18–22: the first user script is `window.Capacitor = { DEBUG: …, isLoggingEnabled: …, Plugins: {} }`, injected at `.atDocumentStart` and `forMainFrameOnly: true`. Lines 24–36 then inject `native-bridge.js` the same way.
- `native-bridge.js` 821: `const cap = win.Capacitor || {}` keeps that object. Line 835 adds `isPluginAvailable` and line 836 adds `isNativePlatform` (always `true` in the shell). Line 999 adds `nativePromise`, which posts to `webkit.messageHandlers.bridge`. Lines 945–951 rebuild a native error as a `Capacitor.Exception` that carries the native `code`.
- `JSExport.swift` 73–109 (`exportJS`): for each plugin, it sets `Plugins[jsName]` to an object with one function per native method. Each function is `return w.Capacitor.nativePromise(jsName, method, _options)` (159–183). It also pushes `{ name, methods }` onto `Capacitor.PluginHeaders`.
- `CapacitorBridge.swift` 623–631 and `JS.swift` 85–98: native errors reach JavaScript as `{ message, errorMessage, code }`.
- `@capacitor/core` (8.5.2 `core/src/runtime.ts` 18–19, 183) also keeps `win.Capacitor` and its `Plugins`, but its `registerPlugin()` puts a Proxy there that returns a function for any property. That is why `plugin()` also requires the plugin's native header when `PluginHeaders` exists. Android's `JSExport.java` (8.5.2) builds the same `Plugins` objects and `PluginHeaders`. The bridge has not been tried on Android.

The plugin behaviour the bridge relies on, from the iOS sources:

| Plugin | Fact | Where |
|---|---|---|
| Filesystem 8.1.5 | jsName `Filesystem`. `LIBRARY` is Library (also `LIBRARY_NO_CLOUD`, not backed up), and `CACHE` is Caches. | `FilesystemPlugin.swift` 14–31, `FilesystemConstants.swift`, `IONFileStructures+Converters.swift`; ion-ios-filesystem 2.0.1 `IONFILEManager.swift` 357–382 |
| | With `encoding`, `data` is written as a string, non-atomically. Without it, `data` is base64. `writeFile` resolves `{ uri }`. | `CAPPluginCall+Accelerators.swift` `getEncodingMapper`; ion-ios-filesystem 2.0.1 `IONFILEManager.swift` 130 |
| | A missing file rejects with code `OS-PLUG-FILE-0008`, "… does not exist." | `FilesystemError.swift`, `FilesystemOperationExecutor.swift` `mapError` |
| | `rename` deletes an existing destination file, then moves the source (two steps, not one atomic replace). | ion-ios-filesystem 2.0.1 `IONFILEManager.swift` 170–182, 311–324 (tag 2.0.1 fetched from GitHub; identical to the research copy) |
| Share 8.0.3 | `share({ title, files: [uri] })` opens a `UIActivityViewController`, and `title` becomes the subject. Resolves `{ activityType }`. A closed sheet rejects with "Share canceled", and an activity error with "Error sharing item". | `SharePlugin.swift` |
| Haptics 8.0.2 | `impact({ style })` plays an unknown style as `HEAVY`. `notification({ type })` defaults to `SUCCESS`. `selectionChanged` plays only between `selectionStart` and `selectionEnd`. | `HapticsPlugin.swift`, `Haptics.swift` |
| Navigation | A top-level navigation outside the app is handed to `UIApplication.open`, and there is no `WKDownload` handling. So a Blob download link is expected to do nothing in the app. That is inferred from the source and has not been observed. | `WebViewDelegationHandler.swift` 67–124 |

## Tests

`node --test tests/bridge.test.mjs` runs the unit tests against a fake shell, shaped like the injection above. Pointing `ORCHARD_CAPACITOR_IOS` at an `@capacitor/ios` package adds one test. It loads that package's real `native-bridge.js` into a Node `vm` context, adds the plugin scripts the way `JSExport.exportJS` writes them (rebuilt from the Swift template), and answers each posted call the way `CapacitorBridge.toJs` / `toJsError` do:

```sh
ORCHARD_CAPACITOR_IOS=~/Games/mythseal-orchard/node_modules/@capacitor/ios node --test tests/bridge.test.mjs
```

This test proves that the bridge's calls survive Capacitor's real JavaScript layer, including a missing file coming back as an exception with code `OS-PLUG-FILE-0008`. It does not prove that the plugins' native code behaves as described.

**Still unverified:**
- The bridge running in a WKWebView, the Simulator or an iPhone.
- The share sheet and the Library copy surviving storage pressure.
- Android.
- Whether an anchor that is never added to the document downloads in every browser. Mythseal's D2 export does it this way and passes its Chromium and WebKit smokes.
