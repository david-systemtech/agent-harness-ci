import { createHash } from "node:crypto";
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
  PNG: { sync: { write(image: { width: number; height: number; data: Buffer }, options?: { deflateLevel: number; filterType: number }): Buffer } };
};
const png = PNG.sync.write({ width: 1400, height: 900, data: Buffer.alloc(1400 * 900 * 4, 255) });
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(mode = "current", captureCount = 1, phone?: { name: string; width: number; height: number }) {
  let image = phone === undefined ? png : PNG.sync.write({ width: phone.width, height: phone.height, data: Buffer.alloc(phone.width * phone.height * 4, 255) });
  if (mode === "large") image = PNG.sync.write({ width: 1400, height: 900, data: Buffer.alloc(1400 * 900 * 4, 255) }, { deflateLevel: 0, filterType: 0 });
  else if (mode === "total-large") image = Buffer.concat([png, Buffer.alloc(25 * 1024 * 1024)]);
  else if (mode === "response-large") image = Buffer.concat([png, Buffer.alloc(48 * 1024 * 1024)]);
  else if (mode === "truncated-png") image = image.subarray(0, 32);
  else if (mode === "invalid-ihdr") image.write("IDAT", 12);
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
      const captureName = phone?.name ?? "window-empty.dark.png";
      const captures = [{ name: captureName, url: `${base}/attachments/capture`, api_url: `${base}/api/packages/example/generic/window-gallery/${version}/${captureName}`, sha256: createHash("sha256").update(mode === "digest-mismatch" ? "different bytes" : image).digest("hex") }];
      for (let index = 1; index < captureCount; index++) {
        const name = mode === "phone-overflow" ? `phone-scene-${index}-phone-390.dark.png` : `window-scene-${index}.dark.png`;
        captures.push({ ...captures[0]!, name, api_url: `${base}/api/packages/example/generic/window-gallery/${version}/${name}` });
      }
      if (mode === "scoped") captures.push({ name: "settings-browser.light.png", url: `${base}/attachments/capture`, api_url: `${base}/api/packages/example/generic/window-gallery/test-head/settings-browser.light.png`, sha256: createHash("sha256").update(png).digest("hex") });
      if (mode === "unsafe") captures.push({ name: "../escape.dark.png", url: `${base}/attachments/capture`, api_url: `${base}/api/packages/example/generic/window-gallery/test-head/escape.dark.png`, sha256: createHash("sha256").update(png).digest("hex") });
      if (mode === "duplicate") captures.push(captures[0]!);
      if (mode === "foreign") captures[0]!.api_url = "https://elsewhere.example.invalid/api/packages/example/generic/window-gallery/test-head/window-empty.dark.png";
      const manifest = { id: 123, user: { id: -2 }, body: '<!-- window-gallery ' + JSON.stringify({ head: mode === "stale" ? "old-head" : "test-head", ...(version !== "test-head" ? { version } : {}), captures }) + ' -->' };
      if (mode === "marker") manifest.body = '<!-- window-gallery {"head":"test-head","captures":[]} -->\n' + manifest.body;
      const invalid = mode === "invalid-json" ? "{broken" : mode === "non-object" ? "[]" : mode === "invalid-shape" ? '{"head":"test-head","captures":null}' : undefined;
      const comments = invalid === undefined ? [manifest] : [{ id: 121, user: { id: -2 }, body: `<!-- window-gallery ${invalid} -->` }, manifest, { id: 125, user: { id: -2 }, body: `<!-- window-gallery ${invalid} -->` }];
      if (mode === "spoofed" || mode === "unbound") {
        const bogus = { head: "test-head", version: "test-head-999", captures: [{ ...captures[0], api_url: `${base}/api/packages/example/generic/window-gallery/test-head-999/window-empty.dark.png` }] };
        comments.push({ id: mode === "spoofed" ? 999 : 1000, user: { id: mode === "spoofed" ? 7 : -2 }, body: '<!-- window-gallery ' + JSON.stringify(bogus) + ' -->' });
      }
      if (mode.startsWith("sharded")) {
        comments.splice(0);
        const count = Math.ceil(captures.length / 400);
        for (let index = 0; index < count; index++) {
          const id = 123 + index, shardVersion = `test-head-${id}`;
          const files = captures.slice(index * 400, (index + 1) * 400).map(item => ({ ...item, api_url: `${base}/api/packages/example/generic/window-gallery/${shardVersion}/${item.name}` }));
          if (mode === "sharded-missing" && index === 0) continue;
          const shard = { run: mode === "sharded-mixed-run" && index === 1 ? "another-run" : "capture-run", index: index + 1, count, total: captures.length };
          if (mode === "sharded-invalid") shard.index = 3;
          if (mode === "sharded-duplicate" && index === 1) files[0]!.name = captures[0]!.name;
          const triplets = mode === "sharded-thread" ? files.map(file => `\n**${file.name}**\n\n| Baseline | Capture | Difference |\n| --- | --- | --- |\n| ${["baseline", "capture", "difference"].map(kind => `![${kind} ${file.name}](${base}/attachments/${file.name}-${kind})`).join(" | ")} |\n`).join("") : "";
          comments.push({ id, user: { id: -2 }, body: triplets + '<!-- window-gallery ' + JSON.stringify({ head: "test-head", version: shardVersion, shard, captures: files }) + ' -->' });
        }
        if (mode === "sharded-uploading" || mode === "sharded-failed") {
          const message = mode === "sharded-uploading" ? "Uploading captures…" : "Gallery upload failed during attachment window-empty.dark.png (HTTP 503).";
          comments.push({ id: 125, user: { id: -2 }, body: `Window gallery for \`test-head\`. ${message}` });
        }
        if (mode === "sharded-duplicate-index") {
          const replacement = comments[0]!.body.replaceAll("test-head-123", "test-head-125");
          comments.push({ id: 125, user: { id: -2 }, body: replacement });
        }
        if (mode === "sharded-thread") {
          const history = comments.map((comment, index) => ({ ...comment, id: 23 + index, body: comment.body.replaceAll(`test-head-${comment.id}`, `test-head-${23 + index}`).replaceAll("capture-run", "earlier-run") }));
          comments.unshift(...history);
          expect(Buffer.byteLength(JSON.stringify(comments))).toBeGreaterThan(4 * 1024 * 1024);
        }
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


it("accepts all 400 captures allowed by a reviewed gallery report", async () => {
  const f = await fixture("versioned", 400);
  await run("bash", [script, "42"], { env: f.env });
  expect(f.requests.filter((url) => url.startsWith("/api/packages/"))).toHaveLength(400);
  const baselines = join(f.folder, "packages/gui/gallery/baselines");
  expect(readFileSync(join(baselines, "window-empty.dark.png"))).toEqual(png);
  for (let index = 1; index < 400; index++) expect(readFileSync(join(baselines, `window-scene-${index}.dark.png`))).toEqual(png);
});


it("accepts captures above the old 24 MiB total within the 48 MiB report budget", async () => {
  const f = await fixture("large", 6);
  expect(f.image.byteLength * 6).toBeGreaterThan(24 * 1024 * 1024);
  expect(f.image.byteLength * 6).toBeLessThan(48 * 1024 * 1024);
  await run("bash", [script, "42"], { env: f.env });
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/window-scene-5.dark.png"))).toEqual(f.image);
});


it("refuses more than 400 captures before downloading or writing baselines", async () => {
  const f = await fixture("versioned", 401);
  await expect(run("bash", [script, "42"], { env: f.env })).rejects.toMatchObject({ stderr: expect.stringContaining("No gallery captures on the current PR head") });
  expect(f.requests.some((url) => url.startsWith("/api/packages/"))).toBe(false);
  expect(existsSync(join(f.folder, "packages/gui/gallery/baselines"))).toBe(false);
});

it("refuses captures exceeding 48 MiB without writing any baseline", async () => {
  const f = await fixture("large", 11);
  expect(f.image.byteLength * 11).toBeGreaterThan(48 * 1024 * 1024);
  await expect(run("bash", [script, "42"], { env: f.env })).rejects.toMatchObject({ stderr: expect.stringContaining("Gallery captures exceed their size limit") });
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

it.each([
  ["unsafe", "Invalid or duplicate gallery filename."],
  ["duplicate", "Invalid or duplicate gallery filename."],
  ["foreign", "Invalid gallery attachment origin."],
  ["corrupt", "bytes do not match the reviewed manifest"],
  ["digest-mismatch", "bytes do not match the reviewed manifest"],
])("retains %s validation for 204-capture manifests without writing baselines", async (mode, error) => {
  const f = await fixture(mode, 204);
  await expect(run("bash", [script, "42"], { env: f.env })).rejects.toMatchObject({ stderr: expect.stringContaining(error) });
  expect(existsSync(join(f.folder, "packages/gui/gallery/baselines"))).toBe(false);
});


it("accepts only explicitly reviewed capture filenames and preserves unrelated baselines", async () => {
  const f = await fixture("scoped");
  const baselines = join(f.folder, "packages/gui/gallery/baselines");
  mkdirSync(baselines, { recursive: true });
  writeFileSync(join(baselines, "window-empty.dark.png"), "prior baseline");
  const result = await run("bash", [script, "42", "settings-browser.light.png"], { env: f.env });
  expect(readFileSync(join(baselines, "settings-browser.light.png"))).toEqual(png);
  expect(readFileSync(join(baselines, "window-empty.dark.png"), "utf8")).toBe("prior baseline");
  expect(f.requests.some((url) => url.endsWith("/window-empty.dark.png"))).toBe(false);
  expect(result.stdout).not.toContain("window-empty.dark.png");
});


it.each(["missing.dark.png", "../settings-browser.light.png"])("refuses an unavailable or unsafe selection %s before downloading or writing", async (name) => {
  const f = await fixture("scoped");
  await expect(run("bash", [script, "42", name], { env: f.env })).rejects.toThrow();
  expect(f.requests.some((url) => url.startsWith("/api/packages/"))).toBe(false);
  expect(existsSync(join(f.folder, "packages/gui/gallery/baselines"))).toBe(false);
});


it("accepts a reviewed pane from a hosted report with more than 200 captures", async () => {
  const f = await fixture("scoped", 240);
  await run("bash", [script, "42", "settings-browser.light.png"], { env: f.env });
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/settings-browser.light.png"))).toEqual(png);
  expect(f.requests.filter((url) => url.startsWith("/api/packages/"))).toHaveLength(1);
});

it.each([
  ["phone-gallery-conversation-phone-390.dark.png", 390, 844],
  ["phone-gallery-conversation-phone-360.light.png", 360, 740],
  ["phone-gallery-conversation-phone-390-text-20.dark.png", 390, 844],
  ["phone-gallery-conversation-phone-390-keyboard.light.png", 390, 480],
  ["phone-gallery-conversation-phone-320.dark.png", 320, 568],
  ["phone-gallery-conversation-phone-320-short.light.png", 320, 320],
  ["phone-gallery-conversation-phone-360-short.dark.png", 360, 400],
  ["phone-gallery-conversation-phone-430.light.png", 430, 932],
  ["phone-gallery-conversation-phone-430-short.dark.png", 430, 360],
  ["phone-gallery-conversation-phone-844.dark.png", 844, 390],
  ["phone-gallery-conversation-phone-740.light.png", 740, 360],
  ["phone-gallery-conversation-phone-844-text-20.dark.png", 844, 390],
  ["phone-gallery-conversation-phone-740-text-20.light.png", 740, 360],
  ["phone-settings-phone-mode-phone-390.dark.png", 390, 844],
] as const)("accepts a reviewed %s capture through the same authenticated manifest", async (name, width, height) => {
  const f = await fixture("versioned", 1, { name, width, height });
  await run("bash", [script, "42"], { env: f.env });
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines", name))).toEqual(f.image);
});

it.each([
  ["phone-gallery-conversation-phone-390.dark.png", 360, 740],
  ["phone-gallery-conversation-phone-390-keyboard.dark.png", 390, 844],
  ["phone-gallery-conversation-phone-999.dark.png", 1400, 900],
  ["phone-gallery-conversation-phone-320.dark.png", 320, 320],
  ["phone-gallery-conversation-phone-320-short.light.png", 320, 568],
  ["phone-gallery-conversation-phone-360-short.dark.png", 360, 740],
  ["phone-gallery-conversation-phone-430.light.png", 430, 360],
  ["phone-gallery-conversation-phone-430-short.dark.png", 430, 932],
  ["phone-gallery-conversation-phone-320-extra.dark.png", 320, 568],
  ["phone-gallery-conversation.dark.png", 320, 568],
  ["phone-gallery-conversation-phone-844.dark.png", 390, 844],
  ["phone-gallery-conversation-phone-740.light.png", 360, 740],
  ["phone-gallery-conversation-phone-844-text-20.dark.png", 740, 360],
  ["phone-gallery-conversation-phone-740-text-20.light.png", 844, 390],
  ["phone-gallery-conversation-phone-844-extra.dark.png", 844, 390],
  ["phone-gallery-conversation-phone-740-short.light.png", 740, 360],
] as const)("rejects %s with incorrect dimensions before writing baselines", async (name, width, height) => {
  const f = await fixture("versioned", 1, { name, width, height });
  await expect(run("bash", [script, "42"], { env: f.env })).rejects.toMatchObject({ stderr: expect.stringContaining("Unexpected phone gallery dimensions") });
  expect(existsSync(join(f.folder, "packages/gui/gallery/baselines"))).toBe(false);
});

it("accepts 472 captures across a complete independently bounded report set", async () => {
  const f = await fixture("sharded", 472);
  await run("bash", [script, "42"], { env: f.env });
  expect(f.requests.filter(url => url.startsWith("/api/packages/"))).toHaveLength(472);
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/window-empty.dark.png"))).toEqual(png);
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/window-scene-471.dark.png"))).toEqual(png);
});

it.each(["320", "844"].flatMap(profile => ["truncated-png", "invalid-ihdr"].map(mode => [profile, mode] as const)))("rejects a phone-%s %s attachment even when its manifest hash matches", async (profile, mode) => {
  const f = await fixture(mode, 1, { name: `phone-frame-conversation-phone-${profile}.dark.png`, ...(profile === "320" ? { width: 320, height: 568 } : { width: 844, height: 390 }) });
  await expect(run("bash", [script, "42"], { env: f.env })).rejects.toMatchObject({ stderr: expect.stringContaining("Gallery attachment is not a PNG") });
  expect(existsSync(join(f.folder, "packages/gui/gallery/baselines"))).toBe(false);
});

it.each(["sharded-uploading", "sharded-failed"])("refuses an older complete run when the latest report is %s", async (mode) => {
  const f = await fixture(mode, 472);
  await expect(run("bash", [script, "42"], { env: f.env })).rejects.toMatchObject({ stderr: expect.stringContaining("Latest gallery publication is incomplete") });
  expect(f.requests.filter(url => url.startsWith("/api/packages/"))).toEqual([]);
  expect(existsSync(join(f.folder, "packages/gui/gallery/baselines"))).toBe(false);
});

it.each([
  ["sharded-missing", "Incomplete gallery shard set"],
  ["sharded-mixed-run", "Incomplete gallery shard set"],
  ["sharded-invalid", "Invalid gallery shard counts"],
  ["sharded-duplicate", "Duplicate gallery filename across shards"],
  ["sharded-duplicate-index", "Duplicate gallery shard index"],
])("refuses %s before downloading or writing any baseline", async (mode, message) => {
  const f = await fixture(mode, 472);
  await expect(run("bash", [script, "42"], { env: f.env })).rejects.toMatchObject({ stderr: expect.stringContaining(message) });
  expect(f.requests.filter(url => url.startsWith("/api/packages/"))).toEqual([]);
  expect(existsSync(join(f.folder, "packages/gui/gallery/baselines"))).toBe(false);
});

it("accepts a reviewed subset from both shards without downloading other captures", async () => {
  const f = await fixture("sharded", 472);
  await run("bash", [script, "42", "window-empty.dark.png", "window-scene-471.dark.png"], { env: f.env });
  expect(f.requests.filter(url => url.startsWith("/api/packages/"))).toHaveLength(2);
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/window-empty.dark.png"))).toEqual(png);
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/window-scene-471.dark.png"))).toEqual(png);
});

it("accepts a reviewed subset from a 6400-capture changed-report thread with prior run history", async () => {
  const f = await fixture("sharded-thread", 6400);
  await run("bash", [script, "42", "window-empty.dark.png", "window-scene-6399.dark.png"], { env: f.env });
  expect(f.requests.filter(url => url.startsWith("/api/packages/"))).toHaveLength(2);
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/window-empty.dark.png"))).toEqual(png);
  expect(readFileSync(join(f.folder, "packages/gui/gallery/baselines/window-scene-6399.dark.png"))).toEqual(png);
});


it("refuses phone shard exhaustion without spending unused desktop slots in an earlier combined report", async () => {
  const f = await fixture("phone-overflow", 401, { name: "phone-frame-drawer-phone-390.dark.png", width: 390, height: 844 });
  await expect(run("bash", [script, "42"], { env: f.env })).rejects.toMatchObject({ stderr: expect.stringContaining("No gallery captures on the current PR head") });
  expect(f.requests.some(url => url.startsWith("/api/packages/"))).toBe(false);
  expect(existsSync(join(f.folder, "packages/gui/gallery/baselines"))).toBe(false);
});
