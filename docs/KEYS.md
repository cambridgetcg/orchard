# Keys and secrets

This is the human version of [DESIGN.md §5](../DESIGN.md#5-keys-and-secrets). The short form is this: the primary route needs no key at all, and if a key is ever made, it lives in the login Keychain or a GitHub environment and nowhere else.

## Xcode Cloud needs none

Xcode Cloud signs with Apple's cloud-managed certificates: Apple holds the signing identity and signs inside its own build environment. No `.p8`, `.p12` or provisioning profile is downloaded, stored, or passed to a runner. That is the main reason it is the primary route.

## When a key exists at all

An App Store Connect **team API key** is needed only for:
- the GitHub Actions backup route (mythseal's `mobile.yml`), and
- scripting App Store Connect from a terminal.

Create one only when that is actually wanted. Some facts make it a high-stakes object ([FACTS.md](FACTS.md#signing-and-keys)):

- **It reaches every app on the team.** A team key's app access can't be limited, so a leak touches Mythseal, TaxSorted and anything else under Mindicraft Limited.
- **Its role is fixed at creation.** Cloud signing through `xcodebuild` is *reported* to need the Admin role; Apple doesn't document a lower role that works. Admin can also manage users.
- **The `.p8` downloads once.** Apple keeps no copy, and a revoked key can't be reinstated.
- **Only the Account Holder or an Admin can create one**, and only after the Account Holder has requested API access.

When one is created, record its name, role, reason and date in [DECISIONS.md](DECISIONS.md). Never record the key itself.

## How orchard stores it

The commands are specified in DESIGN.md §3; the steps are in [RUNBOOK step 8](RUNBOOK.md).

1. Yu downloads `AuthKey_<KEYID>.p8`.
2. `orchard key import AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer-id <ISSUER> [--require-approval]` puts it in the login Keychain under the service `orchard.asc.p8`, with the key ID as the account. Each key ID gets its own item.
   - The command reaches `/usr/bin/security` over stdin, never in argv.
   - It verifies the stored bytes against the file by SHA-256, without printing either.
   - It refuses if an item for that key ID already exists, and if the file is named for a different key ID. Apple key IDs are unique, so either one almost always means a mistyped `--key-id`, and overwriting would destroy bytes Apple can't send again. `--replace` deletes the existing item and stores the file in its place; use it only when you mean exactly that.
   - The key ID and issuer ID are not secret. They go in `~/.config/orchard/asc.json` (mode 0600), outside the repo.
3. Yu deletes the downloaded file. orchard reminds you, and deliberately doesn't delete it itself.
4. `orchard key check` reports whether the item and config exist, and whether the item's size looks like a `.p8`. It reads the value inside its own process to measure it, and never prints it.
5. Only for the backup route: `orchard key gh-secret <app> --yes` pipes `ASC_KEY_P8_B64`, `ASC_KEY_ID` and `ASC_ISSUER_ID` into the app repo's `mobile-stores` environment through stdin. It refuses without `--yes`, because this sends a secret off the machine. Mythseal's workflow also needs the **variable** `APPLE_TEAM_ID` (`ZXUWDK4J3C`, not secret) and, before its first upload, `MOBILE_BUILD_OFFSET`; [RUNBOOK step 8](RUNBOOK.md) sets both.

When a tool needs the key as a file, orchard writes it to a fresh `mktemp -d` directory (mode 0700) as `AuthKey_<id>.p8` (mode 0600), passes the path, and deletes the directory when the work returns or throws, when the process exits, and on Ctrl-C (SIGINT), SIGTERM or SIGHUP, re-raising the signal afterwards. SIGKILL and crashes can't be cleaned up after; macOS purges the per-user `$TMPDIR` eventually.

## What the Keychain does and doesn't protect

The Keychain keeps the key out of repos, argv, logs, chat and other users' accounts. It does **not** keep it from code that runs as Yu.

By default the item trusts `/usr/bin/security`, the tool that created it, so `security find-generic-password -s orchard.asc.p8 -w` returns the key with no prompt to **any process running as Yu**: an npm `postinstall` in any repo, a build step that `orchard sim` runs (`npm ci`, the web build), any agent shell. Credential-stealing npm packages do exactly this kind of read. The service name is in this public repo, so nobody has to guess it.

`--require-approval` creates the item with an empty trusted-application list (`security add-generic-password … -T ""`; `man security`: "You can remove this default access by explicitly specifying an empty app pathname"). Every read then raises a Keychain dialog Yu has to answer:

- The import's own read-back, `orchard key check` and `orchard key gh-secret` each ask. Answer only a dialog you expect, from a command you just started. `key check` can no longer run unattended, so an agent can't use it.
- Click **Allow**, never **Always Allow**. Always Allow adds `/usr/bin/security` back to the item's list, and every later read is silent again.
- `orchard doctor` only asks whether the item exists, which reads attributes, not the secret. That is expected to need no dialog; it has not been observed.
- Not verified on this Mac, deliberately: a real `-T ""` item would put a dialog on Yu's screen in the middle of a test. orchard's tests check only the command line it builds. The first real import shows whether the option took: if its read-back raises no dialog, it didn't.
- To switch an existing item over, import again with `--replace --require-approval` (a delete and a fresh add). Updating an item in place most likely keeps its old access list (inferred, not tested).
- Neither mode covers the key while a tool is using it: the materialized temp file and the downloaded `AuthKey_*.p8` are plain files that any process running as Yu can read.

Whether to pay a dialog per read for that protection is Yu's call. The key's reach (every app on the Mindicraft team, and with the Admin role, its users) argues for it. Agents follow the rule below either way; the Keychain doesn't enforce it.

## What not to do, and why

- **Don't store it with `security add-generic-password … -w` at an interactive prompt.** The prompt goes through getpass(3), which keeps 128 characters and silently drops the rest; a base64 `.p8` is about 340. The item would look fine and fail later. This is inferred from the man page and SDK header, not tested.
- **Don't pass it as `-w <value>`, or in any other argv or environment variable that a child process doesn't need.** Argv is visible to `ps`, and environments leak into child processes and crash logs.
- **Don't put it in this repo or any app repo, even briefly.** These repos are public, and git history keeps what a later commit removes. `.gitignore` excludes `*.p8`, `*.p12` and `*.mobileprovision` as a backstop, not as the plan.
- **Don't echo it, log it, or paste it into a chat or a PR.** Agents don't read secret values: they check that the item exists (`orchard doctor`), and run `key check` or `gh-secret` only when Yu asks for that run. This is a rule agents follow; without `--require-approval`, nothing stops a process running as Yu from reading the item.
- **Don't create local Apple Distribution certificates "to be safe".** Once one is present, Xcode signs locally instead of in the cloud, and identities start to scatter across machines.
- **Don't run a self-hosted runner on a Mac with Yu's login Keychain**, especially for a public repo, where fork PRs can trigger jobs.

## Rotation and revocation

Rotate when someone who had access leaves, when a machine that held the key is lost or retired, after any suspected exposure, and otherwise on a schedule Yu picks.

1. Create the new key with the same role, and import it with `orchard key import`. A new key has a new key ID, so it gets **its own** Keychain item, and `~/.config/orchard/asc.json` now points at it. The old item stays where it was; no `--replace` is needed or wanted.
2. If the backup route is in use, run `orchard key gh-secret <app> --yes` again.
3. Prove the new key with one backup-route run or an API call.
4. Revoke the old key in App Store Connect. Revocation is permanent, so revoke only after step 3.
5. Remove the old key's item from the login Keychain. It takes no secret and prints none:

   ```sh
   security delete-generic-password -s orchard.asc.p8 -a <old key ID>
   ```

   A revoked key can't be reinstated, so the leftover is not a live credential; removing it keeps the Keychain honest about which key is in use, and stops `key check` from finding it if `asc.json` is ever lost (without the config it reads whichever item the Keychain returns first).
6. Note the rotation (date and key name) in [DECISIONS.md](DECISIONS.md).

If a key may have leaked, revoke it first and rotate afterwards. Its reach is the whole Mindicraft team.

## Not secret

The Team ID, key ID, issuer ID, bundle IDs and the App Store Connect app ID are identifiers, not credentials. They can appear in this repo, in project files and in logs.
