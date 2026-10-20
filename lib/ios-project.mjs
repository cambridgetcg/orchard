// Reads an app's iOS project: Info.plist, pbxproj build settings, project format, privacy manifest,
// ci_scripts, Package.resolved and capacitor.config.json. Read-only; conform does the writing.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, posix, relative } from 'node:path';
import { describeFailure } from './run.mjs';
import { parseDeviceFamily, parsePbxproj } from './pbxproj.mjs';

export const PRIVACY_FILE = 'PrivacyInfo.xcprivacy';

export function projectPaths(repo, manifest) {
  const projectDir = join(repo, manifest.ios.project);
  const sourceRoot = dirname(projectDir);
  const projectName = basename(projectDir, '.xcodeproj');
  return {
    repo,
    projectDir,
    sourceRoot,
    pbxproj: join(projectDir, 'project.pbxproj'),
    ciPostClone: join(sourceRoot, 'ci_scripts', 'ci_post_clone.sh'),
    // Xcode Cloud reads Package.resolved from the project's embedded workspace, or from a
    // sibling .xcworkspace when the app uses one (CocoaPods-era projects).
    packageResolved: [
      join(projectDir, 'project.xcworkspace', 'xcshareddata', 'swiftpm', 'Package.resolved'),
      join(sourceRoot, `${projectName}.xcworkspace`, 'xcshareddata', 'swiftpm', 'Package.resolved'),
    ],
    workspace: join(sourceRoot, `${projectName}.xcworkspace`),
    sharedScheme: join(projectDir, 'xcshareddata', 'xcschemes', `${manifest.ios.scheme}.xcscheme`),
    capacitorConfig: join(repo, 'capacitor.config.json'),
  };
}

export function rel(paths, p) {
  return relative(paths.repo, p) || '.';
}

/**
 * Which project format is on disk. Capacitor 8.5.x only understands project.pbxproj; Xcode 27.2's
 * opt-in JSON .xcproj makes `cap sync` fail silently (ionic-team/capacitor#8607). The exact on-disk
 * shape of the new format is not something orchard has seen, so this looks for every sign of it.
 */
export function detectFormat(paths) {
  const signs = [];
  for (const dir of [paths.sourceRoot, paths.projectDir]) {
    if (!existsSync(dir)) continue;
    for (const n of readdirSync(dir)) if (n.endsWith('.xcproj')) signs.push(join(dir, n));
  }
  if (signs.length) return { format: 'json-xcproj', detail: `found ${signs.map((s) => rel(paths, s)).join(', ')}` };
  if (!existsSync(paths.projectDir)) return { format: 'missing', detail: `${rel(paths, paths.projectDir)} does not exist` };
  if (!existsSync(paths.pbxproj)) {
    return { format: 'json-xcproj', detail: `${rel(paths, paths.projectDir)} has no project.pbxproj (a conversion to the JSON .xcproj format removes it)` };
  }
  const head = readFileSync(paths.pbxproj, 'utf8').slice(0, 200).trimStart();
  if (head.startsWith('{') && !head.startsWith('{\n\tarchiveVersion')) {
    try {
      JSON.parse(readFileSync(paths.pbxproj, 'utf8'));
      return { format: 'json-xcproj', detail: 'project.pbxproj holds JSON' };
    } catch {
      /* not JSON: fall through to the classic parser */
    }
  }
  return { format: 'pbxproj', detail: rel(paths, paths.pbxproj) };
}

export function readPlist(file, run) {
  const res = run('plutil', ['-convert', 'json', '-o', '-', file], { timeoutMs: 15_000 });
  if (res.code !== 0) throw new Error(`plutil could not read ${file}: ${describeFailure(res)}`);
  return JSON.parse(res.stdout);
}

export function lintPlist(file, run) {
  const res = run('plutil', ['-lint', file], { timeoutMs: 15_000 });
  return { ok: res.code === 0, detail: (res.stdout + res.stderr).trim() };
}

/**
 * The Capacitor config at the repo root (the source) and the copy cap sync generates into the iOS
 * app. Capacitor's CLI loads capacitor.config.ts first, then .js, and reads capacitor.config.json
 * only when neither exists (@capacitor/cli 8.5.3 config.js loadExtConfig), so orchard follows the
 * same order: a JSON file beside a .ts or .js one is `shadowed` and never trusted. orchard cannot
 * evaluate .ts or .js without running it, so those come back as `otherFormat` with no config.
 * capacitor.config.mjs is not a name Capacitor loads at all (`unloaded`).
 */
export function readCapacitorConfig(paths) {
  const out = { file: paths.capacitorConfig, config: null, error: null, otherFormat: null, shadowed: null, unloaded: null, generated: null };
  const code = ['capacitor.config.ts', 'capacitor.config.js'].find((n) => existsSync(join(paths.repo, n)));
  if (code) {
    out.otherFormat = code;
    if (existsSync(paths.capacitorConfig)) out.shadowed = basename(paths.capacitorConfig);
  } else if (existsSync(paths.capacitorConfig)) {
    try {
      out.config = JSON.parse(readFileSync(paths.capacitorConfig, 'utf8'));
    } catch (e) {
      out.error = e.message;
    }
  } else if (existsSync(join(paths.repo, 'capacitor.config.mjs'))) out.unloaded = 'capacitor.config.mjs';
  const gen = join(paths.sourceRoot, 'App', 'capacitor.config.json');
  if (existsSync(gen)) {
    try {
      out.generated = { file: gen, config: JSON.parse(readFileSync(gen, 'utf8')) };
    } catch (e) {
      out.generated = { file: gen, error: e.message };
    }
  }
  return out;
}

/** The server.url values that would make the app load a live site instead of its bundle. */
export function serverUrls(cap) {
  const found = [];
  if (cap.config?.server?.url) found.push({ file: cap.file, url: cap.config.server.url });
  if (cap.generated?.config?.server?.url) found.push({ file: cap.generated.file, url: cap.generated.config.server.url });
  return found;
}

function stripSrcroot(p) {
  return String(p).replace(/^\$\((SRCROOT|PROJECT_DIR)\)\//, '').replace(/^\$\{(SRCROOT|PROJECT_DIR)\}\//, '');
}

/**
 * Everything conform and doctor need to know about the native project, gathered once.
 * Never throws for project-shaped problems: they come back in `errors`.
 */
export function inspectNative(repo, manifest, { run }) {
  const paths = projectPaths(repo, manifest);
  const s = { paths, errors: [], format: detectFormat(paths), cap: readCapacitorConfig(paths) };
  if (s.format.format !== 'pbxproj') return s;
  s.pbxText = readFileSync(paths.pbxproj, 'utf8');
  try {
    s.pbx = parsePbxproj(s.pbxText);
  } catch (e) {
    s.errors.push(e.message);
    return s;
  }
  const target = s.pbx.appTarget(manifest.ios.target ?? manifest.ios.scheme);
  if (!target) {
    s.errors.push(`no application target named "${manifest.ios.scheme}" in project.pbxproj`);
    return s;
  }
  s.target = target;
  s.configs = s.pbx.configs(target);
  s.settings = {};
  for (const c of s.configs) {
    s.settings[c.name] = {
      id: c.id,
      deploymentTarget: s.pbx.effectiveSetting(target, c.name, 'IPHONEOS_DEPLOYMENT_TARGET'),
      deviceFamily: s.pbx.effectiveSetting(target, c.name, 'TARGETED_DEVICE_FAMILY'),
      bundleId: s.pbx.effectiveSetting(target, c.name, 'PRODUCT_BUNDLE_IDENTIFIER'),
      team: s.pbx.effectiveSetting(target, c.name, 'DEVELOPMENT_TEAM'),
      infoPlist: s.pbx.effectiveSetting(target, c.name, 'INFOPLIST_FILE'),
    };
  }
  const release = s.settings.Release ?? Object.values(s.settings)[0];
  const infoRel = release?.infoPlist.value ? posix.normalize(stripSrcroot(release.infoPlist.value)) : null;
  if (!infoRel) {
    s.errors.push('the app target has no INFOPLIST_FILE');
    return s;
  }
  s.infoPlistRel = infoRel;
  s.infoPlistPath = join(paths.sourceRoot, infoRel);
  if (!existsSync(s.infoPlistPath)) s.errors.push(`${rel(paths, s.infoPlistPath)} does not exist`);
  else {
    try {
      s.plist = readPlist(s.infoPlistPath, run);
    } catch (e) {
      s.errors.push(e.message);
    }
  }
  // `cap sync` writes CapApp-SPM/Package.swift's `.iOS(.vNN)` from the FIRST
  // IPHONEOS_DEPLOYMENT_TARGET in the file (@capacitor/cli getMajoriOSVersion), which in the
  // Capacitor template is a project-level configuration, so those count as much as the target's.
  s.projectDeployment = s.pbx.projectConfigs().map((c) => ({ id: c.id, name: c.name, value: c.settings.IPHONEOS_DEPLOYMENT_TARGET }));
  const first = /IPHONEOS_DEPLOYMENT_TARGET = ([^;\n]+);/.exec(s.pbxText);
  s.firstDeploymentTarget = first ? first[1].trim().replace(/^"|"$/g, '') : null;
  s.spm = readSpmPlatform(paths);
  s.privacy = inspectPrivacy(s);
  s.privacyApis = inspectPrivacyApis(s, run);
  return s;
}

/** CapApp-SPM/Package.swift's `platforms: [.iOS(.vNN)]`, which every `cap sync` regenerates. */
export function readSpmPlatform(paths) {
  const file = join(paths.sourceRoot, 'CapApp-SPM', 'Package.swift');
  if (!existsSync(file)) return { file, exists: false };
  const text = readFileSync(file, 'utf8');
  const all = [...text.matchAll(/\.iOS\(\.v(\d+)(?:_\d+)*\)/g)];
  return { file, exists: true, text, major: all.length === 1 ? Number(all[0][1]) : null, matches: all.length };
}

/**
 * The app-level privacy manifest: where it is and whether the app target ships it.
 *
 * An app may already ship its own manifest somewhere other than next to Info.plist. Any file named
 * PrivacyInfo.xcprivacy in the app target's Resources phase counts, and so does one inside a
 * synchronized folder of the target, because a second one in the same target makes Xcode stop with
 * "Multiple commands produce …/PrivacyInfo.xcprivacy". Only the app target's own Resources are
 * searched: a manifest in an extension or a framework belongs to that product, not the app.
 */
export function inspectPrivacy(s) {
  const { pbx, target, paths } = s;
  const appDir = posix.dirname(s.infoPlistRel);
  const wantRel = posix.join(appDir, PRIVACY_FILE);
  const resolved = pbx.resolvedPaths();
  const resources = pbx.phase(target, 'PBXResourcesBuildPhase');
  const isPrivacyRef = (id) => {
    const o = pbx.objects[id];
    return o?.isa === 'PBXFileReference' && posix.basename(resolved.get(id) ?? o.path ?? o.name ?? '') === PRIVACY_FILE;
  };
  // A PBXBuildFile belongs to one build phase, so only a free one (or the app's Resources entry) is reused.
  const phaseOf = new Map();
  for (const [pid, o] of Object.entries(pbx.objects)) if (/BuildPhase$/.test(o.isa ?? '')) for (const f of o.files ?? []) phaseOf.set(f, pid);
  const buildFileFor = (refId) => Object.entries(pbx.objects)
    .find(([id, o]) => o.isa === 'PBXBuildFile' && o.fileRef === refId && (!phaseOf.has(id) || phaseOf.get(id) === resources?.id))?.[0] ?? null;

  // Where a new reference would go: the group that holds Info.plist, with a path relative to it.
  const infoRefId = [...resolved].find(([id, p]) => p === s.infoPlistRel && pbx.objects[id]?.isa === 'PBXFileReference')?.[0] ?? null;
  let group = infoRefId ? pbx.groupContaining(infoRefId) : null;
  if (!group) {
    const gid = [...resolved].find(([id, p]) => p === appDir && pbx.objects[id]?.isa === 'PBXGroup')?.[0];
    group = gid ? { id: gid, ...pbx.objects[gid] } : null;
  }
  const groupPath = group ? resolved.get(group.id) : undefined;
  const newRefPath = groupPath !== undefined ? posix.relative(groupPath, wantRel) : null;

  const located = (relPath, extra) => {
    const filePath = relPath === undefined ? null : join(paths.sourceRoot, relPath);
    const fileRefId = extra.fileRefId ?? null;
    const buildFileId = extra.buildFileId ?? (fileRefId ? buildFileFor(fileRefId) : null);
    const inResources = Boolean(resources && buildFileId && (resources.files ?? []).includes(buildFileId));
    const inGroup = Boolean(fileRefId && pbx.groupContaining(fileRefId));
    return {
      rel: relPath ?? null,
      wantRel,
      filePath,
      fileExists: Boolean(filePath && existsSync(filePath)),
      fileRefId,
      buildFileId,
      resourcesPhaseId: resources?.id ?? null,
      inResources,
      inGroup,
      synced: false,
      referenced: Boolean(fileRefId) && inResources && inGroup,
      groupId: group?.id ?? null,
      newRefPath,
      where: extra.where,
      duplicates: [],
    };
  };

  // 1. The app target already copies one (or, wrongly, several) into the bundle.
  const shipped = (resources?.files ?? [])
    .map((bf) => ({ buildFileId: bf, fileRefId: pbx.objects[bf]?.fileRef }))
    .filter((x) => x.fileRefId && isPrivacyRef(x.fileRefId));
  if (shipped.length > 1) {
    return {
      ...located(resolved.get(shipped[0].fileRefId), { ...shipped[0], where: 'resources' }),
      duplicates: shipped.map((x) => resolved.get(x.fileRefId) ?? pbx.objects[x.fileRefId].path ?? x.fileRefId),
    };
  }
  if (shipped.length === 1) return located(resolved.get(shipped[0].fileRefId), { ...shipped[0], where: 'resources' });

  // 2. Xcode 16 synchronized folders include files on disk without explicit references.
  for (const gid of target.fileSystemSynchronizedGroups ?? []) {
    const g = pbx.objects[gid];
    const dirRel = resolved.get(gid) ?? (g?.path ? posix.normalize(g.path) : null);
    const dir = dirRel === null ? null : join(paths.sourceRoot, dirRel);
    if (!dir || !existsSync(dir)) continue;
    const hit = readdirSync(dir, { recursive: true }).map(String).find((n) => basename(n) === PRIVACY_FILE);
    if (hit) return { ...located(posix.join(dirRel, hit.split('\\').join('/')), { where: 'synced' }), synced: true, referenced: true };
  }

  // 3. A reference that no target copies yet: finish wiring that one rather than minting another.
  const copiedSomewhere = new Set(pbx.ofIsa('PBXNativeTarget')
    .flatMap((t) => (pbx.phase(t, 'PBXResourcesBuildPhase')?.files ?? []))
    .map((bf) => pbx.objects[bf]?.fileRef));
  const orphans = [...resolved.keys()].filter((id) => isPrivacyRef(id) && !copiedSomewhere.has(id));
  if (orphans.length === 1) return located(resolved.get(orphans[0]), { fileRefId: orphans[0], where: 'orphan' });

  // 4. None yet: the default place, next to Info.plist.
  const fileRefId = [...resolved].find(([id, p]) => p === wantRel && pbx.objects[id]?.isa === 'PBXFileReference')?.[0] ?? null;
  return located(wantRel, { fileRefId, where: 'default' });
}

/**
 * Required-reason API categories that Capacitor plugins ask the app to declare, from each plugin's
 * README (checked 2026-10-20). A plugin listed with [] was checked and needs none; a plugin not
 * listed is not checked, and doctor says so. The reason codes are the plugin READMEs' suggestions:
 * conform adds them only when the category is missing, and the app owns the final answer.
 */
export const PLUGIN_PRIVACY = Object.freeze({
  '@capacitor/filesystem': [{ category: 'NSPrivacyAccessedAPICategoryFileTimestamp', reason: 'C617.1' }],
  '@capacitor/preferences': [{ category: 'NSPrivacyAccessedAPICategoryUserDefaults', reason: 'CA92.1' }],
  // Share 8.0.3's iOS source uses no required-reason API (read 2026-10-20).
  '@capacitor/share': [],
  // Haptics 8.0.2's iOS source (UIImpactFeedbackGenerator and friends) uses no required-reason API (read 2026-10-20).
  '@capacitor/haptics': [],
});
const CAPACITOR_CORE = new Set(['@capacitor/core', '@capacitor/cli', '@capacitor/ios', '@capacitor/android']);

/**
 * The Capacitor plugins `cap sync` would link: dependencies and devDependencies whose installed
 * package.json has a `capacitor` field (how @capacitor/cli resolvePlugin decides), or, when a
 * package is not installed, any `@capacitor/*` package other than the core ones.
 */
export function capacitorPlugins(repo) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  } catch {
    return { ok: false, plugins: [] };
  }
  const plugins = [];
  for (const name of new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])) {
    if (CAPACITOR_CORE.has(name)) continue;
    const meta = join(repo, 'node_modules', name, 'package.json');
    if (existsSync(meta)) {
      try {
        if (JSON.parse(readFileSync(meta, 'utf8')).capacitor) plugins.push(name);
      } catch { /* an unreadable package is not a plugin cap sync could use either */ }
    } else if (name.startsWith('@capacitor/')) plugins.push(name);
  }
  return { ok: true, plugins: plugins.sort() };
}

/**
 * What the privacy manifest declares against what the app's plugins need. orchard's template is a
 * minimum (no required-reason APIs): an app that links @capacitor/filesystem has to declare file
 * timestamps itself, and App Store Connect rejects the upload otherwise (ITMS-91053).
 */
export function inspectPrivacyApis(s, run) {
  const { plugins, ok } = capacitorPlugins(s.paths.repo);
  const need = [];
  const unchecked = [];
  for (const p of plugins) {
    const n = PLUGIN_PRIVACY[p];
    if (!n) unchecked.push(p);
    else for (const x of n) need.push({ ...x, plugin: p });
  }
  const out = { packageJson: ok, plugins, need, unchecked, declared: null, count: 0, isArray: true, hasKey: false, error: null, missing: [], noReason: [] };
  const pv = s.privacy;
  if (pv.duplicates.length) return { ...out, error: 'several manifests in the app target' };
  if (pv.fileExists) {
    try {
      const m = readPlist(pv.filePath, run);
      const types = m.NSPrivacyAccessedAPITypes;
      out.isArray = types === undefined || Array.isArray(types);
      out.hasKey = types !== undefined;
      out.count = Array.isArray(types) ? types.length : 0;
      out.declared = new Map((Array.isArray(types) ? types : [])
        .filter((t) => t && typeof t.NSPrivacyAccessedAPIType === 'string')
        .map((t) => [t.NSPrivacyAccessedAPIType, Array.isArray(t.NSPrivacyAccessedAPITypeReasons) ? t.NSPrivacyAccessedAPITypeReasons : []]));
    } catch (e) {
      out.error = e.message;
      return out;
    }
  } else {
    out.declared = new Map(); // a new manifest starts from the template: the key, with nothing in it
    out.hasKey = true;
  }
  for (const n of need) {
    if (!out.declared.has(n.category)) {
      if (!out.missing.some((m) => m.category === n.category)) out.missing.push(n);
    } else if (!out.declared.get(n.category).length) out.noReason.push(n);
  }
  return out;
}

export function versionCmp(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export function sameSet(a, b) {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export { parseDeviceFamily };

/** git ls-files: is this path committed (tracked) in the repo, and with which mode? */
export function gitTracked(repo, file, run) {
  const res = run('git', ['-C', repo, 'ls-files', '-s', '--', relative(repo, file)], { timeoutMs: 15_000 });
  if (res.code !== 0) return { known: false, tracked: false, detail: describeFailure(res) };
  const line = res.stdout.trim().split('\n')[0];
  if (!line) return { known: true, tracked: false, mode: null };
  return { known: true, tracked: true, mode: line.split(/\s+/)[0] };
}

export function isGitRepo(repo, run) {
  const res = run('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { timeoutMs: 15_000 });
  return res.code === 0;
}

export function isExecutable(file) {
  try {
    // git records 100755 when the owner bit is set, and that is what a cloud clone gets.
    return (statSync(file).mode & 0o100) !== 0;
  } catch {
    return false;
  }
}
