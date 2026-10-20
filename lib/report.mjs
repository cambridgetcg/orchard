// Check results and how they are shown. UNKNOWN is its own state: a check that did not run is not a pass.
export const READY = 'READY';
export const BLOCKED = 'BLOCKED';
export const UNKNOWN = 'UNKNOWN';

export const RUNGS = ['web', 'native-project', 'simulator', 'device', 'signed-archive', 'testflight-internal', 'review'];

/** One check result. `next` is the step that would move it forward (null when READY). */
export function check(group, rung, id, status, detail, next = null) {
  if (![READY, BLOCKED, UNKNOWN].includes(status)) throw new Error(`bad status ${status}`);
  if (!RUNGS.includes(rung)) throw new Error(`bad rung ${rung}`);
  return { group, rung, id, status, detail, next: status === READY ? null : next };
}

export function summarize(checks) {
  const s = { READY: 0, BLOCKED: 0, UNKNOWN: 0 };
  for (const c of checks) s[c.status] += 1;
  return s;
}

/** Exit code per DESIGN §3: 0 when nothing is BLOCKED, 1 otherwise. */
export function exitCodeFor(checks) {
  return checks.some((c) => c.status === BLOCKED) ? 1 : 0;
}

const GROUP_TITLES = {
  manifest: 'manifest',
  toolchain: 'toolchain (this Mac)',
  team: 'team',
  web: 'app web',
  'native-project': 'native project',
  'xcode-cloud': 'Xcode Cloud readiness (primary route)',
  store: 'store readiness',
  backup: 'GitHub Actions backup route',
};

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join('\n');
}

export function renderText(checks, { title } = {}) {
  const out = [];
  if (title) out.push(title, '');
  const groups = [];
  for (const c of checks) if (!groups.includes(c.group)) groups.push(c.group);
  for (const g of groups) {
    const items = checks.filter((c) => c.group === g);
    const rungs = [...new Set(items.map((c) => c.rung))].join(', ');
    out.push(`${GROUP_TITLES[g] ?? g}  [rung: ${rungs}]`);
    for (const c of items) {
      const pad = ' '.repeat(10);
      out.push(`  ${c.status.padEnd(8)}${c.id}`);
      out.push(`${pad}${wrap(c.detail, 88, pad)}`);
      if (c.next) out.push(`${pad}next: ${wrap(c.next, 82, pad + '      ')}`);
    }
    out.push('');
  }
  const s = summarize(checks);
  out.push(`${s.READY} READY, ${s.BLOCKED} BLOCKED, ${s.UNKNOWN} UNKNOWN. UNKNOWN means not checked or not checkable here; it is never a pass.`);
  return out.join('\n') + '\n';
}

export function renderJson(checks, extra = {}) {
  return JSON.stringify({ ...extra, summary: summarize(checks), exitCode: exitCodeFor(checks), checks }, null, 2) + '\n';
}

/** A small line diff (LCS) for showing template drift. Returns lines prefixed with ' ', '-' or '+'. */
export function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(' ' + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push('-' + a[i++]);
    else out.push('+' + b[j++]);
  }
  while (i < n) out.push('-' + a[i++]);
  while (j < m) out.push('+' + b[j++]);
  return out;
}

/** Only the changed lines of a diff, with up to `context` unchanged lines around them. */
export function compactDiff(lines, context = 1) {
  const keep = new Set();
  lines.forEach((l, idx) => {
    if (l[0] !== ' ') for (let k = idx - context; k <= idx + context; k++) keep.add(k);
  });
  const out = [];
  let last = -2;
  lines.forEach((l, idx) => {
    if (!keep.has(idx)) return;
    if (last !== -2 && idx > last + 1) out.push(' …');
    out.push(l);
    last = idx;
  });
  return out;
}
