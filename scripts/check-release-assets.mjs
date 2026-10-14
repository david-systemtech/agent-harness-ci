// Release N+1 (#2171): six builds, release.json and one SHA256SUMS; no .sha256 sidecars.
// Support files come from the tag's repository paths (#2147).
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
assert.deepEqual(readdirSync(folder).sort(), [...names, "SHA256SUMS"].sort(), "Six builds, release.json and SHA256SUMS: eight assets");
const lines = [];
for (const name of names) {
  const bytes = readFileSync(join(folder, name));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const asset = manifest.assets.find((entry) => entry.name === name);
  if (asset) {
    assert.equal(bytes.length, asset.size, `${name}: manifest size`);
    assert.equal(digest, asset.sha256, `${name}: manifest digest`);
  }
  lines.push(`${digest}  ${name}\n`);
}
assert.equal(readFileSync(join(folder, "SHA256SUMS"), "utf8"), lines.join(""), "SHA256SUMS: one sha256sum line per build and release.json");
log("Verified six builds, release.json and SHA256SUMS");
