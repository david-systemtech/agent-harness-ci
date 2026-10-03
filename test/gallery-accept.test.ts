import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "../scripts/gallery-accept.sh");
const require = createRequire(new URL("../packages/gui/package.json", import.meta.url));
const core = dirname(require.resolve("playwright-core/package.json", { paths: [dirname(require.resolve("playwright"))] }));
const { PNG } = require(join(core, "lib/utilsBundle.js")) as {
  PNG: { sync: { write(image: { width: number; height: number; data: Buffer }): Buffer } };
};
const png = PNG.sync.write({ width: 1400, height: 900, data: Buffer.alloc(1400 * 900 * 4, 255) });
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(mode = "current") {
  const folder = mkdtempSync(join(tmpdir(), "gallery-accept-"));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, "bin"));
  writeFileSync(join(folder, "bin/git"), `#!/bin/sh\ncase "$*" in\n *--show-toplevel*) printf '%s\\n' "$GALLERY_TEST_ROOT";;\n *get-url*) echo https://forge.example.invalid/example/project.git;;\n *HEAD*) echo "\${GALLERY_TEST_HEAD:-test-head}";;\n *) exit 1;;\nesac\n`, { mode: 0o755 });
  const requests: string[] = [];
  let base = "";
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    expect(request.headers.authorization).toBe("token token-for-tests");
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("/pulls/")) response.end(JSON.stringify({ head: { sha: "test-head", ref: "build/42-gallery" } }));
    else if (request.url?.includes("/comments")) {
      const captures = [{ name: "window-empty.dark.png", url: `${base}/attachments/capture`, api_url: `${base}/api/packages/example/generic/window-gallery/test-head/window-empty.dark.png` }];
      if (mode === "unsafe") captures.push({ name: "../escape.dark.png", url: `${base}/attachments/capture`, api_url: `${base}/api/packages/example/generic/window-gallery/test-head/escape.dark.png` });
      if (mode === "foreign") captures[0]!.api_url = "https://elsewhere.example.invalid/api/packages/example/generic/window-gallery/test-head/window-empty.dark.png";
      const manifest = { body: '<!-- window-gallery ' + JSON.stringify({ head: mode === "stale" ? "old-head" : "test-head", captures }) + ' -->' };
      if (mode === "marker") manifest.body = '<!-- window-gallery {"head":"test-head","captures":[]} -->\n' + manifest.body;
      const page = new URL(request.url, base).searchParams.get("page");
      response.end(JSON.stringify(mode === "paged" && page === "1" ? Array.from({ length: 50 }, () => ({ body: "Earlier discussion" })) : [manifest]));
    } else if (request.url?.startsWith("/attachments/")) response.writeHead(401).end();
    else response.end(mode === "corrupt" ? Buffer.from("not an image") : png);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no fixture address");
  base = `http://127.0.0.1:${address.port}`;
  return { folder, requests, env: { ...process.env, GALLERY_TEST_ROOT: folder, GALLERY_TEST_HEAD: mode === "wrong-head" ? "another-head" : "test-head", PATH: `${folder}/bin:${process.env["PATH"]}`, FORGEJO_URL: base, FORGEJO_REPOSITORY: "example/project", FORGEJO_TOKEN: "token-for-tests" } };
}

it("accepts the current head's attached capture into the baseline directory", async () => {
  const f = await fixture();
  const result = await run("bash", [script, "42"], { env: f.env });
  expect(result.stdout).toContain("Accepted window-empty.dark.png");
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/window-empty.dark.png"))).toEqual(png);
});

it.each(["stale", "unsafe", "foreign", "corrupt"])("refuses %s captures without writing any baseline", async (mode) => {
  const f = await fixture(mode);
  const result = run("bash", [script, "42"], { env: f.env });
  if (mode === "foreign") {
    await expect(result).rejects.toMatchObject({ stderr: expect.stringContaining("Invalid gallery attachment origin.") });
    expect(f.requests.some((url) => url.startsWith("/api/packages/"))).toBe(false);
  } else await expect(result).rejects.toThrow();
  expect(existsSync(join(f.folder, "packages/gui/gallery/baselines"))).toBe(false);
});

it("finds the current capture manifest after a capped 50-comment page", async () => {
  const f = await fixture("paged");
  const result = await run("bash", [script, "42"], { env: f.env });
  expect(result.stdout).toContain("Accepted window-empty.dark.png");
  expect(f.requests.some((url) => url.includes("limit=50&page=2"))).toBe(true);
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/window-empty.dark.png"))).toEqual(png);
});

it("prints the exact staging, commit and branch push commands after acceptance", async () => {
  const f = await fixture();
  const result = await run("bash", [script, "42"], { env: f.env });
  expect(result.stdout).toContain(`git -C ${f.folder} add -- packages/gui/gallery/baselines/window-empty.dark.png`);
  expect(result.stdout).toContain(`git -C ${f.folder} commit -m 'gallery: accept reviewed captures (PR #42)'`);
  expect(result.stdout).toContain(`git -C ${f.folder} push origin HEAD:build/42-gallery`);
});

it("refuses a different working-tree head before reading comments or writing baselines", async () => {
  const f = await fixture("wrong-head");
  await expect(run("bash", [script, "42"], { env: f.env })).rejects.toMatchObject({ stderr: expect.stringContaining("Check out the PR head") });
  expect(f.requests).toHaveLength(1);
  expect(existsSync(join(f.folder, "packages/gui/gallery/baselines"))).toBe(false);
});

it("uses the final current-head manifest after a marker in reported failure text", async () => {
  const f = await fixture("marker");
  await run("bash", [script, "42"], { env: f.env });
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/window-empty.dark.png"))).toEqual(png);
});
