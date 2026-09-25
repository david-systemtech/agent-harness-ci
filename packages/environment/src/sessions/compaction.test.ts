import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SessionSnapshot, registry, type EventFrame, type Frame, type ParamsOf, type SnapshotFrame } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START, manualClock } from "../../test/clock.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { create, deleteSession, rename } from "../../test/sessions.js";
import { DAY, MINUTE, updateSettings } from "../../test/shelf.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Transcript compaction through the primary seam (env spec, "The event
 * log": compaction; ADR 0002), under the helper's manual clock with the
 * scripted fake adapter: a session with no run, command or event for the
 * window (90 days, the preset of `sessions.transcriptCompactAfterDays`) has
 * its transcript folded into a snapshot by the sweep, which runs at startup
 * and daily. What a client sees of it is the per-session subscription: from
 * a cursor older than the fold, the snapshot in place of the folded events,
 * then the events after it. Time passes between environments on one data
 * directory, each started later on the clock, so no socket is pinged
 * through the months; the daily cadence is watched over two days.
 */

const { onCleanup, tempDir } = useCleanups();

/** The instant `ms` after the manual clock's start. */
const at = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** A session untouched for longer than the window. */
const WINDOW = 90 * DAY;

/** An environment on `dataDir` whose clock starts `ms` after the manual clock's start, on the fake adapter able to rewind. */
const start = async (dataDir: string, ms = 0): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ dataDir, clock: manualClock(at(ms)), adapter: fakeAdapter({ capabilities: { rewind: true } }) });
  onCleanup(() => t.close());
  return t;
};

/** Runs `text` on the session with the fake adapter's reply script and resolves with its message's id once the run has ended. */
const runOnce = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<string> => {
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence: t.env.log.head() });
  await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
  const answer = await client.request("runs.start", { commandId: randomUUID(), sessionId, text });
  const runId = answer.result?.runId;
  await client.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "run.ended" && f.event.payload["runId"] === runId);
  client.send({ type: "unsubscribe", subscription });
  return answer.result?.messageId as string;
};

/** Sends a command about one session and answers its receipt. */
const sessionCommand = async (client: WireClient, method: "sessions.rewind" | "sessions.undoRewind", params: { sessionId: string; messageId?: string }) =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<typeof method>)).receipt;

/** What a client's catch-up of one session was: the snapshot first, if one was sent, then the events, up to `synchronized`. */
interface CatchUp {
  readonly snapshot: (SnapshotFrame & { readonly payload: SessionSnapshot }) | undefined;
  readonly events: EventFrame["event"][];
  readonly synchronizedAt: number;
}

/** Subscribes to one session from `afterSequence` and answers its catch-up. */
const catchUp = async (client: WireClient, sessionId: string, afterSequence: number): Promise<CatchUp> => {
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence });
  const synchronized = await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
  const frames = client.received.filter(
    (f): f is Frame & { subscription: string } => "subscription" in f && f.subscription === subscription && (f.type === "snapshot" || f.type === "event"),
  );
  const [first] = frames;
  const snapshot = first?.type === "snapshot" ? { ...first, payload: SessionSnapshot.parse(first.payload) } : undefined;
  if (frames.slice(1).some((f) => f.type === "snapshot")) throw new Error("A second snapshot was sent.");
  return {
    snapshot,
    events: frames.filter((f): f is EventFrame => f.type === "event").map((f) => f.event),
    synchronizedAt: synchronized.type === "synchronized" ? synchronized.sequence : -1,
  };
};

/** A snapshot's session without the sequence it stands at: its summary, runs, items and parked prompts. */
const session = ({ summary, runs, items, parkedPrompts }: SessionSnapshot) => ({ summary, runs, items, parkedPrompts });

/**
 * A session created and run twice in a fresh environment, which is then
 * closed: its data directory, id, events, and the snapshot a client got of
 * it. Auto-settle is off, so the session's stream and summary stay as they
 * are until a test touches them.
 */
const untouchedSession = async () => {
  const dataDir = join(tempDir(), "data");
  const first = await start(dataDir);
  const client = await first.client();
  await updateSettings(client, { "sessions.autoSettleAfterIdle": null });
  const { id } = await create(client);
  await runOnce(first, client, id);
  await runOnce(first, client, id, "And the tests");
  const stream = first.env.log.readStream({ kind: "session", id });
  // A cursor past the head is answered with a snapshot at the head: the session before any compaction.
  const before = await catchUp(client, id, first.env.log.head() + 1000);
  await first.close();
  return { dataDir, id, stream, before: before.snapshot?.payload as SessionSnapshot };
};

describe("the compaction sweep", () => {
  it("compacts a session untouched for 90 days at the first daily pass after it, and leaves one with activity at day 89", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await start(dataDir);
    let client = await first.client();
    const quiet = await create(client);
    const busy = await create(client);
    await runOnce(first, client, quiet.id);
    await runOnce(first, client, busy.id);
    await first.close();

    const later = await start(dataDir, 89 * DAY);
    client = await later.client();
    await rename(client, busy.id, "Touched on day 89");
    expect((await catchUp(client, quiet.id, 0)).snapshot).toBeUndefined();
    await client.close();

    // The first daily pass is at day 90 on the dot: not older than the window, so nothing yet.
    later.clock.advance(DAY);
    client = await later.client();
    expect((await catchUp(client, quiet.id, 0)).snapshot).toBeUndefined();
    await client.close();

    later.clock.advance(DAY);
    client = await later.client();
    const compacted = await catchUp(client, quiet.id, 0);
    expect(compacted.snapshot?.sequence).toBe(later.env.log.readStream({ kind: "session", id: quiet.id }).at(-1)?.sequence);
    expect(compacted.events).toEqual([]);
    expect((await catchUp(client, busy.id, 0)).snapshot).toBeUndefined();
  });

  it("runs at startup, before the wire opens, and reads its window from sessions.transcriptCompactAfterDays, preset 90", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await start(dataDir);
    const client = await first.client();
    expect(await client.request("settings.get", { keys: ["sessions.transcriptCompactAfterDays"] })).toEqual({
      values: { "sessions.transcriptCompactAfterDays": 90 },
    });
    const { id } = await create(client);
    await runOnce(first, client, id);
    await updateSettings(client, { "sessions.transcriptCompactAfterDays": 30 });
    await first.close();

    const later = await start(dataDir, 30 * DAY + MINUTE);
    expect((await catchUp(await later.client(), id, 0)).snapshot).toBeDefined();
  });
});

describe("replay of a compacted session", () => {
  it("serves the snapshot in place of the folded events, the same one a fresh client and a cursor older than the fold get, and the one before compaction", async () => {
    const { dataDir, id, stream, before } = await untouchedSession();
    const t = await start(dataDir, WINDOW + MINUTE);
    const client = await t.client();
    const last = stream.at(-1)?.sequence as number;

    const fresh = await catchUp(client, id, 0);
    const older = await catchUp(client, id, stream[1]?.sequence as number);

    expect(fresh.snapshot).toMatchObject({ sequence: last, payload: { sequence: last } });
    expect(older.snapshot).toEqual({ ...fresh.snapshot, subscription: older.snapshot?.subscription });
    expect(session(fresh.snapshot?.payload as SessionSnapshot)).toEqual(session(before));
    expect(before.items.map((item) => item.kind)).toEqual(["user-message", "assistant-text", "user-message", "assistant-text"]);
    expect(fresh.events).toEqual([]);
    expect(fresh.synchronizedAt).toBe(t.env.log.head());
    // A cursor past the head still gets the head's snapshot, built from the compaction's fold.
    const pastHead = await catchUp(client, id, t.env.log.head() + 1000);
    expect(session(pastHead.snapshot?.payload as SessionSnapshot)).toEqual(session(before));
    // A cursor at the fold or after it replays as ever.
    expect(await catchUp(client, id, last)).toMatchObject({ snapshot: undefined, events: [] });
  });

  it("replays a run started after compaction after the snapshot, and a cursor at the fold replays the run alone", async () => {
    const { dataDir, id, stream } = await untouchedSession();
    const t = await start(dataDir, WINDOW + MINUTE);
    const client = await t.client();
    const last = stream.at(-1)?.sequence as number;
    await runOnce(t, client, id, "Once more");

    const fresh = await catchUp(client, id, 0);

    expect(fresh.snapshot?.sequence).toBe(last);
    expect(fresh.events.map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "message.sent", "assistant.text", "run.ended"]);
    expect(fresh.events.every((event) => event.sequence > last)).toBe(true);
    expect((await catchUp(client, id, last)).events).toEqual(fresh.events);
    // The snapshot at the head holds the fold and the new run: the same session the client builds from the two.
    const head = (await catchUp(client, id, t.env.log.head() + 1000)).snapshot?.payload as SessionSnapshot;
    const folded = fresh.snapshot?.payload as SessionSnapshot;
    expect(head.runs.slice(0, -1)).toEqual(folded.runs);
    expect(head.items.slice(0, -2)).toEqual(folded.items);
    expect(head.items.slice(-2)).toEqual([
      expect.objectContaining({ kind: "user-message", text: "Once more" }),
      expect.objectContaining({ kind: "assistant-text", text: "Done: Once more" }),
    ]);
  });

  it("counts the replay bound from the snapshot, not from the cursor: 1,000 events after it are replayed, one more sends the head's snapshot", async () => {
    const { dataDir, id, stream } = await untouchedSession();
    const t = await start(dataDir, WINDOW + MINUTE);
    const client = await t.client();
    const last = stream.at(-1)?.sequence as number;
    const runId = randomUUID();
    const says = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ type: "assistant.text", payload: { runId, itemId: `item-${i}`, text: `line ${i}`, aborted: false } }));
    t.env.log.append({ kind: "session", id }, says(1000), { actor: "adapter:fake" });
    // Counted from the cursor, the events kept below the fold would pass the bound.
    expect(t.env.log.replayBound({ kind: "session", id }, 0)).toMatchObject({ withinBound: false });

    const within = await catchUp(client, id, 0);
    expect(within.snapshot?.sequence).toBe(last);
    expect(within.events).toHaveLength(1000);

    t.env.log.append({ kind: "session", id }, says(1), { actor: "adapter:fake" });
    const beyond = await catchUp(client, id, 0);
    expect(beyond.snapshot?.sequence).toBe(t.env.log.head());
    expect(beyond.events).toEqual([]);
    expect(beyond.snapshot?.payload.items).toHaveLength((within.snapshot?.payload.items.length ?? 0) + 1001);
  });

  it("serves the same snapshot after the projections are rebuilt, and after the session is deleted and restored", async () => {
    const { dataDir, id } = await untouchedSession();
    const t = await start(dataDir, WINDOW + MINUTE);
    const client = await t.client();
    const compacted = await catchUp(client, id, 0);

    await client.request("environment.rebuildProjections", { commandId: randomUUID() });
    expect((await catchUp(client, id, 0)).snapshot?.payload).toEqual(compacted.snapshot?.payload);

    await deleteSession(client, id);
    await client.request("sessions.restore", { commandId: randomUUID(), sessionId: id });
    const restored = await catchUp(client, id, 0);
    expect(restored.snapshot?.sequence).toBe(compacted.snapshot?.sequence);
    expect(session(restored.snapshot?.payload as SessionSnapshot)).toEqual({
      ...session(compacted.snapshot?.payload as SessionSnapshot),
      summary: expect.anything(),
    });
    expect(restored.events.map((event) => event.type)).toEqual(["session.deleted", "session.restored"]);
  });
});

describe("a rewound session", () => {
  /** A snapshot's items as their text. */
  const texts = (snapshot: SessionSnapshot | undefined): string[] => (snapshot?.items ?? []).map((item) => ("text" in item ? String(item.text) : item.kind));
  const ALL = ["One", "Done: One", "Two", "Done: Two", "Three", "Done: Three"];

  it("is left out while its rewind can still be undone, so the undo shows every item after the window; once a run has started after the rewind it is compacted as any other", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await start(dataDir);
    let client = await first.client();
    await updateSettings(client, { "sessions.autoSettleAfterIdle": null });
    const pending = await create(client);
    const continued = await create(client);
    const twos: Record<string, string> = {};
    for (const { id } of [pending, continued]) {
      await runOnce(first, client, id, "One");
      twos[id] = await runOnce(first, client, id, "Two");
      await runOnce(first, client, id, "Three");
      expect(await sessionCommand(client, "sessions.rewind", { sessionId: id, messageId: twos[id] })).toMatchObject({ status: "accepted" });
    }
    await runOnce(first, client, continued.id, "Two, again");
    await first.close();

    const later = await start(dataDir, WINDOW + MINUTE);
    client = await later.client();
    expect((await catchUp(client, pending.id, 0)).snapshot).toBeUndefined();
    const compacted = await catchUp(client, continued.id, 0);
    expect(compacted.snapshot?.sequence).toBe(later.env.log.readStream({ kind: "session", id: continued.id }).at(-1)?.sequence);
    expect(texts(compacted.snapshot?.payload)).toEqual(["One", "Done: One", "Two, again", "Done: Two, again"]);

    expect(await sessionCommand(client, "sessions.undoRewind", { sessionId: pending.id })).toMatchObject({ status: "accepted" });
    expect(texts((await catchUp(client, pending.id, later.env.log.head() + 1000)).snapshot?.payload)).toEqual(ALL);
    expect(await sessionCommand(client, "sessions.undoRewind", { sessionId: continued.id })).toMatchObject({ status: "rejected", error: { data: { reason: "run_started" } } });
  });

  it("is left out while its latest rewind can be undone though an earlier one cannot, and compacted once the undo leaves only that earlier one", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await start(dataDir);
    let client = await first.client();
    await updateSettings(client, { "sessions.autoSettleAfterIdle": null });
    const { id } = await create(client);
    await runOnce(first, client, id, "One");
    const two = await runOnce(first, client, id, "Two");
    const three = await runOnce(first, client, id, "Three");
    await sessionCommand(client, "sessions.rewind", { sessionId: id, messageId: three });
    await runOnce(first, client, id, "Three, again");
    await sessionCommand(client, "sessions.rewind", { sessionId: id, messageId: two });
    await first.close();

    const later = await start(dataDir, WINDOW + MINUTE);
    client = await later.client();
    expect((await catchUp(client, id, 0)).snapshot).toBeUndefined();
    expect(await sessionCommand(client, "sessions.undoRewind", { sessionId: id })).toMatchObject({ status: "accepted" });
    const shown = ["One", "Done: One", "Two", "Done: Two", "Three, again", "Done: Three, again"];
    expect(texts((await catchUp(client, id, later.env.log.head() + 1000)).snapshot?.payload)).toEqual(shown);
    await later.close();

    // The earlier rewind had a run after it, so nothing is left to undo, and the next pass after the window compacts the session.
    const last = await start(dataDir, 2 * WINDOW + 2 * MINUTE);
    client = await last.client();
    const compacted = await catchUp(client, id, 0);
    expect(compacted.snapshot?.sequence).toBe(last.env.log.readStream({ kind: "session", id }).at(-1)?.sequence);
    expect(texts(compacted.snapshot?.payload)).toEqual(shown);
  });

  it("undoes a rewind taken after a compaction, bringing back the items the compaction's fold holds", async () => {
    const { dataDir, id, stream, before } = await untouchedSession();
    const t = await start(dataDir, WINDOW + MINUTE);
    const client = await t.client();
    const last = stream.at(-1)?.sequence as number;
    expect((await catchUp(client, id, 0)).snapshot?.sequence).toBe(last);
    const [, second] = stream.filter((event) => event.type === "message.sent").map((event) => event.payload["messageId"] as string);

    expect(await sessionCommand(client, "sessions.rewind", { sessionId: id, messageId: second as string })).toMatchObject({ status: "accepted" });
    expect(texts((await catchUp(client, id, t.env.log.head() + 1000)).snapshot?.payload)).toEqual(["Fix the receipts", "Done: Fix the receipts"]);
    expect(await sessionCommand(client, "sessions.undoRewind", { sessionId: id })).toMatchObject({ status: "accepted" });

    const head = (await catchUp(client, id, t.env.log.head() + 1000)).snapshot?.payload as SessionSnapshot;
    expect(head.items).toEqual(before.items);
    // A fresh client builds the same from the compaction's fold and the events after it.
    const fresh = await catchUp(client, id, 0);
    expect(fresh.snapshot?.sequence).toBe(last);
    expect(fresh.events.map((event) => event.type)).toEqual(["session.rewound", "session.draft-set", "session.rewind-undone", "session.draft-set"]);
  });
});
