import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import type { AccountRecord } from "@agent-harness/contracts";
import { afterEach, expect, it } from "vitest";
import { WAIT_MS } from "../../test/wire-client.js";
import { manualClock } from "../../test/clock.js";
import { claudeVerificationUrl } from "../adapters/claude/signin.js";
import { openEventLog, type EventLog } from "../event-log/event-log.js";
import type { CommandContext } from "../serve/methods.js";
import { createSignInDirector, SIGN_IN_EXPIRY_MS } from "./signin-director.js";
import type { SignInDirector } from "./signin-seam.js";

const eventually = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: WAIT_MS });

const resources: { director: SignInDirector; log: EventLog; provider: Server }[] = [];
afterEach(async () => {
  for (const { director, log, provider } of resources.splice(0)) {
    director.close();
    log.close();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});

const account: AccountRecord = {
  id: "work", provider: "claude", label: "Project", directory: { kind: "owned", path: "/tmp/scripted-account" },
  identity: null, status: { state: "signed-out", checkedAt: null, detail: null }, createdAt: "2026-10-01T00:00:00.000Z",
};

/** Real process and HTTP boundaries; only the provider is scripted. */
const setup = async () => {
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", clock: () => clock.now() });
  const exchanges: { code: string; state: string; code_verifier: string }[] = [];
  let releaseExchange: (() => void) | undefined;
  const heldExchange = new Promise<void>(resolve => { releaseExchange = resolve; });
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const exchange = JSON.parse(body) as (typeof exchanges)[number];
    exchanges.push(exchange);
    await heldExchange;
    response.writeHead(exchange.code === "code-for-tests" && exchange.state === "state-for-tests" && exchange.code_verifier === "proof-key-for-tests" ? 200 : 400).end();
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  if (address === null || typeof address === "string") throw new Error("No scripted provider port.");
  const director = createSignInDirector({ log, clock, environmentId: "environment-for-tests", programs: { claude: {
    bundled: process.execPath, managedTool: () => null, toolName: "scripted-provider",
    argv: [fileURLToPath(new URL("../../test/loopback-signin.mjs", import.meta.url))],
    probeArgv: [fileURLToPath(new URL("../../test/loopback-signin.mjs", import.meta.url)), "--help"],
    runsSignIn: result => result.code === 0,
    env: () => ({ SCRIPTED_TOKEN_URL: `http://127.0.0.1:${address.port}/token` }),
    verificationUrl: claudeVerificationUrl, fallback: () => ({ posix: "scripted-provider", powershell: "scripted-provider" }),
  } } })({ account: () => account, finished: async () => ({ signedIn: true, account }) });
  resources.push({ director, log, provider });
  const command = (action: (context: CommandContext) => unknown) => {
    const commandId = randomUUID();
    log.command({ actor: "client_session:scripted", commandId }, tx => action({ tx, commandId, actor: "client_session:scripted", clientSession: undefined as never }) as never);
  };
  command(context => director.begin({ accountId: account.id }, context));
  await eventually(() => director.latest()?.state).toBe("awaiting-code");
  const url = new URL(director.latest()?.url ?? "");
  const callback = url.searchParams.get("redirect_uri") ?? "";
  return { director, clock, command, url, callback, exchanges, release: () => releaseExchange?.() };
};

const callbackUrl = (callback: string, state = "state-for-tests") => `${callback}?code=code-for-tests&state=${state}`;

it("completes through the provider's loopback without stdin, with a proof key checked and a second use refused", async () => {
  const s = await setup();
  expect(new URL(s.callback).hostname).toBe("127.0.0.1");
  expect(s.url.searchParams.get("code_challenge_method")).toBe("S256");
  const first = fetch(callbackUrl(s.callback));
  await eventually(() => s.exchanges.length).toBe(1);
  expect(createHash("sha256").update(s.exchanges[0]?.code_verifier ?? "").digest("base64url")).toBe(s.url.searchParams.get("code_challenge"));
  expect((await fetch(callbackUrl(s.callback))).status).toBe(400);
  s.release();
  expect((await first).status).toBe(200);
  await eventually(() => s.director.latest()?.state).toBe("done");
  await expect(fetch(callbackUrl(s.callback))).rejects.toThrow();
});

it("rejects a mismatched state without a token exchange", async () => {
  const s = await setup();
  expect((await fetch(callbackUrl(s.callback, "another-state"))).status).toBe(400);
  expect(s.exchanges).toEqual([]);
  expect(s.director.latest()?.state).toBe("awaiting-code");
});

it.each(["cancel", "timeout"])("closes the provider listener on %s", async action => {
  const s = await setup();
  if (action === "cancel") s.command(context => s.director.cancel({ accountId: account.id }, context));
  else s.clock.advance(SIGN_IN_EXPIRY_MS);
  expect(s.director.latest()?.state).toBe(action === "cancel" ? "cancelled" : "expired");
  await eventually(async () => { try { await fetch(callbackUrl(s.callback, "another-state")); return false; } catch { return true; } }).toBe(true);
  expect(s.exchanges).toEqual([]);
});

it("completes the environment's own manual-code flow through stdin", async () => {
  const s = await setup();
  s.command(context => s.director.code({ accountId: account.id, code: "code-for-tests#state-for-tests" }, context));
  expect(s.director.latest()?.state).toBe("submitting");
  s.release();
  await eventually(() => s.director.latest()?.state).toBe("done");
  expect(s.exchanges).toEqual([{ code: "code-for-tests", state: "state-for-tests", code_verifier: "proof-key-for-tests" }]);
  await expect(fetch(callbackUrl(s.callback))).rejects.toThrow();
});
