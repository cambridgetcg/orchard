# Decisions

This is a dated log of what has been decided, by whom, and why, followed by what is still open. Add new entries at the top of their section, and don't rewrite old ones: if a decision changes, add a new entry that says what it supersedes.

## 2026-10-20: Yu's decisions

These four choices reached the orchard agents through the build brief. They are recorded here as choices, not as quotations, because no verbatim wording from Yu is on file. Where a reason is given, it is the reason on record in the research and design notes; Yu may have had others.

### D1. Publisher: Mindicraft Limited

Mindicraft Limited (UK, company 13782045) publishes both apps from its **organization** Apple Developer team. Yu confirmed the Membership page on 2026-10-20: entity **Mindicraft Limited**, Team ID **`ZXUWDK4J3C`** (recorded in `orchard.json`; a Team ID is public, not a secret).

Reasons on record:
- TaxSorted had already been placed under Mindicraft on 2026-07-07: Mindicraft is its liability shield, HMRC Developer Hub organisation and data controller.
- App Review 5.1.1(ix) expects financial services to be submitted by the entity that provides them.
- One team for both apps means one membership and one set of agreements.

Consequences:
- The App Store seller name will be "Mindicraft Limited". An organization's legal name is used, and trade names are not accepted.
- Mythseal's PR #13 assumed Cambridge TCG Limited: its privacy draft names Cambridge TCG (company 15680297, ICO ZB838338). Those values change to Mindicraft on the first-flight branch.
- Whoever owns Mythseal's IP needs to license or assign it to Mindicraft (guideline 5.2.1). This is still open; see below.
- A team API key, if one is ever created, reaches every app on the Mindicraft team.

### D2. Hybrid build route

- Release builds run in the cloud: **Xcode Cloud** is primary, with Apple's cloud-managed signing and no key needed.
- **GitHub Actions** (mythseal's `mobile.yml`) is the backup.
- Local Xcode on a developer Mac is for the simulator loop only.

This supersedes the 2026-10-12 note "build in the cloud, not on this Mac" in mythseal PR #13. The cloud still does every release build, but a local Xcode is now expected for the simulator, and Xcode Cloud replaces GitHub Actions as the primary route.

Reasons on record:
- Xcode Cloud signs without any key on a runner.
- Its 25 included compute hours a month do not depend on the GitHub Actions budget, which stopped mythseal's CI on 2026-10-13 (independence inferred).
- Its first workflow has to be created in the Xcode app anyway.
- Local archive and upload are left out so that signing identities don't accumulate on laptops.

### D3. A new public repo: orchard

orchard lives in `~/orchard` and will become `cambridgetcg/orchard`. It is public, and it never holds secrets.

Reason on record: Yu's 2026-10-19 stance is to develop in public, keep secrets and personal material private, and start a new repo for a new move rather than flip an existing one. The GitHub repo has not been created or pushed yet.

### D4. Mythseal goes first

Mythseal is the first app, on a **new branch** (`ios/first-flight` in the mythseal repo).
- The branch brings PR #13 in **with a merge commit** and fixes it there.
- alpha's `mobile/cloud-pipeline` branch is never pushed to or modified.

Reasons on record:
- PR #13 already holds most of the native work.
- Merge commits preserve the release fence (`git merge-base --is-ancestor 7a7d03e HEAD`) that squash or rebase would break.
- Leaving alpha's branch untouched keeps another hand's work intact.

## Working defaults (set by agents, not decided by Yu)

These are in `orchard.json` and the app manifests because something had to be written down. Change any of them freely, and log the change here.

| Default | Value | Why it was picked |
|---|---|---|
| Xcode | 27.1 (27A9275) on Xcode Cloud; 26.6 in the GitHub Actions backup | 27.1 is the current release, and 27.2 is at RC, so every workflow pins an explicit version rather than "latest". The backup can't use 27.1: the `macos-26` runner image has only 26.0.1–26.6, and 27.x is only on the `xcode-27` preview label (default 27.0; whether it has 27.1 is unverified). Both routes make valid uploads until the iOS 27 SDK becomes mandatory "starting April 2027"; the backup has to move to Xcode 27 before then. Until it does, the routes build with different SDKs (DESIGN §2). |
| Capacitor | 8.5.3 | Current stable; PR #13 has 8.5.2. |
| Minimum iOS | 16.0 | Web Locks need 15.4; Capacitor 9 needs 16; Xcode 27 debugs devices on iOS 17+ only (TestFlight installs still work on 16). |
| Node in CI | 24 on Xcode Cloud; 22 in the GitHub Actions backup | Capacitor 9 needs 24; Capacitor 8 needs 22+. The post-clone script installs `node@24`; mythseal's `mobile.yml` sets up 22. Bumping `mobile.yml` to 24 is a one-line change in the app repo if the split ever matters. |
| Build numbers across the two routes | `MOBILE_BUILD_OFFSET` = 100000 (a repository variable in the app repo), set before the backup's first upload | Xcode Cloud counts from 1 and the backup's `run_number` does too, so without it their first builds collide for the same marketing version. 100000 keeps the ranges apart. Android's `versionCode` uses the same offset and may only rise, so the offset is never lowered (DESIGN §2). |
| Mythseal device family | iPhone only, portrait | Open landscape and vertical-fit faults (RELEASE-NEXT §12 items 17 and 18); no iPad screenshots or iPad layout review needed. |
| Mythseal bundle ID | `com.mythseal.game` | Already in mythseal main's `capacitor.config.json` and PR #13. |
| TaxSorted bundle ID (proposed) | `io.taxsorted.local` | Matches the desktop app's appId. |
| Mythseal territories | exclude CHN, VNM | China needs an NPPA game approval number, and Vietnam a game licence. |

## Earlier decisions that still bind

- **2026-07-07 (Yu, in the taxsorted.io spec):**
  - Mindicraft Limited is TaxSorted's liability shield, Developer Hub organisation and data controller, deliberately not Cambridge TCG (G2).
  - TaxSorted stays free, with no paid tier (G3).
- **2026-10-12 (mythseal PR #13 spec, approved by the owner):**
  - Route A (GitHub Actions + fastlane on macos-26) is now the backup route under D2.
  - The statement that both store accounts are registered to Cambridge TCG Limited is superseded by D1.
- **Standing (mythseal release rule):** merge commits only. The fence commit 7a7d03e must be an ancestor of every release build. The repo still allows squash and rebase, so this rests on discipline.

## Open: Yu's call

These are trimmed from the 2026-10-20 completeness critique to the items D1–D4 left open. The per-app pages give more detail.

**Account and keys**
1. ~~Confirm on the Membership page that the team is Mindicraft Limited, and record the Team ID~~ — done 2026-10-20 (`ZXUWDK4J3C`).
2. Accept the current agreements (DPLA updated 2026-10-13).
3. DSA trader status: which business phone and email to publish on EU product pages, or whether to leave the EU out for now.
4. Backup route: whether to request API access and create a team key at all. If yes, choose the role (Admin is the reported requirement for cloud signing through `xcodebuild`), and decide whether `mobile-stores` gets a required reviewer. Record the answer below when made.
5. Mindicraft's company filings: confirm they are current at Companies House, now that Mindicraft is the seller.

**Spend**

6. Xcode Cloud beyond the 25 included hours, if ever needed.
7. The GitHub Actions budget (its state is unreadable without the `user` token scope), and whether agents may have that scope.

**Mythseal** (details in [apps/mythseal.md](apps/mythseal.md))

8. Who owns Mythseal's IP, and the licence or assignment to Mindicraft.
9. Store name ("Mythseal" or "萬象契 Mythseal"); availability is not checked.
10. Marketing version (package.json says 0.5.1; the content is v0.6.0-era).
11. Privacy page wording under Mindicraft, a privacy contact, Mindicraft's ICO registration, and when `/privacy.html` gets deployed (it returns 404 today).
12. Age-rating answers, territories, and the review notes (drafts on the app page).
13. Confirm iPhone-only portrait, and the native scope (offline guest plus save export and import) for the first flight.
14. A licence for the public mythseal repo, and trademark clearance for the name.

**TaxSorted** (details in [apps/taxsorted.md](apps/taxsorted.md))

15. Who holds the copyright of record; whether to add an AGPL §7 App Store permission; and a CONTRIBUTING/DCO that keeps it.
16. iOS v1 scope: the offline "TaxSorted Local for iOS" (recommended) or an online client.
17. Filing direction for 2027–28 (prepare for it, VAT first, or rest filing).
18. Whether the civic corpus ships in the app.
19. Third-party images.
20. Minimum iOS for TaxSorted.
21. Where the iOS shell lives (an `ios/` folder in taxsorted.io, or elsewhere), and which hand builds it.
22. Developer ID signing and notarisation for TaxSorted Local on macOS.

**Scope and authority**

23. Android: in or out.
24. Which agents, if any, may push upload tags. Today any session with the shared `gh` token could push a `mobile-v*` tag.
25. Which Macs, besides this one, may act as build hosts, if any.
26. Retire, or commit and register, `~/Desktop/kingdom-mobile` and `~/Desktop/kingdom-android`, whose useful parts now live in orchard.
27. A licence for orchard itself, and its registration in the KINGDOM-OS roster.

## Records to add when they happen

- The App Store Connect API key, if created: key name, role, reason, date, and where it is stored. Never the key itself.
- The first Xcode Cloud workflow: its start conditions, Xcode version and post-actions, and which branches and tags the Start Build pop-up actually offered (RUNBOOK step 5 marks that unverified).
- `MOBILE_BUILD_OFFSET`, when it is first set, and any change to it (it only ever goes up).
