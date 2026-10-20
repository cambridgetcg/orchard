import { appName, parseArgs } from '../args.mjs';
import { loadApp, loadOrchard, UsageError } from '../config.mjs';
import { renderCiPostClone } from '../templates.mjs';

export const help = `orchard template ci-post-clone <app>

Prints the Xcode Cloud post-clone script rendered for the app from
templates/xcode-cloud/ci_post_clone.sh. Writes nothing; \`orchard conform <app> --write\`
puts the same text at ios/App/ci_scripts/ci_post_clone.sh (mode 0755).

Placeholders: {{appName}} {{bundleId}} {{preflight}} {{node}} {{install}} {{test}}
{{build}} {{project}}. Null fields render as nothing; preflight renders one command per line.
`;

export function template(argv, ctx) {
  const p = parseArgs(argv, { app: 'string', repo: 'string' });
  if (p.flags.help) return ctx.out(help), 0;
  const [kind, ...rest] = p.positionals;
  if (!kind) throw new UsageError('which template? (ci-post-clone)');
  if (kind !== 'ci-post-clone') throw new UsageError(`unknown template "${kind}" (known: ci-post-clone)`);
  const name = appName({ ...p, positionals: rest });
  const { manifest } = loadApp(name, { root: ctx.root, home: ctx.home, cwd: ctx.cwd });
  const orchard = loadOrchard(ctx.root);
  ctx.out(renderCiPostClone(manifest, orchard, ctx.root));
  return 0;
}
