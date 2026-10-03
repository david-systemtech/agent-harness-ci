import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "../scripts/gallery-retention.py");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(failure = "") {
  const deleted: string[] = [];
  const requests: string[] = [];
  let base = "";
  const packageVersion = (version: string, created_at = "2020-01-01T00:00:00Z", name = "window-gallery") => ({ type: "generic", name, version, created_at });
  const packages = [
    packageVersion("expired-orphan"), packageVersion("active-head-1"), packageVersion("earlier-head-2"),
    packageVersion("legacy-head"), packageVersion("active-head-3"), packageVersion("new-run", "2099-01-01T00:00:00Z"),
    packageVersion("unrelated", undefined, "server-release"), packageVersion("expired-second-page"),
  ];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "", base);
    const expected = failure === "package-auth" && url.pathname.startsWith("/api/v1/packages/") ? "package-token-for-tests" : "token-for-tests";
    if (request.headers.authorization !== `token ${expected}`) { response.writeHead(401).end(); return; }
    requests.push(url.pathname + url.search);
    response.setHeader("content-type", "application/json");
    const page = url.searchParams.get("page") ?? "1";
    if (request.method === "DELETE") { deleted.push(url.pathname.split("/").at(-1)!); response.writeHead(204).end(); }
    else if (url.pathname.endsWith("/pulls")) {
      response.end(JSON.stringify(page === "1" ? [{ number: 42, head: { sha: "active-head" } }] : []));
    } else if (url.pathname.includes("/comments")) {
      if (failure === "comments" && page === "2") { response.writeHead(503).end(); return; }
      const manifest = (head: string, version: string, modern = true) => ({ body: '<!-- window-gallery ' + JSON.stringify({ head, ...(modern ? { version } : {}), captures: [{ api_url: `${base}/api/packages/example/generic/window-gallery/${version}/window-empty.dark.png` }] }) + ' -->' });
      response.end(JSON.stringify(page === "1" ? Array.from({ length: 50 }, () => ({ body: "Discussion" })) : page === "2" ? [
        manifest("active-head", "active-head-1"), manifest("earlier-head", "earlier-head-2"), manifest("legacy-head", "legacy-head", false),
      ] : failure === "malformed" && page === "3" ? [{ body: '<!-- window-gallery {broken -->' }, { body: '<!-- window-gallery [] -->' }] : []));
    } else if (url.pathname === "/api/v1/packages/example") {
      if (failure === "packages" && page === "2") { response.writeHead(503).end(); return; }
      response.end(JSON.stringify(page === "1" ? packages.slice(0, 7) : page === "2" ? packages.slice(7) : []));
    } else response.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no fixture address");
  base = `http://127.0.0.1:${address.port}`;
  return { deleted, requests, env: { ...process.env, FORGEJO_URL: base, FORGEJO_REPOSITORY: "example/project", FORGEJO_TOKEN: "token-for-tests", PACKAGES_TOKEN: failure === "package-auth" ? "package-token-for-tests" : "token-for-tests" } };
}

it("expires old orphan versions while preserving every open PR manifest, its in-flight head, and recent captures", async () => {
  const f = await fixture();
  await run("python3", [script], { env: f.env });
  expect(f.deleted).toEqual(["expired-orphan", "expired-second-page"]);
  expect(f.requests.some((url) => url.includes("/comments?limit=50&page=2"))).toBe(true);
  expect(f.requests.some((url) => url.includes("/packages/example?") && url.includes("page=3"))).toBe(true);
});

it.each(["comments", "packages"])("deletes nothing when the %s inventory cannot be read", async (mode) => {
  const f = await fixture(mode);
  await expect(run("python3", [script], { env: f.env })).rejects.toMatchObject({ stderr: expect.stringContaining("Gallery retention failed (HTTP 503)") });
  expect(f.deleted).toEqual([]);
});




it("ignores manifest examples in discussion while preserving valid active manifests", async () => {
  const f = await fixture("malformed");
  await run("python3", [script], { env: f.env });
  expect(f.deleted).toEqual(["expired-orphan", "expired-second-page"]);
});


it("uses the package credential for inventory and deletion and the repository credential for PR protection", async () => {
  const f = await fixture("package-auth");
  await run("python3", [script], { env: f.env });
  expect(f.deleted).toEqual(["expired-orphan", "expired-second-page"]);
});
