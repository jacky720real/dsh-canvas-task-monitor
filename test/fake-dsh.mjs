// Fake `dsh` shim used only by test/selftest.ps1. It records the forwarded
// arguments and then delegates to the fake package manager, so the script's
// "dsh plugin ..." channel can be exercised without touching a real profile.
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (process.env.FAKE_DSH_LOG) {
  writeFileSync(process.env.FAKE_DSH_LOG, JSON.stringify(args), "utf8");
}
console.log(`fake dsh: ${args.join(" ")}`);

const last = args[args.length - 1];
const command = last === "install" ? "install" : "add";
const spec = last;
const result = spawnSync(process.execPath, [join(here, "fake-pnpm.mjs"), command, spec], {
  stdio: "inherit",
  // `dsh plugin add` reconciles dsh.profile.bundles itself once pnpm succeeds.
  env: { ...process.env, FAKE_PNPM_RECONCILE: "1" }
});
process.exit(result.status === null ? 2 : result.status);
