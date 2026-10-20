# orchard 🍎

One orchard, many trees: each web project grows its own iOS app here.

orchard takes a web project that already works and carries it to an iOS app on TestFlight. It does this with a small CLI (`bin/orchard`), a few templates, and a native bridge the apps can vendor. The apps themselves stay in their own repos with their own `ios/` folder; orchard keeps one manifest per app in `apps/<name>.json` and the team-wide settings in `orchard.json`.

The publisher is Mindicraft Limited (UK company 13782045), on its organization Apple Developer team. The contract for how orchard behaves is [DESIGN.md](DESIGN.md).

**This repo holds no secrets, and never will.** It is meant to be public (it will become `cambridgetcg/orchard`). Keys live in the macOS Keychain or in a CI environment; see [docs/KEYS.md](docs/KEYS.md).

## The ladder

Every status orchard reports names a rung, and a lower rung never stands in for a higher one. A green web build is not an app, and an app in the simulator is not a signed build.

`web` → `native-project` → `simulator` → `device` → `signed-archive` → `testflight-internal` → `testflight-external` → `review`

What each rung proves, and what proves it, is in [DESIGN.md §1](DESIGN.md#1-the-ladder). `orchard doctor` reports READY, BLOCKED or UNKNOWN for each check. UNKNOWN never counts as READY.

## Routes

| Route | Used for | Signing | Needs |
|---|---|---|---|
| **Xcode Cloud** (primary) | release builds → TestFlight | Apple's cloud-managed signing; no key or certificate touches a runner | the first workflow created in Xcode by a person on the Mindicraft team ([RUNBOOK step 5](docs/RUNBOOK.md)); `Package.resolved` committed; `ios/App/ci_scripts/ci_post_clone.sh` |
| **GitHub Actions** (backup) | release builds, only when Xcode Cloud is unavailable | cloud-managed signing through an App Store Connect team key held in a GitHub environment | Yu creating that key and environment, plus the `APPLE_TEAM_ID` and `MOBILE_BUILD_OFFSET` variables ([RUNBOOK step 8](docs/RUNBOOK.md)); an explicitly pinned Xcode (26.6 today, so a different SDK from Xcode Cloud's 27.1 until it moves to Xcode 27, before April 2027) |
| **Local Xcode** | the simulator loop only | none | Xcode installed on a developer Mac ([RUNBOOK step 1](docs/RUNBOOK.md)) |

Local archive and upload are left out on purpose, so that signing identities don't pile up on laptops. The details are in [DESIGN.md §2](DESIGN.md#2-release-routes).

## Quickstart

orchard needs Node 22 or later and has no npm dependencies. The CLI is being built alongside these docs (v0.1). The commands below follow [DESIGN.md §3](DESIGN.md#3-cli), which is the contract if anything here drifts.

```sh
cd ~/orchard
npm test                                    # node --test tests/*.test.mjs
node bin/orchard apps                       # list the app manifests and their status
node bin/orchard doctor mythseal            # read-only checks by rung; never prints secrets
node bin/orchard conform mythseal --check   # what the iOS project would need (diff-style plan)
node bin/orchard template ci-post-clone mythseal   # the rendered Xcode Cloud script
node bin/orchard sim mythseal               # simulator loop; needs local Xcode
```

`conform --write`, `key import` and `key gh-secret` change things (the app's iOS project, the Keychain and GitHub respectively). Read [AGENTS.md](AGENTS.md) before running them.

## Apps

Status as of 2026-10-20.

| App | Manifest | Status | Highest rung proved | Next |
|---|---|---|---|---|
| Mythseal | [apps/mythseal.json](apps/mythseal.json) | **first-flight**: branch `ios/first-flight` in the mythseal repo brings in PR #13 with a merge commit and fixes it. | `signed-archive`: Xcode Cloud build 3 (Xcode 27.1, `bc7252e`, 2026-10-20) ran the post-clone script (667/667 tests, store build, `cap sync`), resolved packages, archived, exported for App Store distribution with Apple's cloud signing and handed version 0.5.1 (3) to App Store Connect | `testflight-internal`: App Store Connect processing, then an internal tester installs it through TestFlight (that install is also the first `device` rung) |
| TaxSorted | [apps/taxsorted.json](apps/taxsorted.json) | **blocked**: the copyright holder of record for the AGPL-3.0 code is not established, and an AGPL §7 App Store permission (a draft that needs legal review) is the recommended protection, pending Yu's and legal judgement; no privacy policy names Mindicraft Limited; the iOS v1 scope is not chosen. | none (no iOS project exists) | Yu's decisions in [docs/apps/taxsorted.md](docs/apps/taxsorted.md) |

Per-app notes: [docs/apps/mythseal.md](docs/apps/mythseal.md), [docs/apps/taxsorted.md](docs/apps/taxsorted.md).

## Docs

- [DESIGN.md](DESIGN.md): the contract (ladder, routes, CLI, modules, keys, bridge, principles).
- [AGENTS.md](AGENTS.md): how agents work here, and the machinery facts of this Mac.
- [docs/RUNBOOK.md](docs/RUNBOOK.md): the steps only Yu, as Account Holder, can do (in Cantonese).
- [docs/FACTS.md](docs/FACTS.md): dated, sourced facts about Apple, Xcode, Capacitor and CI.
- [docs/DECISIONS.md](docs/DECISIONS.md): what has been decided, and what is still Yu's call.
- [docs/KEYS.md](docs/KEYS.md): how keys are handled, and why Xcode Cloud needs none.

## Licence

No licence has been chosen yet. Yu decides. Until a licence is added, the code being visible in public does not give anyone else a right to reuse it.
