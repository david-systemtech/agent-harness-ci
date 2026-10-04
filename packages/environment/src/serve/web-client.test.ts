import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { createHttpSurface, sendJson } from "./http.js";
import { serveWebClient } from "./web-client.js";

const { tempDir, onCleanup } = useCleanups();
const start = async () => {
  const root = tempDir();
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), '<html><script src="/assets/app.js"></script></html>');
  writeFileSync(join(root, "assets", "app.js"), "export const version = '0.0.0';");
  writeFileSync(join(root, "private.txt"), "not an asset");
  const http = createHttpSurface({ webOrigin: "https://web.example:8443" });
  http.route("GET", "/api/health", (_req, res) => sendJson(res, 200, { status: "ready" }));
  http.route("POST", "/api/pair", (_req, res) => sendJson(res, 200, { paired: true }));
  serveWebClient(http, root);
  http.prefix("/v1/", (_req, res) => sendJson(res, 200, { completion: true }));
  http.upgrade("/ws", (_req, socket) => socket.end());
  const address = await http.listen("127.0.0.1", 0);
  onCleanup(() => http.close());
  const ask = (path: string, headers: Record<string, string> = {}, method = "GET") => new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
    const req = request({ hostname: address.host, port: address.port, path, method, headers }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject); req.end();
  });
  return { root, ask, address };
};

describe("the environment's web client", () => {
  it("serves only the declared pages and bundled assets behind Host validation", async () => {
    const { ask } = await start();
    for (const page of ["/", "/pair"]) {
      const res = await ask(page);
      expect(res.status).toBe(200);
      expect(res.text).toContain("/assets/app.js");
      expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect((await ask("/assets/app.js")).status).toBe(200);
    expect((await ask("/api/health")).text).toContain("ready");
    expect((await ask("/v1/models")).text).toContain("completion");
    expect((await ask("/ws")).status).toBe(426);
    expect(JSON.parse((await ask("/api/missing")).text)).toEqual({ error: "not_found", message: "Nothing is served at /api/missing." });
    expect((await ask("/", { Host: "evil.example" })).status).toBe(421);
    for (const path of ["/api/missing", "/private.txt", "/assets/../private.txt", "/assets/%2e%2e/private.txt", "/assets/%2fetc/passwd", "/assets/app.js?token=token-for-tests"]) {
      expect((await ask(path)).status, path).toBe(404);
    }
  });

  it("refuses assets linked outside the bundle and honours HEAD", async () => {
    const { root, ask } = await start();
    const outside = tempDir(); writeFileSync(join(outside, "secret.js"), "secret");
    symlinkSync(join(outside, "secret.js"), join(root, "assets", "secret.js"));
    expect((await ask("/assets/secret.js")).status).toBe(404);
    const head = await ask("/assets/app.js", {}, "HEAD");
    expect(head.status).toBe(200); expect(head.text).toBe("");
    expect((await ask("/assets/app.js", {}, "POST")).status).toBe(405);
  });

  it("admits exact configured, same-listener, desktop and originless pairing, rejecting arbitrary Origins", async () => {
    const { ask, address } = await start();
    for (const origin of [undefined, "https://web.example:8443", `http://127.0.0.1:${address.port}`, "agent-harness://app"]) {
      expect((await ask("/api/pair", origin ? { Origin: origin } : {}, "POST")).status).toBe(200);
    }
    expect((await ask("/api/step/../pair", { Origin: "https://evil.example" }, "POST")).status).toBe(403);
    for (const origin of ["null", "https://evil.example", "https://web.example", "https://web.example:8443.evil.example", "agent-harness://evil"]) {
      expect((await ask("/api/pair", { Origin: origin }, "POST")).status, origin).toBe(403);
    }
  });
});
