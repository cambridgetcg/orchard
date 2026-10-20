# Facts

These are dated facts about Apple, Xcode, Capacitor and CI that orchard relies on. Unless a line says otherwise, each was checked on **2026-10-20** against the source linked. Where an adversarial check corrected the first reading, the corrected wording is used here.

Each fact carries one of these labels:

- **verified**: read in the primary source.
- **reported**: comes from forum posts or secondary sources, not from Apple.
- **inferred**: reasoned from verified facts, not observed.
- **unknown**: looked for, not settled.

These facts go stale. Re-check anything load-bearing before a release, and add new facts with their own date.

## This Mac (2026-10-20)

- **verified.** macOS 26.6.2 (25G83), Apple M2, 16 GiB RAM, about 92 GiB free.
- **verified.** In the morning: Command Line Tools 26.4 only, and no Xcode (`xcodebuild` reported "requires Xcode"). Later the same day: Xcode 27.1 (27A9275) at `/Applications/Xcode.app`, licence accepted, first-launch components installed, iOS 27.0 and 27.1 simulator runtimes (`orchard doctor`, `xcrun simctl list runtimes`).
- **verified.** There are 0 code-signing identities, and no App Store Connect key in the Keychain.
- **verified.** Node 26.0.0 is installed.
- **verified.** There is no `timeout` binary (exit 127).

## Toolchain

- **verified.** Xcode 27.1 (27A9275) is the current release (2026-10-15). Xcode 27.2 RC (27B48) was posted 2026-10-19. [Apple releases](https://developer.apple.com/news/releases/)
- **verified.** Xcode 27.x needs macOS Tahoe 26.6 or later. Xcode 27.1 ships the iOS 27.1 SDK and Swift 6.4, deploys to iOS 15–27, and debugs on devices running iOS 17 or later. [Xcode support matrix](https://developer.apple.com/support/xcode/)
- **verified.** App Store Connect's notes say Xcode 27.1 uploads use "the SDK for iOS 27.1, iPadOS 27.0". [App Store Connect release notes](https://developer.apple.com/help/app-store-connect/release-notes/)
- **verified (corrected).** Xcode 27 installs and runs only on Apple silicon Macs. The note is radar 162138432; radar 161837535 is a different item. [Xcode 27 release notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-27-release-notes)
- **verified.** Upload floor:
  - Since 2026-04-28, uploads must be built with Xcode 26 or later and an iOS 26 SDK.
  - Since 2026-09-09, iOS apps must target iOS 13 or later.

  [Upcoming requirements](https://developer.apple.com/news/upcoming-requirements/)
- **verified.** "Starting April 2027", iOS apps must be built with the iOS 27 SDK or later. No exact day is given, and the Upcoming Requirements page did not list it yet. [Apple news, 2026-09-09](https://developer.apple.com/news/?id=k1mtkt1k)
- **verified.** Apps built with the iOS 27 SDK must adopt the UIScene life cycle or they fail to launch. `UIDesignRequiresCompatibility` is ignored when building for iOS 27. Mythseal's PR #13 project already uses UIScene. [iOS 27 release notes](https://developer.apple.com/documentation/ios-ipados-release-notes)
- **verified.** Known Xcode 27 issues:
  - An app with the Hardware-Checked Pointer Arithmetic Slice enabled cannot be uploaded from macOS 26.6 with automatic signing.
  - The first Simulator launch in 27.1 can take several minutes.

  The Capacitor template does not enable that slice (inferred). [Xcode 27 release notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-27-release-notes)
- **verified.** Setting up Xcode from the command line:
  - `xcode-select -s` needs superuser and changes the setting for all users. `DEVELOPER_DIR` is the per-command alternative.
  - `xcodebuild -license` must run as a privileged user.
  - Simulator runtimes are a separate download: `xcodebuild -downloadPlatform iOS`, which fetches the arm64 variant on Apple silicon.

  Sources: local `man xcode-select`; [Downloading additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- **inferred.** Xcode, one iOS simulator runtime (about 8 GB) and caches take roughly 15–25 GB. Apple publishes no size.
- **verified (on this Mac, 2026-10-20).** Simulator runtimes for Xcode 27.1:
  - The bundled **iOS 27.1** runtime (24A94425) creates only **iPhone Duo**. `simctl create` refuses iPhone 17, iPhone SE (3rd generation) and iPhone 18 Pro Max on it. This fits the 27.1 SDK being the Duo release.
  - Ordinary iPhones need the **iOS 27.0** runtime (24A434, 8.05 GB): `xcodebuild -downloadPlatform iOS -buildVersion 27.0 -architectureVariant arm64`. Once it was in, Xcode created the usual iPhone and iPad simulators by itself.
  - That download ended with `Registering simulator runtime with CoreSimulator failed … Cannot resolve source file` and still exited 0, and `xcrun simctl runtime list` then showed the runtime **Ready**. Check `simctl runtime list` rather than trusting the message.
  - The first app launch on a freshly booted simulator took more than 30 seconds before the WKWebView finished loading; the next launch took about 2 seconds.
- **verified (on this Mac, 2026-10-20).** A Capacitor 8.5.3 app built by Xcode 27.1 for the iOS 27.0 Simulator loads its bundle at `capacitor://localhost`, and a page with no bundler reaches native plugins through `window.Capacitor.Plugins` (mythseal's mirror made `readFile`, `writeFile`, `readdir` and `rename` calls through the real Filesystem plugin). Evidence: Capacitor console output and WebKit `didFinishLoadForFrame` in the simulator log; mythseal `docs/IOS-FIRST-FLIGHT.md`.

### GitHub Actions (backup route)

- **verified.** The `macos-26` runner image (20261013.0424.1) runs macOS 26.6.2 with **Xcode 26.6 as the default** (iOS 26.5 SDK); only Xcode 26.0.1–26.6 are installed. Xcode 27.x lives only on a separate `xcode-27` label (macOS 27.0.1, default Xcode 27.0), which the image calls a "public preview". That image also ships Node 24.21.0, Ruby 3.4.11 and fastlane 2.241.0. [runner-images macOS readmes](https://github.com/actions/runner-images/tree/main/images/macos)
- **verified.** GitHub's docs say standard GitHub-hosted runners are free in public repos, and macOS costs $0.062/min in private ones. [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) · [Runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)
  - **verified.** Even so, an account budget stop blocked jobs in the public mythseal repo on 2026-10-13.
  - **unknown.** GitHub gives no explanation for this. Treat public-repo runs as cheap, not as guaranteed.
- **verified.** `workflow_dispatch` "will only trigger a workflow run if the workflow file exists on the default branch". [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- **verified.** fastlane 2.240+ needs Ruby ≥ 3.1 and 2.241.x needs ≥ 3.2. The system Ruby 2.6 on macOS runs neither. [fastlane.gemspec](https://github.com/fastlane/fastlane/blob/master/fastlane.gemspec)

## Capacitor

- **verified.** Capacitor's current releases and v8 requirements:
  - The stable release is **8.5.3** (npm, 2026-10-07).
  - v8 is Active and needs Node 22+, Xcode 26.0+ and iOS 15.0+.
  - New projects use SPM by default.
  - v7 extended support ends 2026-12-08.

  [Support policy](https://capacitorjs.com/docs/main/reference/support-policy) · [Environment setup](https://capacitorjs.com/docs/getting-started/environment-setup)
- **verified.** Capacitor 9 is in alpha (9.0.0-alpha.8). Its upgrade guide says it needs Xcode 27+, Node 24+ and **iOS 16.0+**, and that it moves boot into a SwiftUI App struct. [Capacitor 9 upgrade guide (prerelease)](https://capacitorjs.com/docs/next/updating/9-0)
- **verified.** CocoaPods trunk is planned to go read-only on 2026-12-02 ("not set in stone"). Stay on SPM. [CocoaPods blog](https://blog.cocoapods.org/CocoaPods-Specs-Repo/)
- **verified.** Known problems with Xcode 27:
  - **#8620**: `npx cap run ios` cannot open simulators, because Simulator.app became Device Hub. The fix (native-run PR #408) merged on 2026-10-15, but npm's native-run was still 2.0.3.
  - **#8607**: converting the project to Xcode 27.2's JSON `.xcproj` breaks `cap sync ios` silently: it exits 0, and `cap doctor` still reports healthy. The fix PR #8608 is open.
  - **#8662**: a Swift 6 warning in `CAPSceneDelegateProxy`.

  [capacitor#8620](https://github.com/ionic-team/capacitor/issues/8620) · [native-run#408](https://github.com/ionic-team/native-run/pull/408) · [capacitor#8607](https://github.com/ionic-team/capacitor/issues/8607) · [capacitor#8662](https://github.com/ionic-team/capacitor/issues/8662)
- **verified.** In the capacitor-swift-pm **8.5.2** binaries, `Capacitor.xcframework` and `Cordova.xcframework` are signed by "Developer ID Application: Drifty Co. (9YN2HU59K8)". Both device and simulator slices contain `PrivacyInfo.xcprivacy`, and the zip hashes match `Package.swift`. The 8.5.3 binaries were not re-checked.
- **reported.** Rebuilding `Capacitor.xcframework` from source leads to ITMS-91065 at upload. Use the signed binaries. [capacitor#8537](https://github.com/ionic-team/capacitor/issues/8537)
- **verified.** None of the 14 official plugin tarballs (v8) checked ships a `PrivacyInfo.xcprivacy`.
  - `@capacitor/preferences` calls `UserDefaults`.
  - `@capacitor/filesystem` 8.1.5 depends on `ion-ios-filesystem` 2.0.1 and returns file creation and modification dates.
  - Both are required-reason API categories. `ion-ios-filesystem` 2.0.1 ships no manifest either (its repository at that tag); it reads `FileAttributeKey.creationDate` and `.modificationDate`, which Apple lists under file timestamps.
  - **verified.** The plugins' READMEs ask the app to declare them: Filesystem `NSPrivacyAccessedAPICategoryFileTimestamp` (suggested reason `C617.1`), Preferences `NSPrivacyAccessedAPICategoryUserDefaults` (`CA92.1`). orchard's template declares neither, so `doctor` and `conform` treat it as a minimum (lib/ios-project.mjs `PLUGIN_PRIVACY`).
- **verified.** `@capacitor/cli` 8.5.3 (`dist/config.js` `loadExtConfig`) loads `capacitor.config.ts` first, then `.js`, and reads `capacitor.config.json` only when neither exists. `capacitor.config.mjs` is not a name it loads.
- **verified.** `cap sync` regenerates `CapApp-SPM/Package.swift`'s `platforms: [.iOS(.vNN)]` from the **first** `IPHONEOS_DEPLOYMENT_TARGET = ` in `project.pbxproj` (`dist/ios/common.js` `getMajoriOSVersion`), which in the Capacitor template is a project-level configuration, not the app target's.
- **verified.** npm's docs: when stdin is not a TTY, `npx` assumes `--yes` and installs a package it doesn't find locally. So `npx cap …` without a local `@capacitor/cli` would fetch the unrelated public package named `cap`. orchard runs `node_modules/.bin/cap` instead. [npm exec](https://docs.npmjs.com/cli/commands/npm-exec)
- **verified.** The iOS template:
  - It sets `IPHONEOS_DEPLOYMENT_TARGET = 15.0` and `CODE_SIGN_STYLE = Automatic`.
  - Its `.gitignore` excludes `App/App/public`, `App/App/capacitor.config.json` and `config.xml`, so CI must build the web app and run `cap sync`.
  - `cap sync` pins capacitor-swift-pm `exact:` to the installed `@capacitor/ios`, so every bump needs a fresh `Package.resolved` (inferred).
- **verified (corrected).** `npx cap build ios` adds `-allowProvisioningUpdates` only to the export step and never passes `-authenticationKey*`. Headless signing therefore needs direct `xcodebuild` calls.
- **verified.** Capacitor's storage guide says the OS "will reclaim local storage from Web Views if a device is running low on space", and that "the same can be said for IndexedDB at least on iOS". [Storage guide](https://capacitorjs.com/docs/guides/storage)
- **verified.** Origin and loading rules:
  - The iOS WebView origin is `capacitor://localhost`.
  - Keeping hostname `localhost` keeps secure-context APIs.
  - `server.url` (loading a remote site) is "not intended for use in production".

  [Capacitor config](https://capacitorjs.com/docs/config)

## Signing and keys

- **verified.** App Store Connect API keys:
  - The Account Holder must request API access, and Apple approves it "on a case-by-case basis".
  - **Team keys** are created by the Account Holder or an Admin. They cover all apps on the team (app access can't be limited) and carry one role, which can't be edited afterwards.
  - **Individual keys** are one per user and cannot use provisioning endpoints or notaryTool.
  - The `.p8` downloads once, Apple keeps no copy, and a revoked key cannot be reinstated.

  [ASC API: get started](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/) · [Creating API keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)
- **verified.** Cloud-managed certificates:
  - Xcode 13+ cloud-signs at distribution when it finds no local signing certificate, and adding an active Apple Distribution certificate to the keychain makes it sign locally instead. The page describes the Organizer workflow.
  - Users with the Admin role or the Account Holder can cloud-sign by default. A Developer-role user needs "Access to Cloud Managed Distribution Certificate".

  [Cloud-managed certificates](https://developer.apple.com/help/account/certificates/cloud-managed-certificates/) · [WWDC21 10204](https://developer.apple.com/videos/play/wwdc2021/10204/)
- **reported.** Cloud signing through `xcodebuild` with an API key fails with Developer or App Manager keys and works with an Admin key. A 2022 reply says keys have no UI for the extra cloud-certificate permission. Apple does not document this. [Forum thread 698117](https://developer.apple.com/forums/thread/698117)
- **verified (corrected).** User roles matrix:
  - Admin can create distribution certificates and profiles.
  - App Manager can do so only with "Access to Certificates, Identifiers & Profiles".
  - Developer cannot.
  - Whether a *team key* with the App Manager role carries that access is **unknown**.

  [Roles](https://developer.apple.com/help/account/access/roles/)
- **verified.** The `xcodebuild` man page says `-allowProvisioningUpdates` "requires a developer account to have been added in Xcode's Accounts preference pane". `-authenticationKeyPath/-ID/-IssuerID` is the documented alternative. This is a mirror of the 27.2 beta man page; it could not be checked locally because Xcode is absent.
- **inferred (strong, untested).** `security add-generic-password … -w` with an interactive prompt reads through getpass(3). getpass keeps at most 128 characters (`_PASSWORD_LEN` in the 26.4 SDK's `pwd.h`) and silently discards the rest, while a base64 `.p8` is about 340 characters. orchard therefore feeds `security -i` over stdin and verifies the round trip by hash ([DESIGN.md §5](../DESIGN.md#5-keys-and-secrets)).
- **verified (corrected).** Only the Account Holder can:
  - accept agreements, renew, and sign the Paid Apps Agreement;
  - transfer apps;
  - request API access;
  - create non-cloud Developer ID certificates. Cloud-managed Developer ID certificates can also be created by an Admin who has been given that access.

  [Roles](https://developer.apple.com/help/account/manage-your-team/roles)
- **unknown.** Apple says only that "only one type of each distribution certificate … is allowed per team". The numeric cap on Apple Distribution certificates per team could not be confirmed.
- **verified.** Devices:
  - 100 devices per product family per membership year.
  - On a new membership, the first 10 per platform are usable at once, and devices 11–100 wait 24–72 hours for processing.

  [Device registration updates](https://developer.apple.com/help/account/reference/device-registration-updates)

## Account and agreements

- **verified.** For an Organization, the seller name is the legal entity name; DBAs and trade names are not accepted. A D-U-N-S number is required. The fee is 99 USD a year, charged in local currency. [Enroll](https://developer.apple.com/programs/enroll/)
- **verified.** Apple updated the DPLA on 2026-10-13, and the Account Holder must accept it. [Apple news](https://developer.apple.com/news/?id=17mwd36z)
- **inferred.** An unaccepted DPLA blocks creating or submitting apps. Apple states this for the Paid Apps Agreement only.
- **verified (corrected).** Free apps are covered by the DPLA. Paid apps and IAP need the Paid Apps Agreement, which cannot be undone once signed. Tax forms and banking both require it first, and banking is processed only after the tax forms are in. [Agreements](https://developer.apple.com/help/app-store-connect/manage-agreements/sign-and-update-agreements)
- **verified.** EU DSA:
  - Every developer must declare a trader status, "even if you don't distribute apps in the EU".
  - Organizations show their D-U-N-S address, plus a phone number and email entered for EU product pages.
  - Apps without a verified status have been removed from the EU storefront since 2025-02-17.

  [DSA trader requirements](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements)
- **verified.** The App Review contact phone must be in international format (+44…) (App Store Connect release notes, 2026-08-19).

## Xcode Cloud

- **verified (locally, 2026-10-20).** `Package.resolved`'s `originHash` depends on the checkout path when a project has local Swift packages (Capacitor's `CapApp-SPM` and plugins in `node_modules`): three paths gave three hashes for identical manifests. A strict build at a different path (`-disableAutomaticPackageResolution -onlyUsePackageVersionsFromResolvedFile`, how Xcode Cloud resolves) still accepted the committed file and succeeded, so the hash does not need to match. The first real Xcode Cloud build is the proof.
- **verified.** Pricing: 25 compute hours a month are included with the membership. The paid tiers are monthly subscriptions, not per-hour overage:

  | Hours a month | Price |
  |---|---|
  | 100 | $49.99 |
  | 250 | $99.99 |
  | 1,000 | $399.99 |
  | 10,000 | $3,999.99 |

  [Xcode Cloud](https://developer.apple.com/xcode-cloud/)
- **verified.** Supported source hosts are GitHub (and Enterprise), GitLab (and self-managed) and Bitbucket (Cloud and Server). Codeberg and Forgejo are not supported. Connecting a GitHub *organization* needs an org owner, while a repo outside an organization needs admin permission (`cambridgetcg` is a personal account). [Setting up your project](https://developer.apple.com/documentation/xcode/setting-up-your-project-to-use-xcode-cloud)
- **verified.** Creating the first workflow:
  - "You need to configure your first Xcode Cloud workflow in Xcode." Workflows can be edited in App Store Connect afterwards.
  - Creating the app record needs App Manager, Admin or Account Holder.
  - The suggested first workflow builds every change to the default branch and every PR, and uses the latest Xcode, so edit it.
  - Artifacts are kept for 30 days.

  [Configuring your first workflow](https://developer.apple.com/documentation/xcode/configuring-your-first-xcode-cloud-workflow)
- **verified.** Dependencies:
  - The build environment includes Homebrew but no third-party tools, so Node is installed in `ci_post_clone.sh`.
  - Xcode Cloud "doesn't use automatic package resolution", so `Package.resolved` must be committed under `App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/`.

  [Making dependencies available](https://developer.apple.com/documentation/xcode/making-dependencies-available-to-xcode-cloud)
- **verified.** Custom scripts:
  - Only one `ci_scripts` directory is recognised per repo, next to the project.
  - Scripts run with `ci_scripts` as their working directory, so `cd "$CI_PRIMARY_REPOSITORY_PATH"`.
  - Scripts need `chmod +x` and a shebang, or they run as `zsh <file>`.
  - Scripts cannot use `sudo`.

  [Writing custom build scripts](https://developer.apple.com/documentation/xcode/writing-custom-build-scripts)
- **inferred (from Apple's own guidance; not yet observed).** Outputs of `ci_post_clone.sh` (`node_modules`, the `cap sync` output) reach the build and archive steps:
  - Apple tells projects that keep `Pods/` out of git to install them "using a custom build script": a `ci_post_clone.sh` that runs `pod install`. That only works if files a post-clone script creates in the repo are still there for `xcodebuild`. [Making dependencies available](https://developer.apple.com/documentation/xcode/making-dependencies-available-to-xcode-cloud)
  - The same custom-scripts page suggests a post-clone script might "add a new entry to a property list", which also only matters if the build sees it.
  - The deletion sentence, in full: "Files you create with a custom build script aren't available to other custom build scripts, and Xcode Cloud deletes any files a custom build script creates. As a result, downloadable Xcode Cloud build artifacts don't include files you create with custom build scripts." Its conclusion is about the artifacts you download, not about the build. [Writing custom build scripts](https://developer.apple.com/documentation/xcode/writing-custom-build-scripts)
  - Read cautiously, its first clause means a future `ci_pre_xcodebuild.sh` should not depend on files `ci_post_clone.sh` created. There is none today.
  - Flutter's official docs rely on the same post-clone pattern.
  - The first real Xcode Cloud build is the observation.
- **inferred.** Xcode Cloud compute is independent of GitHub Actions billing.
- **verified.** Xcode Cloud assigns each build a build number, incrementing from 1; an Admin or App Manager can set a custom next build number in App Store Connect, which Apple describes as the fix for "version collisions". [Setting the next build number](https://developer.apple.com/documentation/xcode/setting-the-next-build-number-for-xcode-cloud-builds). orchard's rule for the backup route's numbers is in [DESIGN.md §2](../DESIGN.md#2-release-routes).

## TestFlight

- **verified.** Testers:
  - Up to 100 internal testers, who must be App Store Connect users, and up to 10,000 external testers.
  - The first build added to an external group goes to Beta App Review.
  - Builds expire after 90 days.

  [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)
- **verified.** At most 6 builds can be submitted to TestFlight review in 24 hours. A build uploaded as "TestFlight Internal Only" can never go to external testers or the App Store. [Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers) · [Add internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers)

## App Review and submission

Source for the guideline texts: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), "Last Updated: October 16, 2026".

- **verified, 4.2:** an app "should include features, content, and UI that elevate it beyond a repackaged website". 4.2.2 rules out web clippings.
  - **reported.** A Capacitor app with several native plugins was still rejected under 4.2 (forum, Jan 2026); reviewers judge the core experience.
- **verified, 2.5.2:** apps may not "download, install, or execute code which introduces or changes features or functionality". Everything ships in the binary, with no `server.url` and no live-update channel.
- **verified (corrected), 2.5.19:** "Don't include any hidden, dormant, or undocumented features in your app." Apple's 2026-10-16 note says this "clarifies long-standing policy … formerly covered in Guideline 2.3.1". It is a renumbered clarification aimed at bait-and-switch, not a new prohibition. [Apple news](https://developer.apple.com/news/?id=92th7e5i)
- **verified, 2.3.1(a):** describe new features specifically in the review notes.
- **verified, 5.1.1(i):** a privacy policy link is required both in App Store Connect and inside the app.
- **verified, 5.1.1(v):** an app that supports account creation must let people start deleting the account inside the app; deactivation alone is not enough. [Offering account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- **verified, 5.1.1(ix):** apps in highly regulated fields, "such as banking and financial services", "should be submitted by a legal entity that provides the services". Tax is not named, but Apple's Finance category lists "tax".
- **verified, 4.8:** an equivalent privacy-preserving login is required only when a third-party or social login sets up the primary account. It is exempt when the app uses only the company's own account system.
- **verified, 3.1.1:** "loot boxes or other mechanisms that provide randomized virtual items **for purchase** must disclose the odds". Digital goods sold in the app use IAP.
- **5.2.1** (quoted in the research but not re-checked by the verify pass): "Apps should be submitted by the person or legal entity that owns or has licensed the intellectual property".
- **verified, 2.4.1:** iPhone apps "should run on iPad whenever possible". An iPhone-only app can still be reviewed on an iPad in compatibility mode.
- **verified.** Privacy manifests:
  - App Store Connect rejects undeclared required-reason API use (since 2024-05-01).
  - Capacitor and Cordova are on Apple's list of SDKs that need a privacy manifest, and a signature when used as binaries.

  [Third-party SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/) · [Privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)
- **verified.** Export compliance: `ITSAppUsesNonExemptEncryption = NO` covers apps that use no encryption, or only exempt encryption. Without the key, App Store Connect asks the questionnaire on every upload. Deciding exemption is the developer's legal call. [ITSAppUsesNonExemptEncryption](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption)
- **verified (corrected).** Age ratings:
  - The ratings are 4+, 9+, 13+, 16+, 18+ and Unrated, and an Unrated app can't be published.
  - The social-media question has been required since September 2026, and declaring social media gives 13+. A lower rating with the feature disabled for under-13s is possible but unconfirmed, because Apple's pages disagree.
  - Questionnaire mappings:

    | Answer | Rating |
    |---|---|
    | "Unrestricted web access" | **16+** |
    | "Frequent cartoon or fantasy violence" | 13+ |
    | "Infrequent horror or fear themes" | 9+ |

  - "Loot Boxes" is defined as randomized items "for purchase".

  [Age ratings](https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/)
- **verified.** Since 2026-02-24, 18+ apps are blocked for unconfirmed adults in Australia, Brazil and Singapore, and declaring loot boxes moves an app's Brazil rating to 18+. [Apple news](https://developer.apple.com/news/?id=f5zj08ey)
- **verified.** Screenshots:
  - Required today: at least one for "iPhone with Dynamic Island (medium display)" (1206×2622 or 1179×2556, the 6.3-inch class), plus a 13-inch iPad set (2064×2752 or 2048×2732) **if the app runs on iPad**.
  - Up to 10 per size, with no alpha channel.
  - The page is internally inconsistent about the 6.5-inch row.

  [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
- **verified.** iPhone Duo screenshots become required "Starting in April 2027": an outer display at 1398×2034 and an inner display at 2007×2853. Apple's pages disagree on scope: one says "any app using the iOS 27.1 SDK or later", another says "any apps or games submitted". [Apple news, 2026-10-05](https://developer.apple.com/news/?id=kkphp5qo)
- **verified.** Games:
  - China mainland requires an NPPA approval number, and App Store Connect itself withholds the China storefront without one.
  - Vietnam requires games to be licensed.

  [App information reference](https://developer.apple.com/help/app-store-connect/reference/app-information/)

## Age-assurance law (legal, not App Review)

These are legal duties with civil penalties. Apple says there are no App Review changes for them, and tells developers to ask counsel. They matter most for apps with accounts, user-generated content or minors as users. [Age assurance](https://developer.apple.com/support/age-assurance/)

- **verified.** Texas SB 2420 has applied to new Texas Apple Accounts since 2026-06-04. Developers decide what counts as a "significant change" and get parental consent through the PermissionKit API. [Apple news](https://developer.apple.com/news/?id=sg176nne)
- **verified.** Apple says age categories are shared for new accounts in Utah from 2026-05-06 and Louisiana from 2026-07-01.
- **unknown.** The amended Utah statute (HB 498) appears to start developer duties on 2027-05-06. That reading rests on a fetched summary of the statute and on forum posts, and the two research passes disagreed.
- **verified.** The Declared Age Range and PermissionKit APIs need the iOS 26.2 SDK or later.
