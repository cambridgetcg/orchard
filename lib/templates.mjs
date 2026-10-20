// Renders templates/* with {{placeholders}} from an app manifest and orchard.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './config.mjs';

/**
 * Replaces every {{name}}. Strict both ways: a placeholder with no value, or a value the
 * template never uses, is an error, so a typo in a template can't render silently.
 * null and undefined render as nothing.
 */
export function render(template, vars) {
  const used = new Set();
  const missing = new Set();
  const out = template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g, (_, name) => {
    if (!Object.hasOwn(vars, name)) {
      missing.add(name);
      return '';
    }
    used.add(name);
    const v = vars[name];
    return v == null ? '' : String(v);
  });
  if (missing.size) throw new Error(`template placeholder(s) with no value: ${[...missing].join(', ')}`);
  const unused = Object.keys(vars).filter((k) => !used.has(k));
  if (unused.length) throw new Error(`template does not use: ${unused.join(', ')}`);
  return out;
}

export function ciPostCloneVars(manifest, orchard) {
  const web = manifest.web ?? {};
  return {
    appName: manifest.displayName ?? manifest.name,
    bundleId: manifest.bundleId,
    preflight: (manifest.release?.preflight ?? []).join('\n'),
    node: orchard.toolchain.node,
    install: web.install ?? null,
    test: web.test ?? null,
    build: web.build ?? null,
    project: manifest.ios.project,
  };
}

export function renderCiPostClone(manifest, orchard, root = REPO_ROOT) {
  const tpl = readFileSync(join(root, 'templates/xcode-cloud/ci_post_clone.sh'), 'utf8');
  return render(tpl, ciPostCloneVars(manifest, orchard));
}

export function privacyTemplate(root = REPO_ROOT) {
  return readFileSync(join(root, 'templates/ios/PrivacyInfo.xcprivacy'), 'utf8');
}
