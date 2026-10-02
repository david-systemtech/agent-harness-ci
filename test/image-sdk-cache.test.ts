/** The optional image download source, over a loopback package registry and real pnpm. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const packageManager = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { packageManager: string }).packageManager;
const script = join(import.meta.dirname, "..", "scripts", "image-sdk-cache.mjs");
const run = promisify(execFile);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const fixture = (archive: Buffer) => {
  const dir = mkdtempSync(join(tmpdir(), "image-sdk-cache-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const lock = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .:
    dependencies:
      '@anthropic-ai/claude-agent-sdk-linux-x64':
        specifier: 0.3.283
        version: 0.3.283
packages:
  '@anthropic-ai/claude-agent-sdk-linux-x64@0.3.283':
    resolution: {integrity: ${integrity}}
snapshots:
  '@anthropic-ai/claude-agent-sdk-linux-x64@0.3.283': {}
`;
  writeFileSync(join(dir, "pnpm-lock.yaml"), lock);
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "image-fixture", version: "1.0.0", packageManager,
    dependencies: { "@anthropic-ai/claude-agent-sdk-linux-x64": "0.3.283" },
  }));
  return {
    dir, lock,
    archive: join(dir, ".image-sdk-cache", "sdk.tgz"),
    invoke: async (args: string[], env: NodeJS.ProcessEnv = {}) => {
      try {
        const result = await run("node", [script, ...args], { cwd: dir, env: { ...process.env, NODE_PATH: "", ...env } });
        return { ...result, code: 0 };
      } catch (error) {
        return error as { code: number; stdout: string; stderr: string };
      }
    },
  };
};

const registry = async (archive: Buffer, status = 200) => {
  const requests: { path: string | undefined; authorization: string | undefined }[] = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    res.writeHead(status);
    res.end(archive);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("registry did not listen");
  return { base: `http://127.0.0.1:${address.port}/api/packages/fixture/generic`, requests, respond: (code: number) => { status = code; } };
};

it("downloads the exact lockfile pin from the authenticated generic registry without changing the lockfile", async () => {
  const bytes = Buffer.from("fixture SDK archive");
  const f = fixture(bytes);
  const source = await registry(bytes);
  const result = await f.invoke(["download"], { IMAGE_SDK_CACHE_BASE: source.base, FORGEJO_TOKEN: "token-for-tests" });
  expect(result.code).toBe(0);
  expect(existsSync(f.archive)).toBe(true);
  expect(readFileSync(f.archive)).toEqual(bytes);
  expect(readFileSync(join(f.dir, "pnpm-lock.yaml"), "utf8")).toBe(f.lock);
  expect(source.requests).toEqual([{
    path: "/api/packages/fixture/generic/claude-agent-sdk-linux-x64/0.3.283/claude-agent-sdk-linux-x64-0.3.283.tgz",
    authorization: "token token-for-tests",
  }]);
  expect(result.stdout + result.stderr).not.toContain("token-for-tests");
});

it("warns and falls back to npm without retaining a corrupt source", async () => {
  const f = fixture(Buffer.from("expected archive"));
  const source = await registry(Buffer.from("different archive"));
  const result = await f.invoke(["download"], { IMAGE_SDK_CACHE_BASE: source.base, FORGEJO_TOKEN: "token-for-tests" });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("does not match lockfile integrity; using npm");
  expect(existsSync(f.archive)).toBe(false);
  expect(readFileSync(join(f.dir, "pnpm-lock.yaml"), "utf8")).toBe(f.lock);
});

it("checks a supplied archive again before pnpm can treat the SDK as an optional dependency", async () => {
  const f = fixture(Buffer.from("expected archive"));
  mkdirSync(join(f.dir, ".image-sdk-cache"));
  writeFileSync(f.archive, "tampered archive");
  const result = await f.invoke(["fetch", "--frozen-lockfile", `--store-dir=${join(f.dir, "store")}`]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("does not match lockfile integrity");
  expect(existsSync(join(f.dir, "store"))).toBe(false);
});

it("leaves public builds on npm when the source is absent or unavailable, discarding a stale archive", async () => {
  const f = fixture(Buffer.from("expected archive"));
  for (const env of [{}, { IMAGE_SDK_CACHE_BASE: (await registry(Buffer.from("unavailable"), 503)).base, FORGEJO_TOKEN: "token-for-tests" }]) {
    mkdirSync(join(f.dir, ".image-sdk-cache"), { recursive: true });
    writeFileSync(f.archive, "stale archive");
    const result = await f.invoke(["download"], { IMAGE_SDK_CACHE_BASE: "", FORGEJO_TOKEN: "", ...env });
    expect(result.code).toBe(0);
    expect(existsSync(f.archive)).toBe(false);
  }
});

it("imports a cold cache through pnpm and reuses completed downloads after a transient registry failure", async () => {
  const f = fixture(Buffer.from("placeholder"));
  const pack = join(f.dir, "pack");
  mkdirSync(join(pack, "package"), { recursive: true });
  writeFileSync(join(pack, "package", "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk-linux-x64", version: "0.3.283", main: "index.js" }));
  writeFileSync(join(pack, "package", "index.js"), 'module.exports = "fixture SDK";\n');
  const tarball = join(f.dir, "fixture.tgz");
  await run("tar", ["-czf", tarball, "-C", pack, "package"]);
  const bytes = readFileSync(tarball);
  const lock = f.lock.replace(/sha512-[A-Za-z0-9+/=]+/, `sha512-${createHash("sha512").update(bytes).digest("base64")}`);
  writeFileSync(join(f.dir, "pnpm-lock.yaml"), lock);
  mkdirSync(join(f.dir, ".image-sdk-cache"));
  writeFileSync(f.archive, bytes);
  const store = `--store-dir=${join(f.dir, "store")}`;
  const result = await f.invoke(["fetch", "--frozen-lockfile", store, "--verify-store-integrity=true"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  expect(readFileSync(join(f.dir, "pnpm-lock.yaml"), "utf8")).toBe(lock);
  // Install in the original workspace; the fetch's temporary workspace is gone.
  await run("pnpm", ["install", "--frozen-lockfile", "--offline", "--ignore-scripts", store], { cwd: f.dir });
  expect(readFileSync(join(f.dir, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64", "index.js"), "utf8")).toContain("fixture SDK");
  // A later build has another missing package and no supplied archive. A
  // transient registry failure must retain the already completed SDK download.
  rmSync(join(f.dir, "node_modules"), { recursive: true });
  rmSync(join(f.dir, ".image-sdk-cache"), { recursive: true });
  writeFileSync(join(pack, "package", "package.json"), JSON.stringify({ name: "fixture-resume", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(pack, "package", "index.js"), 'module.exports = "resumed package";\n');
  await run("tar", ["-czf", tarball, "-C", pack, "package"]);
  const nextBytes = readFileSync(tarball);
  const nextIntegrity = `sha512-${createHash("sha512").update(nextBytes).digest("base64")}`;
  const source = await registry(nextBytes, 503);
  const nextLock = lock.replace("packages:\n", `      fixture-resume:
        specifier: 1.0.0
        version: 1.0.0
packages:
  fixture-resume@1.0.0:
    resolution: {integrity: ${nextIntegrity}, tarball: ${source.base}/fixture.tgz}
`).replace("snapshots:\n", "snapshots:\n  fixture-resume@1.0.0: {}\n");
  writeFileSync(join(f.dir, "pnpm-lock.yaml"), nextLock);
  const fetchArgs = ["fetch", "--frozen-lockfile", store, "--fetch-retries=0"];
  expect((await f.invoke(fetchArgs)).code).toBe(1);
  source.respond(200);
  expect((await f.invoke(fetchArgs)).code).toBe(0);
  // The public path also works with no source archive and no network access.
  expect((await f.invoke(["fetch", "--frozen-lockfile", "--offline", store])).code).toBe(0);
  expect(source.requests).toHaveLength(2);
});

it("fails the image check when the optional SDK binary was skipped, and passes when it resolves", async () => {
  const f = fixture(Buffer.from("unused archive"));
  const sdk = join(f.dir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", main: "sdk.js" }));
  writeFileSync(join(sdk, "sdk.js"), "");
  const missing = await f.invoke(["check"]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("required Linux SDK is missing");
  const native = join(f.dir, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64");
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk-linux-x64" }));
  writeFileSync(join(native, "claude"), "fixture binary");
  expect((await f.invoke(["check"])).code).toBe(0);
});

it("warns and falls back to npm when the cache cannot read the lockfile pin", async () => {
  const f = fixture(Buffer.from("unused archive"));
  writeFileSync(join(f.dir, "pnpm-lock.yaml"), "lockfileVersion: '10.0'\n");
  const source = await registry(Buffer.from("unused"));
  const result = await f.invoke(["download"], { IMAGE_SDK_CACHE_BASE: source.base, FORGEJO_TOKEN: "token-for-tests" });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("lockfile pin not found; using npm");
  expect(source.requests).toEqual([]);
  expect(existsSync(f.archive)).toBe(false);
});

it("seeds only the SDK before fetching the real workspace, without a second workspace install", async () => {
  const f = fixture(Buffer.from("verified fixture archive"));
  mkdirSync(join(f.dir, ".image-sdk-cache"));
  writeFileSync(f.archive, "verified fixture archive");
  const workspaceLock = f.lock.replace("packages:\n", "packages:\n  fixture-other@1.0.0:\n    resolution: {integrity: sha512-Zml4dHVyZQ==}\n").replace("snapshots:\n", "snapshots:\n  fixture-other@1.0.0: {}\n");
  writeFileSync(join(f.dir, "pnpm-lock.yaml"), workspaceLock);
  const bin = join(f.dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), `#!/bin/sh
if [ "$1" = --dir ]; then
  cp "$2/pnpm-lock.yaml" "$FETCH_SCRATCH_LOCK"
  printf 'scratch\n' >> "$FETCH_CALLS"
else
  printf 'workspace\n' >> "$FETCH_CALLS"
fi
`, { mode: 0o755 });
  const calls = join(f.dir, "fetch-calls");
  const scratchLock = join(f.dir, "scratch-lock");
  const result = await f.invoke(["fetch", "--frozen-lockfile"], {
    PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    FETCH_SCRATCH_LOCK: scratchLock, FETCH_CALLS: calls,
  });
  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(scratchLock, "utf8")).not.toContain("fixture-other");
  expect(readFileSync(calls, "utf8")).toBe("scratch\nworkspace\n");
  expect(readFileSync(join(f.dir, "pnpm-lock.yaml"), "utf8")).toBe(workspaceLock);
});

it.each([401, 404, 503])("logs HTTP %s before falling back without credentials or an unchecked archive", async (status) => {
  const f = fixture(Buffer.from("expected archive"));
  const source = await registry(Buffer.from("unavailable"), status);
  const result = await f.invoke(["download"], { IMAGE_SDK_CACHE_BASE: source.base, FORGEJO_TOKEN: "token-for-tests" });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain(`HTTP ${status}; using npm`);
  expect(result.stdout + result.stderr).not.toContain("token-for-tests");
  expect(existsSync(f.archive)).toBe(false);
});
