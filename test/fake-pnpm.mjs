// Fake pnpm used only by test/selftest.ps1. It never touches the real profile:
// FAKE_PROFILE points at a throwaway copy, which this script edits and into
// whose node_modules the plugin package is linked.
//
// FAKE_PLUGIN_DIR is the package the harness wants linked; the default is the
// published plugin location (the repository root of dsh-canvas-task-monitor).
import { readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const profile = process.env.FAKE_PROFILE;
if (!profile) {
  console.error("fake pnpm: FAKE_PROFILE is not set");
  process.exit(2);
}
const pluginDir = process.env.FAKE_PLUGIN_DIR || "D:\\dev\\mcp\\dsh-canvas-task-monitor";
const depName = "dsh-canvas-task-monitor";
const pkgPath = join(profile, "package.json");
// apply.ps1 prefixes the Desktop policy argument (--config.minimumReleaseAge=0)
// exactly like DSH Desktop does, so the command is not necessarily argv[2].
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--config.minimumReleaseAge=0" ? rawArgs.slice(1) : rawArgs;
const command = args[0];
if (process.env.FAKE_PNPM_LOG) {
  writeFileSync(process.env.FAKE_PNPM_LOG, JSON.stringify(rawArgs), "utf8");
}

function readPkg() {
  return JSON.parse(readFileSync(pkgPath, "utf8"));
}
function writePkg(value) {
  writeFileSync(pkgPath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

// The real pnpm does NOT remove an existing `link:` entry when the dependency
// disappears from package.json -- a stale junction survived a successful
// `pnpm install` on a real profile. So the default here is the faithful one:
// leave the link; FAKE_PNPM_PRUNE_LINK=1 restores the old optimistic behaviour
// that hid the bug (it is kept as a switch for debugging).
function linkPlugin(linkDir) {
  mkdirSync(dirname(linkDir), { recursive: true });
  rmSync(linkDir, { recursive: true, force: true });
  symlinkSync(pluginDir, linkDir, "junction");
}

if (process.env.FAKE_PNPM_FAIL === "1") {
  console.error("fake pnpm: forced failure");
  process.exit(1);
}

if (command === "add") {
  const spec = args[1];
  const pkg = readPkg();
  if (!pkg.dependencies) pkg.dependencies = {};
  pkg.dependencies[depName] = spec;
  writePkg(pkg);
  const linkDir = join(profile, "node_modules", depName);
  linkPlugin(linkDir);
  console.log(`fake pnpm: added ${depName} (${spec}) -> ${pluginDir}`);
  if (process.env.FAKE_PNPM_RECONCILE === "1") {
    // Mimic dsh/lib/plugin-*.js reconcilePlugins on a successful `dsh plugin
    // add`: a new dependency that declares dsh.bundle joins the layer list by
    // itself, so apply.ps1 must not append it a second time.
    const after = readPkg();
    const bundles = after.dsh?.profile?.bundles;
    if (Array.isArray(bundles) && !bundles.includes(depName)) {
      bundles.push(depName);
      writePkg(after);
      console.log(`fake pnpm: reconciled ${depName} into dsh.profile.bundles`);
    }
  }
  process.exit(0);
}

if (command === "install") {
  const pkg = readPkg();
  const linkDir = join(profile, "node_modules", depName);
  const wanted = Boolean(pkg.dependencies && pkg.dependencies[depName]);
  if (!wanted) {
    if (process.env.FAKE_PNPM_PRUNE_LINK === "1") {
      rmSync(linkDir, { recursive: true, force: true });
      console.log(`fake pnpm: pruned ${depName}`);
    } else {
      console.log(`fake pnpm: left ${linkDir} in place (real pnpm does not remove stale links)`);
    }
  } else if (leaveStaleOnce() && existsSync(linkDir)) {
    console.log(`fake pnpm: left the pre-existing link at ${linkDir} untouched (real pnpm may not repoint it)`);
  } else {
    linkPlugin(linkDir);
    console.log(`fake pnpm: kept ${depName} (link repointed at ${pluginDir})`);
  }
  process.exit(0);
}

console.error(`fake pnpm: unsupported command ${command}`);
process.exit(2);
