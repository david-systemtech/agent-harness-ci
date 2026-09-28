import { randomUUID } from "node:crypto";
import { Console } from "node:console";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { registry, type EventEnvelope, type EventFrame, type ParamsOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, say, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import { SIGNING_KEY } from "../serve/identity.js";
import { fileVault, VAULT_FILE } from "../serve/vault.js";
import { createScrubRegistry } from "./registry.js";

/**
 * The scrub registry through the primary seam (key-managers spec, "Testing
 * Decisions"): an in-process environment with the scripted fake adapter, a
 * real client over a real WebSocket, the file vault in the test's temporary
 * data directory, and the environment's standard error captured.
 */

const { onCleanup, tempDir } = useCleanups();

const HELD = "a-value-a-forge-holds";

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/**
 * The process's standard error as it is outside the test runner, whose own
 * console writes elsewhere: a Node console on it for the test's length, and
 * every write kept rather than printed. Taken before the environment starts,
 * so the environment's close comes first.
 */
const captureStandardError = (): (() => string) => {
  const written: string[] = [];
  const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  const runnerConsole = globalThis.console;
  globalThis.console = new Console({ stdout: process.stdout, stderr: process.stderr });
  onCleanup(() => {
    globalThis.console = runnerConsole;
    write.mockRestore();
  });
  return () => written.join("");
};

/** A run that says `secret` in its text and passes it to a tool, whose output carries it back. */
const leakingScript =
  (secret: string): Script =>
  () => [
    say(`The token is ${secret}.`),
    {
      type: "tool.started",
      payload: { toolCallId: "toolu_leak", name: "Bash", input: { command: `curl -H "Authorization: Bearer ${secret}" https://git.example.com` }, title: null, agentId: null, parentToolCallId: null },
    },
    { type: "tool.ended", payload: { toolCallId: "toolu_leak", status: "ok", output: `{"token":"${secret}","scopes":["repo"]}`, durationMs: 1 } },
    end(),
  ];

/** Starts a run on a fresh session and resolves with every event of that session up to its run's end, as a subscribed client reads them. */
const runAndRead = async (client: WireClient, sessionId: string, afterSequence: number): Promise<EventEnvelope[]> => {
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence });
  const params: ParamsOf<"runs.start"> = { commandId: randomUUID(), sessionId, text: "Check the forge" };
  const started = registry["runs.start"].response.parse(await client.request("runs.start", params));
  const runId = started.result?.runId;
  const events: EventEnvelope[] = [];
  for (;;) {
    const { event } = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
    events.push(event);
    if (event.type === "run.ended" && event.payload["runId"] === runId) return events;
  }
};

/** The events a client read back, with the texts the test looks for picked out. */
const readBack = (events: readonly EventEnvelope[]) => {
  const tool = events.find((event) => event.type === "tool.started");
  return {
    said: events.filter((event) => event.type === "assistant.text").map((event) => event.payload["text"]),
    command: (tool?.payload["input"] as { command?: unknown } | undefined)?.command,
    output: events.find((event) => event.type === "tool.ended")?.payload["output"],
    json: JSON.stringify(events),
  };
};

describe("the event log's append", () => {
  it("replaces a registered value in the assistant's text and a tool's input and output, read back through sessions.subscribeSession", async () => {
    const t = await start({ adapter: fakeAdapter({ script: leakingScript(HELD) }) });
    t.scrub.register(HELD, { owner: "test:forge" });
    const client = await t.client();
    const { id } = await create(client);

    const read = readBack(await runAndRead(client, id, t.env.log.head()));
    expect(read.said).toEqual(["The token is [redacted]."]);
    expect(read.command).toBe('curl -H "Authorization: Bearer [redacted]" https://git.example.com');
    expect(read.output).toBe('{"token":"[redacted]","scopes":["repo"]}');
    expect(read.json).not.toContain(HELD);
  });

  it("leaves an event appended before its value was registered as it was: the log is never rewritten", async () => {
    const t = await start({ adapter: fakeAdapter({ script: leakingScript(HELD) }) });
    const client = await t.client();
    const { id } = await create(client);
    const from = t.env.log.head();
    expect(readBack(await runAndRead(client, id, from)).said).toEqual([`The token is ${HELD}.`]);

    const release = t.scrub.register(HELD, { owner: "test:forge" });
    const later = readBack(await runAndRead(client, id, t.env.log.head()));
    expect(later.said).toEqual(["The token is [redacted]."]);

    // A client subscribing afresh reads the first run as it was appended, and the second as it was.
    release();
    const again = await client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: from });
    const texts: unknown[] = [];
    while (texts.length < 2) {
      const { event } = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === again.subscription);
      if (event.type === "assistant.text") texts.push(event.payload["text"]);
    }
    expect(texts).toEqual([`The token is ${HELD}.`, "The token is [redacted]."]);
  });
});

describe("the vault's entries", () => {
  it("are registered from start, before the wire opens: those the vault held and the signing key a first start makes", async () => {
    const dataDir = join(tempDir(), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    await fileVault(join(dataDir, VAULT_FILE)).set("forge-git.example.com", HELD);
    const scrub = createScrubRegistry();
    const atListen: string[] = [];
    await start({
      dataDir,
      scrub,
      hooks: {
        beforeStep: async (step) => {
          if (step !== "listen") return;
          const key = (await fileVault(join(dataDir, VAULT_FILE)).get(SIGNING_KEY)) ?? "no signing key yet";
          atListen.push(scrub.scrub(HELD), scrub.scrub(key));
        },
      },
    });
    expect(atListen).toEqual(["[redacted]", "[redacted]"]);
  });

  it("keep the client-session signing key out of every event: a run that says it reads back redacted", async () => {
    const t = await start();
    const key = await fileVault(join(t.dataDir, VAULT_FILE)).get(SIGNING_KEY);
    expect(key).toBeDefined();
    t.adapter.nextScripts.push(leakingScript(key as string));
    const client = await t.client();
    const { id } = await create(client);

    const read = readBack(await runAndRead(client, id, t.env.log.head()));
    expect(read.said).toEqual(["The token is [redacted]."]);
    expect(read.output).toBe('{"token":"[redacted]","scopes":["repo"]}');
    expect(read.json).not.toContain(key);
  });
});

describe("the diagnostic output", () => {
  it("passes every line the environment writes to its standard error through the registry: neither the signing key nor a registered value appears in one", async () => {
    const stderr = captureStandardError();
    const t = await start();
    const key = (await fileVault(join(t.dataDir, VAULT_FILE)).get(SIGNING_KEY)) as string;
    t.scrub.register(HELD, { owner: "test:forge" });
    // A subscriber that throws is a line the event log writes, the error and its stack with it.
    t.env.log.subscribe(() => {
      throw new Error(`a subscriber read ${key} and ${encodeURIComponent(HELD)}`);
    });
    await create(await t.client());

    await vi.waitFor(() => expect(stderr()).toContain("An event log subscriber threw"));
    expect(stderr()).toContain("a subscriber read [redacted] and [redacted]");
    expect(stderr()).not.toContain(key);
    expect(stderr()).not.toContain(HELD);
  });

  it("lets the process's standard error go when the environment closes", async () => {
    const stderr = captureStandardError();
    const t = await start();
    t.scrub.register(HELD, { owner: "test:forge" });
    await t.close();
    console.error(`after the close: ${HELD}`);
    expect(stderr()).toContain(`after the close: ${HELD}`);
  });
});
