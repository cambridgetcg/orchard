// Reads and carefully edits Xcode's classic project.pbxproj (an old-style ASCII plist).
// Reads use a full parser; writes are small text splices at parsed positions, so everything
// orchard does not touch stays byte-for-byte as Xcode wrote it. Callers verify each write
// with `plutil -lint` and restore the original on failure.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

class PbxSyntaxError extends Error {}

function fail(t, i, what) {
  const line = t.slice(0, i).split('\n').length;
  throw new PbxSyntaxError(`project.pbxproj: expected ${what} at line ${line}`);
}

function skipWs(t, i) {
  for (;;) {
    while (i < t.length && (t[i] === ' ' || t[i] === '\t' || t[i] === '\n' || t[i] === '\r')) i++;
    if (t.startsWith('/*', i)) {
      const e = t.indexOf('*/', i + 2);
      if (e < 0) fail(t, i, 'end of comment');
      i = e + 2;
      continue;
    }
    if (t.startsWith('//', i)) {
      const e = t.indexOf('\n', i);
      i = e < 0 ? t.length : e + 1;
      continue;
    }
    return i;
  }
}

function readQuoted(t, i) {
  let s = '';
  let j = i + 1;
  while (j < t.length && t[j] !== '"') {
    if (t[j] === '\\') {
      const c = t[j + 1];
      s += c === 'n' ? '\n' : c === 't' ? '\t' : c;
      j += 2;
    } else s += t[j++];
  }
  if (j >= t.length) fail(t, i, 'closing quote');
  return { value: s, end: j + 1 };
}

const BARE_CHAR = /[A-Za-z0-9_$+/:.\-]/;

function readBare(t, i) {
  let j = i;
  while (j < t.length && BARE_CHAR.test(t[j])) j++;
  if (j === i) fail(t, i, 'a value');
  return { value: t.slice(i, j), end: j };
}

function parseValue(t, i) {
  i = skipWs(t, i);
  const c = t[i];
  if (c === '{') return parseDict(t, i);
  if (c === '(') return parseArray(t, i);
  if (c === '"') return readQuoted(t, i);
  if (c === '<') {
    const e = t.indexOf('>', i);
    if (e < 0) fail(t, i, '>');
    return { value: t.slice(i, e + 1), end: e + 1 };
  }
  return readBare(t, i);
}

function parseDict(t, open) {
  const value = {};
  const entries = [];
  let i = open + 1;
  for (;;) {
    i = skipWs(t, i);
    if (i >= t.length) fail(t, i, '}');
    if (t[i] === '}') return { value, entries, open, close: i, end: i + 1 };
    const keyStart = i;
    const k = t[i] === '"' ? readQuoted(t, i) : readBare(t, i);
    i = skipWs(t, k.end);
    if (t[i] !== '=') fail(t, i, '=');
    const valueStart = skipWs(t, i + 1);
    const v = parseValue(t, valueStart);
    i = skipWs(t, v.end);
    if (t[i] !== ';') fail(t, i, ';');
    value[k.value] = v.value;
    entries.push({ key: k.value, keyStart, valueStart, valueEnd: v.end, end: i + 1, node: v });
    i += 1;
  }
}

function parseArray(t, open) {
  const value = [];
  const items = [];
  let i = open + 1;
  for (;;) {
    i = skipWs(t, i);
    if (i >= t.length) fail(t, i, ')');
    if (t[i] === ')') return { value, items, open, close: i, end: i + 1 };
    const start = i;
    const v = parseValue(t, i);
    value.push(v.value);
    items.push({ start, end: v.end });
    i = skipWs(t, v.end);
    if (t[i] === ',') i += 1;
    else if (t[i] !== ')') fail(t, i, ', or )');
  }
}

/** Parses the whole file. Throws PbxSyntaxError on anything Xcode would not have written. */
export function parsePbxproj(text) {
  const root = parseValue(text, 0);
  if (!root.entries) throw new PbxSyntaxError('project.pbxproj: top level is not a dictionary');
  const objectsEntry = root.entries.find((e) => e.key === 'objects');
  if (!objectsEntry?.node.entries) throw new PbxSyntaxError('project.pbxproj: no objects dictionary');
  return new Pbx(text, root, objectsEntry.node);
}

export class Pbx {
  constructor(text, root, objectsNode) {
    this.text = text;
    this.root = root;
    this.objectsNode = objectsNode;
    this.objects = objectsNode.value;
    this.rootObjectId = root.value.rootObject;
  }

  get project() {
    return this.objects[this.rootObjectId];
  }

  entry(id) {
    return this.objectsNode.entries.find((e) => e.key === id);
  }

  ofIsa(isa) {
    return Object.entries(this.objects).filter(([, o]) => o.isa === isa).map(([id, o]) => ({ id, ...o }));
  }

  /** The application target: the one named `name`, else the only application target. */
  appTarget(name) {
    const apps = this.ofIsa('PBXNativeTarget').filter((t) => t.productType === 'com.apple.product-type.application');
    return apps.find((t) => t.name === name) ?? (apps.length === 1 ? apps[0] : null);
  }

  configs(owner) {
    const list = this.objects[owner.buildConfigurationList];
    return (list?.buildConfigurations ?? []).map((id) => ({ id, name: this.objects[id]?.name, settings: this.objects[id]?.buildSettings ?? {} }));
  }

  projectConfigs() {
    return this.configs(this.project);
  }

  /** A setting as the target sees it: target level first, then the project level of the same configuration. */
  effectiveSetting(target, configName, key) {
    const t = this.configs(target).find((c) => c.name === configName);
    if (t && Object.hasOwn(t.settings, key)) return { value: t.settings[key], level: 'target' };
    const p = this.projectConfigs().find((c) => c.name === configName);
    if (p && Object.hasOwn(p.settings, key)) return { value: p.settings[key], level: 'project' };
    return { value: undefined, level: null };
  }

  phase(target, isa) {
    const id = (target.buildPhases ?? []).find((pid) => this.objects[pid]?.isa === isa);
    return id ? { id, ...this.objects[id] } : null;
  }

  /** Map of file/group id → path relative to SOURCE_ROOT (the directory holding the .xcodeproj). */
  resolvedPaths() {
    const out = new Map();
    const walk = (id, base) => {
      const o = this.objects[id];
      if (!o) return;
      let here = base;
      if (o.sourceTree === 'SOURCE_ROOT') here = o.path ?? '';
      else if (o.sourceTree === '<group>' || o.sourceTree === undefined) here = o.path ? posix.join(base, o.path) : base;
      else here = null; // absolute or build-product paths are not part of the source tree
      if (here !== null) out.set(id, posix.normalize(here || '.'));
      for (const child of o.children ?? []) walk(child, here ?? base);
    };
    walk(this.project.mainGroup, '');
    return out;
  }

  groupContaining(childId) {
    for (const [id, o] of Object.entries(this.objects)) {
      if ((o.isa === 'PBXGroup' || o.isa === 'PBXVariantGroup') && (o.children ?? []).includes(childId)) return { id, ...o };
    }
    return null;
  }
}

/** Formats a value the way Xcode writes it: bare when safe, quoted otherwise. */
export function pbxString(v) {
  const s = String(v);
  if (/^[A-Za-z0-9_./]+$/.test(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

/** A stable 24-hex object id derived from `seed`, avoiding ids already present. */
export function deterministicId(seed, taken) {
  for (let n = 0; ; n++) {
    const id = createHash('sha256').update(n ? `${seed}:${n}` : seed).digest('hex').slice(0, 24).toUpperCase();
    if (!taken(id)) return id;
  }
}

function lineStart(t, i) {
  return t.lastIndexOf('\n', i - 1) + 1;
}

function indentAt(t, i) {
  const ls = lineStart(t, i);
  return t.slice(ls, i).match(/^[\t ]*/)[0];
}

/** Sets (or inserts, in Xcode's alphabetical order) one build setting in an XCBuildConfiguration. */
export function setBuildSetting(text, configId, key, rawValue) {
  const pbx = parsePbxproj(text);
  const cfg = pbx.entry(configId);
  if (!cfg || pbx.objects[configId].isa !== 'XCBuildConfiguration') throw new Error(`no XCBuildConfiguration ${configId}`);
  const bs = cfg.node.entries.find((e) => e.key === 'buildSettings');
  if (!bs?.node.entries) throw new Error(`${configId} has no buildSettings dictionary`);
  const existing = bs.node.entries.find((e) => e.key === key);
  if (existing) return text.slice(0, existing.valueStart) + rawValue + text.slice(existing.valueEnd);
  const after = bs.node.entries.find((e) => e.key > key);
  let at;
  let indent;
  if (after) {
    at = lineStart(text, after.keyStart);
    indent = indentAt(text, after.keyStart);
  } else if (bs.node.entries.length) {
    const last = bs.node.entries[bs.node.entries.length - 1];
    at = text.indexOf('\n', last.end) + 1;
    indent = indentAt(text, last.keyStart);
  } else {
    at = lineStart(text, bs.node.close);
    indent = indentAt(text, bs.node.close) + '\t';
  }
  return text.slice(0, at) + `${indent}${key} = ${rawValue};\n` + text.slice(at);
}

/** Inserts a one-line object into its isa section, ordered by id as Xcode keeps it. */
export function insertObject(text, isa, id, body) {
  const pbx = parsePbxproj(text);
  if (pbx.objects[id]) throw new Error(`object ${id} already exists`);
  const begin = `/* Begin ${isa} section */`;
  const end = `/* End ${isa} section */`;
  const b = text.indexOf(begin);
  const e = text.indexOf(end);
  if (b < 0 || e < 0) {
    // Create the section in alphabetical order among the others.
    const sections = [...text.matchAll(/\/\* Begin (\w+) section \*\//g)];
    const next = sections.find((m) => m[1] > isa);
    const at = next ? lineStart(text, next.index) : lineStart(text, pbx.objectsNode.close);
    const block = `${begin}\n\t\t${id} ${body}\n${end}\n\n`;
    return text.slice(0, at) + block + text.slice(at);
  }
  const inSection = pbx.objectsNode.entries.filter((en) => en.keyStart > b && en.keyStart < e);
  const after = inSection.find((en) => en.key > id);
  const at = after ? lineStart(text, after.keyStart) : lineStart(text, e);
  return text.slice(0, at) + `\t\t${id} ${body}\n` + text.slice(at);
}

/** Appends `item` (already formatted, e.g. `ID /* name *\/`) to an array field of an object. */
export function appendToArray(text, objectId, field, item) {
  const pbx = parsePbxproj(text);
  const obj = pbx.entry(objectId);
  if (!obj) throw new Error(`no object ${objectId}`);
  const f = obj.node.entries?.find((en) => en.key === field);
  if (!f || !f.node.items) throw new Error(`${objectId} has no array ${field}`);
  const fieldIndent = indentAt(text, f.keyStart);
  const closeLine = lineStart(text, f.node.close);
  const closeOnOwnLine = text.slice(closeLine, f.node.close).trim() === '';
  if (closeOnOwnLine && closeLine > f.node.open) {
    return text.slice(0, closeLine) + `${fieldIndent}\t${item},\n` + text.slice(closeLine);
  }
  // `( )` or items on the open line: rewrite the array across lines.
  const existing = f.node.items.map((it) => text.slice(it.start, it.end));
  const lines = [...existing, item].map((s) => `${fieldIndent}\t${s},\n`).join('');
  return text.slice(0, f.node.open) + `(\n${lines}${fieldIndent})` + text.slice(f.node.close + 1);
}

/** The value Xcode uses for TARGETED_DEVICE_FAMILY: 1, or "1,2". */
export function deviceFamilyValue(list) {
  return [...list].sort().join(',');
}

export function parseDeviceFamily(v) {
  if (v == null) return null;
  return String(v).split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)).sort();
}
