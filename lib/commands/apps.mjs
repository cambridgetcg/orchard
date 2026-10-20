import { existsSync } from 'node:fs';
import { parseArgs } from '../args.mjs';
import { expandHome, loadApps, tildify, UsageError } from '../config.mjs';

export const help = `orchard apps [--json]

Lists the app manifests in apps/*.json with their status, bundle ID, local checkout and
release routes. Reads nothing outside this repo except whether each localPath exists.
`;

export function apps(argv, ctx) {
  const p = parseArgs(argv, { json: 'bool' });
  if (p.flags.help) return ctx.out(help), 0;
  if (p.positionals.length) throw new UsageError(`unexpected argument: ${p.positionals[0]}`);
  const { apps: list, errors } = loadApps(ctx.root);
  const rows = list.map((m) => {
    const local = m.localPath ? expandHome(m.localPath, ctx.home) : null;
    return {
      name: m.name,
      displayName: m.displayName ?? m.name,
      status: m.status,
      bundleId: m.bundleId,
      proposedBundleId: m.proposedBundleId ?? null,
      localPath: m.localPath,
      localPathExists: local ? existsSync(local) : false,
      primary: m.release?.primary ?? null,
      backup: m.release?.backup ?? null,
      blockedBy: m.blockedBy ?? [],
    };
  });
  if (p.flags.json) {
    ctx.out(JSON.stringify({ apps: rows, invalid: errors.map(({ name, problems }) => ({ name, problems })) }, null, 2) + '\n');
    return errors.length ? 1 : 0;
  }
  const lines = [];
  for (const r of rows) {
    lines.push(`${r.name}  (${r.displayName})  status: ${r.status}`);
    lines.push(`  bundle ID  ${r.bundleId ?? `none yet${r.proposedBundleId ? ` (proposed ${r.proposedBundleId})` : ''}`}`);
    lines.push(`  checkout   ${r.localPath ? `${tildify(expandHome(r.localPath, ctx.home), ctx.home)} (${r.localPathExists ? 'present' : 'not on this Mac'})` : 'none set'}`);
    lines.push(`  routes     primary ${r.primary ?? 'none'}; backup ${r.backup ?? 'none'}`);
    for (const b of r.blockedBy) lines.push(`  blocked    ${b}`);
    lines.push('');
  }
  for (const e of errors) lines.push(`${e.name}  INVALID MANIFEST`, ...e.problems.map((x) => `  - ${x}`), '');
  lines.push('Status is the manifest\'s own word; `orchard doctor <app>` checks the ground.');
  ctx.out(lines.join('\n') + '\n');
  return errors.length ? 1 : 0;
}
