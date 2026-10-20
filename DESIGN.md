# orchard — design

orchard turns an existing web project into an iOS app and carries it to TestFlight. One orchard serves every app; each app stays in its own repo with its own `ios/` folder and a manifest in `apps/<name>.json` here.

Decided by Yu on 2026-10-20:
- **Publisher:** Mindicraft Limited's organization team (company 13782045).
- **Hybrid build route.** Release builds run in the cloud, with Xcode Cloud as primary and GitHub Actions as backup. Local Xcode on a developer Mac serves the simulator loop only.
- **This repo is public** and never holds secrets.
- **Mythseal goes first.**

## 1. The ladder

Every status orchard reports names a rung. A lower rung never stands in for a higher one: each rung proves only itself.

| Rung | What it proves | Proved by |
|---|---|---|
| `web` | the web build runs and the bundle is self-contained | app's own tests + build |
| `native-project` | the iOS project conforms (Info.plist keys, deployment target, device family, privacy manifest and the required-reason APIs the app's plugins need, ci_scripts) | `orchard conform --check` |
| `simulator` | the app launches in an iOS Simulator | `orchard sim` (needs local Xcode) |
| `device` | it runs on a physical iPhone | a human with a device |
| `signed-archive` | Apple's signing accepted the build | Xcode Cloud archive action or the GitHub Actions backup |
| `testflight-internal` | App Store Connect processed the build for internal testers | App Store Connect |
| `testflight-external` | Beta App Review accepted the build for external TestFlight testers | Apple |
| `review` | App Review accepted it for the App Store | Apple |

`orchard doctor` reports READY, BLOCKED or UNKNOWN per check, together with the reason and the next step. UNKNOWN is never shown as READY, because a missing check is not a passing check.

## 2. Release routes

1. **Xcode Cloud (primary).** Signing is cloud-managed by Apple, so no API key or certificate ever touches a runner.
   - The membership includes 25 compute hours a month.
   - The first workflow has to be created in the Xcode app by a person signed in to the Mindicraft team (docs/RUNBOOK.md).
   - Each app repo carries `ios/App/ci_scripts/ci_post_clone.sh`, rendered from `templates/xcode-cloud/ci_post_clone.sh`. It installs Node, runs the app's web install and build, stamps the marketing version, runs the app's release preflight, and runs `npx cap sync ios`.
   - `Package.resolved` must be committed, because Xcode Cloud does not resolve packages on its own.
2. **GitHub Actions (backup).** The app's own workflow, for example mythseal's `.github/workflows/mobile.yml` (fastlane, cloud-managed signing through an App Store Connect team key held in a GitHub environment, plus the non-secret `APPLE_TEAM_ID` variable the workflow reads).
   - It is used only when Xcode Cloud is unavailable.
   - The Xcode version is pinned explicitly, because the runner's default changes. Only an explicit number counts as a pin (`latest-stable` does not), and `orchard doctor` checks it against `toolchain.xcodeFloorForUpload`.
3. **Local (simulator only).** `orchard sim <app>`. Local archive and upload are deliberately left out of v0.1: release builds belong to the cloud routes, so that signing identities never accumulate on a laptop.

**Two routes, one App Store Connect app.** Both cloud routes upload to the same app record, so two things have to be kept straight.

- **Toolchains differ, on purpose for now.** Xcode Cloud builds with Xcode 27.1 (iOS 27.1 SDK) and Node 24. Mythseal's backup builds with Xcode 26.6 (iOS 26.5 SDK) and Node 22, because the `macos-26` runner image has no Xcode 27; 27.x is only on the separate `xcode-27` preview label ([FACTS](docs/FACTS.md#github-actions-backup-route)). Both are valid uploads today: the floor is Xcode 26. That ends when Apple requires the iOS 27 SDK, "starting April 2027"; before then the backup moves to Xcode 27, or stops being a route. Until then a fault seen in a build from one route may not reproduce in a build from the other.
- **Build numbers must not collide.** Xcode Cloud numbers its builds itself, counting up from 1 (Apple: "Setting the next build number for Xcode Cloud builds"). Mythseal's backup numbers them `github.run_number + MOBILE_BUILD_OFFSET`, which also starts near 1, so its first upload would repeat a build number Xcode Cloud already used for the same marketing version, and App Store Connect would refuse it, during the very outage the backup is for. The rule is disjoint ranges: before the backup's first upload, set the repository variable `MOBILE_BUILD_OFFSET` to a large constant such as `100000`, which Xcode Cloud's count will not reach.
  - iOS needs a build number to be unique within its marketing version, not to rise, so the two ranges may interleave in time.
  - Android's `versionCode` is computed from the same offset, and Google Play accepts only increases. So the offset only ever goes up: never lower it once a build has used it.
  - The other way round, raising Xcode Cloud's Next Build Number in App Store Connect (Admin or App Manager) above the Actions range, has to be redone after every backup use, so it is the weaker choice.
  - iOS and Android carry the same build number only when both come from one Actions run.

## 3. CLI

`bin/orchard` is a Node ≥ 22 ES module with zero npm dependencies. Every command accepts `--app <name>` (or a positional app name) and `--repo <path>` to override `localPath`.

| Command | Writes? | Contract |
|---|---|---|
| `orchard doctor [app] [--json]` | no | Runs read-only checks grouped by rung (toolchain, app web, native project, Xcode Cloud readiness, store readiness, backup route). Every external command gets a timeout (there is no `timeout` binary on macOS, so `spawnSync` takes a `timeout` option). Exit 0 if nothing is BLOCKED, 1 if anything is BLOCKED, 2 on a usage error. Never prints secret values. |
| `orchard conform <app> [--check\|--write]` | `--write` only | Brings the app's iOS project in line with its manifest: Info.plist keys; `IPHONEOS_DEPLOYMENT_TARGET` in the app target and at project level (cap sync takes CapApp-SPM's platform from the first one in the file), and `CapApp-SPM/Package.swift`'s platform to match; `TARGETED_DEVICE_FAMILY`; the orientations; `ITSAppUsesNonExemptEncryption`; an app-level `PrivacyInfo.xcprivacy` (added to the target only if the target ships none, wherever it lives); the required-reason categories the app's plugins need, added to that manifest if missing and never removed; `ci_scripts/ci_post_clone.sh` (executable). It refuses a `server.url` it can read in the Capacitor config, and reports a `capacitor.config.ts` or `.js` (which Capacitor loads before any `.json`) as a manual item, because it cannot read them without running them. `--check` is the default and prints a diff-style plan. `--write` is idempotent: a second pass must find nothing to do, and if it does, or any write fails, every file conform touched is restored. Writes go through PlistBuddy/plutil for plists and through careful, `plutil -lint`-verified text edits for `project.pbxproj`. It never converts the project to the Xcode 27.2 JSON `.xcproj` format, because `cap sync` breaks on that silently. |
| `orchard sim <app> [--device <name>] [--no-build-web]` | build products only | Runs the web build, then the app's own `node_modules/.bin/cap sync ios` (never `npx cap`, which would fetch whatever npm package is named `cap` when the local CLI is missing; missing is BLOCKED with the install step), checks the config cap sync generated for `server.url`, then runs `xcodebuild -destination 'platform=iOS Simulator,name=…' build`, then `xcrun simctl boot/install/launch`. It sets `DEVELOPER_DIR` per command and never runs `xcode-select -s`. It takes no screenshots unless `--screenshot` is passed: agents can't tell when capture is OK (AGENTS.md principle 7), so a simulator capture is an explicit choice. It avoids `npx cap run ios`, which cannot open simulators under Xcode 27's Device Hub. |
| `orchard key import <AuthKey_XXXX.p8> --key-id <id> --issuer-id <id> [--replace] [--require-approval]` | Keychain + `~/.config/orchard/asc.json` | Stores the `.p8` in the login Keychain without truncation and without putting it in argv (see §5). It then verifies the round trip by comparing the SHA-256 of the stored and input bytes, without printing either. It refuses when an item for that key ID already exists (`--replace` deletes it first, and the old bytes are then gone from the Mac) and when the file is named for a different key ID. `--require-approval` makes every later read ask Yu (§5). It prints a reminder to delete the downloaded file and does not delete it itself. |
| `orchard key check` | no | Reports whether the Keychain item and local config exist, the key ID, and the item's byte length matching a sane `.p8` size. It reads the value inside the process to measure it, and never prints it. |
| `orchard key gh-secret <app> [--env mobile-stores]` | GitHub environment secrets | Only for the backup route. Pipes `ASC_KEY_P8_B64`, `ASC_KEY_ID` and `ASC_ISSUER_ID` into `gh secret set --env … --repo …` through stdin, never argv. Refuses unless `--yes` is given, because this sends a secret off the machine. The workflow's non-secret variables (mythseal's `APPLE_TEAM_ID`, `MOBILE_BUILD_OFFSET`) are set by hand (RUNBOOK step 8); `doctor --online` lists whether they exist. |
| `orchard template ci-post-clone <app>` | stdout | Prints the rendered Xcode Cloud script for the app. Used by `conform`, and handy on its own. |
| `orchard apps` | no | Lists the manifests and their status. |

## 4. Modules

```
bin/orchard                 entry; parses argv, dispatches to lib/commands/*
lib/config.mjs              loads orchard.json + apps/*.json; resolves ~ and --repo; validates required fields
lib/run.mjs                 run(cmd, args, {cwd, env, timeoutMs, input}) → {code, stdout, stderr, timedOut}; redacts nothing because secrets never enter argv/env of child commands except the Keychain read path
lib/report.mjs              check results {rung, id, status: READY|BLOCKED|UNKNOWN, detail, next}; text + JSON renderers
lib/xcode.mjs               locate Xcode (/Applications/Xcode*.app, DEVELOPER_DIR), version/build, license + first-launch status, SDKs, simulator runtimes/devices
lib/ios-project.mjs         read Info.plist (plutil -convert json), pbxproj build settings (text; app target, project level, the first deployment target), CapApp-SPM platform, project format (pbxproj vs JSON xcproj), the privacy manifest the app target ships (wherever it lives) and its required-reason APIs against the app's plugins (PLUGIN_PRIVACY), ci_scripts presence/mode, Package.resolved presence, the Capacitor config in Capacitor's own order (.ts, .js, then .json; no server.url, appId match)
lib/keychain.mjs            import (security -i over stdin; optional empty trusted-app list), read (security find-generic-password -w), materialize (mktemp dir 0700, removed on return, throw, exit and SIGINT/SIGTERM/SIGHUP), sha256 compare
lib/templates.mjs           render templates/* with {{placeholders}} from manifest + orchard.json
lib/commands/{doctor,conform,sim,key,template,apps}.mjs
templates/ios/PrivacyInfo.xcprivacy
templates/xcode-cloud/ci_post_clone.sh
bridge/orchard-bridge.mjs   vendorable browser module (see §6)
```

Tests (`node --test tests/*.test.mjs`) use fixture iOS projects under `tests/fixtures/` and an injectable command runner. They never call the real `security`, `xcodebuild` or `gh`, with one exception: an opt-in Keychain round-trip test (`ORCHARD_KEYCHAIN_TEST=1`), which writes and then deletes a dummy item under a test-only service name.

## 5. Keys and secrets

- **Xcode Cloud needs no key.** The App Store Connect team key exists only for the GitHub Actions backup and for API scripting. Create it only if that route is wanted.
- **Role.** Cloud-managed signing through `xcodebuild -allowProvisioningUpdates` with `-authenticationKey*` is reported to need the Admin role. A team key covers every app on the team, so its blast radius is the whole Mindicraft account. Prefer not creating it until it is needed. When it is created, record the role and the reason in docs/DECISIONS.md.
- **Storage.**
  - Don't use `security add-generic-password -w` with an interactive prompt: getpass(3) silently truncates input at 128 characters, and a base64 `.p8` is about 340.
  - Don't use `-w <value>` either, because that puts the secret in argv where `ps` can see it.
  - orchard feeds `add-generic-password -s <service> -a <keyId> -w <base64>` to `security -i` over stdin. There is no `-U`, so an existing item is never overwritten by accident; `key import --replace` deletes it first, on purpose.
  - Verify the round trip by hash.
- **What the Keychain protects against, and what it doesn't.** The item is created by `/usr/bin/security`, which the item then trusts, so later reads through `security find-generic-password -w` raise no prompt. That means **any process running as Yu can read the key silently**: an npm install or build script (including the ones `orchard sim` runs), any agent shell, any compromised dependency. The Keychain keeps the key out of repos, argv, logs and other users' reach; it does not guard it from code running as Yu. The service name is in this public repo, so a targeted read is easy.
  - `orchard key import --require-approval` adds `-T ""` (an empty trusted-application list, as `man security` documents), so every read raises a Keychain dialog that Yu has to allow. The import's own check, `key check` and `gh-secret` then each ask, so `key check` no longer runs headless for agents. Yu must click **Allow**, never **Always Allow**: Always Allow puts `/usr/bin/security` back on the list, and reads go silent again. `doctor` only asks whether the item exists, which reads attributes, not the secret (expected to need no dialog; not observed).
  - Whether `security -i` parses `-T ""` as an empty argument is untested here, because testing it raises a dialog on Yu's screen. orchard tests only the command line it builds. The first real `--require-approval` import shows it: if `key import` reads back without a dialog, the option did not take.
  - Neither mode covers the key while it is in use: the materialized file below and the downloaded `AuthKey_*.p8` are readable by any process running as Yu.
  - Whether to use `--require-approval` is Yu's call: it trades a dialog per read for a stop to silent reads. Its reach is the whole Mindicraft team, which argues for it.
- **Use.** Materialize to `mktemp -d` (mode 0700), write `AuthKey_<id>.p8` (0600), pass the path, and remove it when the work returns or throws, when the process calls `exit`, and on SIGINT, SIGTERM or SIGHUP (the signal is then raised again, so Ctrl-C still stops the command). Nothing can clean up after SIGKILL or a crash; macOS purges the per-user `$TMPDIR` eventually. Never echo the key, never put it in env for child processes that don't need it, never write it into the repo.

## 6. Native bridge

`bridge/orchard-bridge.mjs` is a dependency-free ES module that apps vendor (copy, with a header naming the orchard commit). It talks to Capacitor through `window.Capacitor` when running natively and falls back to web behaviour otherwise.

- `isNative()`, which returns true only when Capacitor reports a native platform.
- `saveFile({ name, mime, text | bytes })`.
  - Web: a Blob plus an anchor download.
  - Native: `Filesystem.writeFile` into the Cache directory, then `Share.share({ files: [uri] })`, so the player can save to Files, AirDrop it, and so on.
  - Blob downloads do nothing inside WKWebView, so this is how D2-style backups survive on iOS.
- `durable` is a small key→JSON store backed by `Filesystem` in the Library directory on native, and by nothing on web.
  - Apps can mirror the critical save there, because iOS may reclaim WKWebView localStorage/IndexedDB under storage pressure.
  - It is a mirror, not a replacement: restore always goes through the app's own strict import path.
- `haptic(kind)`, which is a no-op on web.

How plugins are reached from un-bundled code has to be verified against the Capacitor 8.5.x iOS runtime: either `window.Capacitor.Plugins.<Name>` proxies built from the injected plugin headers, or a vendored `@capacitor/core` ESM `registerPlugin`. The bridge documents which one it uses and why.

## 7. Principles (with reasons)

- **Ask before anything leaves the machine.** An upload, a GitHub secret or an App Store Connect record is outward-facing and slow to undo: bundle IDs and app records stay with a team. orchard does those only on an explicit flag, after Yu has said so for that build.
- **Say which rung you stand on.** A green web build is not an app; an app in the simulator is not a signed build. Mislabelled progress costs more than slow progress.
- **The app repo owns its app.** orchard ships templates and checks. App code and app decisions (scope, wording, privacy text) belong in the app's repo, and other hands work there too.
- **Keep secrets in the Keychain or in the CI environment, nowhere else.** That is Yu's standing practice, and a public repo makes any slip permanent.
- **Prefer the boring path Apple supports.** Cloud-managed signing over hand-carried certificates, SPM over CocoaPods (trunk goes read-only 2026-12-02), and Xcode's project format over newer formats that tools don't read yet.
