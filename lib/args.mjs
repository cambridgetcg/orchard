// Minimal argv parsing: declared flags only, so a typo is a usage error rather than a silent no-op.
import { UsageError } from './config.mjs';

/**
 * @param {string[]} argv
 * @param {Record<string,'bool'|'string'>} flags  allowed flags (without leading --)
 * @returns {{ positionals: string[], flags: Record<string, string|boolean> }}
 */
export function parseArgs(argv, flags) {
  const positionals = [];
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const kind = name === 'help' ? 'bool' : flags[name];
    if (!kind) throw new UsageError(`unknown option --${name}`);
    if (kind === 'bool') {
      if (eq > 0) throw new UsageError(`--${name} takes no value`);
      out[name] = true;
    } else {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || (eq < 0 && v.startsWith('--'))) throw new UsageError(`--${name} needs a value`);
      out[name] = v;
    }
  }
  return { positionals, flags: out };
}

/** The app name from a positional or --app (not both, unless they agree). */
export function appName(parsed, { required = true } = {}) {
  const pos = parsed.positionals[0];
  const flag = parsed.flags.app;
  if (pos && flag && pos !== flag) throw new UsageError(`app given twice: "${pos}" and --app ${flag}`);
  const name = pos ?? flag;
  if (!name && required) throw new UsageError('which app? pass its name (see `orchard apps`)');
  if (parsed.positionals.length > 1) throw new UsageError(`unexpected argument: ${parsed.positionals[1]}`);
  return name ?? null;
}
