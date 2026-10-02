/** The image's dependency fetch, over a fake package manager and held timers. No image or network is used. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const script = join(import.meta.dirname, "..", ".forgejo", "scripts", "image-deps.sh");
const run = promisify(execFile);
const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "image-deps-"));
  cleanups.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls");
  writeFileSync(log, "");
  const fake = (name: string, text: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${text}`, { mode: 0o755 });
  fake("pnpm", `
echo "pnpm $*" >> "$FETCH_LOG"
count=$(cat "$FETCH_STATE" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$FETCH_STATE"
if [ "$count" -le "\${FETCH_FAILURES:-0}" ]; then
  echo "\${FETCH_ERROR:-EAI_AGAIN}" >&2
  echo cached-package > "$FETCH_CACHE"
  exit 1
fi
if [ "$count" -gt 1 ]; then
  [ "$(cat "$FETCH_CACHE")" = cached-package ] || exit 2
fi
`);
  fake("timeout", `
echo "timeout $*" >> "$FETCH_LOG"
shift 2
if [ "\${FETCH_TIMED_OUT:-false}" = true ]; then exit 124; fi
exec "$@"
`);
  fake("sleep", 'echo "sleep $*" >> "$FETCH_LOG"\n');
  const env = {
    PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    FETCH_LOG: log,
    FETCH_STATE: join(dir, "state"),
    FETCH_CACHE: join(dir, "cache"),
  };
  return {
    calls: () => readFileSync(log, "utf8").trim().split("\n"),
    fetch: async (overrides: NodeJS.ProcessEnv = {}) => {
      try {
        const result = await run("bash", [script], { env: { ...env, ...overrides } });
        return { ...result, code: 0 };
      } catch (error) {
        return error as { code: number; stdout: string; stderr: string };
      }
    },
  };
};

it("recovers from a failed registry fetch while retaining the completed packages", async () => {
  const f = fixture();
  const result = await f.fetch({ FETCH_FAILURES: "1" });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("EAI_AGAIN");
  expect(f.calls().filter((call) => call.startsWith("pnpm "))).toHaveLength(2);
  expect(f.calls()).toContain("sleep 10");
});

it("bounds persistent connection failures and reports the final exit without clearing the cache", async () => {
  const f = fixture();
  const result = await f.fetch({ FETCH_FAILURES: "3", FETCH_ERROR: "ECONNRESET" });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("fetch attempt 2/2 failed (exit 1)");
  expect(result.stderr).toContain("fetch exhausted; completed packages remain cached for the next build");
  expect(f.calls().filter((call) => call.startsWith("pnpm "))).toHaveLength(2);
  expect(f.calls().filter((call) => call.startsWith("sleep "))).toEqual(["sleep 10"]);
  // The next build starts a new script process over the same completed downloads.
  expect((await f.fetch()).code).toBe(0);
  expect(f.calls().filter((call) => call.startsWith("pnpm "))).toHaveLength(3);
});

it("bounds stalled downloads independently of the package manager's request timeout", async () => {
  const f = fixture();
  const result = await f.fetch({ FETCH_TIMED_OUT: "true" });
  expect(result.code).toBe(124);
  expect(result.stderr).toContain("fetch attempt 2/2 failed (exit 124)");
  const timers = f.calls().filter((call) => call.startsWith("timeout "));
  expect(timers).toHaveLength(2);
  for (const timer of timers) expect(timer).toMatch(/^timeout --kill-after=30s 540s pnpm fetch /);
});

it("fetches the pinned packages with integrity checks and bounded registry retries, stopping on success", async () => {
  const f = fixture();
  expect((await f.fetch()).code).toBe(0);
  const calls = f.calls().filter((call) => call.startsWith("pnpm "));
  expect(calls).toHaveLength(1);
  const args = calls[0]?.split(" ");
  expect(args).toEqual(expect.arrayContaining([
    "fetch", "--frozen-lockfile", "--store-dir=/pnpm/store", "--verify-store-integrity=true",
    "--network-concurrency=8", "--fetch-timeout=120000", "--fetch-retries=3",
    "--fetch-retry-factor=2", "--fetch-retry-mintimeout=10000", "--fetch-retry-maxtimeout=30000",
  ]));
  expect(f.calls().filter((call) => call.startsWith("sleep "))).toEqual([]);
});
