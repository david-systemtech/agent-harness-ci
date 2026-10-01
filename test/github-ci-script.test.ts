/**
 * The `ci` relay's gitleaks step (`.forgejo/scripts/github-ci.sh`, #1096), run
 * by `bash` on a fake PATH: nothing here reaches GitHub. A fake `curl` serves
 * a fixture tarball whose `gitleaks` logs its call and reports a leak, so every
 * run stops at the scan, before the relay pushes anything. The fixture is not
 * the pinned release, so a `sha256sum` wrapper checks it against its own digest
 * wherever the script names the pinned one, and still compares real bytes: a
 * damaged copy fails the check as it would on the runner.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const script = join(root, ".forgejo", "scripts", "github-ci.sh");
const run = promisify(execFile);

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const VERSION = "8.30.1";
/** The script's pin for this machine, read from its own table. */
const PINNED = (() => {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const pin = new RegExp(`gl_arch=${arch} gl_sum=([0-9a-f]{64})`).exec(readFileSync(script, "utf8"));
  if (!pin?.[1]) throw new Error(`no gitleaks pin for ${arch} in github-ci.sh`);
  return pin[1];
})();
const URL = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_linux_${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`;

/** FAKE_CURL: `ok` serves the fixture, `bad` serves other bytes, `504` fails as curl does once its retries are spent. */
const FAKE_CURL = `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$FAKE_LOG"
out=
while [ $# -gt 0 ]; do [ "$1" = -o ] && { out=$2; shift; }; shift; done
case $FAKE_CURL in
  ok) cp "$FAKE_TARBALL" "$out" ;;
  bad) echo "not gitleaks" > "$out" ;;
  504) echo "curl: (22) The requested URL returned error: 504" >&2; exit 22 ;;
esac
`;

const FAKE_GITLEAKS = `#!/bin/sh
printf 'gitleaks %s\\n' "$*" >> "$FAKE_LOG"
exit 1
`;

interface Fixture {
  readonly log: string;
  readonly cache: string;
  readonly env: NodeJS.ProcessEnv;
}

const fixture = async (): Promise<Fixture> => {
  const dir = mkdtempSync(join(tmpdir(), "github-ci-script-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const release = join(dir, "release");
  const checkout = join(dir, "checkout");
  for (const folder of [bin, release, checkout]) mkdirSync(folder);

  writeFileSync(join(release, "gitleaks"), FAKE_GITLEAKS, { mode: 0o755 });
  const tarball = join(dir, "gitleaks.tar.gz");
  await run("tar", ["-czf", tarball, "-C", release, "gitleaks"]);
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");

  const sha256sum = (await run("bash", ["-c", "command -v sha256sum"])).stdout.trim();
  writeFileSync(join(bin, "curl"), FAKE_CURL);
  writeFileSync(join(bin, "sha256sum"), `#!/bin/sh\nprintf 'sha256sum %s\\n' "$*" >> "$FAKE_LOG"\nsed "s/^${PINNED} /${digest} /" | ${sha256sum} "$@"\n`);
  for (const tool of ["curl", "sha256sum"]) chmodSync(join(bin, tool), 0o755);

  const git = (...args: string[]) => run("git", ["-C", checkout, "-c", "user.name=Tests", "-c", "user.email=tests@example.invalid", ...args]);
  await git("init", "-q");
  await git("commit", "-q", "--allow-empty", "-m", "a commit");

  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const cache = join(dir, "toolcache");
  return {
    log,
    cache,
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      HOME: dir,
      GH_CI_TOKEN: "token-for-tests",
      GROUP: "1096",
      RUNNER_TOOL_CACHE: cache,
      FAKE_LOG: log,
      FAKE_TARBALL: tarball,
      FAKE_CURL: "ok",
    },
  };
};

const relay = async (f: Fixture, env: NodeJS.ProcessEnv = {}) => {
  const cwd = join(f.env["HOME"] ?? "", "checkout");
  try {
    const { stdout, stderr } = await run("bash", [script], { cwd, env: { ...f.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
};

/** The calls the fakes logged since the last read, by tool. */
const calls = (f: Fixture) => {
  const lines = readFileSync(f.log, "utf8").split("\n").filter(Boolean);
  writeFileSync(f.log, "");
  return lines.map((line) => line.split(" ")[0]);
};

const kept = (f: Fixture) => join(f.cache, "gitleaks", VERSION, `${PINNED}.tar.gz`);

describe("the relay's gitleaks", () => {
  it("keeps the checked download for the next run, which checks the kept copy again and does not download", async () => {
    const f = await fixture();

    const first = await relay(f);
    expect(first.code).toBe(1);
    expect(first.stdout).toContain("::error::gitleaks found a secret; nothing was pushed to GitHub");
    expect(calls(f)).toEqual(["curl", "sha256sum", "gitleaks"]);
    expect(existsSync(kept(f))).toBe(true);

    const second = await relay(f);
    expect(second.stdout).toContain("::error::gitleaks found a secret; nothing was pushed to GitHub");
    expect(calls(f)).toEqual(["sha256sum", "gitleaks"]);
    expect(readdirSync(join(f.cache, "gitleaks", VERSION))).toEqual([`${PINNED}.tar.gz`]);
  });
});
