// The local simulator loop: web build, cap sync, xcodebuild for the simulator, simctl boot/install/launch.
// Avoids `npx cap run ios`, which cannot open simulators under Xcode 27's Device Hub, and selects
// Xcode with DEVELOPER_DIR on each command instead of `xcode-select -s`.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appName, parseArgs } from '../args.mjs';
import { loadApp, loadOrchard, tildify } from '../config.mjs';
import { inspectNative, readCapacitorConfig, serverUrls } from '../ios-project.mjs';
import { describeFailure } from '../run.mjs';
import { devEnv, findXcode, INSTALL_XCODE_NEXT, listSimulators, pickDevice } from '../xcode.mjs';

export const help = `orchard sim <app> [--device <name>] [--no-build-web] [--screenshot] [--repo <path>]

Builds the app for the iOS Simulator and launches it:
  1. the web build from the manifest (web.install first if node_modules is missing),
     skipped with --no-build-web
  2. node_modules/.bin/cap sync ios: the app's own Capacitor CLI, never npx, which would
     fetch and run whatever npm package is named \`cap\` when the local CLI is missing.
     Missing is BLOCKED with the install step. After the sync, the generated
     ios/App/App/capacitor.config.json is checked for server.url.
  3. xcodebuild -project … -scheme … -configuration Debug -sdk iphonesimulator
       -destination 'platform=iOS Simulator,name=<device>'
       -derivedDataPath <repo>/build/orchard-sim build
  4. xcrun simctl boot (an already booted device is fine), install, launch <bundleId>

Every Xcode command gets DEVELOPER_DIR for the chosen Xcode; orchard never runs
xcode-select -s. The default device is the first iPhone on the newest iOS runtime.
No screenshot is taken unless --screenshot is passed: agents can't tell when capture is OK,
so it is an explicit choice.
Writes build products under <repo>/build/orchard-sim and whatever the web build and cap
sync write in the app repo.

Rung: simulator. A launch shows the app process started; it does not prove the page
rendered, and it says nothing about devices or signing.
Exit: 0 launched, 1 blocked or failed, 2 usage error.
`;

const MIN = 60_000;

export function buildSimSteps({ manifest, repo, xcode, device, buildWeb, needInstall }) {
  const env = devEnv(xcode);
  const web = manifest.web ?? {};
  const derived = join(repo, 'build', 'orchard-sim');
  const steps = [];
  if (buildWeb) {
    if (needInstall && web.install) steps.push({ label: 'web install', cmd: '/bin/sh', args: ['-c', web.install], cwd: repo, env, timeoutMs: 20 * MIN, stream: true });
    if (web.build) steps.push({ label: 'web build', cmd: '/bin/sh', args: ['-c', web.build], cwd: repo, env, timeoutMs: 20 * MIN, stream: true });
  }
  // The app's own CLI: `npx cap` would fall back to the unrelated npm package named `cap` when
  // @capacitor/cli is not installed (npx assumes --yes when stdin is not a terminal).
  const cap = join(repo, 'node_modules', '.bin', 'cap');
  steps.push({
    label: 'cap sync', cmd: cap, args: ['sync', 'ios'], cwd: repo, env, timeoutMs: 10 * MIN, stream: true,
    needs: { file: cap, why: 'the Capacitor CLI is not installed in the app repo (node_modules/.bin/cap is missing)', next: `run ${web.install ?? 'npm ci'} in the app repo, devDependencies included (@capacitor/cli is usually one)` },
    after: 'capacitor-config',
  });
  steps.push({
    label: 'xcodebuild',
    cmd: 'xcodebuild',
    args: [
      '-project', join(repo, manifest.ios.project),
      '-scheme', manifest.ios.scheme,
      '-configuration', 'Debug',
      '-sdk', 'iphonesimulator',
      '-destination', `platform=iOS Simulator,name=${device.name}`,
      '-derivedDataPath', derived,
      'build',
    ],
    cwd: repo,
    env,
    timeoutMs: 45 * MIN,
    stream: true,
  });
  return { steps, derived, productsDir: join(derived, 'Build', 'Products', 'Debug-iphonesimulator') };
}

export function launchSteps({ manifest, xcode, device, appPath, screenshotPath }) {
  const env = devEnv(xcode);
  const steps = [
    { label: 'simctl boot', cmd: 'xcrun', args: ['simctl', 'boot', device.udid], env, timeoutMs: 3 * MIN, tolerate: /current state: Booted/i },
    { label: 'simctl install', cmd: 'xcrun', args: ['simctl', 'install', device.udid, appPath], env, timeoutMs: 3 * MIN },
    { label: 'simctl launch', cmd: 'xcrun', args: ['simctl', 'launch', device.udid, manifest.bundleId], env, timeoutMs: 2 * MIN },
  ];
  if (screenshotPath) steps.push({ label: 'simctl screenshot', cmd: 'xcrun', args: ['simctl', 'io', device.udid, 'screenshot', screenshotPath], env, timeoutMs: MIN });
  return steps;
}

export function findApp(productsDir, scheme) {
  if (!existsSync(productsDir)) return null;
  const apps = readdirSync(productsDir).filter((n) => n.endsWith('.app'));
  const name = apps.includes(`${scheme}.app`) ? `${scheme}.app` : apps[0];
  return name ? join(productsDir, name) : null;
}

function shown(step) {
  const q = (a) => (/^[A-Za-z0-9_./=:,@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return `DEVELOPER_DIR=${step.env.DEVELOPER_DIR} ${[step.cmd, ...step.args].map(q).join(' ')}`;
}

function runStep(step, ctx) {
  ctx.out(`\n== ${step.label}\n$ ${shown(step)}\n`);
  const res = ctx.run(step.cmd, step.args, { cwd: step.cwd, env: step.env, timeoutMs: step.timeoutMs, stream: step.stream });
  if (res.code !== 0 && step.tolerate && step.tolerate.test(res.stderr + res.stdout)) {
    ctx.out('(already booted)\n');
    return { ...res, code: 0 };
  }
  if (!step.stream && res.stdout.trim()) ctx.out(res.stdout.trim() + '\n');
  return res;
}

export function sim(argv, ctx) {
  const p = parseArgs(argv, { app: 'string', repo: 'string', device: 'string', 'no-build-web': 'bool', screenshot: 'bool' });
  if (p.flags.help) return ctx.out(help), 0;
  const name = appName(p);
  const { manifest, repo } = loadApp(name, { root: ctx.root, repoOverride: p.flags.repo, home: ctx.home, cwd: ctx.cwd });
  const orchard = loadOrchard(ctx.root);
  const blocked = (why, next) => {
    ctx.err(`BLOCKED (rung simulator): ${why}\nnext: ${next}\n`);
    return 1;
  };
  const xc = findXcode({ env: ctx.env, applicationsDir: ctx.applicationsDir, want: orchard.toolchain.xcode });
  if (!xc.selected) return blocked(`no Xcode on this Mac (only Command Line Tools?); xcodebuild and simctl need Xcode ${orchard.toolchain.xcode}.`, INSTALL_XCODE_NEXT);
  if (!repo || !existsSync(repo)) return blocked(`no checkout at ${repo ? tildify(repo, ctx.home) : '(localPath null)'}.`, 'pass --repo <path> or set localPath');
  if (!manifest.bundleId) return blocked('the manifest has no bundleId yet.', `see docs/apps/${name}.md`);
  const state = inspectNative(repo, manifest, { run: ctx.run });
  if (state.format.format !== 'pbxproj') return blocked(`project format: ${state.format.format} (${state.format.detail}).`, 'see orchard doctor (native.format)');
  const urls = serverUrls(state.cap);
  if (urls.length) return blocked(`capacitor config sets server.url (${urls[0].url}); the simulator would show the live site, not the bundle.`, 'remove server.url');
  const sims = listSimulators(xc.selected, ctx.run);
  if (!sims.ok) return blocked(`could not list simulators: ${sims.text}.`, `DEVELOPER_DIR=${xc.selected.developerDir} xcodebuild -downloadPlatform iOS`);
  const device = pickDevice(sims, p.flags.device ?? null);
  if (!device) {
    return blocked(p.flags.device ? `no available simulator named "${p.flags.device}".` : 'no iPhone simulator available.',
      p.flags.device ? 'xcrun simctl list devices available' : `DEVELOPER_DIR=${xc.selected.developerDir} xcodebuild -downloadPlatform iOS`);
  }
  ctx.out(`orchard sim ${name}: Xcode ${xc.selected.version ?? '?'} (${xc.reason}), device ${device.name} [${device.udid}] on ${device.runtime}\n`);
  const plan = buildSimSteps({
    manifest, repo, xcode: xc.selected, device,
    buildWeb: !p.flags['no-build-web'],
    needInstall: !existsSync(join(repo, 'node_modules')),
  });
  for (const step of plan.steps) {
    if (step.needs && !existsSync(step.needs.file)) return blocked(step.needs.why, step.needs.next);
    const res = runStep(step, ctx);
    if (res.code !== 0) {
      ctx.err(`\n${step.label} failed: ${describeFailure(res)}\nRung reached: below simulator.\n`);
      return 1;
    }
    if (step.after === 'capacitor-config') {
      // What cap sync actually resolved, whatever format the source config is in (.ts, .js, .json).
      const synced = serverUrls({ generated: readCapacitorConfig(state.paths).generated });
      if (synced.length) return blocked(`cap sync wrote server.url (${synced[0].url}) into ${synced[0].file}; the simulator would show the live site, not the bundle.`, 'remove server.url from the app\'s capacitor config');
    }
  }
  const appPath = findApp(plan.productsDir, manifest.ios.scheme);
  if (!appPath) {
    ctx.err(`\nno .app under ${plan.productsDir}\n`);
    return 1;
  }
  const shot = p.flags.screenshot ? join(plan.derived, `screenshot-${ctx.now().toISOString().replace(/[:.]/g, '-')}.png`) : null;
  for (const step of launchSteps({ manifest, xcode: xc.selected, device, appPath, screenshotPath: shot })) {
    const res = runStep(step, ctx);
    if (res.code !== 0) {
      ctx.err(`\n${step.label} failed: ${describeFailure(res)}\n`);
      return 1;
    }
  }
  ctx.out(`\nRung reached: simulator. ${manifest.bundleId} launched on ${device.name}; the process started, rendering is not checked${shot ? ` (screenshot: ${shot})` : ''}.\n`);
  ctx.out('Device Hub (Xcode 27) shows the running simulator. Package.resolved may now exist: commit it in the app repo for Xcode Cloud.\n');
  return 0;
}
