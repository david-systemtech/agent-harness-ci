import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { log } from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// Use the shipped command table and the image's real prerequisites as its ordinary user.
// Ignore package managers when choosing the fallback; install only in a disposable home.
const server = resolve(process.argv[2]);
const require = createRequire(join(server, "packages/cli/package.json"));
const { installChoice } = await import(pathToFileURL(require.resolve("@agent-harness/contracts")));
const programs = new Set(["curl", "tar", "sha256sum", "shasum"].filter((name) =>
  spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0));
const entry = installChoice("bao", process.platform, (name) => programs.has(name));
assert.equal(entry?.method, "script", "The shipped artefact must qualify for bao's archive install without sudo or a package manager");
const home = mkdtempSync(join(tmpdir(), "packaged-bao-install-"));
const env = { ...process.env, HOME: home, SHELL: "/bin/sh" };
try {
  for (const step of entry.install) {
    assert.equal(step.length, 1, "The archive installer must need no pipeline");
    const [file, ...args] = step[0];
    execFileSync(file, args, { env, stdio: "inherit" });
  }
  const path = execFileSync("sh", ["-c", '. "$HOME/.profile"; command -v bao'], { env, encoding: "utf8" }).trim();
  assert.equal(path, join(home, ".local/bin/bao"), "The next profile read must find the user-local bao");
  const version = execFileSync(path, ["--version"], { env, encoding: "utf8" }).trim();
  assert.match(version, /^OpenBao v[0-9]/);
  log("Verified packaged bao archive install: checksum checked, no sudo, user-local binary on the login PATH");
} finally {
  rmSync(home, { recursive: true, force: true });
}
