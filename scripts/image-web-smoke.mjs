// Executed by the image CI job as the image's ordinary user, never on the agent box.
import { URL } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEnvironment } from "../packages/environment/dist/index.js";
const dataDir = await mkdtemp(join(tmpdir(), "image-web-smoke-"));
const environment = await startEnvironment({ dataDir, port: 0, bindTailnet: false });
try {
  const origin = `http://${environment.address.host}:${environment.address.port}`;
  for (const path of ["/", "/pair"]) {
    const page = await globalThis.fetch(`${origin}${path}`);
    assert.equal(page.status, 200, `The image serves ${path}.`);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert(page.headers.get("content-security-policy")?.includes("default-src 'self'"));
    const html = await page.text();
    const script = /src="([^"]+\.js)"/.exec(html)?.[1];
    assert(script, "The packaged index references its built script.");
    assert.equal((await globalThis.fetch(new URL(script, `${origin}/`))).status, 200);
  }
  const stamp = await (await globalThis.fetch(`${origin}/version.json`)).json();
  const health = await (await globalThis.fetch(`${origin}/api/health`)).json();
  assert.equal(stamp.version, health.version, "The image ships one server and client version.");
  assert.equal((await globalThis.fetch(`${origin}/api/missing`)).status, 404);
  globalThis.console.log("Image web routes and version matched.");
} finally { await environment.close(); await rm(dataDir, { recursive: true, force: true }); }
