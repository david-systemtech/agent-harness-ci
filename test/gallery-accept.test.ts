import { createHash, randomBytes } from "node:crypto";
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

async function fixture(mode = "current", count = 1) {
  let image = png;
  if (mode === "large") image = PNG.sync.write({ width: 1400, height: 900, data: randomBytes(1400 * 900 * 4) });
  else if (mode === "total-large") image = Buffer.concat([png, Buffer.alloc(13 * 1024 * 1024)]);
  else if (mode === "response-large") image = Buffer.concat([png, Buffer.alloc(24 * 1024 * 1024)]);
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
      const version = ["versioned", "digest-mismatch", "wrong-version", "spoofed", "unbound", "large", "total-large", "response-large"].includes(mode) ? (mode === "wrong-version" ? "another-head-123" : "test-head-123") : "test-head";
      const captures = Array.from({ length: count }, (_, i) => {
        const name = count === 1 ? "window-empty.dark.png" : `scene-${i}.dark.png`;
        return { name, url: `${base}/attachments/capture`, api_url: `${base}/api/packages/example/generic/window-gallery/${version}/${name}`, sha256: createHash("sha256").update(mode === "digest-mismatch" ? "different bytes" : image).digest("hex") };
      });
      if (mode === "unsafe") captures.push({ name: "../escape.dark.png", url: `${base}/attachments/capture`, api_url: `${base}/api/packages/example/generic/window-gallery/test-head/escape.dark.png`, sha256: createHash("sha256").update(png).digest("hex") });
      if (mode === "foreign") captures[0]!.api_url = "https://elsewhere.example.invalid/api/packages/example/generic/window-gallery/test-head/window-empty.dark.png";
      const manifest = { id: 123, user: { id: -2 }, body: '<!-- window-gallery ' + JSON.stringify({ head: mode === "stale" ? "old-head" : "test-head", ...(version !== "test-head" ? { version } : {}), captures }) + ' -->' };
      if (mode === "marker") manifest.body = '<!-- window-gallery {"head":"test-head","captures":[]} -->\n' + manifest.body;
      const invalid = mode === "invalid-json" ? "{broken" : mode === "non-object" ? "[]" : mode === "invalid-shape" ? '{"head":"test-head","captures":null}' : undefined;
      const comments = invalid === undefined ? [manifest] : [{ id: 121, user: { id: -2 }, body: `<!-- window-gallery ${invalid} -->` }, manifest, { id: 125, user: { id: -2 }, body: `<!-- window-gallery ${invalid} -->` }];
      if (mode === "spoofed" || mode === "unbound") {
        const bogus = { head: "test-head", version: "test-head-999", captures: [{ ...captures[0], api_url: `${base}/api/packages/example/generic/window-gallery/test-head-999/window-empty.dark.png` }] };
        comments.push({ id: mode === "spoofed" ? 999 : 1000, user: { id: mode === "spoofed" ? 7 : -2 }, body: '<!-- window-gallery ' + JSON.stringify(bogus) + ' -->' });
      }
      response.end(JSON.stringify(mode === "unpaginated" ? [...Array.from({ length: 50 }, () => ({ body: "Earlier discussion" })), ...comments] : comments));
    } else if (request.url?.startsWith("/attachments/")) response.writeHead(401).end();
    else response.end(mode === "corrupt" ? Buffer.from("not an image") : image);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no fixture address");
  base = `http://127.0.0.1:${address.port}`;
  return { folder, requests, image, env: { ...process.env, GALLERY_TEST_ROOT: folder, GALLERY_TEST_HEAD: mode === "wrong-head" ? "another-head" : "test-head", PATH: `${folder}/bin:${process.env["PATH"]}`, FORGEJO_URL: base, FORGEJO_REPOSITORY: "example/project", FORGEJO_TOKEN: "token-for-tests" } };
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

it("reads an unpaginated thread once and finds the current manifest after 50 earlier comments", async () => {
  const f = await fixture("unpaginated");
  const result = await run("bash", [script, "42"], { env: f.env });
  expect(result.stdout).toContain("Accepted window-empty.dark.png");
  expect(f.requests.filter((url) => url.includes("/comments"))).toEqual(["/api/v1/repos/example/project/issues/42/comments"]);
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


it("accepts an immutable report version through its manifest URL", async () => {
  const f = await fixture("versioned");
  await run("bash", [script, "42"], { env: f.env });
  expect(f.requests).toContain("/api/packages/example/generic/window-gallery/test-head-123/window-empty.dark.png");
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/window-empty.dark.png"))).toEqual(png);
});

it("refuses bytes that differ from the reviewed manifest without writing a baseline", async () => {
  const f = await fixture("digest-mismatch");
  await expect(run("bash", [script, "42"], { env: f.env })).rejects.toMatchObject({ stderr: expect.stringContaining("bytes do not match the reviewed manifest") });
  expect(existsSync(join(f.folder, "packages/gui/gallery/baselines"))).toBe(false);
});

it("refuses a report version for another head before downloading", async () => {
  const f = await fixture("wrong-version");
  await expect(run("bash", [script, "42"], { env: f.env })).rejects.toMatchObject({ stderr: expect.stringContaining("No gallery captures on the current PR head") });
  expect(f.requests.some((url) => url.startsWith("/api/packages/"))).toBe(false);
});

it.each(["invalid-json", "non-object", "invalid-shape"])("ignores %s markers in other comments while accepting the current capture report", async (mode) => {
  const f = await fixture(mode);
  const result = await run("bash", [script, "42"], { env: f.env });
  expect(result.stdout).toContain("Accepted window-empty.dark.png");
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/window-empty.dark.png"))).toEqual(png);
});


it.each(["spoofed", "unbound"])("keeps the genuine report when a later %s manifest names the current head", async (mode) => {
  const f = await fixture(mode);
  await run("bash", [script, "42"], { env: f.env });
  expect(f.requests).toContain("/api/packages/example/generic/window-gallery/test-head-123/window-empty.dark.png");
  expect(f.requests.some((url) => url.includes("test-head-999"))).toBe(false);
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/window-empty.dark.png"))).toEqual(png);
});


it("accepts a valid capture larger than 4 MiB within the gallery report budget", async () => {
  const f = await fixture("large");
  expect(f.image.byteLength).toBeGreaterThan(4 * 1024 * 1024);
  await run("bash", [script, "42"], { env: f.env });
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/window-empty.dark.png"))).toEqual(f.image);
});

it("refuses more than 600 captures before downloading or writing any baseline", async () => {
  const f = await fixture("current", 601);
  await expect(run("bash", [script, "42"], { env: f.env })).rejects.toMatchObject({ stderr: expect.stringContaining("No gallery captures on the current PR head") });
  expect(f.requests.some((url) => url.startsWith("/api/packages/"))).toBe(false);
  expect(existsSync(join(f.folder, "packages/gui/gallery/baselines"))).toBe(false);
});

it.each([
  ["total-large", 2, "Gallery captures exceed their size limit."],
  ["response-large", 1, "Gallery response exceeds its size limit."],
])("refuses %s capture bytes before writing any baseline", async (mode, count, message) => {
  const f = await fixture(mode, count);
  await expect(run("bash", [script, "42"], { env: f.env })).rejects.toMatchObject({ stderr: expect.stringContaining(message) });
  expect(existsSync(join(f.folder, "packages/gui/gallery/baselines"))).toBe(false);
});
