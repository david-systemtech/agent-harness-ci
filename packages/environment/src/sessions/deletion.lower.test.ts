import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIST_PATCH_KEY } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { openEventLog, type EventInput, type EventLog, type Projector, type StreamRef } from "../event-log/event-log.js";
import { createDeletion, type ProviderTranscripts } from "./deletion.js";
import { sessionListProjector } from "./session-list.js";

/**
 * The purge at the lower seam (session-state spec, "Testing Decisions"):
 * the session-list projector and the purge against an in-memory log, where
 * what is asserted is what the purge leaves in the tables: the session's
 * events but the tombstone, its snapshot, its rows and tags gone, and the
 * command receipts untouched. The wire's view of it is `deletion.test.ts`.
 */

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const START = "2026-09-24T00:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number): string => new Date(Date.parse(START) + days * DAY).toISOString();

const open = (path = ":memory:", projectors: readonly Projector[] = [sessionListProjector]): EventLog => {
  const log = openEventLog({ path, projectors, clock: () => new Date(START) });
  cleanups.push(() => log.close());
  return log;
};

const purged = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const kept = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const stream = (id: string): StreamRef => ({ kind: "session", id });
const actor = "client_session:cs-1";

const created = (tags: string[]): EventInput => ({
  type: "session.created",
  payload: { title: null, tags, groupId: null, workspace: { kind: "directory", path: "/work" }, repositoryIdentity: null, account: null, model: null, mode: null },
});
const deleted = (deletedAt: string, deleteProviderTranscript: boolean): EventInput => ({
  type: "session.deleted",
  payload: { deletedAt, purgeAt: new Date(Date.parse(deletedAt) + 30 * DAY).toISOString(), deleteProviderTranscript },
});

/** The rows of the session-list tables, whole, in a fixed order. */
const tables = (log: EventLog) => ({
  sessions: log.read("SELECT * FROM sessions ORDER BY id"),
  tags: log.read("SELECT * FROM session_tags ORDER BY session_id, tag_key"),
});

/**
 * Two sessions with tags, events beyond the list's, a snapshot and a
 * receipt each; the first deleted, asking for its provider transcript to go.
 */
const seed = (log: EventLog) => {
  const receipts = [purged, kept].map((id, i) =>
    log.command({ actor, commandId: `0f8fad5b-d9cb-469f-a165-7086772895${i}e` }, () => ({ aggregate: stream(id), result: {}, events: [created(["wip", "Milo"])] })),
  );
  for (const id of [purged, kept]) {
    log.append(stream(id), [{ type: "session.archived", payload: { archivedAt: START } }, { type: "transcript.chunk", payload: { text: "hi" } }], { actor });
    log.atomically((tx) => log.compactStream(stream(id), { sequence: log.head(), payload: { transcript: "folded" }, remove: [] }, { tx }));
  }
  log.append(stream(purged), [deleted(START, true)], { actor });
  return receipts.map((run) => run.receipt);
};

/** A transcript capability that records what it was asked to delete. */
const recording = () => {
  const asked: string[] = [];
  const transcripts: ProviderTranscripts = { deleteTranscript: (id) => void asked.push(id) };
  return { asked, transcripts };
};

describe("purging a session", () => {
  it("deletes its events but for one session.purged, its snapshot, its rows and its tags, and leaves the receipts and every other session", () => {
    const log = open();
    const receipts = seed(log);
    const { asked, transcripts } = recording();
    const deletion = createDeletion({ log, transcripts });
    const keptEvents = log.readStream(stream(kept));
    const keptTables = { sessions: tables(log).sessions.filter((row) => row["id"] === kept), tags: tables(log).tags.filter((row) => row["session_id"] === kept) };
    const head = log.head();

    const tombstone = log.atomically((tx) => deletion.purgeSession(purged, { tx, actor: "system:sweep" }));

    expect(tombstone).toMatchObject({
      sequence: head + 1,
      streamKind: "session",
      streamId: purged,
      // The stream starts again: the tombstone is its only event.
      streamVersion: 1,
      type: "session.purged",
      actor: "system:sweep",
      payload: { providerTranscript: { outcome: "deleted" } },
      metadata: { [LIST_PATCH_KEY]: { op: "remove", sessionId: purged } },
    });
    expect(log.readStream(stream(purged))).toEqual([tombstone]);
    expect(log.readSnapshot(stream(purged))).toBeNull();
    expect(tables(log)).toEqual(keptTables);
    expect(asked).toEqual([purged]);
    for (const receipt of receipts) expect(log.receipt(receipt.actor, receipt.commandId)).toEqual(receipt);
    expect(log.readStream(stream(kept))).toEqual(keptEvents);
    expect(log.readSnapshot(stream(kept))).toMatchObject({ payload: { transcript: "folded" } });
    expect(log.head()).toBe(head + 1);
  });

  it("purges every deleted session whose purgeAt has come, each as the sweep, and leaves those in their grace and the live ones", () => {
    const log = open();
    const early = "9b2f3e40-3c1a-4d8e-9a57-2e6f0a1b2c3d";
    for (const id of [purged, kept, early]) log.append(stream(id), [created([])], { actor });
    log.append(stream(early), [deleted(START, false)], { actor });
    log.append(stream(purged), [deleted(inDays(5), false)], { actor });
    const deletion = createDeletion({ log });

    expect(deletion.purgeDue(new Date(inDays(30)))).toEqual([early]);
    expect(deletion.purgeDue(new Date(Date.parse(inDays(35)) - 1))).toEqual([]);
    expect(deletion.purgeDue(new Date(inDays(35)))).toEqual([purged]);
    for (const id of [early, purged]) {
      expect(log.readStream(stream(id))).toEqual([expect.objectContaining({ type: "session.purged", actor: "system:sweep" })]);
    }
    expect(tables(log).sessions.map((row) => row["id"])).toEqual([kept]);
    expect(deletion.purgeDue(new Date(inDays(100)))).toEqual([]);
  });

  it("purges the others when one fails, then throws naming the one that failed, which stays deleted for the next sweep", () => {
    const log = open();
    for (const id of [purged, kept]) {
      log.append(stream(id), [created([])], { actor });
      log.append(stream(id), [deleted(START, id === purged)], { actor });
    }
    // An adapter that broke the synchronous contract fails the purge that asked it.
    const transcripts: ProviderTranscripts = { deleteTranscript: () => Promise.resolve() as unknown as undefined };
    const deletion = createDeletion({ log, transcripts });

    expect(() => deletion.purgeDue(new Date(inDays(31)))).toThrow(new RegExp(`Purging 1 of 2 sessions failed: ${purged}`));
    expect(log.readStream(stream(kept)).map((event) => event.type)).toEqual(["session.purged"]);
    expect(log.readStream(stream(purged)).map((event) => event.type)).toEqual(["session.created", "session.deleted"]);
    expect(tables(log).sessions.map((row) => row["id"])).toEqual([purged]);
  });

  it("gives the same tables when the projections are rebuilt after a purge", () => {
    const log = open();
    seed(log);
    log.atomically((tx) => createDeletion({ log }).purgeSession(purged, { tx, actor }));
    const before = tables(log);
    log.rebuildProjections();
    expect(tables(log)).toEqual(before);
    expect(before.sessions.map((row) => row["id"])).toEqual([kept]);
  });

  it("clears the rows a projector that missed the purge left behind, on a rebuild", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-harness-purge-"));
    cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "environment.db");
    // A projector with a bug: it applies everything but the tombstone, so the purged session's rows stay.
    const missesThePurge: Projector = {
      ...sessionListProjector,
      apply: (event, db, context) => (event.type === "session.purged" ? undefined : sessionListProjector.apply(event, db, context)),
    };
    const buggy = open(path, [missesThePurge]);
    seed(buggy);
    buggy.atomically((tx) => createDeletion({ log: buggy }).purgeSession(purged, { tx, actor }));
    expect(tables(buggy).sessions.map((row) => row["id"]).sort()).toEqual([kept, purged].sort());
    buggy.close();

    const fixed = open(path);
    fixed.rebuildProjections();
    expect(tables(fixed).sessions.map((row) => row["id"])).toEqual([kept]);
    expect(tables(fixed).tags.every((row) => row["session_id"] === kept)).toBe(true);
  });
});
