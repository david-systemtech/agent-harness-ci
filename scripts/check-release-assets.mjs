// Release N keeps sidecars for installed clients; support files come from its tag.
import process from "node:process";
import { log } from "node:console";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const folder = process.argv[2];
assert(folder, "Pass the release assets directory");
const manifest = JSON.parse(readFileSync(join(folder, "release.json"), "utf8"));
const builds = [
  "environment:linux-x64:tar.gz", "environment:darwin-arm64:tar.gz", "environment:win32-x64:zip",
  "desktop:linux-x64:pacman", "desktop:darwin-arm64:zip", "desktop:win32-x64:nsis",
];
assert.deepEqual(manifest.assets.map(({ kind, platform, format }) => `${kind}:${platform}:${format}`).sort(), builds.sort());
const names = [...manifest.assets.map(({ name }) => name), "release.json"];
assert.equal(new Set(names).size, 7, "Each build needs a unique name");
assert.deepEqual(readdirSync(folder).sort(), names.flatMap((name) => [name, `${name}.sha256`]).sort());
for (const name of names) {
  const bytes = readFileSync(join(folder, name));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const asset = manifest.assets.find((entry) => entry.name === name);
  if (asset) {
    assert.equal(bytes.length, asset.size, `${name}: manifest size`);
    assert.equal(digest, asset.sha256, `${name}: manifest digest`);
  }
  assert.equal(readFileSync(join(folder, `${name}.sha256`), "utf8"), `${digest}  ${name}\n`, `${name}: compatibility sidecar`);
}
log("Verified six builds and their compatibility sidecars");
