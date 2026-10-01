import { createServer, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { testCertificates } from "./fake-openbao.js";
import type { AddressInfo } from "node:net";

/** Loopback Doppler API; all credentials and secrets are deliberately fake. */
export const DOPPLER_TEST_TOKEN = "doppler-token-for-tests";
export const startFakeDoppler = async (options: { tls?: boolean } = {}) => {
  const secrets = new Map<string, string>();
  const requests: { method: string; path: string; query: Record<string, string>; body: unknown }[] = [];
  let status = 200;
  let writable = true;
  const handler: RequestListener = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let text = "";
    for await (const chunk of req) text += String(chunk);
    const body: unknown = text === "" ? null : JSON.parse(text);
    requests.push({ method: req.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const reply = (code: number, value: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${DOPPLER_TEST_TOKEN}`) return reply(401, { success: false });
    if (status !== 200) return reply(status, { success: false });
    if (url.pathname === "/v3/me") return reply(200, { success: true, name: "Harness", type: "service_token" });
    if (url.pathname === "/v3/configs/config/secrets/names") return reply(200, { success: true, names: [...secrets.keys()] });
    if (url.pathname === "/v3/configs/config/secrets" && req.method === "GET") {
      const names = url.searchParams.get("secrets")?.split(",") ?? [...secrets.keys()];
      return reply(200, { success: true, secrets: Object.fromEntries(names.filter((name) => secrets.has(name)).map((name) => [name, { raw: secrets.get(name), computed: secrets.get(name) }])) });
    }
    if (url.pathname === "/v3/configs/config/secrets" && req.method === "POST") {
      if (!writable) return reply(403, { success: false });
      const patch = body as { secrets: Record<string, string> };
      for (const [name, value] of Object.entries(patch.secrets)) secrets.set(name, value);
      return reply(200, { success: true });
    }
    reply(404, { success: false });
  };
  const certificate = options.tls === true ? testCertificates() : null;
  const server = certificate === null ? createServer(handler) : createHttpsServer({ key: certificate.key, cert: certificate.certificate }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    address: `${options.tls === true ? "https" : "http"}://127.0.0.1:${(server.address() as AddressInfo).port}`,
    secrets, requests,
    status: (code: number) => { status = code; },
    writable: (value: boolean) => { writable = value; },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};
