import { randomUUID } from "node:crypto";
import { DEFAULT_ENVIRONMENT_PORT, DISCOVERY_PATH, PAIR_PATH, PAIRING_TTL_MS, PROTOCOL_VERSION, SCOPES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { Address } from "../../environment/src/serve/http.js";
import { startTestEnvironment } from "../../environment/test/helper.js";
import { notJsonAt, originOf, rewritingFetch, rewritingWebSocket, until, useHarness } from "../test/harness.js";
import { pairingDeepLink, pairingLinkIsLocal, parsePairingInput } from "./pairing.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";
import { CredentialAccessUnansweredError, isCredentialAccessUnanswered, PairingCodeSpentError, StoredCredentialUnavailableError } from "./credential-unavailable.js";

const harness = useHarness();

describe("reading what David pastes or types", () => {
  it("reads a link, the code in its fragment", () => {
    expect(parsePairingInput({ link: " http://100.64.0.7:7433/pair#K7Q2M-XH4RT " })).toEqual({
      ok: true,
      origin: "http://100.64.0.7:7433",
      code: "K7Q2MXH4RT",
    });
  });

  it("reads a link handed to the app as its deep link, and one that carries no pairing link as no link", () => {
    const link = "http://desk.tail1234.ts.net:7433/pair#K7Q2M-XH4RT";
    expect(pairingDeepLink(link)).toBe("agent-harness://pair?link=http%3A%2F%2Fdesk.tail1234.ts.net%3A7433%2Fpair%23K7Q2M-XH4RT");
    expect(parsePairingInput({ link: pairingDeepLink(link) })).toEqual({ ok: true, origin: "http://desk.tail1234.ts.net:7433", code: "K7Q2MXH4RT" });
    expect(parsePairingInput({ link: ` ${pairingDeepLink(link).replace("agent-harness://pair", "Agent-Harness://Pair")} ` })).toMatchObject({ ok: true });
    for (const other of ["agent-harness://pair?link=desk", "agent-harness://pair?link=%E0%A4%A", "agent-harness://open/desk/1", `agent-harness://pair?code=K7Q2MXH4RT`]) {
      expect(parsePairingInput({ link: other })).toMatchObject({ ok: false, failure: { reason: "invalid-link" } });
    }
  });

  it("reads an address and a typed code, in any case, with spaces or hyphens", () => {
    expect(parsePairingInput({ address: "desk.tail1234.ts.net:7433", code: "k7q2m xh4rt" })).toEqual({
      ok: true,
      origin: "http://desk.tail1234.ts.net:7433",
      code: "K7Q2MXH4RT",
    });
    expect(parsePairingInput({ address: "http://[fd7a::1]:8000/", code: "K7Q2M-XH4RT" })).toMatchObject({
      ok: true,
      origin: "http://[fd7a::1]:8000",
    });
  });

  it("takes an address without a port at the environment's default port", async () => {
    const { DEFAULT_PORT } = await import("../../environment/src/serve/start.js");
    expect(DEFAULT_ENVIRONMENT_PORT).toBe(DEFAULT_PORT);
    expect(parsePairingInput({ address: "desk", code: "K7Q2MXH4RT" })).toMatchObject({ ok: true, origin: "http://desk:7433" });
  });

  it("refuses a link that carries no code, an address that is not one, and a code that is not one, in setup-copy.md §4.2's words", () => {
    expect(parsePairingInput({ link: "http://desk:7433/pair" })).toEqual({
      ok: false,
      failure: { reason: "invalid-link", message: "That is not a pairing link. A pairing link ends with /pair# and a code." },
    });
    expect(parsePairingInput({ address: "desk:7433", code: "0000" })).toEqual({
      ok: false,
      failure: { reason: "invalid-code", message: "A pairing code has 10 letters and numbers, like K7Q2M-XH4RT." },
    });
    expect(parsePairingInput({ address: "desk:7433/some/path?x", code: "K7Q2MXH4RT" })).toEqual({
      ok: false,
      failure: { reason: "invalid-address", message: "Enter the other computer's address, like my-server or 192.168.1.20." },
    });
  });
});

describe("a link only this computer can use", () => {
  it("is one whose address is loopback, and no other", () => {
    for (const link of ["http://127.0.0.1:7433/pair#K7Q2MXH4RT", "http://127.4.5.6/pair#K7Q2MXH4RT", "http://localhost:7433/pair#K7Q2MXH4RT", "http://[::1]:7433/pair#K7Q2MXH4RT"]) {
      expect(pairingLinkIsLocal(link), link).toBe(true);
    }
    for (const link of ["http://100.64.0.7:7433/pair#K7Q2MXH4RT", "http://desk.tail1234.ts.net:7433/pair#K7Q2MXH4RT", "https://127.0.0.1.example.test/pair#K7Q2MXH4RT", "not a link"]) {
      expect(pairingLinkIsLocal(link), link).toBe(false);
    }
  });
});

describe("pairing with an environment", () => {
  it("pairs from a link: reads discovery, exchanges the code with kind and label, keeps the token, writes the record, connects", async () => {
    const t = await harness.environment({ name: "desk" });
    const platform = inMemoryPlatform({ kind: "tui", label: "Milo's laptop" });
    const runtime = harness.runtime(platform);
    await runtime.start();
    const { link } = await t.createPairing();

    expect(await runtime.connections.add({ link })).toEqual({ status: "paired", environmentId: t.env.id });

    const [record] = runtime.connections.list.read();
    expect(record).toMatchObject({
      environmentId: t.env.id,
      kind: "paired",
      address: originOf(t.address),
      enabled: true,
      phase: "ready",
      blocked: null,
    });
    const token = await platform.secrets.get(t.env.id);
    expect(token).toEqual(expect.any(String));
    // The token lives in secret storage only.
    expect(JSON.stringify(platform.documents.entries())).not.toContain(token);
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", { live: true });
    expect(sessions.find((s) => s.id === record?.clientSessionId)).toMatchObject({ kind: "tui", label: "Milo's laptop", local: false });
  });

  it("pairs from an address and the short code", async () => {
    const t = await harness.environment();
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    const { code } = await t.createPairing();

    const outcome = await runtime.connections.add({ address: `${t.address.host}:${t.address.port}`, code: code.toLowerCase() });

    expect(outcome).toEqual({ status: "paired", environmentId: t.env.id });
    expect(runtime.connections.list.read()[0]?.phase).toBe("ready");
  });

  it("keeps a paired connection across a restart and connects it again", async () => {
    const t = await harness.environment();
    const first = inMemoryPlatform();
    const runtime = harness.runtime(first);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const { clientSessionId } = runtime.connections.list.read()[0] ?? {};
    await runtime.close();

    const again = harness.runtime(inMemoryPlatform({ documents: first.documents, secrets: first.secrets }));
    await again.start();

    expect(again.connections.list.read()).toEqual([
      expect.objectContaining({ environmentId: t.env.id, kind: "paired", clientSessionId, phase: "ready" }),
    ]);
  });

  it("offers to re-pair a saved environment in place without spending the code, and re-pairs when asked", async () => {
    const t = await harness.environment({ name: "desk" });
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const before = runtime.connections.list.read()[0];
    const { link } = await t.createPairing();

    expect(await runtime.connections.add({ link })).toEqual({ status: "re-pair-offered", environmentId: t.env.id, name: "desk" });

    expect(await runtime.connections.add({ link }, { rePair: t.env.id })).toEqual({ status: "paired", environmentId: t.env.id, replaced: { revoked: true } });
    const after = runtime.connections.list.read();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ environmentId: t.env.id, phase: "ready" });
    expect(after[0]?.clientSessionId).not.toBe(before?.clientSessionId);
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", {});
    expect(sessions.find((s) => s.id === before?.clientSessionId)?.revokedAt).toEqual(expect.any(String));
    expect(sessions.find((s) => s.id === after[0]?.clientSessionId)?.revokedAt).toBeNull();
  });

  it("asks the store whether it can keep a token before spending the code, so a store that keeps none or an unanswered OS prompt leaves the code to pair with", async () => {
    const t = await harness.environment({ name: "desk" });
    const platform = inMemoryPlatform();
    let answer: () => Promise<"os" | "none"> = async () => "none";
    const runtime = harness.runtime(inMemoryPlatform({ secrets: { ...platform.secrets, protection: () => answer() } }));
    await runtime.start();
    const { link } = await t.createPairing();

    expect(await runtime.connections.add({ link })).toMatchObject({ status: "failed", failure: { reason: "refused", message: "This device has no safe place to keep the connection. Unlock or set up its keychain, then pair again.", details: [expect.stringContaining("client session token")] } });
    answer = () => Promise.reject(new CredentialAccessUnansweredError(30));
    await expect(runtime.connections.add({ link })).rejects.toThrow(CredentialAccessUnansweredError);
    expect(runtime.connections.list.read()).toEqual([]);

    answer = async () => "os";
    expect(await runtime.connections.add({ link })).toEqual({ status: "paired", environmentId: t.env.id });
    expect(await platform.secrets.get(t.env.id)).toEqual(expect.any(String));
  });

  it("says a token the store could not keep after the exchange spent the code, so the same code is not offered again", async () => {
    const t = await harness.environment({ name: "desk" });
    const platform = inMemoryPlatform();
    const secrets = { ...platform.secrets, protection: async () => "os" as const, set: () => Promise.reject(new CredentialAccessUnansweredError(30)) };
    const runtime = harness.runtime(inMemoryPlatform({ secrets }));
    await runtime.start();
    const { link } = await t.createPairing();

    const failure = await runtime.connections.add({ link }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PairingCodeSpentError);
    expect(isCredentialAccessUnanswered(failure)).toBe(true);
    expect(runtime.connections.list.read()).toEqual([]);
    expect(await runtime.connections.add({ link })).toMatchObject({ status: "failed", failure: { reason: "used-code" } });
  });

  it("revokes the new client session over its socket when the store cannot keep its token, so no session is left live that no client holds (#1706)", async () => {
    const t = await harness.environment();
    const platform = inMemoryPlatform();
    const secrets = { ...platform.secrets, set: () => Promise.reject(new Error("The keychain refused the write.")) };
    const runtime = harness.runtime(inMemoryPlatform({ label: "Milo's laptop", secrets }));
    await runtime.start();

    await expect(runtime.connections.add({ link: (await t.createPairing()).link })).rejects.toThrow(PairingCodeSpentError);
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", {});
    expect(sessions.filter(session => session.label === "Milo's laptop")).toEqual([expect.objectContaining({ revokedAt: expect.any(String) })]);
  });

  it("re-pairs in place with a store that cannot keep the new token: both client sessions are given up and the connection is blocked, to pair again with a new code (#1706)", async () => {
    const t = await harness.environment();
    const platform = inMemoryPlatform();
    let refuse = false;
    const secrets = {
      ...platform.secrets,
      set: async (id: string, token: string) => {
        if (refuse) throw new Error("The keychain refused the write.");
        await platform.secrets.set(id, token);
      },
    };
    const runtime = harness.runtime(inMemoryPlatform({ label: "Milo's laptop", secrets }));
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const before = runtime.connections.list.read()[0]?.clientSessionId;
    refuse = true;

    await expect(runtime.connections.add({ link: (await t.createPairing()).link }, { rePair: t.env.id })).rejects.toThrow(PairingCodeSpentError);
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", {});
    const paired = sessions.filter(session => session.label === "Milo's laptop");
    expect(paired).toHaveLength(2);
    expect(paired.map(session => session.revokedAt)).toEqual([expect.any(String), expect.any(String)]);
    await until(() => runtime.connections.list.read()[0]?.phase === "blocked", "the connection blocked");
    expect(runtime.connections.list.read()).toEqual([expect.objectContaining({ clientSessionId: before, blocked: "revoked" })]);
  });

  it("re-pairs with a code without admin: the replaced client session is revoked with the old token", async () => {
    const t = await harness.environment();
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const before = runtime.connections.list.read()[0]?.clientSessionId;

    expect(await runtime.connections.add({ link: (await t.createPairing({ scopes: ["read"] })).link }, { rePair: t.env.id })).toEqual({
      status: "paired",
      environmentId: t.env.id,
      replaced: { revoked: true },
    });
    const after = runtime.connections.list.read()[0];
    expect(after).toMatchObject({ phase: "ready", scopes: ["read"] });
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", {});
    expect(sessions.find((s) => s.id === before)?.revokedAt).toEqual(expect.any(String));
    expect(sessions.find((s) => s.id === after?.clientSessionId)?.revokedAt).toBeNull();
  });

  it.each([
    { scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits" },
    { scopes: ["read"], ceiling: "bypassPermissions" },
    { scopes: [...SCOPES], ceiling: "auto" },
  ] as const)("keeps the saved pairing when a full-access replacement grants $scopes with $ceiling", async grant => {
    const t = await harness.environment();
    const platform = inMemoryPlatform();
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const before = runtime.connections.list.read();
    const token = await platform.secrets.get(t.env.id);
    const link = (await t.createPairing({ scopes: [...grant.scopes], ceiling: grant.ceiling })).link;

    expect(await runtime.connections.add({ link }, { rePair: t.env.id, fullAccess: true })).toMatchObject({
      status: "failed", failure: { reason: "refused", message: "Full access could not be confirmed. Use a full-access code made for Me. This phone's pairing has not changed.", details: [expect.stringMatching(new RegExp(`^The code granted .+ with ceiling ${grant.ceiling}\\.$`)), expect.stringContaining("The new connection holds")] },
    });
    expect(runtime.connections.list.read()).toEqual(before);
    expect(await platform.secrets.get(t.env.id)).toBe(token);
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", {});
    expect(sessions.find(session => session.id === before[0]?.clientSessionId)?.revokedAt).toBeNull();
  });

  it("keeps the old pairing when the authenticated replacement grant is narrower than its exchange", async () => {
    const t = await harness.environment();
    let replacing = false;
    const platform = inMemoryPlatform({ webSocket: rewritingWebSocket(frame => frame["type"] !== "hello" ? frame : { ...frame, scopes: ["read"] }, () => replacing) });
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const before = runtime.connections.list.read();
    const token = await platform.secrets.get(t.env.id);
    replacing = true;
    const link = (await t.createPairing({ scopes: [...SCOPES], ceiling: "bypassPermissions" })).link;

    expect(await runtime.connections.add({ link }, { rePair: t.env.id, fullAccess: true })).toMatchObject({ status: "failed", failure: { reason: "refused" } });
    expect(runtime.connections.list.read()).toEqual(before);
    expect(await platform.secrets.get(t.env.id)).toBe(token);
  });

  it("re-pairs an unreadable earlier credential with a read-only code, without pretending to revoke the older session", async () => {
    const t = await harness.environment();
    const platform = inMemoryPlatform();
    let unavailable = false;
    const secrets = {
      ...platform.secrets,
      get: async (id: string) => {
        if (unavailable) throw new Error(`Error invoking remote method 'shell:secrets.get': ${new StoredCredentialUnavailableError("OS approval was unavailable.").message}`);
        return platform.secrets.get(id);
      },
      set: async (id: string, token: string) => { await platform.secrets.set(id, token); unavailable = false; },
    };
    const runtime = harness.runtime(inMemoryPlatform({ secrets }));
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const previous = runtime.connections.list.read()[0]?.clientSessionId;
    unavailable = true;
    await runtime.connections.retryNow(t.env.id);
    expect(runtime.connections.list.read()).toEqual([expect.objectContaining({ phase: "blocked", blocked: "credential-unavailable" })]);
    expect(runtime.projections.notices.read()).toContainEqual(expect.objectContaining({ kind: "credential-unavailable", action: "re-pair" }));
    expect(await runtime.connections.add({ link: (await t.createPairing({ scopes: ["read"] })).link }, { rePair: t.env.id })).toMatchObject({
      status: "paired", replaced: { revoked: false, message: expect.stringContaining("stored credentials") },
    });
    expect(runtime.connections.list.read()).toEqual([expect.objectContaining({ phase: "ready", scopes: ["read"] })]);
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", { live: true });
    expect(sessions.map(session => session.id)).toContain(previous);
  });

  it("re-pairs when neither client session holds admin: the replaced one is still live, and says so", async () => {
    const t = await harness.environment();
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing({ scopes: ["read"] })).link });
    const before = runtime.connections.list.read()[0]?.clientSessionId;

    expect(await runtime.connections.add({ link: (await t.createPairing({ scopes: ["read"] })).link }, { rePair: t.env.id })).toMatchObject({
      status: "paired",
      replaced: { revoked: false, reason: "scope", message: expect.stringContaining("admin") },
    });
    const admin = await t.client();
    const { sessions } = await admin.apply("access.sessions.list", { live: true });
    expect(sessions.map((s) => s.id)).toContain(before);
  });

  describe("fails with a typed reason", () => {
    it("expired-code: the code's ten minutes are over", async () => {
      const t = await harness.environment();
      const runtime = harness.runtime(inMemoryPlatform());
      await runtime.start();
      const { link } = await t.createPairing();
      t.clock.advance(PAIRING_TTL_MS + 1);

      expect(await runtime.connections.add({ link })).toMatchObject({
        status: "failed",
        failure: { reason: "expired-code", message: "This code has run out. Make a new code on the other computer.", details: [expect.stringContaining("pairing_expired")] },
      });
      expect(runtime.connections.list.read()).toEqual([]);
    });

    it("used-code: the code has been exchanged already", async () => {
      const t = await harness.environment();
      const runtime = harness.runtime(inMemoryPlatform());
      await runtime.start();
      const { code, link } = await t.createPairing();
      expect((await t.pairExchange({ code, kind: "program", label: "first", protocolVersion: PROTOCOL_VERSION })).status).toBe(200);

      expect(await runtime.connections.add({ link })).toMatchObject({
        status: "failed",
        failure: { reason: "used-code", message: "This code was already used. Make a new code on the other computer.", details: [expect.stringContaining("pairing_used")] },
      });
    });

    it("unreachable: nothing answers at the address", async () => {
      const t = await harness.environment();
      const { link } = await t.createPairing();
      await t.close();
      const runtime = harness.runtime(inMemoryPlatform());
      await runtime.start();

      // The line names the host the person can check; the address and what the platform said ("fetch failed") are Details.
      const host = new URL(link).host;
      expect(await runtime.connections.add({ link })).toEqual({
        status: "failed",
        failure: {
          reason: "unreachable",
          message: `Nothing answered at ${host}. Check that the other computer is on and that both are connected to Tailscale.`,
          details: [expect.stringMatching(new RegExp(`^Nothing answered at http://${host.replace(/\./g, "\\.")}: .+\\.$`))],
        },
      });
    });

    it("protocol-mismatch: the environment speaks an older protocol than this client, and the code is not spent", async () => {
      const t = await harness.environment({ name: "desk" });
      const runtime = harness.runtime(inMemoryPlatform(), { protocolVersion: PROTOCOL_VERSION + 1 });
      await runtime.start();
      const { code, link } = await t.createPairing();

      expect(await runtime.connections.add({ link })).toMatchObject({
        status: "failed",
        failure: {
          reason: "protocol-mismatch",
          message: "This app and desk run versions that cannot talk. Update desk, then pair again.",
          details: [expect.stringContaining("update the environment")],
        },
      });
      expect((await t.pairExchange({ code, kind: "program", label: "later", protocolVersion: PROTOCOL_VERSION })).status).toBe(200);
    });

    it.each([
      { version: PROTOCOL_VERSION + 1, reason: "protocol-mismatch", update: "desk" },
      { version: PROTOCOL_VERSION - 1, reason: "unsupported-client", update: "this app" },
    ])("keeps the raw exchange refusal in Details for $reason", async ({ version, reason, update }) => {
      const t = await harness.environment({ name: "desk" });
      const runtime = harness.runtime(
        inMemoryPlatform({ fetch: rewritingFetch(DISCOVERY_PATH, body => ({ ...body, protocolVersion: version })) }),
        { protocolVersion: version },
      );
      await runtime.start();
      const { code, link } = await t.createPairing();

      expect(await runtime.connections.add({ link })).toMatchObject({
        status: "failed",
        failure: {
          reason,
          message: `This app and desk run versions that cannot talk. Update ${update}, then pair again.`,
          details: [`protocol_mismatch (HTTP 400): The client speaks protocol ${version}; this environment speaks ${PROTOCOL_VERSION}.`],
        },
      });
      expect(runtime.connections.list.read()).toEqual([]);
      expect((await t.pairExchange({ code, kind: "program", label: "later", protocolVersion: PROTOCOL_VERSION })).status).toBe(200);
    });

    it("unsupported-client: the environment speaks a newer protocol than this client", async () => {
      const t = await harness.environment({ name: "desk" });
      const runtime = harness.runtime(
        inMemoryPlatform({ fetch: rewritingFetch(DISCOVERY_PATH, (body) => ({ ...body, protocolVersion: PROTOCOL_VERSION + 1 })) }),
      );
      await runtime.start();

      expect(await runtime.connections.add({ link: (await t.createPairing()).link })).toMatchObject({
        status: "failed",
        failure: {
          reason: "unsupported-client",
          message: "This app and desk run versions that cannot talk. Update this app, then pair again.",
          details: [expect.stringContaining("update this client")],
        },
      });
    });

    it("not-ready: discovery says the environment is still starting", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let address: Address | undefined;
      const starting = startTestEnvironment({
        hooks: {
          beforeStep: async (step, progress) => {
            if (step !== "prepared") return;
            address = progress.address;
            await gate;
          },
        },
      });
      harness.onCleanup(async () => {
        release();
        await (await starting).close();
      });
      await until(() => address !== undefined, "the environment to bind");
      const runtime = harness.runtime(inMemoryPlatform());
      await runtime.start();

      expect(await runtime.connections.add({ address: originOf(address as Address), code: "23456-789AB" })).toMatchObject({
        status: "failed",
        failure: { reason: "not-ready", message: "The other computer is still starting. Try again in a moment.", details: [expect.stringContaining("starting")] },
      });
    });

    it("different-environment: re-pairing a saved connection with another environment's code", async () => {
      const a = await harness.environment({ name: "desk" });
      const b = await harness.environment({ name: "laptop" });
      const runtime = harness.runtime(inMemoryPlatform());
      await runtime.start();
      await runtime.connections.add({ link: (await a.createPairing()).link });

      expect(await runtime.connections.add({ link: (await b.createPairing()).link }, { rePair: a.env.id })).toMatchObject({
        status: "failed",
        failure: { reason: "different-environment", message: "That code is for laptop, not desk. Make a new code on desk." },
      });
      expect(runtime.connections.list.read().map((r) => r.environmentId)).toEqual([a.env.id]);
    });

    it("refused, not unreachable: discovery answers something that is not JSON", async () => {
      const t = await harness.environment();
      const runtime = harness.runtime(inMemoryPlatform({ fetch: notJsonAt(DISCOVERY_PATH, 502) }));
      await runtime.start();

      const { link } = await t.createPairing();
      expect(await runtime.connections.add({ link })).toMatchObject({
        status: "failed",
        failure: { reason: "refused", message: `${new URL(link).host} is not running agent-harness.`, details: [expect.stringContaining("502")] },
      });
    });

    it("refused, not unreachable: the pairing exchange answers something that is not JSON", async () => {
      const t = await harness.environment();
      const runtime = harness.runtime(inMemoryPlatform({ fetch: notJsonAt(PAIR_PATH, 204) }));
      await runtime.start();

      const { link } = await t.createPairing();
      expect(await runtime.connections.add({ link })).toMatchObject({
        status: "failed",
        failure: { reason: "refused", message: `${new URL(link).host} did not accept the pairing. Make a new code and try again.`, details: [expect.stringContaining("204")] },
      });
    });

    it("refused: an error code that is only an inherited property name, such as constructor", async () => {
      const t = await harness.environment();
      const runtime = harness.runtime(inMemoryPlatform({ fetch: rewritingFetch(PAIR_PATH, () => ({ code: "constructor", message: "no" })) }));
      await runtime.start();

      const { link } = await t.createPairing();
      expect(await runtime.connections.add({ link })).toEqual({
        status: "failed",
        failure: { reason: "refused", message: `${new URL(link).host} did not accept the pairing. Make a new code and try again.`, details: [expect.stringContaining(": no")] },
      });
    });

    it("rate-limited and not-ready: the exchange's refusals read setup-copy.md §4.2, the environment's own words in Details", async () => {
      const t = await harness.environment();
      const answers = [{ code: "rate_limited", message: "slow down" }, { code: "unavailable", message: "draining" }];
      const runtime = harness.runtime(inMemoryPlatform({ fetch: rewritingFetch(PAIR_PATH, () => answers.shift() ?? {}) }));
      await runtime.start();

      expect(await runtime.connections.add({ link: (await t.createPairing()).link })).toMatchObject({
        status: "failed",
        failure: { reason: "rate-limited", message: "Too many tries. Wait one minute, then try again.", details: [expect.stringContaining("rate_limited")] },
      });
      expect(await runtime.connections.add({ link: (await t.createPairing()).link })).toMatchObject({
        status: "failed",
        failure: { reason: "not-ready", message: "The other computer is still starting. Try again in a moment.", details: [expect.stringContaining("draining")] },
      });
    });

    it("invalid-code: the environment issued no such code", async () => {
      const t = await harness.environment();
      const runtime = harness.runtime(inMemoryPlatform());
      await runtime.start();

      expect(await runtime.connections.add({ address: originOf(t.address), code: "23456-789AB" })).toMatchObject({
        status: "failed",
        failure: { reason: "invalid-code", message: "The other computer does not know this code. Check it, or make a new one.", details: [expect.stringContaining("pairing_invalid")] },
      });
    });

    it("different-environment: hello names another environment than discovery did; the client session is revoked and nothing is kept", async () => {
      const t = await harness.environment();
      const elsewhere = randomUUID();
      const platform = inMemoryPlatform({ fetch: rewritingFetch(DISCOVERY_PATH, (body) => ({ ...body, environmentId: elsewhere })) });
      const runtime = harness.runtime(platform);
      await runtime.start();

      expect(await runtime.connections.add({ link: (await t.createPairing()).link })).toMatchObject({
        status: "failed",
        failure: {
          reason: "different-environment",
          message: "That address reaches a different computer than the one that made the code. Make a new code and try again.",
          details: [expect.stringContaining("not the one its address named")],
        },
      });

      expect(runtime.connections.list.read()).toEqual([]);
      expect(await platform.secrets.get(elsewhere)).toBeUndefined();
      expect(await platform.secrets.get(t.env.id)).toBeUndefined();
      const admin = await t.client();
      const { sessions } = await admin.apply("access.sessions.list", {});
      expect(sessions.filter((s) => s.kind === "tui" && !s.local).map((s) => s.revokedAt)).toEqual([expect.any(String)]);
    });

    it("unsupported-client: hello speaks a newer protocol than discovery said, and nothing is kept", async () => {
      const t = await harness.environment({ name: "desk" });
      const newer = (frame: Record<string, unknown>) => (frame["type"] === "hello" ? { ...frame, protocolVersion: PROTOCOL_VERSION + 1 } : frame);
      const platform = inMemoryPlatform({ webSocket: rewritingWebSocket(newer, () => true) });
      const runtime = harness.runtime(platform);
      await runtime.start();

      expect(await runtime.connections.add({ link: (await t.createPairing()).link })).toMatchObject({
        status: "failed",
        failure: { reason: "unsupported-client", message: "This app and desk run versions that cannot talk. Update this app, then pair again." },
      });
      expect(runtime.connections.list.read()).toEqual([]);
      expect(await platform.secrets.get(t.env.id)).toBeUndefined();
    });
  });
});
