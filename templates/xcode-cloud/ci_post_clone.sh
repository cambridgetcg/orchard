#!/bin/sh
# Rendered by orchard for {{appName}} ({{bundleId}}).
# Xcode Cloud runs this after cloning and before it resolves packages and builds.
# It turns the web project into the bundle the iOS project embeds. Apple signs in the
# cloud, so nothing here needs a secret.
set -eu

cd "$CI_PRIMARY_REPOSITORY_PATH"

# The app repo's own release rules (for example an ancestry fence) need full history.
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  git fetch --unshallow --quiet || echo "warning: could not unshallow; history-based checks may fail"
fi
{{preflight}}

export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1
brew install node@{{node}}
PATH="$(brew --prefix node@{{node}})/bin:$PATH"
export PATH
node --version

{{install}}
{{test}}
{{build}}

# The marketing version comes from the app's own version source; Xcode Cloud sets the build number.
ORCHARD_PBXPROJ="{{project}}/project.pbxproj" node -e '
const fs = require("fs");
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) { console.error(`marketing version must be X.Y.Z, got ${version}`); process.exit(1); }
const file = process.env.ORCHARD_PBXPROJ;
const before = fs.readFileSync(file, "utf8");
if (!/MARKETING_VERSION = [^;]+;/.test(before)) { console.error(`MARKETING_VERSION not found in ${file}`); process.exit(1); }
fs.writeFileSync(file, before.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`));
console.log(`MARKETING_VERSION = ${version}`);
'

# The app's own Capacitor CLI, never whatever npx might fetch.
./node_modules/.bin/cap sync ios
