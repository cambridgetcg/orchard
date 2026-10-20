// Read-only checks grouped by rung. Each check is READY, BLOCKED or UNKNOWN with the reason and
// the next step; a check that could not run is UNKNOWN, never READY.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appName, parseArgs } from '../args.mjs';
import { backupWorkflow, expandHome, loadApp, loadOrchard, tildify } from '../config.mjs';
import {
  gitTracked, inspectNative, isExecutable, isGitRepo, lintPlist, rel, sameSet, serverUrls, versionCmp,
} from '../ios-project.mjs';
import { itemExists } from '../keychain.mjs';
import { deviceFamilyValue, parseDeviceFamily } from '../pbxproj.mjs';
import { BLOCKED, check, exitCodeFor, READY, renderJson, renderText, UNKNOWN } from '../report.mjs';
import { describeFailure } from '../run.mjs';
import { renderCiPostClone } from '../templates.mjs';
import { activeDeveloperDir, findXcode, INSTALL_XCODE_NEXT, listSimulators, pickDevice, xcodeState } from '../xcode.mjs';

export const help = `orchard doctor [app] [--repo <path>] [--json] [--online]

Read-only checks, grouped by rung, each READY, BLOCKED or UNKNOWN with a reason and a next
step. UNKNOWN means not checked or not checkable from here; it is never a pass.

Without an app: this Mac's toolchain and the team settings.
With an app (checked in its localPath, or --repo): manifest, app web, native project,
Xcode Cloud readiness, store readiness and the GitHub Actions backup route.

Doctor runs the app's release preflight commands (read-only by contract) and git queries in
the app repo. It does not run the web build or tests, sign anything, or print secrets.
--online also fetches the privacy URL (generic User-Agent) and reads the backup route's
GitHub environment with read-only \`gh api\` calls. Without --online nothing leaves the Mac.

Exit: 0 nothing BLOCKED, 1 something BLOCKED, 2 usage error.
`;

const CONFORM = (app) => `orchard conform ${app} --write, review the diff, and commit it in the app repo`;

/** What an Xcode Cloud build reads from the app repo besides the web sources. Names that don't exist are harmless to git status. */
export const NATIVE_INPUTS = [
  'ios', 'capacitor.config.json', 'capacitor.config.ts', 'capacitor.config.js', 'package.json',
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
];

/**
 * The Xcode version a workflow pins, read from its text with comments removed. Only explicit
 * numbers count: `latest-stable`, a bare `setup-xcode` and a commented-out line pin nothing.
 * Returns { versions: exact pins, partial: ranges such as 16.x or ^26 }.
 */
export function xcodePins(yaml) {
  const text = stripYamlComments(yaml);
  const versions = new Set();
  const partial = new Set();
  const take = (v) => (/^\d+(\.\d+)*$/.test(v) ? versions.add(v) : partial.add(v));
  for (const m of text.matchAll(/DEVELOPER_DIR\s*[:=]\s*["']?\/Applications\/Xcode[_-]?(\d[\d.]*)\.app/gi)) take(m[1]);
  for (const m of text.matchAll(/xcode-select\s+(?:-s|--switch)\s+["']?\/Applications\/Xcode[_-]?(\d[\d.]*)\.app/gi)) take(m[1]);
  for (const m of text.matchAll(/xcode-version\s*:\s*["']?([\^~]?\d[^\s"'#]*)/gi)) take(m[1]);
  return { versions: [...versions], partial: [...partial] };
}

/** YAML with whole-line and trailing comments removed (a # inside quotes stays). */
export function stripYamlComments(yaml) {
  return String(yaml).split('\n').map((line) => {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

function toolchainChecks(ctx, orchard) {
  const out = [];
  const want = orchard.toolchain.xcode;
  const xc = findXcode({ env: ctx.env, applicationsDir: ctx.applicationsDir, want });
  if (!xc.selected) {
    const active = activeDeveloperDir(ctx.run);
    const clt = active && active.includes('CommandLineTools');
    out.push(check('toolchain', 'simulator', 'toolchain.xcode', BLOCKED,
      `No Xcode app in ${ctx.applicationsDir}${ctx.env.DEVELOPER_DIR ? ` and DEVELOPER_DIR=${ctx.env.DEVELOPER_DIR} is not an Xcode` : ''}. Active developer directory: ${active ?? 'unknown'}${clt ? ' (Command Line Tools only; xcodebuild and simctl need Xcode)' : ''}. orchard.json pins Xcode ${want} (${orchard.toolchain.xcodeBuild ?? 'build not pinned'}).`,
      INSTALL_XCODE_NEXT));
    for (const [id, what] of [['toolchain.xcode-license', 'licence'], ['toolchain.xcode-first-launch', 'first-launch components'], ['toolchain.ios-simulator', 'iOS Simulator SDK and runtime']]) {
      out.push(check('toolchain', 'simulator', id, UNKNOWN, `Xcode ${what}: not checked, needs Xcode.`, 'see toolchain.xcode'));
    }
  } else {
    const x = xc.selected;
    const st = xcodeState(x, ctx.run);
    const pin = x.version === want ? `matches the pinned ${want}` : `orchard.json pins ${want}; this is ${x.version ?? 'an unknown version'}`;
    out.push(check('toolchain', 'simulator', 'toolchain.xcode', st.version.ok ? READY : UNKNOWN,
      `${x.app} (${x.version ?? '?'} ${x.build ?? ''}) chosen as ${xc.reason}, used through DEVELOPER_DIR=${x.developerDir}; ${pin}. xcodebuild -version: ${st.version.text}.`,
      st.version.ok ? null : `run DEVELOPER_DIR=${x.developerDir} xcodebuild -version and read the error`));
    out.push(check('toolchain', 'simulator', 'toolchain.xcode-license',
      st.license.ok === true ? READY : st.license.ok === false ? BLOCKED : UNKNOWN,
      `Licence: ${st.license.text}.`, 'Yu runs sudo xcodebuild -license accept (needs the admin password)'));
    out.push(check('toolchain', 'simulator', 'toolchain.xcode-first-launch',
      st.firstLaunch.ok === true ? READY : st.firstLaunch.ok === false ? BLOCKED : UNKNOWN,
      `First-launch components: ${st.firstLaunch.text}.`, 'Yu runs sudo xcodebuild -runFirstLaunch'));
    const sdkOk = st.sdks.ok && st.sdks.list.some((s) => s.platform === 'iphonesimulator');
    const sims = listSimulators(x, ctx.run);
    const dev = sims.ok ? pickDevice(sims, null) : null;
    const ok = sdkOk && dev;
    out.push(check('toolchain', 'simulator', 'toolchain.ios-simulator', ok ? READY : (st.sdks.ok === null || !sims.ok) ? UNKNOWN : BLOCKED,
      ok ? `iOS Simulator SDK present; ${sims.runtimes.length} iOS runtime(s); default device ${dev.name} (${dev.runtime}).`
        : `iOS Simulator: ${!sdkOk ? 'no iphonesimulator SDK' : 'no iPhone simulator device'}${sims.ok ? '' : ` (${sims.text})`}.`,
      `DEVELOPER_DIR=${x.developerDir} xcodebuild -downloadPlatform iOS (or Xcode Settings → Components)`));
  }
  const major = Number(process.versions.node.split('.')[0]);
  out.push(check('toolchain', 'web', 'toolchain.node', major >= 22 ? READY : BLOCKED,
    `Node ${process.versions.node} here; orchard needs 22+, Capacitor 8 needs 22+. Xcode Cloud installs node@${orchard.toolchain.node} (orchard.json)${String(major) === String(orchard.toolchain.node) ? '' : ', so a difference seen only locally may be the Node version'}.`,
    'install Node 22 or later'));
  const plistTools = existsSync('/usr/bin/plutil') && existsSync('/usr/libexec/PlistBuddy');
  out.push(check('toolchain', 'native-project', 'toolchain.plist-tools', plistTools ? READY : BLOCKED,
    plistTools ? 'plutil and PlistBuddy present (conform uses them).' : 'plutil or /usr/libexec/PlistBuddy missing.',
    'install the Xcode Command Line Tools (xcode-select --install)'));
  return out;
}

function teamChecks(orchard) {
  const t = orchard.team;
  if (t.teamId) return [check('team', 'signed-archive', 'team.id', READY, `${t.entity} (${t.accountType}), Team ID ${t.teamId}.`)];
  return [check('team', 'signed-archive', 'team.id', BLOCKED,
    `orchard.json team.teamId is null. Publisher: ${t.entity} (company ${t.companyNumber}, ${t.accountType} team). Signing, Xcode Cloud and App Store Connect all hang off the Team ID.`,
    'Yu reads the Team ID from developer.apple.com → Account → Membership details (Mindicraft Limited team) and records it in orchard.json team.teamId')];
}

function gitDescribe(repo, run) {
  const b = run('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 15_000 });
  const h = run('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { timeoutMs: 15_000 });
  return `branch ${b.code === 0 ? b.stdout.trim() : '?'} at ${h.code === 0 ? h.stdout.trim() : '?'}`;
}

function webChecks(ctx, m, repo) {
  const out = [];
  const git = isGitRepo(repo, ctx.run);
  out.push(check('web', 'web', 'web.repo', git ? READY : UNKNOWN,
    git ? `${tildify(repo, ctx.home)}: git work tree, ${gitDescribe(repo, ctx.run)}.` : `${tildify(repo, ctx.home)} is not a git work tree.`,
    'point localPath (or --repo) at a git checkout of the app'));
  const w = m.web ?? {};
  const missing = ['install', 'build', 'dir'].filter((k) => !w[k]);
  out.push(check('web', 'web', 'web.commands', missing.length ? BLOCKED : READY,
    missing.length ? `apps/${m.name}.json leaves web.${missing.join(', web.')} unset, so nothing can build the bundle.`
      : `install: ${w.install}; test: ${w.test ?? '(none)'}; build: ${w.build}; bundle dir: ${w.dir}.`,
    `wire the web build in apps/${m.name}.json`));
  if (w.dir) {
    const index = join(repo, w.dir, 'index.html');
    const has = existsSync(index);
    out.push(check('web', 'web', 'web.bundle', has ? READY : UNKNOWN,
      has ? `${w.dir}/index.html exists (built ${statSync(index).mtime.toISOString()}). Doctor does not rebuild, so this shows a build happened, not that it is current.`
        : `${w.dir}/index.html not found: the bundle has not been built in this checkout.`,
      `in the app repo: ${[w.install, w.build].filter(Boolean).join(' && ')}`));
  }
  out.push(check('web', 'web', 'web.tests', UNKNOWN,
    'Doctor does not run the app\'s tests or build (they write files and can take minutes). The web rung is proved by running them.',
    `in the app repo: ${[w.install, w.test, w.build].filter(Boolean).join(' && ') || '(not wired)'}`));
  return out;
}

function nativeChecks(ctx, m, repo, state) {
  const out = [];
  const g = 'native-project';
  const add = (id, status, detail, next) => out.push(check(g, 'native-project', id, status, detail, next));
  const fix = CONFORM(m.name);
  // capacitor config
  const cap = state.cap;
  const urls = serverUrls(cap);
  const lastSync = cap.generated?.config ? ` The last cap sync's output (${rel(state.paths, cap.generated.file)}) has no server.url, but it may be stale and a fresh clone does not have it.` : '';
  if (urls.length) add('native.capacitor-config', BLOCKED, `server.url is set (${urls.map((u) => `${rel(state.paths, u.file)}: ${u.url}`).join('; ')}). The app would load a live site instead of its bundle; Apple's 4.2 risk and Capacitor say not for production.`, 'remove server.url from the app\'s capacitor config');
  else if (cap.shadowed) {
    add('native.capacitor-config', BLOCKED, `${cap.shadowed} is ignored: Capacitor loads ${cap.otherFormat} first (then .js, then .json), so appId, webDir and server.url come from ${cap.otherFormat}, which orchard cannot read without running it.${lastSync}`,
      `keep one Capacitor config in the app repo (remove the stale ${cap.shadowed}, or move the settings into it and delete ${cap.otherFormat})`);
  } else if (cap.error) add('native.capacitor-config', BLOCKED, `capacitor.config.json does not parse: ${cap.error}.`, 'fix capacitor.config.json in the app repo');
  else if (!cap.config) {
    add('native.capacitor-config', cap.otherFormat ? UNKNOWN : BLOCKED,
      cap.otherFormat ? `Capacitor uses ${cap.otherFormat}, which is not JSON; orchard cannot read it without running it.${lastSync}` : `No Capacitor config at the repo root${cap.unloaded ? ` (${cap.unloaded} is not a name Capacitor loads)` : ''}.`,
      cap.otherFormat ? 'check appId, webDir and server.url by hand, or use capacitor.config.json' : 'add capacitor.config.json (appId, appName, webDir)');
  }
  else {
    const probs = [];
    if (cap.config.appId !== m.bundleId) probs.push(`appId ${cap.config.appId ?? '(missing)'} ≠ manifest bundleId ${m.bundleId}`);
    if (m.web?.dir && cap.config.webDir !== m.web.dir) probs.push(`webDir ${cap.config.webDir ?? '(missing)'} ≠ manifest web.dir ${m.web.dir}`);
    add('native.capacitor-config', probs.length ? BLOCKED : READY,
      probs.length ? `capacitor.config.json: ${probs.join('; ')}.` : `capacitor.config.json: appId ${cap.config.appId}, webDir ${cap.config.webDir}, no server.url.`,
      'make the app repo\'s capacitor.config.json match the manifest (or fix the manifest)');
  }
  // project + format
  const fmt = state.format;
  if (fmt.format === 'missing') {
    add('native.project', BLOCKED, `No iOS project: ${fmt.detail}.`, m.name === 'mythseal' ? 'check out the first-flight branch that merges PR #13 (it carries ios/)' : 'npx cap add ios in the app repo');
  } else add('native.project', READY, `${rel(state.paths, state.paths.projectDir)} exists.`);
  if (fmt.format === 'json-xcproj') {
    add('native.format', BLOCKED, `Xcode 27.2 JSON .xcproj format detected (${fmt.detail}). Capacitor 8.5.x cap sync fails on it while exiting 0 (ionic-team/capacitor#8607, fix PR #8608 open as of 2026-10-20).`, 'restore project.pbxproj from git in the app repo and do not convert in the File inspector');
  } else if (fmt.format === 'pbxproj') add('native.format', READY, 'Classic project.pbxproj (the format cap sync reads).');
  if (fmt.format !== 'pbxproj' || state.errors.length) {
    const why = state.errors.length ? state.errors.join('; ') : 'no readable project.pbxproj';
    for (const id of ['native.bundle-id', 'native.deployment-target', 'native.device-family', 'native.encryption', 'native.orientations', 'native.device-capabilities', 'native.privacy-manifest', 'native.privacy-reasons']) {
      add(id, state.errors.length ? BLOCKED : UNKNOWN, `Not checked: ${why}.`, state.errors.length ? 'fix the project in the app repo' : 'see native.project / native.format');
    }
    return out;
  }
  const s = state.settings;
  const names = Object.keys(s);
  const bad = (fn) => names.filter((n) => fn(s[n]));
  const bid = bad((x) => x.bundleId.value !== m.bundleId);
  add('native.bundle-id', bid.length ? BLOCKED : READY,
    bid.length ? `PRODUCT_BUNDLE_IDENTIFIER ${bid.map((n) => `${n}=${s[n].bundleId.value ?? '(missing)'}`).join(', ')}; manifest says ${m.bundleId}.` : `PRODUCT_BUNDLE_IDENTIFIER ${m.bundleId} in ${names.join(', ')}.`,
    'set the bundle identifier in the app repo (it is the app\'s decision; conform does not change it)');
  const dt = bad((x) => x.deploymentTarget.value === undefined || versionCmp(x.deploymentTarget.value, m.ios.minIOS) < 0);
  // cap sync writes CapApp-SPM's platform from the first IPHONEOS_DEPLOYMENT_TARGET in the file,
  // usually a project-level one, so a low project level means a low SPM platform on every sync.
  const projLow = (state.projectDeployment ?? []).filter((c) => c.value !== undefined && versionCmp(c.value, m.ios.minIOS) < 0);
  const spm = state.spm;
  const major = (v) => Number(String(v).split('.')[0]) || 0;
  const spmWant = Math.max(major(m.ios.minIOS), state.firstDeploymentTarget ? major(state.firstDeploymentTarget) : 0);
  const spmLow = spm?.exists && (spm.major === null || spm.major < spmWant);
  add('native.deployment-target', dt.length || projLow.length || spmLow ? BLOCKED : READY,
    `IPHONEOS_DEPLOYMENT_TARGET ${names.map((n) => `${n}=${s[n].deploymentTarget.value ?? '(unset)'}${s[n].deploymentTarget.level === 'project' ? ' (project level)' : ''}`).join(', ')}` +
      `; project level ${(state.projectDeployment ?? []).map((c) => `${c.name}=${c.value ?? '(unset)'}`).join(', ') || '(none)'}` +
      `${spm?.exists ? `; ${rel(state.paths, spm.file)} ${spm.major === null ? `has ${spm.matches} .iOS platform entries` : `.iOS(.v${spm.major})`}` : ''}` +
      `; manifest minIOS ${m.ios.minIOS}.${projLow.length || spmLow ? ' cap sync takes CapApp-SPM\'s platform from the first deployment target in project.pbxproj, so a plugin that needs the higher minimum would fail to resolve.' : ''}`, fix);
  const famWant = deviceFamilyValue(m.ios.deviceFamily);
  const fam = bad((x) => (parseDeviceFamily(x.deviceFamily.value) ?? []).join(',') !== famWant);
  add('native.device-family', fam.length ? BLOCKED : READY,
    `TARGETED_DEVICE_FAMILY ${names.map((n) => `${n}=${s[n].deviceFamily.value ?? '(unset)'}`).join(', ')}; manifest ${famWant} (${m.ios.deviceFamily.map((d) => (d === 1 ? 'iPhone' : 'iPad')).join(' + ')}).`, fix);
  const pl = state.plist ?? {};
  const enc = pl.ITSAppUsesNonExemptEncryption;
  add('native.encryption', enc === m.ios.usesNonExemptEncryption ? READY : BLOCKED,
    enc === undefined ? `Info.plist has no ITSAppUsesNonExemptEncryption, so export compliance must be answered by hand for every build; manifest says ${m.ios.usesNonExemptEncryption}.`
      : `ITSAppUsesNonExemptEncryption = ${enc}; manifest says ${m.ios.usesNonExemptEncryption}.`, fix);
  const or = pl.UISupportedInterfaceOrientations;
  add('native.orientations', Array.isArray(or) && sameSet(or, m.ios.orientations) ? READY : BLOCKED,
    `UISupportedInterfaceOrientations = ${Array.isArray(or) ? or.join(', ') : '(missing)'}; manifest ${m.ios.orientations.join(', ')}.${pl['UISupportedInterfaceOrientations~ipad'] ? ' (The ~ipad key is not compared.)' : ''}`, fix);
  const caps = pl.UIRequiredDeviceCapabilities;
  const armv7 = Array.isArray(caps) ? caps.includes('armv7') : Boolean(caps?.armv7);
  add('native.device-capabilities', armv7 ? BLOCKED : READY,
    `UIRequiredDeviceCapabilities = ${caps === undefined ? '(none)' : JSON.stringify(caps)}${armv7 ? '; armv7 comes from the old template and describes no device the app targets' : ''}.`, fix);
  const pv = state.privacy;
  if (pv.duplicates.length) {
    add('native.privacy-manifest', BLOCKED, `The app target copies ${pv.duplicates.length} files named PrivacyInfo.xcprivacy (${pv.duplicates.join(', ')}). Xcode stops with "Multiple commands produce …/PrivacyInfo.xcprivacy".`,
      'keep one in the App target\'s Copy Bundle Resources (in the app repo); conform will not choose between them');
  } else {
    const shown = pv.filePath ? rel(state.paths, pv.filePath) : (pv.rel ?? 'PrivacyInfo.xcprivacy');
    const lint = pv.fileExists ? lintPlist(pv.filePath, ctx.run) : null;
    const pvOk = pv.fileExists && lint.ok && pv.referenced;
    const parts = [];
    const own = pv.rel !== pv.wantRel ? ' (the app\'s own, not next to Info.plist)' : '';
    parts.push(pv.fileExists ? `${shown}${own} exists${lint.ok ? '' : ' but does not lint'}` : `${shown} missing`);
    parts.push(pv.synced ? 'included through a synchronized folder' : pv.referenced ? 'referenced by the app target (file reference, group, Resources phase)' : `not fully referenced (file reference ${pv.fileRefId ? 'yes' : 'no'}, group ${pv.inGroup ? 'yes' : 'no'}, Resources phase ${pv.inResources ? 'yes' : 'no'})`);
    add('native.privacy-manifest', pvOk ? READY : BLOCKED, `App privacy manifest: ${parts.join('; ')}. What it declares is checked in native.privacy-reasons.`, fix);
  }
  out.push(privacyReasonsCheck(state, fix));
  return out;
}

/**
 * The required-reason APIs the app's plugins need, against what the manifest declares. orchard's
 * template declares none, so it is a minimum, not an answer: App Store Connect rejects an upload
 * whose binary uses a required-reason API the manifest does not declare (ITMS-91053). Only the
 * category is checked; which reason applies is the app's call. Plugins orchard has no entry for
 * are named and make the check UNKNOWN, because an unchecked plugin is not a passing one.
 */
function privacyReasonsCheck(state, fix) {
  const api = state.privacyApis;
  const c = (status, detail, next) => check('native-project', 'native-project', 'native.privacy-reasons', status, detail, next);
  if (!api) return c(UNKNOWN, 'Not checked: the project was not readable.', 'see native.project');
  if (state.privacy.duplicates.length) return c(UNKNOWN, 'Not checked: the app target has more than one privacy manifest (see native.privacy-manifest).', 'see native.privacy-manifest');
  if (!api.packageJson) return c(UNKNOWN, 'Not checked: package.json could not be read, so the app\'s Capacitor plugins are unknown.', 'check package.json in the app repo');
  if (api.error) return c(BLOCKED, `The privacy manifest could not be read: ${api.error}.`, 'fix PrivacyInfo.xcprivacy in the app repo (plutil -lint)');
  if (!api.isArray) return c(BLOCKED, 'NSPrivacyAccessedAPITypes in the privacy manifest is not an array.', 'fix PrivacyInfo.xcprivacy in the app repo');
  const declared = [...api.declared.entries()].map(([k, r]) => `${k.replace('NSPrivacyAccessedAPICategory', '')} (${r.join(', ') || 'no reason'})`);
  const parts = [`Plugins: ${api.plugins.join(', ') || '(none)'}`, `declared: ${declared.join(', ') || '(none)'}`];
  if (api.missing.length) parts.push(`missing: ${api.missing.map((n) => `${n.category} for ${n.plugin} (its README suggests ${n.reason})`).join('; ')}`);
  if (api.noReason.length) parts.push(`declared without a reason: ${api.noReason.map((n) => n.category).join(', ')}`);
  if (api.unchecked.length) parts.push(`not checked (orchard has no entry for ${api.unchecked.join(', ')}; each plugin's README says what it needs)`);
  const detail = `${parts.join('; ')}.${state.privacy.fileExists ? '' : ' The manifest does not exist yet; conform creates it from the template.'}`;
  if (api.missing.length || api.noReason.length) return c(BLOCKED, `${detail} App Store Connect rejects undeclared required-reason API use at upload (ITMS-91053).`, api.missing.length ? fix : 'add the reason the app relies on in PrivacyInfo.xcprivacy (app repo)');
  if (api.unchecked.length) return c(UNKNOWN, detail, `read the README of ${api.unchecked.join(', ')} and declare what it asks for; add the plugin to PLUGIN_PRIVACY in orchard's lib/ios-project.mjs once checked`);
  return c(READY, detail);
}

function xcodeCloudChecks(ctx, m, repo, state, orchard) {
  const out = [];
  const add = (id, status, detail, next) => out.push(check('xcode-cloud', 'signed-archive', id, status, detail, next));
  const paths = state.paths;
  const git = isGitRepo(repo, ctx.run);
  // ci_post_clone.sh
  const sp = paths.ciPostClone;
  const relSp = rel(paths, sp);
  if (!existsSync(sp)) add('xcode-cloud.ci-post-clone', BLOCKED, `${relSp} missing. Xcode Cloud would build without the web bundle.`, CONFORM(m.name));
  else {
    const want = renderCiPostClone(m, orchard, ctx.root);
    const cur = readFileSync(sp, 'utf8');
    const probs = [];
    if (cur !== want) probs.push('content drifted from the rendered template (orchard conform shows the diff)');
    if (!isExecutable(sp)) probs.push('not executable');
    const needsConform = probs.length > 0;
    const tr = git ? gitTracked(repo, sp, ctx.run) : { known: false };
    if (tr.known && !tr.tracked) probs.push('not committed');
    else if (tr.tracked && tr.mode !== '100755') probs.push(`committed with mode ${tr.mode}, not 100755`);
    add('xcode-cloud.ci-post-clone', probs.length ? BLOCKED : (tr.known ? READY : UNKNOWN),
      probs.length ? `${relSp}: ${probs.join('; ')}.` : `${relSp} matches the template, is executable${tr.known ? ' and committed as 100755' : ' (git state unknown)'}.`,
      needsConform ? CONFORM(m.name) : `commit ${relSp} in the app repo (git records the executable bit)`);
  }
  // Package.resolved
  if (!git) add('xcode-cloud.package-resolved', UNKNOWN, 'Not a git work tree, so committed state is unknown.', 'check out the app as a git repo');
  else {
    const states = paths.packageResolved.map((f) => ({ f, exists: existsSync(f), tr: gitTracked(repo, f, ctx.run) }));
    const tracked = states.find((x) => x.tr.tracked);
    const onDisk = states.find((x) => x.exists);
    add('xcode-cloud.package-resolved', tracked ? READY : BLOCKED,
      tracked ? `${rel(paths, tracked.f)} is committed.` : onDisk ? `${rel(paths, onDisk.f)} exists but is not committed. Xcode Cloud does not resolve packages itself.` : `No Package.resolved (expected ${rel(paths, paths.packageResolved[0])}). Xcode Cloud does not resolve packages itself.`,
      'run orchard sim once after Xcode is installed, then commit Package.resolved');
  }
  // shared scheme with the archive action
  const sc = paths.sharedScheme;
  if (!existsSync(sc)) {
    add('xcode-cloud.scheme', UNKNOWN, `No shared scheme at ${rel(paths, sc)}. A scheme that is not shared lives in xcuserdata (git-ignored), so a cloud clone would not see it (inferred; Xcode offers to share it during first workflow setup).`,
      `share the "${m.ios.scheme}" scheme in Xcode (Product → Scheme → Manage Schemes → Shared) and commit it`);
  } else {
    const xml = readFileSync(sc, 'utf8');
    const archive = /buildForArchiving\s*=\s*"YES"/.test(xml);
    const tr = git ? gitTracked(repo, sc, ctx.run) : { known: false };
    add('xcode-cloud.scheme', !archive || (tr.known && !tr.tracked) ? BLOCKED : tr.known ? READY : UNKNOWN,
      `${rel(paths, sc)}: ${archive ? 'builds for archiving' : 'does not build for archiving (Xcode Cloud needs the archive action)'}${tr.known ? (tr.tracked ? ', committed' : ', not committed') : ''}.`,
      'tick Archive for the app target in the shared scheme and commit it');
  }
  // marketing version source (the post-clone script stamps it and insists on X.Y.Z)
  if (m.release?.versionFrom === 'package.json') {
    let v = null;
    try {
      v = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version ?? null;
    } catch { /* reported below */ }
    const hasMv = state.pbxText ? /MARKETING_VERSION = [^;]+;/.test(state.pbxText) : false;
    const ok = v && /^\d+\.\d+\.\d+$/.test(v) && hasMv;
    add('xcode-cloud.marketing-version', ok ? READY : BLOCKED,
      `package.json version ${v ?? '(unreadable)'}${v && !/^\d+\.\d+\.\d+$/.test(v) ? ' (must be X.Y.Z)' : ''}; MARKETING_VERSION ${hasMv ? 'present' : 'not found'} in project.pbxproj. ci_post_clone.sh stamps one into the other.`,
      'give package.json an X.Y.Z version and keep MARKETING_VERSION in the app target');
  }
  // release preflight (the app's own rules, read-only by contract)
  const pre = m.release?.preflight ?? [];
  if (!pre.length) add('xcode-cloud.preflight', READY, 'The manifest lists no release preflight commands.');
  else {
    const results = pre.map((c) => ({ c, r: ctx.run('/bin/sh', ['-c', c], { cwd: repo, timeoutMs: 120_000 }) }));
    const failed = results.filter((x) => x.r.code !== 0);
    add('xcode-cloud.preflight', failed.length ? BLOCKED : READY,
      failed.length ? `Failed in ${tildify(repo, ctx.home)}: ${failed.map((x) => `\`${x.c}\` (${describeFailure(x.r)})`).join('; ')}.` : `Passed: ${pre.map((c) => `\`${c}\``).join(', ')}.`,
      'these are the app repo\'s own release rules; bring the branch in line (for mythseal, merge the commit the fence names)');
  }
  // uncommitted native inputs (the cloud builds what is pushed). The lockfile counts: the post-clone
  // script runs the app's install (`npm ci` for mythseal), which stops when package.json and the
  // committed lockfile disagree, and plugins bring native code into the SPM build. git status also
  // lists an untracked lockfile, which `npm ci` would not see in a cloud clone either.
  if (git) {
    const st = ctx.run('git', ['-C', repo, '--no-optional-locks', 'status', '--porcelain', '--', ...NATIVE_INPUTS], { timeoutMs: 15_000 });
    const lines = st.code === 0 ? st.stdout.split('\n').filter(Boolean) : null;
    const what = 'ios/, the Capacitor config, package.json or the lockfile';
    add('xcode-cloud.committed', lines === null ? UNKNOWN : lines.length ? BLOCKED : READY,
      lines === null ? `git status failed: ${describeFailure(st)}.` : lines.length ? `${lines.length} uncommitted change(s) to ${what} (e.g. ${lines.slice(0, 3).map((l) => l.trim()).join('; ')}). Xcode Cloud builds the pushed commit. Push state is not checked.` : `No uncommitted changes to ${what} (push state not checked).`,
      'commit the native inputs in the app repo, the lockfile with package.json (pushing is Yu\'s call)');
  }
  // development team in the project
  const teams = state.settings ? [...new Set(Object.values(state.settings).map((x) => x.team.value).filter(Boolean))] : [];
  const tid = orchard.team.teamId;
  if (!state.settings) add('xcode-cloud.team', UNKNOWN, 'Not checked: project not readable.', 'see native.project');
  else if (!teams.length) add('xcode-cloud.team', UNKNOWN, `The app target sets no DEVELOPMENT_TEAM. Xcode writes it when someone picks the team in Signing & Capabilities${tid ? '' : '; orchard.json has no Team ID to compare with yet'}. Whether Xcode Cloud needs it committed is not verified.`, 'when Yu first opens the project in Xcode, pick the Mindicraft team under Signing & Capabilities and commit the change');
  else if (!tid) add('xcode-cloud.team', UNKNOWN, `DEVELOPMENT_TEAM ${teams.join(', ')}; orchard.json has no Team ID to compare with.`, 'record the Team ID in orchard.json');
  else add('xcode-cloud.team', teams.length === 1 && teams[0] === tid ? READY : BLOCKED, `DEVELOPMENT_TEAM ${teams.join(', ')}; orchard.json Team ID ${tid}.`, 'set the Mindicraft team in Signing & Capabilities and commit it');
  add('xcode-cloud.workflow', UNKNOWN,
    'orchard cannot see Xcode Cloud workflows, the bundle ID registration or the App Store Connect app record. The first workflow is created in the Xcode app by someone signed in to the Mindicraft team.',
    'docs/RUNBOOK.md (human steps)');
  return out;
}

async function storeChecks(ctx, m, online) {
  const url = m.store?.privacyUrl;
  if (!url) return [check('store', 'review', 'store.privacy-url', BLOCKED, `apps/${m.name}.json has no store.privacyUrl. App Review and external TestFlight need a reachable privacy policy.`, 'publish a privacy policy that names the publisher and record its URL in the manifest')];
  if (!online) return [check('store', 'review', 'store.privacy-url', UNKNOWN, `${url} is set; not fetched (doctor stays offline unless --online).`, `orchard doctor ${m.name} --online`)];
  try {
    const res = await ctx.fetch(url, { method: 'GET', redirect: 'follow', headers: { 'user-agent': 'orchard-doctor/0.1' }, signal: AbortSignal.timeout(15_000) });
    const moved = res.url && res.url !== url ? ` (after redirect to ${res.url})` : '';
    return [check('store', 'review', 'store.privacy-url', res.status === 200 ? READY : BLOCKED, `${url} returned HTTP ${res.status}${moved}.`, 'publish the privacy policy at that URL (in the app\'s web deploy)')];
  } catch (e) {
    return [check('store', 'review', 'store.privacy-url', UNKNOWN, `${url} could not be fetched: ${e.name === 'TimeoutError' ? 'timed out' : e.message}.`, 'retry with --online when the network is up')];
  }
}

function backupChecks(ctx, m, repo, orchard, online) {
  const out = [];
  const add = (id, status, detail, next) => out.push(check('backup', 'signed-archive', id, status, detail, next));
  const wf = backupWorkflow(m);
  if (!wf) {
    add('backup.route', UNKNOWN, `apps/${m.name}.json names no backup route (release.backup is ${m.release?.backup ?? 'null'}). Only Xcode Cloud is available.`, 'add release.backup if a GitHub Actions route is wanted');
    return out;
  }
  let text = null;
  if (!repo || !existsSync(repo)) add('backup.workflow', UNKNOWN, `No checkout, so ${wf} was not read.`, 'see web.repo');
  else if (!existsSync(join(repo, wf))) add('backup.workflow', BLOCKED, `${wf} not found in ${tildify(repo, ctx.home)}.`, 'bring the workflow into the app repo (for mythseal it comes with PR #13)');
  else {
    text = readFileSync(join(repo, wf), 'utf8');
    add('backup.workflow', READY, `${wf} present. A workflow_dispatch run only works once the file is on the default branch.`);
    // A pin exists so the runner's moving default can't change the SDK between two runs of one
    // commit (DESIGN §2). Only an explicit number is a pin, and it must meet Apple's upload floor.
    const pins = xcodePins(text);
    const floor = orchard.toolchain.xcodeFloorForUpload;
    const cloud = orchard.toolchain.xcode;
    const pinNext = 'select the Xcode version in the workflow (DEVELOPER_DIR=/Applications/Xcode_<version>.app/Contents/Developer on the build steps)';
    if (!pins.versions.length && !pins.partial.length) {
      add('backup.xcode-pin', BLOCKED, 'The workflow does not select an explicit Xcode version (`latest-stable`, a bare setup-xcode or a commented-out line pins nothing), so it builds with whatever the runner image defaults to (macos-26 defaults to Xcode 26.6 as of 2026-10-20).', pinNext);
    } else if (pins.partial.length || pins.versions.length > 1) {
      add('backup.xcode-pin', UNKNOWN, pins.versions.length + pins.partial.length > 1
        ? `The workflow names several Xcode versions (${[...pins.versions, ...pins.partial].join(', ')}); orchard cannot tell which one the iOS job uses without parsing the workflow.`
        : `The workflow names Xcode ${pins.partial[0]}, a range rather than one version, so the build can still move when the runner image changes.`, pinNext);
    } else {
      const v = pins.versions[0];
      const below = floor && versionCmp(v, floor) < 0;
      const split = cloud && versionCmp(v, cloud) !== 0 ? ` Xcode Cloud builds with ${cloud} (orchard.json), so the two routes use different SDKs; both are valid uploads while ${v} meets the upload floor (${floor}), which Apple raises to the iOS 27 SDK in April 2027 (docs/FACTS.md).` : '';
      add('backup.xcode-pin', below ? BLOCKED : READY,
        below ? `The workflow pins Xcode ${v}, below the upload floor ${floor} in orchard.json; App Store Connect would refuse the upload.` : `The workflow pins Xcode ${v}.${split}`,
        `pin Xcode ${floor} or later in the workflow`);
    }
  }
  const env = text?.match(/^\s*environment:\s*([A-Za-z0-9_.-]+)\s*$/m)?.[1] ?? 'mobile-stores';
  if (!online) add('backup.environment', UNKNOWN, `GitHub environment "${env}" on ${m.repo} not checked (doctor stays offline unless --online).`, `orchard doctor ${m.name} --online`);
  else {
    const r = ctx.run('gh', ['api', `repos/${m.repo}/environments/${env}`, '--jq', '.name'], { timeoutMs: 30_000 });
    if (r.code !== 0) {
      const missing = /404|Not Found/i.test(r.stderr + r.stdout);
      add('backup.environment', missing ? BLOCKED : UNKNOWN, missing ? `GitHub environment "${env}" does not exist on ${m.repo}.` : `gh api failed: ${describeFailure(r)}.`, missing ? 'Yu decides whether to create it (and whether it needs a required reviewer)' : 'check gh auth status');
    } else {
      const s = ctx.run('gh', ['api', `repos/${m.repo}/environments/${env}/secrets`, '--jq', '[.secrets[].name]'], { timeoutMs: 30_000 });
      let names = null;
      try { names = s.code === 0 ? JSON.parse(s.stdout) : null; } catch { names = null; }
      const need = ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8_B64'];
      const lack = names ? need.filter((n) => !names.includes(n)) : need;
      let status = names === null ? UNKNOWN : lack.length ? BLOCKED : READY;
      let detail = names === null ? `Environment "${env}" exists; its secret names could not be listed (${describeFailure(s)}).` : `Environment "${env}" exists; secrets ${lack.length ? `missing: ${lack.join(', ')}` : 'ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8_B64 present (names only)'}.`;
      let next = `orchard key gh-secret ${m.name} --env ${env} --yes (after Yu says so for this route)`;
      // Non-secret variables the workflow reads: the Team ID it cannot run without, and the build
      // number offset that keeps its numbers clear of Xcode Cloud's (DESIGN §2). `vars.X` resolves
      // from the environment first, then the repository.
      const wf = stripYamlComments(text ?? '');
      const listVars = (path) => {
        const v = ctx.run('gh', ['api', path, '--jq', '[.variables[].name]'], { timeoutMs: 30_000 });
        try { return v.code === 0 ? JSON.parse(v.stdout) : null; } catch { return null; }
      };
      const wanted = ['APPLE_TEAM_ID', 'MOBILE_BUILD_OFFSET'].filter((n) => new RegExp(`\\bvars\\.${n}\\b`).test(wf));
      if (wanted.length) {
        const envVars = listVars(`repos/${m.repo}/environments/${env}/variables`);
        const repoVars = listVars(`repos/${m.repo}/actions/variables`);
        const has = (n) => (envVars?.includes(n) || repoVars?.includes(n) ? true : envVars === null || repoVars === null ? null : false);
        if (wanted.includes('APPLE_TEAM_ID')) {
          const t = has('APPLE_TEAM_ID');
          if (t === false) { status = BLOCKED; next = `gh variable set APPLE_TEAM_ID --env ${env} --repo ${m.repo} --body ${orchard.team.teamId ?? '<Team ID>'} (not secret; RUNBOOK step 8)`; }
          else if (t === null && status === READY) status = UNKNOWN;
          detail += ` Variable APPLE_TEAM_ID ${t ? 'set' : t === false ? 'missing (the workflow stops in its secrets check without it)' : 'could not be listed'}.`;
        }
        if (wanted.includes('MOBILE_BUILD_OFFSET')) {
          const o = has('MOBILE_BUILD_OFFSET');
          detail += ` Variable MOBILE_BUILD_OFFSET ${o ? 'set' : o === false ? 'unset, so this route numbers builds from about 1, the same range Xcode Cloud uses; set it before the first backup upload (DESIGN §2)' : 'could not be listed'}.`;
        }
      }
      add('backup.environment', status, detail, next);
    }
  }
  const cfgFile = expandHome(orchard.appStoreConnect.localConfig, ctx.home);
  let cfg = null;
  try { cfg = JSON.parse(readFileSync(cfgFile, 'utf8')); } catch { cfg = null; }
  const service = cfg?.service ?? orchard.appStoreConnect.keychainService;
  const exists = cfg?.keyId ? itemExists({ service, account: cfg.keyId, run: ctx.run }) : itemExists({ service, run: ctx.run });
  add('backup.key', cfg && exists === true ? READY : exists === null ? UNKNOWN : BLOCKED,
    cfg && exists ? `App Store Connect key ${cfg.keyId} is in the login Keychain (service ${service}); ${tildify(cfgFile, ctx.home)} present.`
      : `No App Store Connect team key on this Mac (${cfg ? `config names ${cfg.keyId} but the Keychain item is ${exists === false ? 'missing' : 'unreadable'}` : `${tildify(cfgFile, ctx.home)} absent`}). Only this backup route needs one; Xcode Cloud signs without a key.`,
    'only if Yu wants the backup route: create the team key in App Store Connect (role per docs/KEYS.md), then orchard key import AuthKey_<id>.p8 --key-id <id> --issuer-id <id>');
  return out;
}

export async function collectChecks(ctx, { name, repoOverride, online }) {
  const orchard = loadOrchard(ctx.root);
  const checks = [...toolchainChecks(ctx, orchard), ...teamChecks(orchard)];
  if (!name) return { checks, orchard };
  const { manifest: m, repo } = loadApp(name, { root: ctx.root, repoOverride, home: ctx.home, cwd: ctx.cwd });
  if (m.status === 'blocked' || (m.blockedBy ?? []).length) {
    checks.push(check('manifest', 'web', 'manifest.status', BLOCKED, `apps/${m.name}.json status "${m.status}": ${(m.blockedBy ?? ['(no reason given)']).join(' | ')}`, `see docs/apps/${m.name}.md; these are Yu's decisions`));
  } else checks.push(check('manifest', 'web', 'manifest.status', READY, `apps/${m.name}.json is valid; status "${m.status}", bundle ID ${m.bundleId}.`));
  const hasRepo = repo && existsSync(repo);
  if (!hasRepo) {
    const why = repo ? `${tildify(repo, ctx.home)} does not exist on this Mac` : `apps/${m.name}.json has no localPath`;
    const next = repo ? `clone ${m.repo} there (or pass --repo <path>)` : `set localPath in apps/${m.name}.json or pass --repo <path>`;
    for (const [g, rung] of [['web', 'web'], ['native-project', 'native-project'], ['xcode-cloud', 'signed-archive']]) {
      checks.push(check(g, rung, `${g === 'native-project' ? 'native' : g}.repo`, UNKNOWN, `Not checked: ${why}.`, next));
    }
  } else {
    checks.push(...webChecks(ctx, m, repo));
    if (!m.bundleId) checks.push(check('native-project', 'native-project', 'native.bundle-id', BLOCKED, 'The manifest has no bundleId yet.', `see docs/apps/${m.name}.md`));
    else {
      const state = inspectNative(repo, m, { run: ctx.run });
      checks.push(...nativeChecks(ctx, m, repo, state));
      checks.push(...xcodeCloudChecks(ctx, m, repo, state, orchard));
    }
  }
  checks.push(...(await storeChecks(ctx, m, online)));
  checks.push(...backupChecks(ctx, m, hasRepo ? repo : null, orchard, online));
  return { checks, orchard, manifest: m, repo };
}

export async function doctor(argv, ctx) {
  const p = parseArgs(argv, { app: 'string', repo: 'string', json: 'bool', online: 'bool' });
  if (p.flags.help) return ctx.out(help), 0;
  const name = appName(p, { required: false });
  const { checks, repo } = await collectChecks(ctx, { name, repoOverride: p.flags.repo, online: Boolean(p.flags.online) });
  if (p.flags.json) {
    ctx.out(renderJson(checks, { app: name, repo: repo ?? null, online: Boolean(p.flags.online), generatedAt: ctx.now().toISOString() }));
  } else {
    const title = `orchard doctor${name ? ` ${name}` : ''}${repo ? `   (repo ${tildify(repo, ctx.home)})` : ''}   ${ctx.now().toISOString()}${p.flags.online ? '' : '   offline'}`;
    ctx.out(renderText(checks, { title }));
    if (!name) ctx.out('Pass an app name for the app checks (see `orchard apps`).\n');
  }
  return exitCodeFor(checks);
}

