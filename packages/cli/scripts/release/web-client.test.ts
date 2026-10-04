import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildRelease } from "./build.js";
import { fixtureBuild, type FixtureBuild } from "../../test/release-fixtures.js";

let fixture: FixtureBuild;
afterEach(() => fixture?.remove());
it.each([
  ["linux-x64", "agent-harness-linux-x64.tar.gz"],
  ["darwin-arm64", "agent-harness-darwin-arm64.tar.gz"],
  ["win32-x64", "agent-harness-win32-x64.zip"],
])("ships the version-matched web bundle in the unpacked %s server", async (platform, archive) => {
  fixture = fixtureBuild({ host: platform });
  await buildRelease(fixture.options({ tag: "v0.5.0", platforms: [platform] }), fixture.seams);
  const unpacked = join(fixture.out, "unpacked"); mkdirSync(unpacked);
  if (archive.endsWith(".zip")) execFileSync("python3", ["-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", join(fixture.out, archive), unpacked]);
  else execFileSync("tar", ["-xf", join(fixture.out, archive), "-C", unpacked]);
  const web = join(unpacked, "node_modules/@agent-harness/environment/dist/serve/web-client");
  expect(readFileSync(join(web, "index.html"), "utf8")).toContain("assets/app.js");
  expect(JSON.parse(readFileSync(join(web, "version.json"), "utf8"))).toEqual({ version: "0.5.0" });
  expect(readFileSync(join(web, "assets/app.js"), "utf8")).toContain("fixture web client");
});
