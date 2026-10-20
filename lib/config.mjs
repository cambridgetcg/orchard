// Loads orchard.json and apps/*.json, resolves ~ and --repo, and checks the fields commands rely on.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The orchard checkout this module lives in, wherever the CLI is invoked from. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class UsageError extends Error {}
export class ConfigError extends Error {}

export function expandHome(p, home = homedir()) {
  if (p == null) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

/** Shows a path with the home directory folded back to ~, for output. */
export function tildify(p, home = homedir()) {
  if (!p) return p;
  return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${file}: ${e.message}`);
  }
}

export function loadOrchard(root = REPO_ROOT) {
  const file = join(root, 'orchard.json');
  if (!existsSync(file)) throw new ConfigError(`missing ${file}`);
  const o = readJson(file);
  const problems = [];
  if (!o.team || typeof o.team !== 'object') problems.push('team is missing');
  else if (!(o.team.teamId === null || /^[A-Z0-9]{10}$/.test(o.team.teamId ?? ''))) {
    problems.push('team.teamId must be null or a 10-character Team ID');
  }
  if (!o.appStoreConnect?.keychainService) problems.push('appStoreConnect.keychainService is missing');
  if (!o.appStoreConnect?.localConfig) problems.push('appStoreConnect.localConfig is missing');
  if (!o.toolchain?.xcode) problems.push('toolchain.xcode is missing');
  if (!o.toolchain?.node) problems.push('toolchain.node is missing');
  if (problems.length) throw new ConfigError(`orchard.json: ${problems.join('; ')}`);
  return o;
}

const ORIENTATION = /^UIInterfaceOrientation[A-Za-z]+$/;
const VERSION = /^\d+(\.\d+){0,2}$/;

/** Returns a list of problems; an empty list means the manifest is usable. */
export function validateManifest(m, fileName) {
  const p = [];
  const blocked = m.status === 'blocked';
  if (typeof m.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(m.name)) p.push('name must be lower-case letters, digits and dashes');
  if (fileName && m.name !== fileName) p.push(`name "${m.name}" does not match file name "${fileName}"`);
  if (typeof m.status !== 'string') p.push('status is missing');
  if (m.bundleId !== null && !(typeof m.bundleId === 'string' && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(m.bundleId))) {
    p.push('bundleId must be a reverse-DNS string (or null while the app is blocked)');
  }
  if (m.bundleId === null && !blocked) p.push('bundleId may be null only while status is "blocked"');
  if (m.localPath !== null && typeof m.localPath !== 'string') p.push('localPath must be a string or null');
  const ios = m.ios;
  if (!ios || typeof ios !== 'object') p.push('ios is missing');
  else {
    if (typeof ios.project !== 'string' || !ios.project.endsWith('.xcodeproj')) p.push('ios.project must name a .xcodeproj');
    if (typeof ios.scheme !== 'string' || !ios.scheme) p.push('ios.scheme is missing');
    if (typeof ios.minIOS !== 'string' || !VERSION.test(ios.minIOS)) p.push('ios.minIOS must look like "16.0"');
    if (!Array.isArray(ios.deviceFamily) || !ios.deviceFamily.length || ios.deviceFamily.some((d) => d !== 1 && d !== 2)) {
      p.push('ios.deviceFamily must be a non-empty list of 1 (iPhone) and/or 2 (iPad)');
    }
    if (!Array.isArray(ios.orientations) || !ios.orientations.length || ios.orientations.some((o) => !ORIENTATION.test(o))) {
      p.push('ios.orientations must be a non-empty list of UIInterfaceOrientation* names');
    }
    if (typeof ios.usesNonExemptEncryption !== 'boolean') p.push('ios.usesNonExemptEncryption must be true or false');
  }
  const web = m.web ?? {};
  for (const k of ['install', 'build', 'dir', 'test']) {
    if (web[k] !== undefined && web[k] !== null && typeof web[k] !== 'string') p.push(`web.${k} must be a string or null`);
  }
  const rel = m.release ?? {};
  if (rel.preflight !== undefined && (!Array.isArray(rel.preflight) || rel.preflight.some((c) => typeof c !== 'string' || c.includes('\n')))) {
    p.push('release.preflight must be a list of single-line commands');
  }
  if (rel.backup != null && !/^github-actions:.+\.ya?ml$/.test(rel.backup)) p.push('release.backup must look like "github-actions:<workflow path>" or be null');
  return p;
}

/** Loads every manifest. Invalid ones are reported, not thrown, so `orchard apps` can still list the rest. */
export function loadApps(root = REPO_ROOT) {
  const dir = join(root, 'apps');
  const apps = [];
  const errors = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const name = f.slice(0, -5);
    let m;
    try {
      m = readJson(join(dir, f));
    } catch (e) {
      errors.push({ name, problems: [e.message] });
      continue;
    }
    const problems = validateManifest(m, name);
    if (problems.length) errors.push({ name, problems, manifest: m });
    else apps.push(m);
  }
  return { apps, errors };
}

/**
 * Loads one app. `repoOverride` (from --repo) wins over the manifest's localPath.
 * Returns { manifest, repo } where repo is an absolute path or null.
 */
export function loadApp(name, { root = REPO_ROOT, repoOverride, cwd = process.cwd(), home = homedir() } = {}) {
  const { apps, errors } = loadApps(root);
  const m = apps.find((a) => a.name === name);
  if (!m) {
    const bad = errors.find((e) => e.name === name);
    if (bad) throw new ConfigError(`apps/${name}.json is not usable: ${bad.problems.join('; ')}`);
    const known = [...apps.map((a) => a.name), ...errors.map((e) => e.name)].sort();
    throw new UsageError(`unknown app "${name}" (known: ${known.join(', ') || 'none'})`);
  }
  let repo = null;
  if (repoOverride) repo = isAbsolute(expandHome(repoOverride, home)) ? expandHome(repoOverride, home) : resolve(cwd, repoOverride);
  else if (m.localPath) repo = expandHome(m.localPath, home);
  return { manifest: m, repo };
}

/** The workflow path of a "github-actions:<path>" backup route, or null. */
export function backupWorkflow(manifest) {
  const b = manifest.release?.backup;
  if (!b || !b.startsWith('github-actions:')) return null;
  return b.slice('github-actions:'.length);
}
