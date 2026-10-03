import assert from "node:assert/strict";
import { log } from "node:console";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

// Run with the packaged Node after readiness. Both the shipped build and the
// folder startup supplied for Chrome must carry this release's complete assets.
const [server, dataDir, version] = process.argv.slice(2);
assert.ok(server && dataDir && version, "Expected server directory, data directory and release version");
const source = resolve(server, "node_modules/@agent-harness/extension/dist");
const current = resolve(dataDir, "extension/current");
for (const folder of [source, current]) {
  const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version_name, version, `${folder} must carry the release version`);
  for (const asset of [manifest.background.service_worker, manifest.options_ui.page, "options.js"]) {
    assert.ok(statSync(join(folder, asset)).isFile(), `${asset} must be a file`);
    assert.ok(readFileSync(join(folder, asset)).length > 0, `${asset} must not be empty`);
  }
}
// Includes shared chunks as well as the worker, manifest and options page.
for (const asset of readdirSync(source, { recursive: true })) {
  if (statSync(join(source, asset)).isFile()) {
    assert.deepEqual(readFileSync(join(current, asset)), readFileSync(join(source, asset)), `${asset} must match the shipped build`);
  }
}
log(`Verified packaged browser extension ${version}; Load unpacked: ${current}`);
