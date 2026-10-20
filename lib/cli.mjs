// Entry point: dispatches argv to lib/commands/*. `main` takes an injectable context so tests can
// stub the command runner, home directory, clock and network.
import { homedir } from 'node:os';
import { ConfigError, REPO_ROOT, UsageError } from './config.mjs';
import { run as realRun } from './run.mjs';
import { apps, help as appsHelp } from './commands/apps.mjs';
import { conform, help as conformHelp } from './commands/conform.mjs';
import { doctor, help as doctorHelp } from './commands/doctor.mjs';
import { key, help as keyHelp } from './commands/key.mjs';
import { sim, help as simHelp } from './commands/sim.mjs';
import { template, help as templateHelp } from './commands/template.mjs';

export const VERSION = '0.1.0';

const COMMANDS = {
  doctor: { fn: doctor, help: doctorHelp, summary: 'read-only checks by rung: READY / BLOCKED / UNKNOWN' },
  conform: { fn: conform, help: conformHelp, summary: 'bring the iOS project in line with the manifest (--check | --write)' },
  sim: { fn: sim, help: simHelp, summary: 'build for the iOS Simulator and launch (needs local Xcode)' },
  key: { fn: key, help: keyHelp, summary: 'App Store Connect key: import | check | gh-secret' },
  template: { fn: template, help: templateHelp, summary: 'print a rendered template (ci-post-clone)' },
  apps: { fn: apps, help: appsHelp, summary: 'list the app manifests and their status' },
};

export const usage = `orchard ${VERSION}: grow iOS apps from existing web projects.

usage: orchard <command> [app] [options]

${Object.entries(COMMANDS).map(([n, c]) => `  ${n.padEnd(9)}${c.summary}`).join('\n')}

Every app command takes the app name (or --app <name>) and --repo <path> to use a checkout
other than the manifest's localPath. \`orchard <command> --help\` explains each one.

Rungs (DESIGN.md §1): web, native-project, simulator, device, signed-archive,
testflight-internal, review. Each proves only itself.
`;

export function defaultContext(overrides = {}) {
  return {
    root: REPO_ROOT,
    run: realRun,
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    applicationsDir: '/Applications',
    fetch: globalThis.fetch,
    now: () => new Date(),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    ...overrides,
  };
}

export async function main(argv, overrides = {}) {
  const ctx = defaultContext(overrides);
  const [cmd, ...rest] = argv;
  try {
    if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
      const topic = cmd === 'help' ? rest[0] : null;
      if (topic && COMMANDS[topic]) ctx.out(COMMANDS[topic].help);
      else ctx.out(usage);
      return cmd ? 0 : 2;
    }
    if (cmd === '--version') {
      ctx.out(`${VERSION}\n`);
      return 0;
    }
    const c = COMMANDS[cmd];
    if (!c) throw new UsageError(`unknown command "${cmd}"`);
    return await c.fn(rest, ctx);
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.err(`orchard: ${e.message}\n(see orchard ${COMMANDS[cmd] ? `${cmd} ` : ''}--help)\n`);
      return 2;
    }
    if (e instanceof ConfigError) {
      ctx.err(`orchard: config: ${e.message}\n`);
      return 1;
    }
    ctx.err(`orchard: ${e.stack ?? e.message}\n`);
    return 1;
  }
}
