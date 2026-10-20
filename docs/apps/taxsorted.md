# TaxSorted

| | |
|---|---|
| Manifest | [apps/taxsorted.json](../../apps/taxsorted.json) |
| Repo | `cambridgetcg/taxsorted.io`: public, AGPL-3.0 code, CC BY-SA 4.0 + OGL content |
| Publisher | Mindicraft Limited (decided 2026-07-07 for TaxSorted; confirmed for both apps on 2026-10-20) |
| Proposed bundle ID | `io.taxsorted.local` (matches the desktop app) |
| Status | **BLOCKED** as of 2026-10-20 |
| Highest rung proved | **none**: no iOS project exists |

Work from `cambridgetcg/taxsorted.io` main (`8f0a8cf` or later) in a fresh clone. Two other copies are not sources:

- **`~/Desktop/taxsorted.io`** is stale and unsafe to build from. It sits at `6014064` (2026-09-04), an unpushed commit that is on no remote and is 57 commits behind the real main.
- **`cambridgetcg/taxsorted`** is archived.

taxsorted.io is maintained by other hands (Beta, Fable), so any iOS work goes to them as PRs through Yu.

## Why it is blocked

1. **The copyright holder of record is not settled, and an AGPL §7 App Store permission is the recommended protection.** Both are Yu's call, with legal review; nothing below is a legal conclusion.
   - The code is plain AGPL-3.0, with no additional permissions and no CONTRIBUTING, CLA or DCO.
   - The FSF's position (2010) is that the App Store's Usage Rules add restrictions the GPL family forbids, and Apple's current terms (updated 2026-09-14) still carry those Usage Rules. This is not settled law.
   - A copyright holder can publish its own AGPL code. Signal-iOS is plain AGPLv3, and Signal ships it because it holds the copyright.
   - That only works if every contributor's copyright is held by, or licensed to, the publisher. Commit authors are Yu and Yu's agent identities, but **the copyright holder of record (Yu personally, cambridgetcg, or Mindicraft) is not established**, and AI-authored code adds legal uncertainty.
   - A §7 additional permission (draft below) protects against future outside contributors and lets others redistribute.
2. **No privacy policy names Mindicraft Limited.**
   - The frontend has no privacy or terms route and never names a data controller.
   - Guideline 5.1.1(i) needs a policy link in App Store Connect and inside the app.
   - Guideline 5.1.1(ix) expects a finance app to be submitted by the providing entity: Apple's Finance category lists "tax", and Apple has rejected apps whose seller didn't match the provider. Mindicraft fits, but it has to be named.
3. **The iOS v1 scope is not chosen.** The recommended shape is below.

Further cautions:

- **Third-party images**:
  - One CC BY-SA 2.0 photo (Stephen Richards / Geograph) ships in `frontend/public/media/window-tax`.
  - One National Records of Scotland image is marked licence status "conditional", limited to "20 Crown-copyright digital images per website".
  - Leave both out of the iOS bundle unless their terms are confirmed.
- **Dated content in a frozen binary.**
  - The MTD source admission was renewed only through **2026-11-12**, and the web build already shows review-due stops.
  - A store binary will drift into "review overdue" states unless releases follow the source-review cadence, or the in-app expiry stops stay.
  - Any build made now would pass that date within weeks.
- **CC BY-SA 4.0 content.** The licence forbids technological measures that restrict recipients. Whether App Store FairPlay counts as one for bundled CC BY-SA content is an open legal question.

## Recommended iOS v1: "TaxSorted Local for iOS"

This mirrors the Electron desktop edition, TaxSorted Local (`io.taxsorted.local`): offline, no account, no HMRC or Xero calls, and no remote requests. It is the cheapest way past guidelines 4.2 (repackaged website), 5.1.1(v) (account deletion) and 2.1 (filing isn't live anyway).

How to build it:

- **Reuse the existing staging.** Run `npm run build` (a Next.js 16 static export), then `desktop/scripts/stage.cjs`.
  - stage.cjs refuses unless the professional-opportunity gate is closed.
  - It strips `_worker.js`, `_routes.json`, `_headers` and `_redirects`.
  - Wrap the result with Capacitor and orchard's templates.
- **Add an iOS branch to `isLocalApp()`** (`frontend/src/lib/local-runtime.ts`) that detects `capacitor://localhost`.
  - **Keep the hostname `localhost`.** Don't rename the origin to `taxsorted://app` to match the desktop check: that would probably lose secure-context status, and with it `crypto.subtle` (encrypted backups) and `navigator.locks` (workspace writes). This is inferred and needs a device test.
  - `isLocalApp()` says of itself that it is "not the security boundary".
- **Rebuild the Electron guarantees natively.** On desktop they live in the Electron runtime, not in stage.cjs:
  - **Cancel non-local requests.** Desktop cancels every non-local request. On iOS, use a CSP with `connect-src 'self'`, no `server.url`, an empty `allowNavigation`, and native navigation blocking.
  - **Block the guarded roots.** Desktop returns 403 for `GUARDED_ROOTS` (`/uk/opportunities`, `/uk/regulator-scrutiny`) even in a closed-gate bundle, and stage.cjs does *not* remove those pages. On iOS, strip them from the bundle or block them natively.
  - **Downloads and sharing.** Desktop has a will-download handler. On iOS, use the orchard bridge `saveFile` (Files and the share sheet) for backups, Passport and CSV exports; Blob downloads do nothing in WKWebView.
  - **Deny permission requests**, as desktop does.
- **Add native value that answers 4.2:**
  - a Face ID or passcode lock (LocalAuthentication);
  - Files import for bank CSVs and backup restore;
  - opt-in local notifications for the 7 Aug, 7 Nov, 7 Feb and 7 May deadlines (never required);
  - a "next deadline" widget later, if review pushes back.
- **Protect the records.**
  - All user work is one IndexedDB envelope (`taxsorted-local-workspace-v1`), and iOS may reclaim WKWebView storage.
  - Mirror it to native storage (bridge `durable`), or make backup and restore prominent.
  - Deleting the app deletes the records.
- **Cut the scope.** Leave the civic corpus (`/uk/politics`, `/uk/opportunities`, `/uk/cases` and similar) out, or behind web links. A people directory compiled from public records raises 5.1.1(viii) questions, and a focused app answers 4.2 and the category better.
- **App Store answers:**
  - Category Finance, with Education secondary.
  - UK storefront first.
  - Free, with no IAP, ads or analytics, in line with the project's free-commons principle.
  - App Privacy "Data Not Collected" for the offline edition, after a WKWebView network check.
  - `ITSAppUsesNonExemptEncryption = false` probably holds, because backups use WebCrypto inside WebKit. That exemption is inferred, and the export-compliance call is Yu's.

## Later: an online client

This waits for Yu's 2027–28 filing decision. Each item below is work in a repo other hands maintain:

- **HMRC fraud headers.**
  - A server-mediated iOS client uses `MOBILE_APP_VIA_SERVER`: 18 headers, including an app-generated persistent Device-ID UUID, Local-IPs, and a User-Agent carrying the device model.
  - The API hardcodes `WEB_APP_VIA_SERVER`, and the engine's `ConnectionMethod` type lists `MOBILE_APP_DIRECT` but **not** `MOBILE_APP_VIA_SERVER`.
  - A filing build therefore cannot claim "Data Not Collected": the Device-ID has to be declared.
- **OAuth.** Use `ASWebAuthenticationSession`, which has its own cookie jar.
  - Start HMRC OAuth with a one-time handoff token instead of the session cookie the callback currently requires.
  - HMRC's redirect stays `https://api.taxsorted.io/v1/hmrc/callback`, with the client secret on the server.
  - The server then returns to the app through an https universal link. `ASWebAuthenticationSession`'s https callback needs iOS 17.4, and HMRC doesn't accept custom URL schemes as redirect URIs.
- **CORS and cookies.**
  - The API allows credentialed CORS only from `taxsorted.io` and `www`. A live preflight from `capacitor://localhost` got no allow-origin header.
  - Sessions are host-only `SameSite=Lax` cookies.
  - Either allow the app's origin and move to bearer tokens in the Keychain, or use CapacitorHttp with an origin allowlist.
- **Passkeys.** Native ASAuthorization with an associated domain `webcredentials:taxsorted.io`, served from `/.well-known/apple-app-site-association`. That file returns 404 today and needs a Team ID first.
- **Account deletion.** Build an account-deletion door before accounts ship in the app (5.1.1(v)); none exists today, only passkey removal.
- **For review.** Provide a demo or sandbox account, and update the App Privacy answers.

### HMRC note

- **Income Tax (MTD ITSA):** HMRC's end-to-end guide (updated 15 Sep 2026) says it "is no longer accepting production credential access requests for new 2026–27 quarterly update products". The API also returns 404 for ITSA `/start` outside the sandbox.
- **VAT:** the MTD VAT guide (updated 23 June 2026) shows no such closure. VAT production access is blocked only by TaxSorted's own "not-yet" plus normal HMRC approval. The pages were read; that conclusion is inferred.

## DRAFT: AGPL-3.0 §7 additional permission for App Store distribution

> **Draft for Yu and legal review. This is not legal advice and is not in effect.** It follows the common App Store exception pattern, such as the additional permission Open Whisper Systems added to libsignal-protocol-c in 2016, but the wording is orchard's own. Before it can mean anything, the copyright holder of record has to be established, and every contributor's rights have to be held by, or licensed to, that holder.

```text
Additional permission under GNU AGPL version 3, section 7
(distribution through app stores)

[COPYRIGHT HOLDER OF RECORD — to be confirmed] ("the Licensor") grants the
following additional permission for the software in this repository that is
licensed under the GNU Affero General Public License version 3 ("the Program").

1. You may convey the Program, or a covered work based on it, in object code
   form through Apple's App Store or TestFlight, or through another app
   distribution service whose terms, usage rules or technical protection
   measures place restrictions on recipients (each a "Store"), even where
   those restrictions would otherwise conflict with the Program's licence.

2. This permission applies only if, for each version you convey through a
   Store:
   (a) the Corresponding Source of that exact version is available to anyone,
       at no charge, from a publicly accessible network server, as section
       6(d) describes, for as long as you offer that version through the
       Store;
   (b) the app shows, in a place users can easily reach, a notice that it is
       licensed under the GNU AGPL version 3 with this additional permission,
       together with a link to that Corresponding Source; and
   (c) you impose no restriction on recipients beyond those the Store itself
       imposes.

3. This permission does not relicense the Program, and does not apply to
   material licensed under Creative Commons licences, the Open Government
   Licence or any third-party licence.

4. As section 7 allows, anyone who conveys a copy of the Program may remove
   this additional permission from that copy.
```

A matching CONTRIBUTING line would keep the permission alive for outside contributions (also a draft): *"By contributing, you certify the Developer Certificate of Origin 1.1 and license your contribution under AGPL-3.0, including the App Store additional permission in LICENSE."*

## Related quick win: Developer ID for TaxSorted Local (macOS)

The desktop app is ad-hoc signed, with hardened runtime but `notarize: false` and no Developer ID, and SERVICE-REBUILD lists notarisation as pending. The Mindicraft membership covers Developer ID. Only the Account Holder can create the (non-cloud) Developer ID certificate; see [RUNBOOK](../RUNBOOK.md). The signing and notarisation configuration belongs in the taxsorted.io repo, via its maintainers.

## Open questions for Yu

1. **Copyright:** who is the copyright holder of record for the code and content? Do you want the §7 permission above, plus a CONTRIBUTING/DCO, after legal review?
2. **Privacy:** will Mindicraft Limited be named as controller and provider in a TaxSorted privacy policy and on the site?
3. **iOS v1 scope:** offline "TaxSorted Local for iOS" (recommended), or the online client?
4. **Filing direction for 2027–28:** prepare for it, VAT first, or rest filing for now?
5. **Content:** does the civic corpus ship in the app, and what happens to the two rights-conditional images?
6. **Minimum iOS:** which version? The https OAuth callback needs 17.4, and only matters for the online client.
7. **Who builds it, and where:** an `ios/` folder next to `desktop/` in taxsorted.io, or elsewhere?
8. **macOS:** Developer ID and notarisation for TaxSorted Local: now, or later?
9. **SDSTeam emails:** were the two "cannot collect" emails sent on 2026-07-09? The repo's runbook still lists them as drafts.
