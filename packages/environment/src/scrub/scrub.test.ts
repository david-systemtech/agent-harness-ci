import { randomUUID } from "node:crypto";
import { Console } from "node:console";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { registry, type EventEnvelope, type EventFrame, type ParamsOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, say, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { fakePty, type FakeProcess } from "../../test/fake-pty.js";
import { create } from "../../test/sessions.js";
import { follow, openTerminal, sessionIn, type TerminalView } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";
import { HOLD_BACK_MS } from "../terminals/terminals.js";
import { SIGNING_KEY } from "../serve/identity.js";
import { fileVault, VAULT_FILE } from "../serve/vault.js";
import { createScrubRegistry } from "./registry.js";

/**
 * The scrub registry through the primary seam (key-managers spec, "Testing
 * Decisions"): an in-process environment with the scripted fake adapter, a
 * real client over a real WebSocket, the file vault in the test's temporary
 * data directory, the environment's standard error captured, and a fake
 * pseudo-terminal printing a registered value in pieces on the manual clock.
 */

const { onCleanup, tempDir } = useCleanups();

const HELD = "a-value-a-forge-holds";

/** A GitHub-shaped token the environment never registered, put together at run time so no line here looks like a key to a secret scanner. */
const GITHUB_SHAPED = ["gh", "p_", "Fake0Test9".repeat(4).slice(0, 36)].join("");

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

  it("keeps a shape-matching string in the prompt, the model's text and a tool's output as written, while a registered value beside it is redacted", async () => {
    const t = await start({
      adapter: fakeAdapter({
        script: () => [
          say(`Found ${GITHUB_SHAPED} beside ${HELD}.`),
          { type: "tool.started", payload: { toolCallId: "toolu_shape", name: "Bash", input: { command: "cat .env" }, title: null, agentId: null, parentToolCallId: null } },
          { type: "tool.ended", payload: { toolCallId: "toolu_shape", status: "ok", output: `GITHUB_TOKEN=${GITHUB_SHAPED}\nFORGE=${HELD}`, durationMs: 1 } },
          end(),
        ],
      }),
    });
    t.scrub.register(HELD, { owner: "test:forge" });
    const client = await t.client();
    const { id } = await create(client);

    const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: t.env.log.head() });
    const params: ParamsOf<"runs.start"> = { commandId: randomUUID(), sessionId: id, text: `Is ${GITHUB_SHAPED} the one, or ${HELD}?` };
    await client.request("runs.start", params);
    const events: EventEnvelope[] = [];
    while (!events.some((event) => event.type === "run.ended")) {
      events.push((await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription)).event);
    }

    const read = readBack(events);
    const prompt = events.find((event) => event.type === "message.sent")?.payload["text"];
    expect(prompt).toBe(`Is ${GITHUB_SHAPED} the one, or [redacted]?`);
    expect(read.said).toEqual([`Found ${GITHUB_SHAPED} beside [redacted].`]);
    expect(read.output).toBe(`GITHUB_TOKEN=${GITHUB_SHAPED}\nFORGE=[redacted]`);
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

  it("replaces registered values and then shape-rule hits in every line the environment logs", async () => {
    const stderr = captureStandardError();
    const t = await start();
    t.scrub.register(HELD, { owner: "test:forge" });
    t.env.log.subscribe(() => {
      throw new Error(`the forge refused ${GITHUB_SHAPED} and ${HELD}; Authorization: Bearer ${HELD}-longer`);
    });
    await create(await t.client());

    await vi.waitFor(() => expect(stderr()).toContain("An event log subscriber threw"));
    expect(stderr()).toContain("the forge refused [redacted] and [redacted]; Authorization: Bearer [redacted]");
    expect(stderr()).not.toContain(GITHUB_SHAPED);
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

describe("terminal output", () => {
  const SPLIT = "alpha-secret-value-1";

  /**
   * The client-session signing key these tests start with, 32 bytes as
   * base64. The vault's entries are registered for scrubbing, and the stream
   * holds back the longest tail of a chunk that could begin a registered
   * value: the random key a first start makes began with `c` one start in
   * 64, and held the `c` of `token alpha-sec` back into the next chunk
   * (#610). This one begins with `d`, and no chunk printed here ends in a
   * text it begins with.
   */
  const SIGNING_KEY_TEXT = Buffer.from("terminal-output-test-signing-key").toString("base64");

  /**
   * An environment on a fake pseudo-terminal whose output is a chunk the
   * moment it is printed, started on a data directory whose vault holds
   * `SIGNING_KEY_TEXT`, a terminal open on it, and a client following that
   * terminal.
   */
  const terminalOn = async () => {
    const dataDir = join(tempDir(), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    await fileVault(join(dataDir, VAULT_FILE)).set(SIGNING_KEY, SIGNING_KEY_TEXT);
    const pty = fakePty();
    const t = await start({ dataDir, terminals: { pty, gatherMs: 0 } });
    const client = await t.client();
    const sessionId = await sessionIn(client, tempDir("agent-harness-terminal-"));
    const terminal = await openTerminal(client, sessionId);
    const view = await follow(client, terminal.id, 0);
    await view.until((v) => v.synchronized, "the subscription's catch-up");
    return { t, client, id: terminal.id, child: pty.spawned[0] as FakeProcess, view };
  };

  /** The output chunks the view received, each as it came. */
  const chunks = (view: TerminalView): string[] =>
    view.frames.flatMap((frame) => (frame.type === "event" && frame.event.type === "terminal.output" ? [String(frame.event.payload["data"])] : []));

  /** The scrollback a client connecting afresh is sent. */
  const reconnected = async (t: TestEnvironment, id: string): Promise<string> => {
    const view = await follow(await t.client(), id, 0);
    await view.until((v) => v.synchronized, "a fresh subscription's catch-up");
    return view.snapshot?.scrollback ?? "";
  };

  it("replaces a registered value printed across two chunks, live and in the scrollback, so no piece of it reaches a subscriber", async () => {
    const { t, id, child, view } = await terminalOn();
    t.scrub.register(SPLIT, { owner: "test:terminal" });

    child.print("$ echo alpha-sec");
    child.print("ret-value-1 done\r\n");
    await view.until((v) => v.text.includes("done"), "the rest of the line");

    expect(chunks(view)).toEqual(["$ echo ", "[redacted] done\r\n"]);
    expect(await reconnected(t, id)).toBe("$ echo [redacted] done\r\n");
  });

  it("shows output whose tail begins no registered value at once, setting no timer", async () => {
    const { t, child, view } = await terminalOn();
    t.scrub.register(SPLIT, { owner: "test:terminal" });
    const timers = t.clock.pending();

    child.print("plain output\r\n$ ");
    await view.until((v) => v.text === "plain output\r\n$ ", "the output");
    expect(t.clock.pending()).toBe(timers);
  });

  it("holds a tail back at most fifty milliseconds on the environment's clock, then shows it as it is", async () => {
    const { t, id, child, view } = await terminalOn();
    t.scrub.register(SPLIT, { owner: "test:terminal" });

    child.print("x alpha-sec");
    await view.until((v) => v.text === "x ", "the head of the line");
    t.clock.advance(HOLD_BACK_MS - 1);
    expect(await reconnected(t, id)).toBe("x ");

    t.clock.advance(1);
    await view.until((v) => v.text === "x alpha-sec", "the held tail");
    expect(chunks(view)).toEqual(["x ", "alpha-sec"]);
    expect(HOLD_BACK_MS).toBe(50);
  });

  it("shows a held tail before the terminal's exit", async () => {
    const { t, child, view } = await terminalOn();
    t.scrub.register(SPLIT, { owner: "test:terminal" });

    child.print("x alpha-sec");
    child.exit(0);
    await view.until((v) => v.exited !== undefined, "the exit");
    expect(chunks(view)).toEqual(["x ", "alpha-sec"]);
  });

  it("sends a client reconnecting the scrollback, or the chunks after its cursor, scrubbed of a value registered after they were printed", async () => {
    const { t, id, child, view } = await terminalOn();
    child.print("$ ");
    child.print(`token ${SPLIT}\r\n`);
    await view.until((v) => v.text.includes(SPLIT), "the line");

    t.scrub.register(SPLIT, { owner: "test:later" });
    expect(await reconnected(t, id)).toBe("$ token [redacted]\r\n");
    const resumed = await follow(await t.client(), id, 1);
    await resumed.until((v) => v.synchronized, "the replay");
    expect(chunks(resumed)).toEqual(["token [redacted]\r\n"]);
  });

  it("sends a client resuming from its cursor the chunks after it scrubbed as one text, so a value printed across two of them before it was registered is not sent in pieces", async () => {
    const { t, id, child, view } = await terminalOn();
    child.print("$ ");
    child.print("token alpha-sec");
    child.print("ret-value-1\r\n$ ");
    await view.until((v) => v.text.includes(SPLIT), "the line");
    expect(chunks(view)).toEqual(["$ ", "token alpha-sec", "ret-value-1\r\n$ "]);

    t.scrub.register(SPLIT, { owner: "test:later" });
    const resumed = await follow(await t.client(), id, 1);
    await resumed.until((v) => v.synchronized, "the replay");
    expect(chunks(resumed)).toEqual(["token ", "[redacted]\r\n$ "]);
    expect(resumed.frames.flatMap((frame) => (frame.type === "event" ? [frame.sequence] : []))).toEqual([2, 3]);
  });
});
