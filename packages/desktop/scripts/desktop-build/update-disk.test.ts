import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { DATABASE_FILE, LAUNCHER_PROTOCOL } from "@agent-harness/contracts/launcher";
import { expect, it } from "vitest";
import { build } from "vite";
import { releaseWorkflowInput } from "../../../../test/release-workflow-input.js";

const root = join(import.meta.dirname, "../../../..");
it("runs the disk smoke against built staging and launcher modules, without a service manager", async () => {
  const server = mkdtempSync(join(tmpdir(), "packaged-disk-fixture-"));
  try {
    for (const [entry, output] of [
      ["packages/environment/src/updates/staging.ts", "node_modules/@agent-harness/environment/dist/updates/staging.js"],
      ["packages/cli/src/launch/launcher.ts", "packages/cli/dist/launch/launcher.js"],
    ]) {
      const destination = join(server, output!);
      await build({ configFile: false, ssr: { noExternal: true, resolve: { conditions: ["@agent-harness/source", "node"] } }, logLevel: "silent", build: {
        ssr: join(root, entry!), target: "node24", outDir: dirname(destination), emptyOutDir: false,
        rolldownOptions: { external: (id) => id.startsWith("node:") || builtinModules.includes(id), output: { format: "es", entryFileNames: destination.split(/[\\/]/).at(-1)! } },
      } });
    }
    const file = (path: string, text: string) => {
      mkdirSync(dirname(join(server, path)), { recursive: true });
      writeFileSync(join(server, path), text);
    };
    file("package.json", '{"type":"module"}');
    file("packages/cli/package.json", '{"type":"module","version":"0.6.0"}');
    file("packages/cli/dist/main.js", "");
    file("node_modules/@agent-harness/contracts/package.json", '{"type":"module","exports":{"./launcher":"./launcher.js"}}');
    file("node_modules/@agent-harness/contracts/launcher.js", `export const DATABASE_FILE = ${JSON.stringify(DATABASE_FILE)}; export const LAUNCHER_PROTOCOL = ${LAUNCHER_PROTOCOL};`);
    const node = join(server, process.platform === "win32" ? "node/node.exe" : "node/bin/node");
    mkdirSync(dirname(node), { recursive: true });
    copyFileSync(process.execPath, node);
    const result = await promisify(execFile)(process.execPath, [join(root, "scripts/check-packaged-update-disk.mjs"), server]);
    expect(result.stdout).toContain("Verified packaged staging budget and refused-switch candidate reclamation");
  } finally {
    rmSync(server, { recursive: true, force: true });
  }
}, 180_000);

it("runs the packaged update disk check in all three release smoke jobs", () => {
  const workflow = releaseWorkflowInput(root).hosted;
  for (const name of ["windows", "macos", "linux"]) {
    const job = workflow.split(`  smoke-${name}:`)[1]!.split(/^ {2}[a-z-]+:/m)[0]!;
    expect(job).toContain("scripts/check-packaged-update-disk.mjs");
  }
  expect(workflow).toContain("(Resolve-Path 'scripts/check-packaged-update-disk.mjs').Path -Destination");
});
