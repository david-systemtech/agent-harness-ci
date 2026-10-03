import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildExtension } from "../../../extension/scripts/build.js";
import { extensionFolder } from "../../../environment/src/browser/extension-folder.js";
import { fixtureBuild, type FixtureBuild } from "../../test/release-fixtures.js";
import { buildRelease } from "./build.js";

let fixture: FixtureBuild;
afterEach(() => fixture?.remove());

it.each([
  ["linux-x64", "agent-harness-linux-x64.tar.gz"],
  ["darwin-arm64", "agent-harness-darwin-arm64.tar.gz"],
  ["win32-x64", "agent-harness-win32-x64.zip"],
])("ships a usable Load unpacked folder in the %s release", async (platform, archive) => {
  fixture = fixtureBuild({ host: platform });
  const version = "0.5.0-rc.2";
  await buildRelease(fixture.options({ tag: `v${version}`, platforms: [platform] }), {
    ...fixture.seams,
    compile: async (root, releaseVersion) => {
      await fixture.seams.compile!(root, releaseVersion);
      await buildExtension({ outDir: join(root, "packages/extension/dist"), version: releaseVersion });
    },
  });
  const into = join(fixture.out, "unpacked");
  mkdirSync(into);
  const packed = join(fixture.out, archive);
  if (archive.endsWith(".zip")) {
    execFileSync("python3", ["-c", "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nz.extractall(sys.argv[2])", packed, into]);
  } else execFileSync("tar", ["-xf", packed, "-C", into]);
  const source = join(into, "node_modules/@agent-harness/extension/dist");
  const packageManifest = JSON.parse(readFileSync(join(source, "../package.json"), "utf8")) as { version: string };
  expect(packageManifest.version).toBe(version);
  const folder = extensionFolder({ source, dataDir: join(into, "profile") });
  expect(await folder.ensure(null)).toEqual({ shippedVersion: version, problem: null });
  const manifest = JSON.parse(readFileSync(join(folder.path, "manifest.json"), "utf8")) as {
    version_name: string; background: { service_worker: string }; options_ui: { page: string };
  };
  expect(manifest.version_name).toBe(version);
  expect(readFileSync(join(folder.path, manifest.background.service_worker), "utf8")).toContain("chrome");
  expect(readFileSync(join(folder.path, manifest.options_ui.page), "utf8")).toContain("options.js");
  expect(readdirSync(folder.path)).toContain("options.js");
  const check = join(import.meta.dirname, "../../../../scripts/check-packaged-extension.mjs");
  const args = [check, into, join(into, "profile"), version];
  expect(execFileSync(process.execPath, args, { encoding: "utf8" })).toContain(folder.path);
  // Startup alone is insufficient: stale manifests or missing runtime assets must fail the smoke.
  expect(() => execFileSync(process.execPath, [check, into, join(into, "profile"), "0.5.1"], { stdio: "pipe" })).toThrow();
  for (const asset of readdirSync(source)) {
    expect(readFileSync(join(folder.path, asset))).toEqual(readFileSync(join(source, asset)));
  }
  rmSync(join(folder.path, "options.js"));
  expect(() => execFileSync(process.execPath, args, { stdio: "pipe" })).toThrow();
}, 120_000);
