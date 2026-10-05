import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOTSTRAP_PATH,
  ClientSessionCredential,
  PROTOCOL_VERSION,
  SCOPES,
  formatPairingCode,
  parsePairingLink, BOOTSTRAP_GRANT_FILE } from "@agent-harness/contracts";
import { DEFAULT_CEILING } from "@agent-harness/environment";
import { renderUnicodeCompact } from "uqr";
import { afterEach, describe, expect, it } from "vitest";
import { startTestEnvironment, type TestEnvironment } from "../../environment/test/helper.js";
import { runCli, type CliContext } from "./cli.js";

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

const start = async (): Promise<TestEnvironment> => {
  const t = await startTestEnvironment();
  cleanups.push(() => t.close());
  return t;
};

/** The CLI in-process, its output captured, its fetch and WebSocket recording every URL they are given. */
const harness = () => {
  let out = "";
  let err = "";
  const urls: string[] = [];
  const recordingFetch: typeof fetch = (input, init) => {
    urls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return fetch(input, init);
  };
  const Native = globalThis.WebSocket;
  class RecordingWebSocket extends Native {
    constructor(url: string | URL, protocols?: ConstructorParameters<typeof WebSocket>[1]) {
      urls.push(`WS ${String(url)}`);
      super(url, protocols);
    }
  }
  const context: Partial<CliContext> = {
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    net: { fetch: recordingFetch, WebSocket: RecordingWebSocket },
  };
  return { context, urls, out: () => out, err: () => err };
};

/** The link the CLI printed. */
const linkIn = (out: string): string => {
  const link = /http:\/\/\S+\/pair#\S+/.exec(out)?.[0];
  if (!link) throw new Error(`no link in ${out}`);
  return link;
};

describe("agent-harness pair", () => {
  it("explains full access for an own phone, restricted Phone, and adjustable Custom in pair help without reaching an environment", async () => {
    const cli = harness();
    expect(await runCli(["pair", "--help"], cli.context)).toBe(0);
    expect(cli.err()).toBe("");
    expect(cli.urls).toEqual([]);
    expect(cli.out()).toContain("own-client: My own client — everything for your own devices, a phone included.");
    expect(cli.out()).toContain("Every scope, including terminal and admin; ceiling bypassPermissions");
    expect(cli.out()).toContain("phone: Phone — restricted.");
    expect(cli.out()).toContain("read, sessions:write and runs:drive; ceiling acceptEdits");
    expect(cli.out()).toContain("Bypass permissions is unavailable; no terminal or admin access.");
    expect(cli.out()).toContain("custom: Choose --scopes and --ceiling to raise or lower access for a single pairing.");
  });

  it("prints the link, a QR of the link and the short code, minted over the local bootstrap grant", async () => {
    const t = await start();
    const cli = harness();
    expect(await runCli(["pair", "--data-dir", t.dataDir], cli.context)).toBe(0);
    expect(cli.err()).toBe("");

    const link = linkIn(cli.out());
    const parsed = parsePairingLink(link);
    if (!parsed) throw new Error(`not a pairing link: ${link}`);
    expect(parsed.origin).toBe(`http://127.0.0.1:${t.address.port}`);
    expect(cli.out()).toContain(renderUnicodeCompact(link, { border: 2 }));
    expect(cli.out()).toContain(formatPairingCode(parsed.code));

    const answer = await t.pairExchange({ code: parsed.code, kind: "web", label: "phone", protocolVersion: PROTOCOL_VERSION });
    expect(answer.status).toBe(200);
    expect(ClientSessionCredential.parse(answer.body)).toMatchObject({ scopes: [...SCOPES], ceiling: DEFAULT_CEILING });
    expect(DEFAULT_CEILING).toBe("acceptEdits");
  });

  it("presets the ceiling from the environment's permissions.defaultCeiling setting", async () => {
    const t = await start();
    const admin = await t.client();
    await admin.apply("permissions.settings.set", { commandId: randomUUID(), values: { "permissions.defaultCeiling": "plan" } });
    const cli = harness();
    expect(await runCli(["pair", "--data-dir", t.dataDir], cli.context)).toBe(0);
    expect(cli.out()).toContain("Ceiling: plan");
    const code = parsePairingLink(linkIn(cli.out()))?.code;
    const answer = await t.pairExchange({ code, kind: "program", label: "bot", protocolVersion: PROTOCOL_VERSION });
    expect(answer.body).toMatchObject({ ceiling: "plan" });
  });

  it("mints the scopes and ceiling it is given", async () => {
    const t = await start();
    const cli = harness();
    expect(await runCli(["pair", "--data-dir", t.dataDir, "--scopes", "read,runs:drive", "--ceiling", "plan"], cli.context)).toBe(0);
    expect(cli.out()).toMatch(/read, runs:drive/);
    const code = parsePairingLink(linkIn(cli.out()))?.code;
    const answer = await t.pairExchange({ code, kind: "program", label: "bot", protocolVersion: PROTOCOL_VERSION });
    expect(answer.body).toMatchObject({ scopes: ["read", "runs:drive"], ceiling: "plan" });
  });

  it("mints my own client's preset with --preset own-client, every scope up to bypassPermissions, and prints what the code grants", async () => {
    const t = await start();
    const cli = harness();
    expect(await runCli(["pair", "--preset", "own-client", "--data-dir", t.dataDir], cli.context)).toBe(0);
    expect(cli.err()).toBe("");
    expect(cli.out()).toContain("  Preset: My own client\n  Scopes: read, sessions:write, runs:drive, terminal, admin\n  Ceiling: bypassPermissions\n");
    const code = parsePairingLink(linkIn(cli.out()))?.code;
    const answer = await t.pairExchange({ code, kind: "desktop", label: "laptop", protocolVersion: PROTOCOL_VERSION });
    expect(ClientSessionCredential.parse(answer.body)).toMatchObject({ scopes: [...SCOPES], ceiling: "bypassPermissions" });
  });

  it("mints a program's preset with --preset program, read, sessions:write and runs:drive up to acceptEdits, or the ceiling it is given", async () => {
    const t = await start();
    const cli = harness();
    expect(await runCli(["pair", "--preset", "program", "--data-dir", t.dataDir], cli.context)).toBe(0);
    expect(cli.out()).toContain("  Preset: A program\n  Scopes: read, sessions:write, runs:drive\n  Ceiling: acceptEdits\n");
    const code = parsePairingLink(linkIn(cli.out()))?.code;
    const answer = await t.pairExchange({ code, kind: "program", label: "hermes", protocolVersion: PROTOCOL_VERSION });
    expect(answer.body).toMatchObject({ scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits" });

    const lower = harness();
    expect(await runCli(["pair", "--preset", "program", "--ceiling", "plan", "--data-dir", t.dataDir], lower.context)).toBe(0);
    expect(lower.out()).toContain("  Ceiling: plan\n");
  });

  it("refuses a change the preset does not take, before it reaches the environment", async () => {
    for (const [args, message] of [
      [["--preset", "own-client", "--ceiling", "plan"], "My own client grants every scope, up to bypassPermissions: it takes no other scopes or ceiling."],
      [["--preset", "program", "--scopes", "read"], "A program grants read, sessions:write and runs:drive: only its ceiling may be picked."],
      [["--preset", "everything"], "--preset takes one of own-client, program, phone, custom; got everything."],
    ] as const) {
      const cli = harness();
      expect(await runCli(["pair", ...args], cli.context), args.join(" ")).toBe(2);
      expect(cli.err()).toContain(message);
      expect(cli.urls).toEqual([]);
    }
  });

  it("revokes its own local client session before it exits, so none is left behind", async () => {
    const t = await start();
    const cli = harness();
    expect(await runCli(["pair", "--data-dir", t.dataDir], cli.context)).toBe(0);
    expect(cli.err()).toBe("");
    const admin = await t.client();
    const own = (await admin.request("access.sessions.list", {})).sessions.filter((s) => s.label === "agent-harness pair");
    expect(own).toHaveLength(1);
    expect(own[0]?.revokedAt).not.toBeNull();
    const live = (await admin.request("access.sessions.list", { live: true })).sessions.map((s) => s.label);
    expect(live).not.toContain("agent-harness pair");
    const revoked = (await admin.request("access.log.list", { limit: 1000 })).events.filter(
      (e) => e.type === "client-session.revoked" && e.payload["clientSessionId"] === own[0]?.id,
    );
    expect(revoked).toMatchObject([{ payload: { reason: "requested" }, actor: { kind: "client_session", id: own[0]?.id } }]);
  });

  it("exchanges the grant, then opens the bare wire path: the token is never in a URL", async () => {
    const t = await start();
    const cli = harness();
    expect(await runCli(["pair", "--data-dir", t.dataDir, "--port", String(t.address.port)], cli.context)).toBe(0);
    expect(cli.urls).toEqual([`POST http://127.0.0.1:${t.address.port}${BOOTSTRAP_PATH}`, `WS ws://127.0.0.1:${t.address.port}/ws`]);
  });

  it("says so and exits 1 when no environment runs on the data directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-harness-cli-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const cli = harness();
    expect(await runCli(["pair", "--data-dir", dir], cli.context)).toBe(1);
    expect(cli.err()).toMatch(/no environment is running/i);
    expect(cli.out()).toBe("");
  });

  it("says so and exits 1 when the environment does not answer on the port", async () => {
    const t = await start();
    const free = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const cli = harness();
    expect(await runCli(["pair", "--data-dir", t.dataDir, "--port", String(free)], cli.context)).toBe(1);
    expect(cli.err()).toMatch(/did not answer/);
  });

  it("says so and exits 1 when the bootstrap grant file is not JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-harness-cli-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, BOOTSTRAP_GRANT_FILE), "{ not json");
    const cli = harness();
    expect(await runCli(["pair", "--data-dir", dir], cli.context)).toBe(1);
    expect(cli.err()).toMatch(/not one an environment writes/);
  });

  it("says so and exits 1 when whatever answers on the port is not an environment", async () => {
    const t = await start();
    const impostor = createHttpServer((_, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ hello: "world" }));
    });
    const port = await new Promise<number>((resolve) => impostor.listen(0, "127.0.0.1", () => resolve((impostor.address() as AddressInfo).port)));
    cleanups.push(() => void impostor.close());
    const cli = harness();
    expect(await runCli(["pair", "--data-dir", t.dataDir, "--port", String(port)], cli.context)).toBe(1);
    expect(cli.err()).toMatch(/not a client session/);
  });

  it("prints its usage and exits 2 on arguments it cannot parse", async () => {
    for (const args of [
      ["pair", "--scopes", "read,write"],
      ["pair", "--scopes", ""],
      ["pair", "--scopes", "read,read"],
      ["pair", "--ceiling", ""],
      ["pair", "--ceiling", "default"],
      ["pair", "--ceiling", "dontAsk"],
      ["pair", "--port", "0"],
      ["pair", "--port", "http"],
      ["pair", "extra"],
      ["pair", "--label", "x"],
    ]) {
      const cli = harness();
      expect(await runCli(args, cli.context), args.join(" ")).toBe(2);
      expect(cli.err()).toContain("agent-harness pair [--preset <own-client|program|phone|custom>] [--scopes <a,b>] [--ceiling <mode>] [--data-dir <path>] [--port <n>]");
      if (args[1] === "--ceiling") expect(cli.err()).toContain("--ceiling takes one of plan, acceptEdits, auto, bypassPermissions");
    }
  });
});
