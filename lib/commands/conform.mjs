// Brings an app's iOS project in line with its manifest. --check (default) prints the plan;
// --write applies it. Every write is verified (plutil -lint), and a second pass must find nothing
// left to do. If a write fails, or the second pass still finds work (a bug in conform), every file
// conform touched is put back as it was, so a failed --write leaves the app repo unchanged.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { appName, parseArgs } from '../args.mjs';
import { loadApp, loadOrchard, tildify, UsageError } from '../config.mjs';
import { inspectNative, isExecutable, lintPlist, PRIVACY_FILE, rel, sameSet, serverUrls, versionCmp } from '../ios-project.mjs';
import { appendToArray, deterministicId, deviceFamilyValue, insertObject, parseDeviceFamily, parsePbxproj, pbxString, setBuildSetting } from '../pbxproj.mjs';
import { compactDiff, lineDiff } from '../report.mjs';
import { describeFailure } from '../run.mjs';
import { privacyTemplate, renderCiPostClone } from '../templates.mjs';

export const help = `orchard conform <app> [--check | --write] [--repo <path>]

Brings the app's iOS project in line with apps/<app>.json:
  Info.plist     ITSAppUsesNonExemptEncryption, UISupportedInterfaceOrientations,
                 UIRequiredDeviceCapabilities (armv7 becomes arm64)
  project.pbxproj  IPHONEOS_DEPLOYMENT_TARGET raised to ios.minIOS (never lowered) in the
                 app target's configurations and the project-level ones, because cap sync
                 writes CapApp-SPM's platform from the first one in the file;
                 TARGETED_DEVICE_FAMILY in the app target's configurations;
                 PrivacyInfo.xcprivacy added to the app target (file reference, build file,
                 group child, Resources phase) with ids derived from a hash, so reruns match
  CapApp-SPM/Package.swift  platforms: [.iOS(.vNN)] raised to match (cap sync would write
                 the same once the project level is raised)
  PrivacyInfo.xcprivacy  created from templates/ios/ when the app target ships none. A
                 manifest the target already ships, wherever it lives, is the app's own:
                 conform never adds a second one and never removes anything from it. It
                 adds a required-reason category only when one of the app's plugins needs
                 it and the manifest lacks it (lib/ios-project.mjs PLUGIN_PRIVACY), with
                 the reason code the plugin's README suggests; the app owns the final answer.
  ci_scripts/ci_post_clone.sh  rendered from templates/xcode-cloud/, mode 0755

--check (default) prints a diff-style plan and changes nothing. --write applies it with
PlistBuddy for plists and verified text edits for project.pbxproj (plutil -lint after
every write). If anything fails, or a second pass still finds work, every file conform
touched is restored, so a failed --write leaves the app repo as it was.

Refuses (exit 3) when capacitor config sets server.url (the app must ship its bundle,
not load a live site) or when the project is in Xcode 27.2's JSON .xcproj format, which
cap sync cannot read (ionic-team/capacitor#8607). conform never converts formats. A
capacitor.config.ts or .js (which Capacitor loads before any .json) cannot be read
without running it, so it is a manual item.

Things the app repo decides (capacitor appId, PRODUCT_BUNDLE_IDENTIFIER) are reported as
manual items, not changed.

Exit: 0 conforms, 1 changes pending or manual items left (or a write failed),
      2 usage error, 3 refused.
Rung: native-project only. It says nothing about the simulator or signing.
`;

const PB = '/usr/libexec/PlistBuddy';

function fmt(v) {
  if (v === undefined) return '(missing)';
  if (Array.isArray(v)) return `(${v.join(', ')})`;
  return String(v);
}

function arrayCmds(key, values, exists) {
  const cmds = [];
  if (exists) cmds.push(`Delete :${key}`);
  cmds.push(`Add :${key} array`);
  values.forEach((v, i) => cmds.push(`Add :${key}:${i} string ${v}`));
  return cmds;
}

/** Works out what conform would do. Pure apart from reading files. */
export function planConform(state, manifest, orchard, root) {
  const plan = { refusals: [], manual: [], plist: [], pbx: [], privacyPieces: [], files: [] };
  const { paths } = state;
  for (const s of serverUrls(state.cap)) {
    plan.refusals.push(`${rel(paths, s.file)} sets server.url (${s.url}). An App Store build must ship its web bundle (webDir), not load a live site: remove server.url from the app's capacitor config first.`);
  }
  if (state.format.format === 'json-xcproj') {
    plan.refusals.push(`the project uses Xcode 27.2's JSON .xcproj format (${state.format.detail}). Capacitor 8.5.x cap sync breaks on it silently (ionic-team/capacitor#8607); revert to project.pbxproj in the app repo.`);
  }
  if (state.format.format === 'missing') plan.refusals.push(`no iOS project: ${state.format.detail}. Add one in the app repo first (npx cap add ios).`);
  if (plan.refusals.length) return plan;
  if (state.errors.length) {
    plan.refusals.push(...state.errors.map((e) => `cannot read the project: ${e}`));
    return plan;
  }

  // capacitor config: reported, not edited (the app repo owns it).
  const cap = state.cap;
  if (cap.shadowed) {
    plan.manual.push(`${cap.shadowed} is ignored: Capacitor loads ${cap.otherFormat} first, and orchard cannot read appId or server.url from it without running it. Keep one config file, and check appId, webDir and server.url in ${cap.otherFormat} by hand`);
  } else if (cap.error) plan.manual.push(`capacitor.config.json does not parse: ${cap.error}`);
  else if (!cap.config) {
    plan.manual.push(cap.otherFormat
      ? `${cap.otherFormat} is not JSON, so orchard cannot read appId or server.url; check them by hand or switch to capacitor.config.json`
      : `no capacitor.config.json at the repo root${cap.unloaded ? ` (${cap.unloaded} is not a name Capacitor loads)` : ''}`);
  } else if (cap.config.appId !== manifest.bundleId) {
    plan.manual.push(`capacitor.config.json appId is ${cap.config.appId ?? '(missing)'}, manifest bundleId is ${manifest.bundleId}`);
  }

  // Info.plist
  const pl = state.plist;
  const enc = pl.ITSAppUsesNonExemptEncryption;
  const wantEnc = manifest.ios.usesNonExemptEncryption;
  if (enc !== wantEnc) {
    plan.plist.push({
      key: 'ITSAppUsesNonExemptEncryption', from: enc, to: wantEnc,
      cmds: [...(enc !== undefined ? ['Delete :ITSAppUsesNonExemptEncryption'] : []), `Add :ITSAppUsesNonExemptEncryption bool ${wantEnc}`],
    });
  }
  const wantOr = manifest.ios.orientations;
  const or = pl.UISupportedInterfaceOrientations;
  if (!Array.isArray(or) || !sameSet(or, wantOr)) {
    plan.plist.push({ key: 'UISupportedInterfaceOrientations', from: or, to: wantOr, cmds: arrayCmds('UISupportedInterfaceOrientations', wantOr, or !== undefined) });
  }
  const caps = pl.UIRequiredDeviceCapabilities;
  if (Array.isArray(caps) && caps.includes('armv7')) {
    const to = [...new Set(caps.map((c) => (c === 'armv7' ? 'arm64' : c)))];
    plan.plist.push({ key: 'UIRequiredDeviceCapabilities', from: caps, to, cmds: arrayCmds('UIRequiredDeviceCapabilities', to, true) });
  } else if (caps && !Array.isArray(caps) && typeof caps === 'object' && caps.armv7) {
    plan.manual.push('UIRequiredDeviceCapabilities is a dictionary that requires armv7; replace armv7 with arm64 by hand');
  }

  // pbxproj build settings, app target configurations only.
  const famWant = deviceFamilyValue(manifest.ios.deviceFamily);
  for (const [name, st] of Object.entries(state.settings)) {
    const dt = st.deploymentTarget.value;
    if (dt === undefined || versionCmp(dt, manifest.ios.minIOS) < 0) {
      plan.pbx.push({ config: name, configId: st.id, key: 'IPHONEOS_DEPLOYMENT_TARGET', from: dt, to: manifest.ios.minIOS, level: st.deploymentTarget.level });
    }
    const fam = parseDeviceFamily(st.deviceFamily.value);
    if (!fam || fam.join(',') !== famWant) {
      plan.pbx.push({ config: name, configId: st.id, key: 'TARGETED_DEVICE_FAMILY', from: st.deviceFamily.value, to: famWant, level: st.deviceFamily.level });
    }
    if (manifest.bundleId && st.bundleId.value !== manifest.bundleId) {
      plan.manual.push(`PRODUCT_BUNDLE_IDENTIFIER (${name}) is ${st.bundleId.value ?? '(missing)'}, manifest bundleId is ${manifest.bundleId}`);
    }
  }
  // Project-level deployment targets too: cap sync reads the first IPHONEOS_DEPLOYMENT_TARGET in
  // the file (a project-level one in the Capacitor template) for CapApp-SPM's platform, so a low
  // project level keeps generating `.iOS(.v15)` whatever the app target says.
  for (const pc of state.projectDeployment ?? []) {
    if (pc.value !== undefined && versionCmp(pc.value, manifest.ios.minIOS) < 0) {
      plan.pbx.push({ config: `project ${pc.name}`, configId: pc.id, key: 'IPHONEOS_DEPLOYMENT_TARGET', from: pc.value, to: manifest.ios.minIOS, level: 'project-config' });
    }
  }
  // What cap sync will write into CapApp-SPM once the first target in the file is at least minIOS.
  const spm = state.spm;
  const major = (v) => Number(String(v).split('.')[0]);
  const spmWant = Math.max(major(manifest.ios.minIOS), state.firstDeploymentTarget ? major(state.firstDeploymentTarget) || 0 : 0);
  if (spm?.exists) {
    if (spm.major === null) {
      plan.manual.push(`${rel(paths, spm.file)} has ${spm.matches} \`.iOS(.vNN)\` platform entries, not one; it should read \`platforms: [.iOS(.v${spmWant})]\` (cap sync rewrites it from the first IPHONEOS_DEPLOYMENT_TARGET)`);
    } else if (spm.major < spmWant) {
      const content = spm.text.replace(/\.iOS\(\.v\d+(?:_\d+)*\)/, `.iOS(.v${spmWant})`);
      plan.files.push({ kind: 'spm', path: spm.file, content, mode: statSync(spm.file).mode & 0o777, before: spm.text, from: spm.major, to: spmWant });
    }
  }

  // Privacy manifest: the file, then its four references in project.pbxproj. A manifest the app
  // target already ships (wherever it lives) is the app's own; conform only finishes wiring it.
  const pv = state.privacy;
  if (pv.duplicates.length) {
    plan.manual.push(`the app target copies ${pv.duplicates.length} files named ${PRIVACY_FILE} (${pv.duplicates.join(', ')}); Xcode stops with "Multiple commands produce …/${PRIVACY_FILE}". Keep one in the app target's Copy Bundle Resources`);
  } else {
    if (!pv.fileExists) {
      if (pv.filePath) plan.files.push({ kind: 'privacy', path: pv.filePath, content: privacyTemplate(root), mode: 0o644 });
      else plan.manual.push(`the app target's ${PRIVACY_FILE} reference does not resolve to a file in the source tree; check it in Xcode`);
    }
    if (!pv.referenced) {
      const taken = (id) => Boolean(state.pbx.objects[id]);
      const fileRefId = pv.fileRefId ?? deterministicId(`orchard:${state.target.id}:${PRIVACY_FILE}:PBXFileReference`, taken);
      const buildFileId = pv.buildFileId ?? deterministicId(`orchard:${state.target.id}:${PRIVACY_FILE}:PBXBuildFile`, (id) => taken(id) || id === fileRefId);
      const pieces = [];
      if (!pv.fileRefId) {
        if (pv.newRefPath === null) plan.manual.push(`could not work out a path for ${PRIVACY_FILE} relative to the group that holds Info.plist; add it to the app target in Xcode`);
        else pieces.push({ piece: 'fileRef', id: fileRefId, path: pv.newRefPath });
      }
      if (!pv.inGroup) {
        if (!pv.groupId) plan.manual.push(`could not find the group that holds Info.plist; add ${PRIVACY_FILE} to the app target in Xcode`);
        else pieces.push({ piece: 'group', id: fileRefId, groupId: pv.groupId });
      }
      if (!pv.buildFileId) pieces.push({ piece: 'buildFile', id: buildFileId, fileRefId });
      if (!pv.inResources) {
        if (!pv.resourcesPhaseId) plan.manual.push(`the app target has no Resources build phase; add ${PRIVACY_FILE} to it in Xcode`);
        else pieces.push({ piece: 'resources', id: buildFileId, phaseId: pv.resourcesPhaseId });
      }
      // A reference with no file behind it would break the build, so wire all of it or none.
      if (!pv.fileRefId && pv.newRefPath === null) pieces.length = 0;
      plan.privacyPieces.push(...pieces);
    }
    // Required-reason categories the app's plugins need: added if missing, never removed.
    const api = state.privacyApis;
    if (api?.error) plan.manual.push(`${PRIVACY_FILE} could not be read to check its required-reason APIs: ${api.error}`);
    else if (api && !api.isArray) plan.manual.push(`${PRIVACY_FILE}: NSPrivacyAccessedAPITypes is not an array; fix it by hand`);
    else if (api?.missing.length && pv.filePath) {
      const cmds = api.hasKey ? [] : ['Add :NSPrivacyAccessedAPITypes array'];
      api.missing.forEach((n, k) => {
        const i = api.count + k;
        cmds.push(
          `Add :NSPrivacyAccessedAPITypes:${i} dict`,
          `Add :NSPrivacyAccessedAPITypes:${i}:NSPrivacyAccessedAPIType string ${n.category}`,
          `Add :NSPrivacyAccessedAPITypes:${i}:NSPrivacyAccessedAPITypeReasons array`,
          `Add :NSPrivacyAccessedAPITypes:${i}:NSPrivacyAccessedAPITypeReasons:0 string ${n.reason}`,
        );
      });
      plan.privacyApis = { path: pv.filePath, adds: api.missing, cmds };
    }
    for (const n of api?.noReason ?? []) {
      plan.manual.push(`${PRIVACY_FILE} declares ${n.category} with no reason; add the reason the app relies on (${n.plugin}'s README suggests ${n.reason})`);
    }
  }

  // ci_post_clone.sh
  const script = renderCiPostClone(manifest, orchard, root);
  const sp = paths.ciPostClone;
  if (!existsSync(sp)) plan.files.push({ kind: 'ci', path: sp, content: script, mode: 0o755 });
  else {
    const cur = readFileSync(sp, 'utf8');
    if (cur !== script) plan.files.push({ kind: 'ci', path: sp, content: script, mode: 0o755, before: cur });
    else if (!isExecutable(sp)) plan.files.push({ kind: 'chmod', path: sp, mode: 0o755 });
  }
  return plan;
}

export function changeCount(plan) {
  return plan.plist.length + plan.pbx.length + plan.privacyPieces.length + plan.files.length + (plan.privacyApis?.adds.length ?? 0);
}

export function renderPlan(plan, state, { manifest, repo, home, mode }) {
  const out = [];
  out.push(`orchard conform ${manifest.name} --${mode}   (repo ${tildify(repo, home)})`);
  out.push('rung: native-project. Conforming proves only that rung; the simulator and signing are separate rungs.');
  out.push('');
  if (plan.refusals.length) {
    out.push('REFUSED');
    for (const r of plan.refusals) out.push(`  x ${r}`);
    return out.join('\n') + '\n';
  }
  const { paths } = state;
  if (plan.plist.length) {
    out.push(rel(paths, state.infoPlistPath));
    for (const c of plan.plist) {
      if (c.from !== undefined) out.push(`  - ${c.key} = ${fmt(c.from)}`);
      out.push(`  + ${c.key} = ${fmt(c.to)}`);
    }
  }
  if (plan.pbx.length || plan.privacyPieces.length) {
    out.push(`${rel(paths, paths.pbxproj)}   (target ${state.target.name})`);
    const groups = new Map();
    for (const c of plan.pbx) {
      const k = `${c.key}\u0000${c.from}\u0000${c.to}`;
      if (!groups.has(k)) groups.set(k, { ...c, configs: [] });
      groups.get(k).configs.push(c.config + (c.level === 'project' ? ' (was inherited from project level)' : ''));
    }
    if (plan.pbx.some((c) => c.level === 'project-config')) {
      out.push('  (project-level targets are raised too: cap sync takes CapApp-SPM\'s platform from the first one in the file)');
    }
    for (const g of groups.values()) {
      const where = `[${g.configs.join(', ')}]`;
      if (g.from !== undefined) out.push(`  - ${g.key} = ${pbxString(g.from)};   ${where}`);
      out.push(`  + ${g.key} = ${pbxString(g.to)};   ${where}`);
    }
    for (const p of plan.privacyPieces) {
      if (p.piece === 'fileRef') out.push(`  + PBXFileReference ${p.id} /* ${PRIVACY_FILE} */ path = ${p.path}`);
      if (p.piece === 'group') out.push(`  + group ${p.groupId}: child ${p.id} /* ${PRIVACY_FILE} */`);
      if (p.piece === 'buildFile') out.push(`  + PBXBuildFile ${p.id} /* ${PRIVACY_FILE} in Resources */`);
      if (p.piece === 'resources') out.push(`  + Resources phase ${p.phaseId}: ${p.id} /* ${PRIVACY_FILE} in Resources */`);
    }
  }
  for (const f of plan.files) {
    out.push(rel(paths, f.path));
    if (f.kind === 'privacy') out.push(`  + new file from templates/ios/${PRIVACY_FILE} (no tracking, no collected data, no required-reason APIs of its own; the wording is the app's to own)`);
    else if (f.kind === 'spm') {
      out.push(`  - platforms: [.iOS(.v${f.from})]`);
      out.push(`  + platforms: [.iOS(.v${f.to})]   (what the next cap sync writes, from the first deployment target in project.pbxproj)`);
    } else if (f.kind === 'chmod') out.push('  ~ mode becomes 0755 (Xcode Cloud runs only executable scripts with their shebang)');
    else if (f.before === undefined) out.push(`  + new file, mode 0755, ${f.content.trimEnd().split('\n').length} lines (\`orchard template ci-post-clone ${manifest.name}\` prints it)`);
    else {
      out.push('  ~ drifted from the rendered template:');
      for (const l of compactDiff(lineDiff(f.before, f.content))) out.push(`    ${l}`);
    }
  }
  if (plan.privacyApis) {
    const listed = plan.files.some((f) => f.path === plan.privacyApis.path);
    if (!listed) out.push(rel(paths, plan.privacyApis.path));
    for (const n of plan.privacyApis.adds) {
      out.push(`  + NSPrivacyAccessedAPITypes: ${n.category}, reason ${n.reason}   (${n.plugin} needs it; the reason is its README's suggestion, the app confirms it)`);
    }
  }
  if (plan.manual.length) {
    out.push('');
    out.push('manual (the app repo decides these; conform does not change them):');
    for (const m of plan.manual) out.push(`  ! ${m}`);
  }
  out.push('');
  const n = changeCount(plan);
  if (mode === 'check') {
    out.push(n ? `${n} change(s) planned. Run with --write to apply.` : 'No changes needed: the native project conforms to the manifest.');
  }
  return out.join('\n') + '\n';
}

function plistBuddy(file, cmds, run) {
  const args = cmds.flatMap((c) => ['-c', c]);
  return run(PB, [...args, file], { timeoutMs: 15_000 });
}

/** Applies a plan. Throws (after restoring the file it was writing) if a verification fails. */
export function applyPlan(plan, state, { run }) {
  const done = [];
  if (plan.plist.length) {
    const file = state.infoPlistPath;
    const original = readFileSync(file);
    const res = plistBuddy(file, plan.plist.flatMap((c) => c.cmds), run);
    const lint = lintPlist(file, run);
    if (res.code !== 0 || !lint.ok) {
      writeFileSync(file, original);
      throw new Error(`Info.plist edit failed (${res.code !== 0 ? describeFailure(res) : lint.detail}); original restored`);
    }
    done.push(`${rel(state.paths, file)}: ${plan.plist.map((c) => c.key).join(', ')}`);
  }
  if (plan.pbx.length || plan.privacyPieces.length) {
    const file = state.paths.pbxproj;
    const original = readFileSync(file, 'utf8');
    let text = original;
    for (const c of plan.pbx) {
      text = setBuildSetting(text, c.configId, c.key, pbxString(c.to));
    }
    for (const p of plan.privacyPieces) {
      if (p.piece === 'fileRef') {
        text = insertObject(text, 'PBXFileReference', p.id, `/* ${PRIVACY_FILE} */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = ${pbxString(p.path)}; sourceTree = "<group>"; };`);
      }
    }
    for (const p of plan.privacyPieces) {
      if (p.piece === 'group') text = appendToArray(text, p.groupId, 'children', `${p.id} /* ${PRIVACY_FILE} */`);
      if (p.piece === 'buildFile') {
        text = insertObject(text, 'PBXBuildFile', p.id, `/* ${PRIVACY_FILE} in Resources */ = {isa = PBXBuildFile; fileRef = ${p.fileRefId} /* ${PRIVACY_FILE} */; };`);
      }
    }
    for (const p of plan.privacyPieces) {
      if (p.piece === 'resources') text = appendToArray(text, p.phaseId, 'files', `${p.id} /* ${PRIVACY_FILE} in Resources */`);
    }
    writeFileSync(file, text);
    const lint = lintPlist(file, run);
    let parsed = false;
    try {
      parsePbxproj(text);
      parsed = true;
    } catch {
      /* reported below */
    }
    if (!lint.ok || !parsed) {
      writeFileSync(file, original);
      throw new Error(`project.pbxproj failed verification after the edit (${lint.ok ? 'orchard parser' : lint.detail}); original restored`);
    }
    done.push(`${rel(state.paths, file)}: ${plan.pbx.length} build setting(s), ${plan.privacyPieces.length} privacy reference piece(s); plutil -lint OK`);
  }
  for (const f of plan.files) {
    if (f.kind === 'chmod') chmodSync(f.path, f.mode);
    else {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content, { mode: f.mode });
      chmodSync(f.path, f.mode);
    }
    if (f.kind === 'privacy') {
      const lint = lintPlist(f.path, run);
      if (!lint.ok) throw new Error(`${PRIVACY_FILE} does not lint: ${lint.detail}`);
    }
    done.push(`${rel(state.paths, f.path)}: ${f.kind === 'chmod' ? 'mode 0755' : f.kind === 'privacy' ? 'created' : `written, mode 0${f.mode.toString(8)}`}`);
  }
  if (plan.privacyApis) {
    // After the files: a new manifest has to exist before entries go into it.
    const file = plan.privacyApis.path;
    const res = plistBuddy(file, plan.privacyApis.cmds, run);
    const lint = lintPlist(file, run);
    if (res.code !== 0 || !lint.ok) throw new Error(`${PRIVACY_FILE} edit failed (${res.code !== 0 ? describeFailure(res) : lint.detail})`);
    done.push(`${rel(state.paths, file)}: added ${plan.privacyApis.adds.map((n) => `${n.category} (${n.reason})`).join(', ')}`);
  }
  return done;
}

/** The bytes and mode of every file a write may touch, so a failed --write can put them all back. */
export function snapshotFiles(files) {
  const saved = [...new Set(files.filter(Boolean))].map((path) => {
    const existed = existsSync(path);
    return { path, existed, bytes: existed ? readFileSync(path) : null, mode: existed ? statSync(path).mode & 0o7777 : null, dirExisted: existsSync(dirname(path)) };
  });
  return {
    restore() {
      const put = [];
      for (const s of saved) {
        if (s.existed) {
          writeFileSync(s.path, s.bytes);
          chmodSync(s.path, s.mode);
        } else rmSync(s.path, { force: true });
        put.push(s.path);
      }
      for (const s of saved) if (!s.dirExisted) rmSync(dirname(s.path), { recursive: true, force: true });
      return put;
    },
  };
}

export function conform(argv, ctx) {
  const p = parseArgs(argv, { app: 'string', repo: 'string', check: 'bool', write: 'bool' });
  if (p.flags.help) return ctx.out(help), 0;
  if (p.flags.check && p.flags.write) throw new UsageError('pass --check or --write, not both');
  const mode = p.flags.write ? 'write' : 'check';
  const name = appName(p);
  const { manifest, repo } = loadApp(name, { root: ctx.root, repoOverride: p.flags.repo, home: ctx.home, cwd: ctx.cwd });
  const orchard = loadOrchard(ctx.root);
  if (!repo) {
    ctx.err(`${name}: no checkout (localPath is null). Pass --repo <path>.\n`);
    return 1;
  }
  if (!existsSync(repo)) {
    ctx.err(`${name}: ${tildify(repo, ctx.home)} does not exist. Pass --repo <path> or create the checkout first.\n`);
    return 1;
  }
  if (!manifest.bundleId) {
    ctx.err(`${name}: the manifest has no bundleId yet (status ${manifest.status}); conform needs one.\n`);
    return 3;
  }
  const state = inspectNative(repo, manifest, { run: ctx.run });
  const plan = planConform(state, manifest, orchard, ctx.root);
  ctx.out(renderPlan(plan, state, { manifest, repo, home: ctx.home, mode }));
  if (plan.refusals.length) return 3;
  if (mode === 'check') return changeCount(plan) || plan.manual.length ? 1 : 0;

  if (!changeCount(plan)) {
    ctx.out('Nothing to write.\n');
    return plan.manual.length ? 1 : 0;
  }
  const snap = snapshotFiles([state.infoPlistPath, state.paths.pbxproj, ...plan.files.map((f) => f.path), plan.privacyApis?.path]);
  const restored = () => `Every file conform touched was put back as it was (${snap.restore().map((f) => rel(state.paths, f)).join(', ')}), so the app repo is unchanged.`;
  let done;
  try {
    done = applyPlan(plan, state, { run: ctx.run });
  } catch (e) {
    ctx.err(`write failed: ${e.message}. ${restored()}\n`);
    return 1;
  }
  ctx.out('Wrote:\n' + done.map((d) => `  ${d}\n`).join(''));
  // Second pass: an idempotent write leaves nothing to do. If it finds work, the write is wrong
  // in a way the checks above did not catch, so nothing of it stays on disk.
  const after = planConform(inspectNative(repo, manifest, { run: ctx.run }), manifest, orchard, ctx.root);
  const left = changeCount(after);
  if (left) {
    ctx.err(`after writing, ${left} change(s) still show as pending; this is a bug in orchard conform. ${restored()}\n`);
    return 1;
  }
  ctx.out(`Verified: a second pass finds nothing to change.${after.manual.length ? ` ${after.manual.length} manual item(s) remain.` : ''}\n`);
  ctx.out('Review with git diff in the app repo and commit there; conform does not commit.\n');
  return after.manual.length ? 1 : 0;
}
