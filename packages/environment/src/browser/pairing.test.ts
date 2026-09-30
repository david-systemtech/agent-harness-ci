import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHROME_PAIRING_CODE_LENGTH,
  PAIRING_CODE_ALPHABET,
  type BridgeFromEnvironment,
  type EventEnvelope,
  type ResultOf,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { TEST_EXTENSION_VERSION, dialExtension, fakeChrome, type FakeChrome, type FakeConnection, type FakeExtension } from "../../test/fake-extension.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { VAULT_FILE } from "../serve/vault.js";

/**
 * Pairing and paired Chromes through the primary seam (browser spec, "The
 * extension, its folder and its listener" and "Testing Decisions"; ADR
 * 0014, ADR 0024; #548): the in-process environment with the fake extension
 * pairing, proving and reconnecting over the real socket, the typed client
 * over the wire for the methods and the notices, and the manual clock for a
 * code's expiry. What is asserted is what the extension hears and what a
 * client sees; the log is read only to show what it never holds.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const folderOf = (t: Pick<TestEnvironment, "dataDir">): string => join(t.dataDir, "extension", "current");

/** A client of `t`, closed after the test. */
const clientOf = async (t: TestEnvironment): Promise<WireClient> => {
  const client = await t.client();
  onCleanup(() => client.close());
  return client;
};

const pairingCode = async (t: TestEnvironment): Promise<ResultOf<"browser.pairing.code">> => (await clientOf(t)).apply("browser.pairing.code", {});

const chromes = async (t: TestEnvironment): Promise<ResultOf<"browser.chromes.list">["chromes"]> => (await (await clientOf(t)).apply("browser.chromes.list", {})).chromes;

/** The fake extension in one Chrome profile, whose sockets close after the test. */
const chromeOf = (t: Pick<TestEnvironment, "dataDir">): FakeChrome => {
  const chrome = fakeChrome(folderOf(t));
  return {
    credential: () => chrome.credential(),
    connect: async (options) => closing(await chrome.connect(options)),
    pair: async (code, name) => closing(await chrome.pair(code, name)),
  };
};

const closing = (connection: FakeConnection): FakeConnection => {
  onCleanup(() => connection.extension.close());
  return connection;
};

/** The fake extension's socket, dialled from the folder, closed after the test. */
const dial = async (t: Pick<TestEnvironment, "dataDir">): Promise<FakeExtension> => {
  const extension = await dialExtension(folderOf(t));
  onCleanup(() => extension.close());
  return extension;
};

/** Pairs a fake Chrome as `name` with a code minted now, and answers it with the `paired` message. */
const paired = async (t: TestEnvironment, name = "Work"): Promise<{ chrome: FakeChrome; connection: FakeConnection; message: Extract<BridgeFromEnvironment, { type: "paired" }> }> => {
  const chrome = chromeOf(t);
  const connection = await chrome.pair((await pairingCode(t)).code, name);
  if (connection.answer.type !== "paired") throw new Error(`The pairing was refused: ${JSON.stringify(connection.answer)}`);
  return { chrome, connection, message: connection.answer };
};

/** Makes the log's reads of `table` throw, as a disk gone bad would, until the answer is called or the test ends; its other reads go through. */
const failReadsOf = (t: TestEnvironment, table: RegExp): (() => void) => {
  const read = t.env.log.read.bind(t.env.log);
  const failing = vi.spyOn(t.env.log, "read").mockImplementation(((sql: string, ...params: Parameters<typeof read>[1][]) => {
    if (table.test(sql)) throw new Error("the disk is gone");
    return read(sql, ...params);
  }) as typeof read);
  onCleanup(() => failing.mockRestore());
  return () => failing.mockRestore();
};

/** console.error, quiet until the test ends. */
const quietErrors = () => {
  const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
  onCleanup(() => said.mockRestore());
  return said;
};

/** Every event the log holds, on every stream. */
const everyEvent = (t: TestEnvironment): EventEnvelope[] =>
  t.env.log.read<{ payload: string; metadata: string; type: string }>("SELECT type, payload, metadata FROM events") as unknown as EventEnvelope[];

/** Follows environment.subscribe from now: answers the chrome.updated notices it hears, as they come. */
const followNotices = async (t: TestEnvironment) => {
  const watcher = await clientOf(t);
  const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
  return {
    /** The next chrome.updated notice's payload. */
    next: async () => {
      const frame = await watcher.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "chrome.updated");
      if (frame.type !== "event") throw new Error("Not an event frame.");
      return frame.event.payload;
    },
  };
};

describe("browser.pairing.code", () => {
  it("mints a code of eight characters of the pairing alphabet, good for five minutes, and answers the same code while it is live", async () => {
    const t = await start();

    const first = await pairingCode(t);

    expect(first.code).toHaveLength(CHROME_PAIRING_CODE_LENGTH);
    for (const character of first.code) expect(PAIRING_CODE_ALPHABET).toContain(character);
    expect(first.expiresAt).toBe(new Date(t.clock.now().getTime() + 5 * 60 * 1000).toISOString());
    t.clock.advance(5 * 60 * 1000 - 1);
    expect(await pairingCode(t)).toEqual(first);
  });

  it("mints another once the live one has expired, which is never logged", async () => {
    const t = await start();
    const first = await pairingCode(t);

    t.clock.advance(5 * 60 * 1000);
    const second = await pairingCode(t);

    expect(second.code).not.toBe(first.code);
    expect(second.expiresAt).toBe(new Date(t.clock.now().getTime() + 5 * 60 * 1000).toISOString());
    expect(JSON.stringify(everyEvent(t))).not.toContain(first.code);
    expect(JSON.stringify(everyEvent(t))).not.toContain(second.code);
  });

  it("is refused to a client session without admin", async () => {
    const t = await start();
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
    onCleanup(() => reader.close());

    await expect(reader.request("browser.pairing.code", {})).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("pairing", () => {
  it("makes a paired Chrome of a good code: its id, a 32-byte secret kept in the vault, the page policy, and a chrome.updated naming it", async () => {
    const t = await start({ harnessVersion: "1.0.0-test" });
    const notices = await followNotices(t);
    const { code } = await pairingCode(t);
    const chrome = chromeOf(t);

    const { answer } = await chrome.pair(code, "  Work  ");

    expect(answer).toEqual({
      type: "paired",
      chromeId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      secret: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      policy: { devSites: [], evaluateEverywhere: false, deepReadEverywhere: false, browserDomains: expect.any(Array) as unknown[] },
    });
    if (answer.type !== "paired") return;
    expect(await notices.next()).toEqual({ chromeId: answer.chromeId, name: "Work", change: "paired" });
    const vault = JSON.parse(readFileSync(join(t.dataDir, VAULT_FILE), "utf8")) as Record<string, string>;
    expect(Object.values(vault)).toContain(answer.secret);
    expect(await chromes(t)).toEqual([
      {
        id: answer.chromeId,
        name: "Work",
        pairedAt: t.clock.now().toISOString(),
        lastConnectedAt: t.clock.now().toISOString(),
        lastReportedVersion: TEST_EXTENSION_VERSION,
        connected: true,
        outdated: false,
      },
    ]);
    // The socket is the Chrome's now, no longer an unpaired extension's.
    expect((await (await clientOf(t)).apply("browser.status", {})).unpairedConnected).toBe(false);
  });

  it("records chrome.paired with the name and the announced version, and no event holds the secret", async () => {
    const t = await start();
    const { message } = await paired(t);

    const events = t.env.log.readStream({ kind: "chrome", id: message.chromeId });

    expect(events.map((event) => [event.type, event.payload])).toEqual([["chrome.paired", { name: "Work", extensionVersion: TEST_EXTENSION_VERSION }]]);
    expect(JSON.stringify(everyEvent(t))).not.toContain(message.secret);
  });

  it("cleans the name: control and invisible characters removed, and A browser when nothing is left", async () => {
    const t = await start();

    await paired(t, "​Per\u0007sonal‮ ");
    t.clock.advance(5 * 60 * 1000);
    await paired(t, " ‍ ");

    expect((await chromes(t)).map((chrome) => chrome.name)).toEqual(["Personal", "A browser"]);
  });

  it("pairs once: a spent code is refused with a sentence, and the socket stays for another", async () => {
    const t = await start();
    const { code } = await pairingCode(t);
    await chromeOf(t).pair(code, "Work");

    const { extension, answer } = await chromeOf(t).pair(code, "Personal");

    expect(answer).toEqual({ type: "refused", reason: expect.stringMatching(/used/) as string });
    expect(extension.isOpen()).toBe(true);
    expect((await chromes(t)).map((chrome) => chrome.name)).toEqual(["Work"]);
    // The next code pairs on the same socket.
    expect(await extension.pair((await pairingCode(t)).code, "Personal")).toMatchObject({ type: "paired" });
  });

  it("refuses an expired code with a sentence", async () => {
    const t = await start();
    const { code } = await pairingCode(t);
    t.clock.advance(5 * 60 * 1000);

    const { answer } = await chromeOf(t).pair(code);

    expect(answer).toEqual({ type: "refused", reason: expect.stringMatching(/expired/) as string });
    expect(await chromes(t)).toEqual([]);
  });

  it("refuses a wrong code with a sentence, and voids the live code after five wrong guesses", async () => {
    const t = await start();
    const { code } = await pairingCode(t);
    const wrong = code === "22222222" ? "33333333" : "22222222";
    const extension = await dial(t);
    await extension.announce();

    const answers: BridgeFromEnvironment[] = [];
    for (let guess = 0; guess < 5; guess++) answers.push(await extension.pair(guess === 2 ? "not a code" : wrong));

    for (const answer of answers.slice(0, 4)) expect(answer).toEqual({ type: "refused", reason: expect.stringMatching(/not the code/) as string });
    expect(answers[4]).toEqual({ type: "refused", reason: expect.stringMatching(/void/) as string });
    expect(await extension.pair(code)).toEqual({ type: "refused", reason: expect.stringMatching(/void/) as string });
    expect(await chromes(t)).toEqual([]);
    // A new code is minted in the void one's place, and pairs.
    const next = await pairingCode(t);
    expect(next.code).not.toBe(code);
    expect(await extension.pair(next.code.toLowerCase().replace(/(.{4})/, "$1-"))).toMatchObject({ type: "paired" });
  });

  it("reads a code in any case, with spaces and hyphens ignored", async () => {
    const t = await start();
    const { code } = await pairingCode(t);

    const { answer } = await chromeOf(t).pair(` ${code.slice(0, 4).toLowerCase()} - ${code.slice(4)} `);

    expect(answer).toMatchObject({ type: "paired" });
  });

  it("refuses a code when none is live", async () => {
    const t = await start();

    const { answer } = await chromeOf(t).pair("K7Q2MXH4");

    expect(answer).toEqual({ type: "refused", reason: expect.stringMatching(/No pairing code is live/) as string });
  });
});

describe("the proof", () => {
  it("is asked of a paired Chrome's later socket by a challenge carrying the environment id; a correct proof is answered ready with the page policy", async () => {
    const t = await start();
    const { chrome, connection, message } = await paired(t);
    await connection.extension.close();
    await expect.poll(async () => (await chromes(t))[0]?.connected, { timeout: WAIT_MS }).toBe(false);
    const notices = await followNotices(t);
    t.clock.advance(60_000);

    const extension = await dial(t);
    const challenge = await extension.hello({ chromeId: message.chromeId, environmentId: t.env.id });
    expect(challenge).toEqual({ type: "challenge", environmentId: t.env.id, nonce: expect.stringMatching(/^[0-9a-f]{64}$/) as string });
    if (challenge.type !== "challenge") return;
    const ready = await extension.prove(message.secret, challenge.nonce);

    expect(ready).toEqual({ type: "ready", policy: message.policy });
    expect(await notices.next()).toEqual({ chromeId: message.chromeId, name: "Work", change: "connected" });
    expect(await chromes(t)).toEqual([
      expect.objectContaining({ id: message.chromeId, connected: true, lastConnectedAt: t.clock.now().toISOString(), pairedAt: new Date(t.clock.now().getTime() - 60_000).toISOString() }),
    ]);
    expect(chrome.credential()).toMatchObject({ chromeId: message.chromeId });
  });

  it("refuses a wrong proof, and a proof from a Chrome this environment does not hold, and closes the socket", async () => {
    const t = await start();
    const { message } = await paired(t);

    for (const [chromeId, secret] of [
      [message.chromeId, "ab".repeat(32)],
      [randomUUID(), message.secret],
    ] as const) {
      const extension = await dial(t);
      const challenge = await extension.hello({ chromeId, environmentId: t.env.id });
      if (challenge.type !== "challenge") throw new Error(`No challenge: ${JSON.stringify(challenge)}`);
      expect(await extension.prove(secret, challenge.nonce)).toEqual({ type: "refused", reason: expect.any(String) as string });
      expect((await extension.closed).code).toBe(1008);
    }
  });

  it("refuses the proof of a Chrome paired with another environment, saying so", async () => {
    const t = await start({ name: "Laptop" });
    const { message } = await paired(t);
    const extension = await dial(t);

    const challenge = await extension.hello({ chromeId: message.chromeId, environmentId: randomUUID() });
    expect(challenge).toMatchObject({ type: "challenge", environmentId: t.env.id });
    if (challenge.type !== "challenge") return;

    expect(await extension.prove(message.secret, challenge.nonce)).toEqual({ type: "refused", reason: expect.stringMatching(/another environment/) as string });
  });

  it("leaves the recorded name as it is when a later hello names another", async () => {
    const t = await start();
    const { chrome, connection } = await paired(t, "Work");
    await connection.extension.close();

    expect((await chrome.connect({ name: "Something else" })).answer).toMatchObject({ type: "ready" });

    expect((await chromes(t)).map((listed) => listed.name)).toEqual(["Work"]);
  });
});

describe("a version report", () => {
  it("is recorded as chrome.version-reported when a connection reports another version than the last, and the Chrome is outdated and still served", async () => {
    const t = await start();
    const { chrome, connection, message } = await paired(t);
    await connection.extension.close();
    const notices = await followNotices(t);

    const { answer } = await chrome.connect({ extensionVersion: "0.9.0-older" });

    expect(answer).toMatchObject({ type: "ready" });
    expect(await notices.next()).toEqual({ chromeId: message.chromeId, name: "Work", change: "version" });
    expect(await notices.next()).toEqual({ chromeId: message.chromeId, name: "Work", change: "connected" });
    expect(await chromes(t)).toEqual([expect.objectContaining({ lastReportedVersion: "0.9.0-older", connected: true, outdated: true })]);
    expect(t.env.log.readStream({ kind: "chrome", id: message.chromeId }).map((event) => [event.type, event.payload])).toEqual([
      ["chrome.paired", { name: "Work", extensionVersion: TEST_EXTENSION_VERSION }],
      ["chrome.version-reported", { extensionVersion: "0.9.0-older" }],
    ]);
  });

  it("is not recorded when a connection reports the version last recorded", async () => {
    const t = await start();
    const { chrome, connection, message } = await paired(t);
    await connection.extension.close();

    const again = await chrome.connect();
    await again.extension.close();
    await chrome.connect();

    expect(t.env.log.readStream({ kind: "chrome", id: message.chromeId }).map((event) => event.type)).toEqual(["chrome.paired"]);
    expect(await chromes(t)).toEqual([expect.objectContaining({ lastReportedVersion: TEST_EXTENSION_VERSION, outdated: false })]);
  });
});

describe("a disconnection", () => {
  it("raises chrome.updated, and the Chrome is listed not connected", async () => {
    const t = await start();
    const { connection, message } = await paired(t);
    const notices = await followNotices(t);

    await connection.extension.close();

    expect(await notices.next()).toEqual({ chromeId: message.chromeId, name: "Work", change: "disconnected" });
    expect(await chromes(t)).toEqual([expect.objectContaining({ id: message.chromeId, connected: false })]);
  });

  it("that cannot be recorded is logged, and the environment carries on", async () => {
    const t = await start();
    const { connection, message } = await paired(t);
    const said = quietErrors();
    const mend = failReadsOf(t, /FROM chromes\b/);

    await connection.extension.close();

    await vi.waitFor(() => expect(said).toHaveBeenCalledWith(`Recording that the Chrome ${message.chromeId} disconnected failed:`, expect.any(Error)), { timeout: WAIT_MS });
    mend();
    expect(await chromes(t)).toEqual([expect.objectContaining({ id: message.chromeId, connected: false })]);
  });

  it("is not raised for a socket a newer one of the same Chrome replaced", async () => {
    const t = await start();
    const { chrome, connection, message } = await paired(t);
    const head = t.env.log.head();
    const notices = await followNotices(t);

    const newer = await chrome.connect();
    expect(newer.answer).toMatchObject({ type: "ready" });
    expect((await connection.extension.closed).code).toBe(1000);
    expect(await chromes(t)).toEqual([expect.objectContaining({ connected: true })]);
    await newer.extension.close();
    await notices.next();
    await notices.next();

    const changes = t.env.log.readStream({ kinds: ["environment"], types: ["chrome.updated"] }, head).map((event) => event.payload);
    expect(changes).toEqual([
      { chromeId: message.chromeId, name: "Work", change: "connected" },
      { chromeId: message.chromeId, name: "Work", change: "disconnected" },
    ]);
  });
});

describe("browser.chromes.rename", () => {
  it("renames under the same name rules: chrome.renamed, and chrome.updated naming the new name", async () => {
    const t = await start();
    const { message } = await paired(t);
    const notices = await followNotices(t);
    const admin = await clientOf(t);

    const renamed = await admin.apply("browser.chromes.rename", { commandId: randomUUID(), chromeId: message.chromeId, name: " \u200bPersonal\u0007 " });

    expect(renamed.chrome).toMatchObject({ id: message.chromeId, name: "Personal", connected: true });
    expect(await notices.next()).toEqual({ chromeId: message.chromeId, name: "Personal", change: "renamed" });
    expect((await chromes(t)).map((chrome) => chrome.name)).toEqual(["Personal"]);
    expect((await admin.apply("browser.chromes.rename", { commandId: randomUUID(), chromeId: message.chromeId, name: "" })).chrome.name).toBe("A browser");
  });

  it("appends nothing for a name that cleans to the one the Chrome has, and refuses a Chrome this environment does not hold", async () => {
    const t = await start();
    const { message } = await paired(t);
    const admin = await clientOf(t);

    const same = await admin.request("browser.chromes.rename", { commandId: randomUUID(), chromeId: message.chromeId, name: "  Work " });
    const unknown = randomUUID();
    const missing = await admin.request("browser.chromes.rename", { commandId: randomUUID(), chromeId: unknown, name: "Work" });

    expect(same).toMatchObject({ receipt: { status: "accepted", changed: false }, result: { chrome: { name: "Work" } } });
    expect(missing).toMatchObject({ receipt: { status: "rejected", reason: "not_found", error: { data: { kind: "chrome", chromeId: unknown } } } });
    expect(t.env.log.readStream({ kind: "chrome", id: message.chromeId }).map((event) => event.type)).toEqual(["chrome.paired"]);
  });

  it("is kept when a later hello names the Chrome otherwise", async () => {
    const t = await start();
    const { chrome, connection, message } = await paired(t);
    await (await clientOf(t)).apply("browser.chromes.rename", { commandId: randomUUID(), chromeId: message.chromeId, name: "Personal" });
    await connection.extension.close();

    await chrome.connect({ name: "Work" });

    expect((await chromes(t)).map((listed) => listed.name)).toEqual(["Personal"]);
  });
});

describe("browser.chromes.unpair", () => {
  it("forgets the secret through the vault's delete and closes the socket with a refusal; the extension, dialling again, announces as unpaired", async () => {
    const t = await start({ name: "Laptop" });
    const { chrome, connection, message } = await paired(t);
    const notices = await followNotices(t);

    const unpaired = await (await clientOf(t)).apply("browser.chromes.unpair", { commandId: randomUUID(), chromeId: message.chromeId });

    expect(unpaired.chrome).toMatchObject({ id: message.chromeId, name: "Work" });
    expect(await notices.next()).toEqual({ chromeId: message.chromeId, name: "Work", change: "unpaired" });
    expect(await connection.extension.next((m) => m.type === "refused")).toEqual({ type: "refused", reason: expect.stringMatching(/unpaired from Laptop/) as string });
    expect((await connection.extension.closed).code).toBe(1008);
    const vault = JSON.parse(readFileSync(join(t.dataDir, VAULT_FILE), "utf8")) as Record<string, string>;
    expect(Object.values(vault)).not.toContain(message.secret);
    expect(await chromes(t)).toEqual([]);
    expect(chrome.credential()).toBeNull();
    expect((await chrome.connect()).answer).toEqual({ type: "announced", environmentId: t.env.id, environmentName: "Laptop" });
    expect((await (await clientOf(t)).apply("browser.status", {})).unpairedConnected).toBe(true);
  });

  it("refuses a later proof of the unpaired Chrome, and a Chrome this environment does not hold", async () => {
    const t = await start();
    const { connection, message } = await paired(t);
    const admin = await clientOf(t);
    await admin.apply("browser.chromes.unpair", { commandId: randomUUID(), chromeId: message.chromeId });
    await connection.extension.closed;

    const extension = await dial(t);
    const challenge = await extension.hello({ chromeId: message.chromeId, environmentId: t.env.id });
    if (challenge.type !== "challenge") throw new Error(`No challenge: ${JSON.stringify(challenge)}`);
    expect(await extension.prove(message.secret, challenge.nonce)).toEqual({ type: "refused", reason: expect.stringMatching(/no pairing/) as string });
    expect(await admin.request("browser.chromes.unpair", { commandId: randomUUID(), chromeId: message.chromeId })).toMatchObject({
      receipt: { status: "rejected", reason: "not_found" },
    });
  });
});

describe("the page policy", () => {
  const browserDomains = (message: BridgeFromEnvironment) => ("policy" in message ? message.policy.browserDomains.map((entry) => entry.pattern) : undefined);

  it("is sent on ready with the dev sites, the two switches and the enabled entries of the denylist's browser section, and again when any of them changes", async () => {
    const t = await start();
    const admin = await clientOf(t);
    await admin.apply("permissions.denylist.set", { commandId: randomUUID(), sections: { browserDomains: [{ pattern: "*.bank.example" }, { pattern: "*.off.example", enabled: false }] } });
    const { chrome, connection } = await paired(t);
    await connection.extension.close();

    const { extension, answer } = await chrome.connect();
    expect(answer).toMatchObject({ type: "ready", policy: { devSites: [], evaluateEverywhere: false, deepReadEverywhere: false } });
    expect(browserDomains(answer)).toEqual(["*.bank.example"]);

    await admin.apply("settings.update", { commandId: randomUUID(), values: { "browser.devSites": ["*.myapp.test"] } });
    expect(await extension.next((m) => m.type === "policy")).toMatchObject({ type: "policy", policy: { devSites: ["*.myapp.test"] } });
    await admin.apply("settings.update", { commandId: randomUUID(), values: { "browser.evaluateEverywhere": true } });
    expect(await extension.next((m) => m.type === "policy")).toMatchObject({ type: "policy", policy: { evaluateEverywhere: true, deepReadEverywhere: false } });
    await admin.apply("settings.update", { commandId: randomUUID(), values: { "browser.deepReadEverywhere": true } });
    expect(await extension.next((m) => m.type === "policy")).toMatchObject({ type: "policy", policy: { evaluateEverywhere: true, deepReadEverywhere: true } });
    await admin.apply("permissions.denylist.set", {
      commandId: randomUUID(),
      sections: { browserDomains: [{ pattern: "*.bank.example", enabled: false }, { pattern: "*.pay.example" }, { pattern: "*.off.example", enabled: false }] },
    });
    expect(browserDomains(await extension.next((m) => m.type === "policy"))).toEqual(["*.pay.example"]);
  });

  it("is the one last read, so a Chrome pairs and connects while the settings and the denylist cannot be read", async () => {
    const t = await start();
    const { code } = await pairingCode(t);
    failReadsOf(t, /FROM (settings|denylist_sections)\b/);
    const chrome = chromeOf(t);

    const pairing = await chrome.pair(code, "Work");
    expect(pairing.answer).toMatchObject({ type: "paired", policy: { devSites: [], evaluateEverywhere: false, deepReadEverywhere: false } });
    const { policy } = pairing.answer as Extract<BridgeFromEnvironment, { type: "paired" }>;
    await pairing.extension.close();
    expect((await chrome.connect()).answer).toEqual({ type: "ready", policy });
  });

  it("reaches the socket a Chrome paired on, and is not sent for a change that leaves it as it was", async () => {
    const t = await start();
    const admin = await clientOf(t);
    const { connection } = await paired(t);

    await admin.apply("settings.update", { commandId: randomUUID(), values: { "browser.internalHosts": ["localhost"] } });
    await admin.apply("permissions.denylist.set", { commandId: randomUUID(), sections: { hosts: [{ pattern: "*.bank.example" }] } });
    await admin.apply("settings.update", { commandId: randomUUID(), values: { "browser.devSites": ["localhost"] } });

    expect(await connection.extension.next((m) => m.type === "policy")).toMatchObject({ type: "policy", policy: { devSites: ["localhost"] } });
    expect(connection.extension.received.filter((m) => m.type === "policy")).toHaveLength(1);
  });
});

describe("a restart", () => {
  it("keeps the paired Chromes, not connected, and each proves its secret again", async () => {
    const dataDir = join(tempDir("agent-harness-pairing-"), "data");
    const first = await start({ dataDir });
    const { chrome, message } = await paired(first);
    const pairedAt = first.clock.now().toISOString();
    await first.close();

    const second = await start({ dataDir });
    expect(await chromes(second)).toEqual([expect.objectContaining({ id: message.chromeId, name: "Work", pairedAt, connected: false })]);
    expect((await chrome.connect()).answer).toMatchObject({ type: "ready" });
    expect(await chromes(second)).toEqual([expect.objectContaining({ id: message.chromeId, connected: true })]);
  });

  it("deletes the vault entry of a Chrome that is not paired, which an unpairing whose delete failed left behind", async () => {
    const dataDir = join(tempDir("agent-harness-pairing-"), "data");
    const first = await start({ dataDir });
    const { message } = await paired(first);
    await first.close();
    const left = `chrome:${randomUUID()}`;
    const vaultPath = join(dataDir, VAULT_FILE);
    writeFileSync(vaultPath, JSON.stringify({ ...(JSON.parse(readFileSync(vaultPath, "utf8")) as Record<string, string>), [left]: "token-for-tests" }));

    await start({ dataDir });

    const vault = JSON.parse(readFileSync(vaultPath, "utf8")) as Record<string, string>;
    expect(Object.keys(vault)).not.toContain(left);
    expect(vault[`chrome:${message.chromeId}`]).toBe(message.secret);
  });
});
