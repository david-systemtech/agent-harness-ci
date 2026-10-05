import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { buildRelease } from "./build.js";
import { fixtureBuild, type FixtureBuild } from "../../test/release-fixtures.js";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
let fixture: FixtureBuild;
afterEach(() => fixture?.remove());

const addPhoneAssets = (root: string): void => {
  const web = join(root, "packages/gui/dist");
  cpSync(join(repository, "packages/gui/public"), web, { recursive: true });
  writeFileSync(join(web, "service-worker.js"), 'const publicAssets = ["/", "/assets/app.js", "/manifest.webmanifest", "/phone-icons/icon-192.png", "/phone-icons/icon-512.png"];\n');
  writeFileSync(join(web, "assets/app.css"), "/* bundled stylesheet */\n");
};

/** Compare every byte, including nested fonts/icons, with the build before packing. */
const sameBundle = (source: string, packaged: string): void => {
  expect(readdirSync(packaged).sort()).toEqual(readdirSync(source).sort());
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory()) sameBundle(join(source, entry.name), join(packaged, entry.name));
    else expect(readFileSync(join(packaged, entry.name))).toEqual(readFileSync(join(source, entry.name)));
  }
};

it.each([
  ["linux-x64", "agent-harness-linux-x64.tar.gz"],
  ["darwin-arm64", "agent-harness-darwin-arm64.tar.gz"],
  ["win32-x64", "agent-harness-win32-x64.zip"],
])("preserves the complete installable phone bundle in the packed and unpacked %s release", async (platform, archive) => {
  fixture = fixtureBuild({ host: platform });
  const compile = fixture.seams.compile!;
  await buildRelease(fixture.options({ platforms: [platform] }), {
    ...fixture.seams,
    compile: async (root, version) => { await compile(root, version); addPhoneAssets(root); },
  });
  const unpacked = join(fixture.out, "phone-unpacked"); mkdirSync(unpacked);
  const packed = join(fixture.out, archive);
  if (archive.endsWith(".zip")) execFileSync("python3", ["-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", packed, unpacked]);
  else execFileSync("tar", ["-xf", packed, "-C", unpacked]);
  const web = join(unpacked, "node_modules/@agent-harness/environment/dist/serve/web-client");
  sameBundle(join(fixture.root, "packages/gui/dist"), web);
  expect(JSON.parse(readFileSync(join(web, "version.json"), "utf8"))).toEqual({ version: "0.5.0" });
  expect(JSON.parse(readFileSync(join(web, "manifest.webmanifest"), "utf8"))).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone" });
  // A missing worker/icon must fail the same completeness assertion used above.
  rmSync(join(web, "service-worker.js"));
  expect(() => sameBundle(join(fixture.root, "packages/gui/dist"), web)).toThrow();
});

it("stages the same versioned phone assets into the container build output and replaces stale assets", async () => {
  fixture = fixtureBuild();
  await fixture.seams.compile!(fixture.root, "0.5.0");
  addPhoneAssets(fixture.root);
  const script = join(fixture.root, "scripts/stage-web-client.mjs");
  mkdirSync(dirname(script), { recursive: true });
  cpSync(join(repository, "scripts/stage-web-client.mjs"), script);
  const destination = join(fixture.root, "packages/environment/dist/serve/web-client");
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "stale.js"), "stale asset");
  execFileSync(process.execPath, [script]);
  execFileSync(process.execPath, [join(repository, "scripts/image-version.mjs"), "0.5.0"], { cwd: fixture.root });
  sameBundle(join(fixture.root, "packages/gui/dist"), destination);
  expect(JSON.parse(readFileSync(join(destination, "version.json"), "utf8"))).toEqual({ version: "0.5.0" });
  expect(JSON.parse(readFileSync(join(fixture.root, "packages/environment/package.json"), "utf8")).version).toBe("0.5.0");
  const dockerfile = readFileSync(join(repository, "Dockerfile"), "utf8");
  expect(dockerfile).toContain('HARNESS_VERSION="$HARNESS_VERSION" pnpm --filter @agent-harness/gui build');
  expect(dockerfile).toContain("node scripts/stage-web-client.mjs");
  expect(dockerfile).toContain("COPY --from=build /opt/agent-harness /opt/agent-harness");
});

it("refuses a release whose client build has a different version", async () => {
  fixture = fixtureBuild();
  const compile = fixture.seams.compile!;
  await expect(buildRelease(fixture.options({ platforms: ["linux-x64"] }), {
    ...fixture.seams,
    compile: async (root, version) => {
      await compile(root, version);
      writeFileSync(join(root, "packages/gui/dist/version.json"), JSON.stringify({ version: "0.4.0" }));
    },
  })).rejects.toThrow("web bundle must match");
});
