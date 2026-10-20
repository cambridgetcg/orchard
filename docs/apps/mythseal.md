# Mythseal (萬象契)

| | |
|---|---|
| Manifest | [apps/mythseal.json](../../apps/mythseal.json) |
| Repo | `cambridgetcg/mythseal`. Public, and it has no licence file. |
| Bundle ID | `com.mythseal.game` |
| Publisher | Mindicraft Limited ([DECISIONS D1](../DECISIONS.md)) |
| Status | **first-flight**, as of 2026-10-20 |
| Highest rung proved | **`native-project`** on `ios/first-flight` at `ea77702`: `orchard conform mythseal --check` passes (2026-10-20). `web` is proved by the app's own tests and build (its VALIDATION record: `npm test` 657/657, `npm run build:native`). `simulator` is not reached: it has not been run. Xcode 27.1 is now on this Mac (`orchard doctor` reads it, 2026-10-20), so the next step is `orchard sim mythseal`, then committing the `Package.resolved` it produces. |

## Where things stand (2026-10-20)

- **main** is `998b614` (2026-10-13). It has never had a CI pass: the four runs on 2026-10-13 were stopped by an Actions budget annotation.
  - In a scratch merge of PR #13 into main, 604 of 605 Node tests passed. The one failure was missing `node_modules`.
  - That run is research evidence, not evidence for the first-flight branch.
- **PR #13** (`mobile/cloud-pipeline`, by alpha) holds the native work: Capacitor 8.5.2 `ios/` with SPM and UIScene, fastlane lanes, and `mobile.yml`.
  - It is open, conflicts with main, and branched before D2 and D3.
  - **We never push to or modify that branch.**
- **`ios/first-flight`** is the new branch, checked out in `~/Games/mythseal-orchard`. Its own `docs/IOS-FIRST-FLIGHT.md` records every commit, its reason and its rung; read the tip there rather than here, because the branch moves. On 2026-10-20 it reached `simulator` (`orchard sim mythseal` at `0cb207f`).

What the existing evidence does *not* show:
- **The PR #13 native smoke test is not native.** It drives desktop Chrome with a Pixel 7 profile and a stubbed `window.Capacitor` over loopback; the file says so itself. No iOS simulator or WKWebView run exists.
- **The PR #13 guard has a gap.** D2's lobby actions `restore-offer-cloud` and `backup-prompt-cloud` start the account client and open 旅程閣 without going through the native guard. PR #13's regex tests still pass despite this.

## What the first-flight branch changes

This is the plan, and it describes intent. The branch's own commits and the mythseal repo's docs are the record of what was actually done.

1. **Bring PR #13 in with a merge commit.**
   - The three conflicts are `platform.mjs` (add/add; append `isNativeShell` to D2's file), `hosting/public-assets.json` (main's list plus `privacy.html`) and the `docs/README.md` rows.
   - Use a merge commit, never squash or rebase, so the 7a7d03e fence holds.
2. **Close the guard gap.** Put the native check inside `navigate('account')` and `account.init()` rather than at each call site, so a new button can't route around it again. Replace the regex-only tests with tests that drive the actions.
3. **Leave the account modules out of the native build.**
   - `account-client.mjs`, `account-ui.mjs` and `account.css` should not ship switched off. Apple's 2.5.19 asks for no dormant features (a clarification of long-standing policy, formerly 2.3.1).
   - `cloud-save.mjs` ships. Despite its name it is the local save validator: `profile-store.mjs`, `local-commands.mjs`, `platform.mjs` (file import) and `app.mjs` import it, and it makes no request. The branch's `tools/build.mjs` (`NATIVE_EXCLUDED`) is the source of truth for what the native build leaves out. For the next app: check a file's importers before excluding it, not its name.
   - Accounts can't work from `capacitor://localhost` anyway: the Worker answers only on `https://mythseal.com` and uses `__Host-` cookies.
   - There is no in-app account deletion (5.1.1(v)).
   - `mythseal-dev` holds real player accounts, so no native or test build ever points at it.
4. **Give native its own save panel, outside 旅程閣.** It covers status, export and import.
   - Export goes through the share sheet (orchard bridge `saveFile`), because Blob downloads do nothing in WKWebView.
   - A durable mirror of the journey sits in the app's Library directory (bridge `durable`), because iOS may reclaim WKWebView localStorage and IndexedDB.
   - Restore always goes through the game's strict import.
   - Keep the iOS scheme and hostname fixed forever: changing them after the first install would orphan every native save.
5. **iPhone only, portrait only** (`TARGETED_DEVICE_FAMILY = 1`). The landscape fault below 701 px and the portrait vertical-fit fault (RELEASE-NEXT §12 items 17 and 18) are still open. An iPhone-only app also needs no iPad screenshot set. Under 2.4.1 reviewers may still run it on an iPad in compatibility mode, which portrait lock makes safer.
6. **Deployment target iOS 16.** Web Locks need 15.4; Capacitor 9 will need 16.
7. **Export compliance:** `ITSAppUsesNonExemptEncryption = false`, so App Store Connect stops asking on every upload. Whether the app's encryption is exempt is a legal judgement for Yu, based on a build that makes no network calls.
8. **An app-level privacy manifest** (`PrivacyInfo.xcprivacy`, added to the target).
   - The official Capacitor plugin packages ship no manifest of their own (checked for 14 v8 plugins).
   - If the build uses `@capacitor/preferences` (UserDefaults) or `@capacitor/filesystem` (file timestamps via `ion-ios-filesystem`), declare those required-reason categories in the app's manifest. Confirm the reason codes against Apple's list.
9. **Capacitor 8.5.3**, up from 8.5.2.
10. **Xcode Cloud files.**
    - `ios/App/ci_scripts/ci_post_clone.sh`, rendered by `orchard template ci-post-clone mythseal`.
    - A committed `Package.resolved`, which needs Xcode to produce, so it comes after [RUNBOOK step 1](../RUNBOOK.md).
11. **`mobile.yml` (backup route).**
    - Fail unless `git merge-base --is-ancestor 7a7d03e HEAD`.
    - Pin Xcode explicitly. The `macos-26` image defaults to Xcode 26.6, and 27.x exists only on the `xcode-27` preview image. The branch pins 26.6, so the backup builds with a different SDK from Xcode Cloud's 27.1 until it moves to Xcode 27, which it must before April 2027 (DESIGN §2).
    - Before its first upload, set `APPLE_TEAM_ID` and `MOBILE_BUILD_OFFSET` ([RUNBOOK step 8](../RUNBOOK.md)), so the workflow can run and its build numbers stay clear of Xcode Cloud's.
12. **Privacy page names Mindicraft Limited** instead of Cambridge TCG Limited.
    - Correct the "stored only on your device" wording, because device and iCloud backups can copy WKWebView data.
    - Publishing it on mythseal.com is a separate web deploy, and Yu's call.
13. Smaller template leftovers: replace or remove the `armv7` device capability, and set the zh-Hant development region.

Each item lands on a rung when its proof runs:
- items 1–4 at `web` (the app's tests and `build:native`);
- items 5–10 at `native-project` (`orchard conform --check`). The branch records both rungs as reached for its items;
- the save and export behaviour at `simulator`, and then at `device` on Yu's iPhone. Neither has run.

## Store preparation (drafts for Yu)

Nothing below has been entered in App Store Connect. Each part is a draft for Yu.

### App Privacy

The intended answer is **Data Not Collected**. Enter it only after a zero-network check in a real WKWebView, on the simulator, shows no requests leave the app. The Chromium smoke test is not evidence for this.

The privacy policy URL is `https://mythseal.com/privacy.html`. It returns 404 today, and it must name Mindicraft Limited before it is used.

### Age rating questionnaire: DRAFT answers

The mappings are from Apple's age-ratings page, checked 2026-10-20 ([FACTS.md](../FACTS.md#app-review-and-submission)). The answers are Yu's to give.

| Question | Draft answer | Basis | Check |
|---|---|---|---|
| Cartoon or fantasy violence | Infrequent/mild? | Card battles with no gore | If Yu judges it frequent, the rating is 13+ |
| Horror or fear themes | Infrequent | 聊齋 ghost-story characters | Maps to 9+ |
| Realistic violence, sexual content, nudity, profanity, alcohol/tobacco/drugs, mature or suggestive themes, medical | None | Nothing known | Yu to skim the card art and text, including 紅樓夢 and 聊齋 themes |
| Simulated gambling | No | Packs use earned coins only | Yu's judgement |
| Loot boxes | No | Apple defines them as randomized items "for purchase"; packs use earned coins, and odds are shown anyway | Getting this right matters: declaring loot boxes makes the Brazil rating 18+ |
| Unrestricted web access | No | Navigation stays inside the bundle | "Yes" would mean 16+; any external link should open in the system browser |
| User-generated content, messaging, social media | No | None in the native build | The social-media question is mandatory |
| Advertising, contests, health | No | None | |

Likely result: **9+**, if fantasy violence counts as infrequent. Apple's mapping for *infrequent* fantasy violence was not checked; frequent fantasy violence is 13+.

### Territories

- **Exclude:** China mainland and Vietnam.
  - China needs an NPPA game approval number, and App Store Connect withholds that storefront without one anyway.
  - Vietnam needs a game licence.
- **EU:** depends on the DSA trader declaration ([RUNBOOK step 4](../RUNBOOK.md)).
- **Everything else** (HK, TW, MO, SG, MY, UK, US and others) is Yu's choice.

### Review notes: DRAFT

> Mythseal is a complete single-player card game in Traditional Chinese. Everything runs from files bundled in the app. It makes no network requests and has no sign-in, accounts, purchases, advertising or tracking. Card packs are opened with coins earned in play, and the odds are shown on the pack screen. Progress is stored on the device. Players can export a save file through the share sheet and import it again from the save panel. The web version at mythseal.com offers optional online accounts; that feature is not part of this app.

Check every sentence against the build that is actually submitted. Guideline 2.3.1(a) asks for specific, accurate notes.

Use an international-format phone number (+44…) for the App Review contact.

### Screenshots plan

- **Required:** one set for "iPhone with Dynamic Island (medium display)", 1206×2622 (or 1179×2556), with up to 10 images and no alpha channel.
- **Not needed:** an iPad set, while the device family is iPhone-only.
- **From April 2027:** iPhone Duo sets (outer 1398×2034, inner 2007×2853). Apple's pages disagree on whether these apply to every submission.
- **How to make them:** taking them is screen capture.
  - Either Yu takes them on a device,
  - or Yu explicitly OKs `orchard sim mythseal --screenshot` at a moment Yu says capture is OK.
- **Content:** show the app in use (2.3.3). Keep references to other franchises, such as Bandai, One Piece or "Shanhai Bestiary", out of the screenshots and metadata (2.3.7, 5.2).

## Open questions for Yu

1. **IP:** who owns Mythseal's code and art today, and how does Mindicraft get a licence or assignment (5.2.1)?
2. **Marketing version:** package.json says 0.5.1, but the content is v0.6.0-era. Which number goes to the store?
3. **Store name:** "Mythseal" or "萬象契 Mythseal"? Availability on the App Store has not been checked, and no trademark clearance has been done.
4. **Privacy:** what wording, which contact address, and is Mindicraft registered with the ICO? When does `/privacy.html` go live?
5. **Store answers:** the age-rating answers above, the territories, and the EU.
6. **Scope:** confirm iPhone-only portrait, plus offline guest play with save export and import, for the first TestFlight.
7. **Licence:** which licence, if any, for the public repo?
