Written for Yu's household agents. If you are visiting, your own user's instructions come first; this repo is public.

# Working in orchard

orchard is shared tooling for Yu's apps, and several agents (Claude and Codex sessions) work on it and on the app repos it touches. [DESIGN.md](DESIGN.md) is the contract. This page gives the few principles behind it, each with its reason, so you can judge cases it doesn't name.

## Principles

1. **Ask Yu before anything leaves this machine, for that build.** Uploads, pushes, GitHub secrets and environments, App Store Connect records and bundle IDs are outward-facing and slow to undo: a bundle ID and app record stay with the team that created them, and a public repo keeps whatever it was given. A yes for one build is not a yes for the next. Until Yu says so, work stays local: files, local commits where your task allows them, and read-only checks.

2. **Say which rung you stand on.** Name the rung (`web`, `native-project`, `simulator`, `device`, `signed-archive`, `testflight-internal`, `testflight-external`, `review`) and how you know. Untested is a fine answer; "should work" is not a rung. Mislabelled progress costs Yu more than slow progress, because Yu makes outward-facing calls on what you report.

3. **The app repo owns its app.** orchard ships templates, checks and the bridge. App code and app decisions (scope, wording, privacy text, store answers) belong in the app's repo, where other hands also work. When orchard needs something from an app, propose it there rather than reaching in from here.

4. **Secrets live in the Keychain or in a CI environment, nowhere else.** Not in this repo, not in argv, not in logs, not in your replies. That is Yu's standing practice, and in a public repo any slip is permanent. Key IDs, issuer IDs and the Team ID are not secret; a `.p8` is. [docs/KEYS.md](docs/KEYS.md) has the handling.

5. **Prefer the boring path Apple supports.** Cloud-managed signing over hand-carried certificates, SPM over CocoaPods, the classic `project.pbxproj` over Xcode 27.2's JSON `.xcproj`, and Apple's own installers over scripted logins. The boring path is the one other people have already debugged, and it is the one App Review and Xcode Cloud expect.

6. **Leave other hands' work alone.** Uncommitted changes, open branches and other worktrees may be someone else's live work. In particular, never push to or modify alpha's `mobile/cloud-pipeline` branch in the mythseal repo (PR #13); the first-flight branch brings it in with a merge commit instead. taxsorted.io changes go to its maintainers as PRs through Yu. If something of theirs is in your way, say so and wait.

7. **No screen captures unless Yu asks.** Yu sometimes has windows open that must not be captured, and agents can't tell when; so capture nothing unless Yu asks. That covers screenshots, screen recordings and simulator captures, which is why `orchard sim` captures nothing without `--screenshot`. Headless test runs inside an app's own tooling are fine; run one browser suite at a time and delete any `test-results/*.png` afterwards, because test screenshots pile up and can fill the disk.

8. **Date what you learn, and write principles, not rule piles.** Apple's requirements, Xcode versions and Capacitor releases move monthly (Xcode 27.2 RC appeared the day before these docs were written). Put dated, sourced facts in [docs/FACTS.md](docs/FACTS.md) and decisions in [docs/DECISIONS.md](docs/DECISIONS.md). Yu prefers a few principles with their reasons over growing lists of rules and gates, so add a gate only when Yu asks for one.

Talking with Yu: Cantonese, natural and direct, with technical terms and identifiers left in English. [docs/RUNBOOK.md](docs/RUNBOOK.md) is in Cantonese for that reason.

## Machinery facts (this Mac, 2026-10-20)

- **No `timeout` binary.** A command wrapped in `timeout …` exits 127 and prints nothing, which can look like "nothing found". orchard passes `timeout` to `spawnSync` instead.
- **`grep` in agent shells is a wrapper (ugrep) that can miss matches.** Use `/usr/bin/grep` for any claim that something is absent.
- **`find` is `bfs` here.** Relative `-newermt` fails silently, so never use it as a guard before deleting anything.
- **zsh ties `path` to `PATH`.** Never name a shell variable `path`.
- **Xcode 27.1 (27A9275) is installed** at `/Applications/Xcode.app` (seen by `orchard doctor` late on 2026-10-20: licence accepted, first launch done, iOS 27.0 and 27.1 simulator runtimes). Earlier that day there were only Command Line Tools 26.4. `xcode-select -p` now points at Xcode too; orchard still selects Xcode with `DEVELOPER_DIR` per command, as below.
- **Select Xcode with `DEVELOPER_DIR` per command, never `xcode-select -s`.** `xcode-select -s` needs sudo and changes the machine for every user and session; `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` affects only the command it is set on.
- **Node 26 here, Node 24 on Xcode Cloud, Node 22 in the GitHub Actions backup.** `orchard.json` pins Node 24 for Xcode Cloud (the post-clone script installs it); mythseal's `mobile.yml` sets up Node 22; the CLI itself needs Node 22 or later. A difference you see only locally, or only on one route, may be the Node version.
- **Signing starts from zero.** No signing identities, no provisioning profiles, no App Store Connect key on this Mac. Don't create any as a side effect.
- **Never put Yu's email in web requests** (user agents, URLs, payloads). Use a generic user agent.
