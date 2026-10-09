import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry, type ParamsOf, type ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, gate, say, type FakeAdapter, type FakeAdapterOptions, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, deleteSession, purgeSession, refusal } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import type { EventEnvelope } from "../event-log/event-log.js";
import { ATTACHMENTS_DIRECTORY } from "./attachment-stage.js";

/**
 * Attachment bytes staged on disk (#185; claude-adapter spec, #185's notes)
 * through the primary seam: an in-process environment on a data directory
 * with the scripted fake adapter, driven by a real client, stopped and
 * started again on the same directory. What is asserted is what the next run
 * receives and what lies in the data directory's `attachments/`.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (adapter: FakeAdapterOptions | FakeAdapter = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: "descriptor" in adapter ? adapter : fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

const command = async <N extends "runs.start" | "runs.send">(
  client: WireClient,
  method: N,
  params: Omit<ParamsOf<N>, "commandId">,
  commandId = randomUUID(),
): Promise<ResponseOf<N>> => registry[method].response.parse(await client.request(method, { commandId, ...params } as ParamsOf<N>)) as ResponseOf<N>;

const startRun = async (client: WireClient, sessionId: string, text = "Fix the receipts", attachments?: ParamsOf<"runs.start">["attachments"]) => {
  const answer = await command(client, "runs.start", { sessionId, text, ...(attachments !== undefined && { attachments }) });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result;
};

/** Sends a message with one image during the session's live run; resolves with its id. */
const sendImage = async (client: WireClient, sessionId: string, text = "Look at this", pixels = "pixels") => {
  const answer = await command(client, "runs.send", { sessionId, text, attachments: [image(pixels)] });
  if (answer.result === undefined) throw new Error(`runs.send was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result;
};

const image = (pixels = "pixels") => ({ kind: "image" as const, name: "screen.png", mediaType: "image/png", data: Buffer.from(pixels).toString("base64") });

const eventsOf = (t: TestEnvironment, sessionId: string): EventEnvelope[] => t.env.log.readStream({ kind: "session", id: sessionId });

/** Once the session's log holds run `runId`'s end: heard as it commits, or read when it is there already, never on a time budget. */
const untilEnded = (t: TestEnvironment, sessionId: string, runId: string): Promise<void> =>
  new Promise((resolve) => {
    const isEnd = (event: EventEnvelope): boolean => event.type === "run.ended" && event.payload["runId"] === runId;
    const settle = (): void => {
      stop();
      resolve();
    };
    const stop = t.env.log.subscribe((event) => {
      if (isEnd(event)) settle();
    });
    if (eventsOf(t, sessionId).some(isEnd)) settle();
  });

const stagedDir = (dataDir: string, messageId?: string): string => (messageId === undefined ? join(dataDir, ATTACHMENTS_DIRECTORY) : join(dataDir, ATTACHMENTS_DIRECTORY, messageId));

/** The bytes the last run received for its message `messageId`, as text. */
const received = (t: TestEnvironment, messageId: string): string[] =>
  (t.adapter.lastRun().input.prompt.find((message) => message.messageId === messageId)?.attachments ?? []).map((attachment) => Buffer.from(attachment.data).toString());

/** A run that works until `held` opens, then ends. */
const heldScript =
  (held: Promise<void>): Script =>
  async function* () {
    yield say("Working");
    await held;
    yield end();
  };

describe("a queued message's attachment bytes", () => {
  it("are on disk under the data directory, 0600 under 0700, by the time runs.send answers, and gone once a run has read them", async () => {
    const held = gate();
    const t = await start({ capabilities: { providerQueue: false, steering: false }, script: heldScript(held.opened) });
    const client = await t.client();
    const { id } = await create(client);
    const first = await startRun(client, id);
    const { messageId } = await sendImage(client, id);

    // Straight after the answer, before anything else can happen: the receipt means the bytes are safe.
    expect(readFileSync(join(stagedDir(t.dataDir, messageId), "0"), "utf8")).toBe("pixels");
    if (process.platform !== "win32") {
      expect(statSync(stagedDir(t.dataDir)).mode & 0o777).toBe(0o700);
      expect(statSync(stagedDir(t.dataDir, messageId)).mode & 0o777).toBe(0o700);
      expect(statSync(join(stagedDir(t.dataDir, messageId), "0")).mode & 0o777).toBe(0o600);
    }
    // Never in the log.
    expect(JSON.stringify(eventsOf(t, id))).not.toContain(Buffer.from("pixels").toString("base64"));

    held.open();
    await untilEnded(t, id, first.runId);
    // The environment's queue starts the next run with it once the first completed.
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(2));
    expect(received(t, messageId)).toEqual(["pixels"]);
    await vi.waitFor(() => expect(existsSync(stagedDir(t.dataDir, messageId))).toBe(false));
  });

  it("survive a stop and start on one data directory: the next run receives them, and they are removed once it has", async () => {
    const dataDir = join(tempDir(), "data");
    const held = gate();
    const adapter = { capabilities: { providerQueue: false, steering: false } } as const;
    const t = await start({ ...adapter, script: heldScript(held.opened) }, { dataDir });
    const client = await t.client();
    const { id } = await create(client);
    await startRun(client, id);
    // Once its adapter has the run and has read its first message: a stop that finds the run still composing its
    // instructions queues that message again, ahead of this one.
    await t.adapter.reached(1);
    const { messageId } = await sendImage(client, id);
    await client.close();
    await t.close();
    held.open();

    const again = await start(adapter, { dataDir });
    const later = await again.client();
    const next = await startRun(later, id, "Carry on");
    await untilEnded(again, id, next.runId);
    expect(again.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Look at this", "Carry on"]);
    expect(received(again, messageId)).toEqual(["pixels"]);
    expect(existsSync(stagedDir(dataDir, messageId))).toBe(false);
  });

  it("are staged for a run's first message too when the environment stops while the run composes its instructions: the next run reads it first, with its bytes", async () => {
    const dataDir = join(tempDir(), "data");
    const composing = gate();
    const adapter = { capabilities: { providerQueue: false, steering: false } } as const;
    let holdComposition = false;
    // Its instructions wait until the environment has stopped, so its adapter never has the run.
    const orientation = async () => {
      if (holdComposition) await composing.opened;
      return { text: "You are on SAMPLE-SERVER.", unreadRegistries: [] };
    };
    const t = await start(adapter, { dataDir, orientation });
    holdComposition = true;
    const client = await t.client();
    const { id } = await create(client);
    const first = await startRun(client, id, "Fix the receipts", [image("receipts")]);
    const { messageId } = await sendImage(client, id);
    await client.close();
    await t.close();
    expect(t.adapter.runs).toHaveLength(0);
    composing.open();
    // Nothing is lost (ADR 0022): what the run was launched with is the environment's queue again, its bytes on disk.
    expect(readFileSync(join(stagedDir(dataDir, first.messageId), "0"), "utf8")).toBe("receipts");

    const again = await start(adapter, { dataDir });
    const later = await again.client();
    const next = await startRun(later, id, "Carry on");
    await untilEnded(again, id, next.runId);
    expect(again.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Fix the receipts", "Look at this", "Carry on"]);
    expect(received(again, first.messageId)).toEqual(["receipts"]);
    expect(received(again, messageId)).toEqual(["pixels"]);
    expect(existsSync(stagedDir(dataDir, first.messageId))).toBe(false);
    expect(existsSync(stagedDir(dataDir, messageId))).toBe(false);
  });

  it("survive a restart that cut the run whose provider held them: the recovery sweep queues the message again with its bytes", async () => {
    const dataDir = join(tempDir(), "data");
    const held = gate();
    const adapter = { capabilities: { providerQueue: true, steering: false } } as const;
    const t = await start({ ...adapter, script: heldScript(held.opened) }, { dataDir });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await t.adapter.reached(1);
    const sent = await sendImage(client, id);
    expect(sent).toMatchObject({ delivery: "queued", heldBy: "provider" });

    // The environment dies with the run mid-flight: its end never reaches the log.
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await client.close();
    t.env.log.close();
    await t.close();
    loud.mockRestore();
    held.open();

    const again = await start(adapter, { dataDir });
    expect(eventsOf(again, id).slice(-2)).toMatchObject([
      { type: "message.requeued", payload: { runId, messageId: sent.messageId } },
      { type: "run.ended", payload: { runId, reason: "interrupted", cause: "restart" } },
    ]);
    const later = await again.client();
    const next = await startRun(later, id, "Carry on");
    await untilEnded(again, id, next.runId);
    expect(received(again, sent.messageId)).toEqual(["pixels"]);
    expect(existsSync(stagedDir(dataDir, sent.messageId))).toBe(false);
  });

  it("are removed once a run steers the message in", async () => {
    const held = gate();
    const t = await start({ capabilities: { providerQueue: true, steering: true }, script: heldScript(held.opened) });
    const client = await t.client();
    const { id } = await create(client);
    await startRun(client, id);
    await t.adapter.reached(1);
    const { messageId } = await sendImage(client, id);
    await vi.waitFor(() => expect(eventsOf(t, id).some((event) => event.type === "message.delivered" && event.payload["delivery"] === "steered")).toBe(true));
    await vi.waitFor(() => expect(existsSync(stagedDir(t.dataDir, messageId))).toBe(false));
    held.open();
  });

  it("stay through the session's deletion and a restart, for a restore, and are removed when it is purged", async () => {
    const dataDir = join(tempDir(), "data");
    const held = gate();
    const adapter = { capabilities: { providerQueue: false, steering: false } } as const;
    const t = await start({ ...adapter, script: heldScript(held.opened) }, { dataDir });
    const client = await t.client();
    const { id } = await create(client);
    await startRun(client, id);
    const { messageId } = await sendImage(client, id);
    await deleteSession(client, id);
    held.open();
    expect(existsSync(stagedDir(dataDir, messageId))).toBe(true);
    await client.close();
    await t.close();

    const again = await start(adapter, { dataDir });
    expect(existsSync(stagedDir(dataDir, messageId))).toBe(true);
    const later = await again.client();
    await purgeSession(later, id);
    await vi.waitFor(() => expect(existsSync(stagedDir(dataDir, messageId))).toBe(false));
  });

  it("that cannot be staged refuse the send internal, appending nothing and keeping no receipt, so the same command succeeds once they can", async () => {
    const held = gate();
    const t = await start({ capabilities: { providerQueue: false, steering: false }, script: heldScript(held.opened) });
    const client = await t.client();
    const { id } = await create(client);
    await startRun(client, id);
    // Past its skill set and instructions, and working: nothing more is appended while it is held.
    await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id }).some((event) => event.type === "assistant.text")).toBe(true), { timeout: WAIT_MS });
    // A file where the stage's directory should be: nothing can be written under it.
    writeFileSync(stagedDir(t.dataDir), "in the way");
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const head = t.env.log.head();
    const commandId = randomUUID();
    const refused = await refusal(command(client, "runs.send", { sessionId: id, text: "Look at this", attachments: [image()] }, commandId));
    loud.mockRestore();
    expect(refused.code).toBe("internal");
    expect(t.env.log.head()).toBe(head);

    rmSync(stagedDir(t.dataDir));
    const retried = await command(client, "runs.send", { sessionId: id, text: "Look at this", attachments: [image()] }, commandId);
    expect(retried.result).toMatchObject({ delivery: "queued" });
    expect(readFileSync(join(stagedDir(t.dataDir, retried.result?.messageId as string), "0"), "utf8")).toBe("pixels");
    held.open();
  });

  it("are left alone at startup only for a message still queued: what no message owns and a write a crash cut short are removed", async () => {
    const dataDir = join(tempDir(), "data");
    const orphan = randomUUID();
    mkdirSync(join(stagedDir(dataDir), orphan), { recursive: true });
    writeFileSync(join(stagedDir(dataDir), orphan, "0"), "nobody's");
    mkdirSync(join(stagedDir(dataDir), ".partial-left-by-a-crash"));
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await start({}, { dataDir });
    loud.mockRestore();
    expect(readdirSync(stagedDir(dataDir))).toEqual([]);
  });
});
