import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BOOTSTRAP_GRANT_FILE,
  BOOTSTRAP_PATH,
  BootstrapError,
  ClientSessionCredential,
  SCOPES,
  type ClientSessionCredential as Credential,
} from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { postExchange, readGrant, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { ByeError } from "../../test/wire-client.js";
import type { Address } from "../serve/http.js";
import type { StartupStep } from "../serve/start.js";
import { isLoopbackAddress } from "./bootstrap.js";
import { TOP_CEILING, TUI_REVOKE_AFTER_MS } from "./client-sessions.js";

const { onCleanup, tempDir } = useCleanups();
const posix = process.platform !== "win32";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** The bye an auth with `credential` ends with, or `hello` when it is accepted. */
const outcome = async (t: TestEnvironment, credential: Credential, clientKind: "desktop" | "tui" = "tui") => {
  try {
    const client = await t.client({ token: credential.token, clientKind });
    await client.close();
    return "hello";
  } catch (error) {
    if (error instanceof ByeError) return `bye: ${error.bye?.reason ?? "none"}`;
    throw error;
  }
};

describe("the bootstrap grant file", () => {
  it("is written on start in the data directory with a fresh secret and the environment's address", async () => {
    const t = await start();
    const grant = t.grant();
    expect(grant.address).toEqual({ host: t.address.host, port: t.address.port });
    expect(grant.secret.length).toBeGreaterThanOrEqual(32);
    expect(existsSync(join(t.dataDir, BOOTSTRAP_GRANT_FILE))).toBe(true);
  });

  it.runIf(posix)("is readable by the environment's OS user alone", async () => {
    const t = await start();
    expect(statSync(join(t.dataDir, BOOTSTRAP_GRANT_FILE)).mode & 0o777).toBe(0o600);
    await t.bootstrap();
    expect(statSync(join(t.dataDir, BOOTSTRAP_GRANT_FILE)).mode & 0o777).toBe(0o600);
  });

  it("holds a new secret after every start on the same directory, and the old one is refused", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await startTestEnvironment({ dataDir });
    const old = first.grant().secret;
    await first.close();
    const second = await start({ dataDir });
    expect(second.grant().secret).not.toBe(old);
    expect((await second.exchange({ secret: old, kind: "tui", label: "t" })).status).toBe(401);
  });

  it("is removed when the environment closes", async () => {
    const dataDir = join(tempDir(), "data");
    const t = await startTestEnvironment({ dataDir });
    await t.close();
    expect(existsSync(join(dataDir, BOOTSTRAP_GRANT_FILE))).toBe(false);
  });
});

describe("POST /api/bootstrap", () => {
  it("exchanges the secret for a local client session with every scope and the top ceiling", async () => {
    const t = await start();
    const answer = await t.exchange({ secret: t.grant().secret, kind: "desktop", label: "MacBook desktop" });
    expect(answer.status).toBe(200);
    const credential = ClientSessionCredential.parse(answer.body);
    expect(credential).toEqual({
      token: expect.any(String),
      clientSessionId: expect.any(String),
      scopes: [...SCOPES],
      ceiling: TOP_CEILING,
      expiresAt: new Date(t.clock.now().getTime() + 30 * DAY).toISOString(),
    });
    expect(TOP_CEILING).toBe("bypassPermissions");
    const client = await t.client({ token: credential.token, clientKind: "desktop" });
    expect(client.hello).toMatchObject({ clientSessionId: credential.clientSessionId, scopes: [...SCOPES], ceiling: "bypassPermissions" });
  });

  it("rotates the secret after each exchange, and refuses the old one", async () => {
    const t = await start();
    const first = t.grant();
    expect((await t.exchange({ secret: first.secret, kind: "tui", label: "one" })).status).toBe(200);
    const second = t.grant();
    expect(second.secret).not.toBe(first.secret);
    expect(second.address).toEqual(first.address);

    const reused = await t.exchange({ secret: first.secret, kind: "tui", label: "again" });
    expect(reused.status).toBe(401);
    expect(BootstrapError.parse(reused.body)).toMatchObject({ code: "unauthorized", data: {} });
    expect(t.grant().secret).toBe(second.secret);
    expect((await t.exchange({ secret: second.secret, kind: "tui", label: "two" })).status).toBe(200);
  });

  it("lets one secret be exchanged once even when two exchanges race", async () => {
    const t = await start();
    const { secret } = t.grant();
    const answers = await Promise.all([1, 2, 3].map((n) => t.exchange({ secret, kind: "tui", label: `racer ${n}` })));
    expect(answers.map((a) => a.status).sort()).toEqual([200, 401, 401]);
  });

  it("refuses a wrong secret 401 with a typed error, and keeps the grant as it was", async () => {
    const t = await start();
    const before = t.grant();
    const answer = await t.exchange({ secret: `${before.secret}x`, kind: "tui", label: "guess" });
    expect(answer.status).toBe(401);
    expect(BootstrapError.parse(answer.body)).toEqual({ code: "unauthorized", message: expect.any(String), data: {} });
    expect(t.grant()).toEqual(before);
    expect((await t.exchange({ secret: before.secret, kind: "tui", label: "right" })).status).toBe(200);
  });

  it("refuses a body that is not an exchange 400 invalid_params, and keeps the grant", async () => {
    const t = await start();
    const { secret } = t.grant();
    for (const body of [
      { secret, kind: "web", label: "browser" },
      { secret, kind: "program", label: "bot" },
      { secret, kind: "tui" },
      { secret, kind: "tui", label: "" },
      "not json",
      [secret],
    ]) {
      const answer = await t.exchange(body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(BootstrapError.parse(answer.body)).toMatchObject({ code: "invalid_params" });
    }
    expect(t.grant().secret).toBe(secret);
  });

  it("refuses a body too large to be an exchange", async () => {
    const t = await start();
    const answer = await t.exchange({ secret: t.grant().secret, kind: "tui", label: "x".repeat(64 * 1024) });
    expect(answer.status).toBe(413);
    expect(BootstrapError.parse(answer.body)).toMatchObject({ code: "invalid_params" });
  });

  it("takes 10 exchanges a minute from one address, then answers 429 rate_limited until the bucket refills", async () => {
    const t = await start();
    for (let i = 0; i < 10; i++) expect((await t.exchange({ secret: "a guess", kind: "tui", label: "guess" })).status).toBe(401);
    const limited = await fetch(`http://${t.address.host}:${t.address.port}${BOOTSTRAP_PATH}`, {
      method: "POST",
      body: JSON.stringify({ secret: t.grant().secret, kind: "tui", label: "right, but too soon" }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("6");
    expect(BootstrapError.parse(await limited.json())).toEqual({
      code: "rate_limited",
      message: expect.any(String),
      data: { retryAfterMs: 6000 },
    });
    // The refused exchange did not spend the secret.
    t.clock.advance(6000);
    expect((await t.exchange({ secret: t.grant().secret, kind: "tui", label: "on time" })).status).toBe(200);
    expect((await t.exchange({ secret: t.grant().secret, kind: "tui", label: "too soon" })).status).toBe(429);
  });

  it("takes POST only", async () => {
    const t = await start();
    const response = await fetch(`http://${t.address.host}:${t.address.port}${BOOTSTRAP_PATH}`);
    expect(response.status).toBe(405);
  });

  it("answers unavailable before the startup gate", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reach!: (address: Address | undefined) => void;
    const reached = new Promise<Address | undefined>((resolve) => (reach = resolve));
    const dataDir = join(tempDir(), "data");
    const starting = startTestEnvironment({
      dataDir,
      hooks: {
        beforeStep: async (step: StartupStep, progress) => {
          if (step !== "prepared") return;
          reach(progress.address);
          await gate;
        },
      },
    });
    onCleanup(async () => {
      release();
      await (await starting).close();
    });
    const address = await reached;
    if (!address) throw new Error("the listener was not bound before the prepared step");
    const grant = readGrant(dataDir);
    expect(grant.address).toEqual(address);

    const early = await postExchange(address, { secret: grant.secret, kind: "tui", label: "early" });
    expect(early.status).toBe(503);
    expect(BootstrapError.parse(early.body)).toMatchObject({ code: "unavailable", data: { readiness: "starting" } });

    release();
    await starting;
    expect((await postExchange(address, { secret: grant.secret, kind: "tui", label: "on time" })).status).toBe(200);
  });

  it("takes requests over loopback only, judged by the socket's address and not the Host header", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(address), address).toBe(true);
    for (const address of ["100.101.102.103", "192.168.1.2", "::ffff:10.0.0.1", "fd7a:115c:a1e0::1", "", undefined]) {
      expect(isLoopbackAddress(address), String(address)).toBe(false);
    }
  });
});

describe("desktop local client sessions", () => {
  it("are replaced by a new desktop exchange: the old one's socket gets bye revoked and its token is refused", async () => {
    const t = await start();
    const first = await t.bootstrap("desktop", "desktop at 9");
    const window = await t.client({ token: first.token, clientKind: "desktop" });

    const second = await t.bootstrap("desktop", "desktop at 10");
    expect((await window.closed).bye?.reason).toBe("revoked");
    expect(await outcome(t, first, "desktop")).toBe("bye: revoked");
    expect(await outcome(t, second, "desktop")).toBe("hello");
  });

  it("are not replaced by a tui exchange", async () => {
    const t = await start();
    const desktop = await t.bootstrap("desktop");
    await t.bootstrap("tui");
    expect(await outcome(t, desktop, "desktop")).toBe("hello");
  });

  it("are not revoked for being disconnected", async () => {
    const t = await start();
    const desktop = await t.bootstrap("desktop");
    t.clock.advance(3 * DAY);
    expect(await outcome(t, desktop, "desktop")).toBe("hello");
  });
});

describe("tui local client sessions", () => {
  it("are not replaced by another tui exchange: several run at once", async () => {
    const t = await start();
    const one = await t.bootstrap("tui", "left pane");
    const oneClient = await t.client({ token: one.token });
    const two = await t.bootstrap("tui", "right pane");
    const twoClient = await t.client({ token: two.token });
    expect(await oneClient.request("environment.status", {})).toEqual({ readiness: "ready" });
    expect(await twoClient.request("environment.status", {})).toEqual({ readiness: "ready" });
    expect(await t.bootstrap("desktop")).toBeDefined();
    expect(await oneClient.request("environment.status", {})).toEqual({ readiness: "ready" });
  });

  it("are revoked once their last socket has been closed for an hour", async () => {
    const t = await start();
    const tui = await t.bootstrap("tui");
    const client = await t.client({ token: tui.token });
    await client.close();

    t.clock.advance(TUI_REVOKE_AFTER_MS - 2 * MINUTE);
    // Reconnecting within the hour keeps it, and starts the hour again from the next close.
    expect(await outcome(t, tui)).toBe("hello");
    t.clock.advance(TUI_REVOKE_AFTER_MS - 2 * MINUTE);
    expect(await outcome(t, tui)).toBe("hello");

    t.clock.advance(TUI_REVOKE_AFTER_MS + 2 * MINUTE);
    expect(await outcome(t, tui)).toBe("bye: revoked");
    expect(TUI_REVOKE_AFTER_MS).toBe(HOUR);
  });

  it("are kept while a socket is open, however long", async () => {
    const t = await start();
    const tui = await t.bootstrap("tui");
    const client = await t.client({ token: tui.token });
    t.clock.advance(3 * HOUR);
    expect(await client.request("environment.status", {})).toEqual({ readiness: "ready" });
    expect(client.isOpen()).toBe(true);
  });

  it("count the hour from the exchange when they never connect", async () => {
    const t = await start();
    const tui = await t.bootstrap("tui");
    t.clock.advance(TUI_REVOKE_AFTER_MS + 2 * MINUTE);
    expect(await outcome(t, tui)).toBe("bye: revoked");
  });

  it("are swept after a restart too, from when they were last seen", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await startTestEnvironment({ dataDir });
    const tui = await first.bootstrap("tui");
    const client = await first.client({ token: tui.token });
    first.clock.advance(10 * MINUTE);
    await client.close();
    await first.close();

    // The restarted environment's clock starts where the first one's did: ten minutes before the close.
    const second = await start({ dataDir });
    second.clock.advance(10 * MINUTE + TUI_REVOKE_AFTER_MS - 2 * MINUTE);
    expect(await outcome(second, tui)).toBe("hello");
    second.clock.advance(TUI_REVOKE_AFTER_MS + 2 * MINUTE);
    expect(await outcome(second, tui)).toBe("bye: revoked");
  });
});
