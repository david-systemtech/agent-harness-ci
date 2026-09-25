import { join } from "node:path";
import {
  foldSessionSummary,
  renameSession,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { runSessionStoreConformance } from "../../test/session-store-conformance.js";
import { openEventLog, type EventInput, type EventLog, type StreamRef } from "../event-log/event-log.js";
import { createDeletion } from "../sessions/deletion.js";
import { sessionListProjector } from "../sessions/session-list.js";
import { RENAME_ENTRY_TYPE, createProviderTranscriptStore, type ProviderTranscriptStore } from "./store.js";

/**
 * The SDK session store at its lower seam (claude-adapter spec, "Testing
 * Decisions"): the store against an in-memory log, where the rows it keeps
 * are the behaviour. The SDK's published conformance suite first (vendored:
 * the pinned package ships none); then what
 * the suite leaves out: the summaries folded with the SDK's helper,
 * appends serialised per session, a retried batch stored once, the fold
 * without renames the title read lists, the fork's copy and the purge.
 */

const { onCleanup, tempDir } = useCleanups();

const open = (path = ":memory:"): EventLog => {
  const log = openEventLog({ path, projectors: [sessionListProjector] });
  onCleanup(() => log.close());
  return log;
};

const clock = manualClock();
const storeOn = (log: EventLog): ProviderTranscriptStore => createProviderTranscriptStore({ log, clock });

const HARNESS = "6f1d2a4e-8c3b-4f5a-9d7e-1a2b3c4d5e6f";
const OTHER = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const PROVIDER = "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a";
const MAIN: SessionKey = { projectKey: HARNESS, sessionId: PROVIDER };
const SUB: SessionKey = { ...MAIN, subpath: "subagents/agent-a1" };

const at = "2026-09-25T01:00:00.000Z";
const prompt = (uuid: string, text: string): SessionStoreEntry => ({ type: "user", uuid, timestamp: at, cwd: "/work/repo", message: { role: "user", content: text } });
const reply = (uuid: string, text: string): SessionStoreEntry => ({ type: "assistant", uuid, timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } });
const aiTitle = (title: string): SessionStoreEntry => ({ type: "ai-title", aiTitle: title, sessionId: PROVIDER });
const rename = (title: string): SessionStoreEntry => ({ type: RENAME_ENTRY_TYPE, customTitle: title, sessionId: PROVIDER, uuid: crypto.randomUUID(), timestamp: at });

describe("the environment's session store, against the SDK's published conformance suite", () => {
  runSessionStoreConformance(() => storeOn(open()));
});

describe("the summaries", () => {
  it("folds each main transcript's summary with the SDK's helper inside append, stamped with the write time listSessions answers, and leaves a subagent's transcript out", async () => {
    const store = storeOn(open());
    const first = [prompt("u1", "Fix the receipts"), reply("a1", "On it.")];
    const second = [aiTitle("Fixing the receipt sweep")];
    await store.append(MAIN, first);
    await store.append(SUB, [prompt("s1", "Look it up"), aiTitle("A subagent's own title")]);
    await store.append(MAIN, second);

    const [summary] = await store.listSessionSummaries(HARNESS);
    const [listed] = await store.listSessions(HARNESS);
    expect(summary?.mtime).toBe(listed?.mtime);
    expect(summary).toEqual(foldSessionSummary(undefined, MAIN, [...first, ...second], { mtime: listed?.mtime ?? 0 }));
    expect(summary?.data["aiTitle"]).toBe("Fixing the receipt sweep");
    expect(await store.listSessionSummaries("another-project")).toEqual([]);
  });

  it("serialises concurrent appends to one session: every entry kept in call order, the summary folded over all of them", async () => {
    const store = storeOn(open());
    const batches = Array.from({ length: 40 }, (_, i) => [{ type: "last-prompt", lastPrompt: `prompt ${i}`, sessionId: PROVIDER }, prompt(`u${i}`, `Prompt ${i}`)]);
    await Promise.all(batches.map((batch) => store.append(MAIN, batch)));
    expect(await store.load(MAIN)).toEqual(batches.flat());
    const [summary] = await store.listSessionSummaries(HARNESS);
    expect(summary?.data).toEqual(foldSessionSummary(undefined, MAIN, batches.flat(), { mtime: summary?.mtime ?? 0 }).data);
    expect(summary?.data["lastPrompt"]).toBe("prompt 39");
  });

  it("keeps an entry once under its uuid when a batch is retried, and appends one without a uuid each time", async () => {
    const store = storeOn(open());
    const marker = { type: "mode", mode: "plan" };
    await store.append(MAIN, [prompt("u1", "Once"), marker]);
    await store.append(MAIN, [prompt("u1", "Once"), marker]);
    expect(await store.load(MAIN)).toEqual([prompt("u1", "Once"), marker, marker]);
  });

  it("stores a retried batch once over a prior summary, leaving the summary as it was when nothing new was kept, and folding and restamping it when something was", async () => {
    const store = storeOn(open());
    await store.append(MAIN, [prompt("u0", "Before")]);
    await store.append(MAIN, [prompt("u1", "One"), reply("a1", "Done.")]);
    const [first] = await store.listSessionSummaries(HARNESS);

    // Every entry of the retry is stored already: nothing is kept, and the summary, write time included, stays.
    await store.append(MAIN, [prompt("u1", "One"), reply("a1", "Done.")]);
    expect(await store.load(MAIN)).toEqual([prompt("u0", "Before"), prompt("u1", "One"), reply("a1", "Done.")]);
    expect(await store.listSessionSummaries(HARNESS)).toEqual([first]);

    // A retry carrying an entry without a uuid keeps that entry again: the summary is folded over it and its write time rises.
    const marker = { type: "last-prompt", lastPrompt: "Again", sessionId: PROVIDER };
    await store.append(MAIN, [prompt("u2", "Two"), marker]);
    const [second] = await store.listSessionSummaries(HARNESS);
    await store.append(MAIN, [prompt("u2", "Two"), marker]);
    const [third] = await store.listSessionSummaries(HARNESS);
    expect((await store.load(MAIN))?.slice(-3)).toEqual([prompt("u2", "Two"), marker, marker]);
    expect(second?.mtime).toBeGreaterThan(first?.mtime ?? Infinity);
    expect(third?.mtime).toBeGreaterThan(second?.mtime ?? Infinity);
    expect(third?.data).toEqual(foldSessionSummary(second, MAIN, [marker], { mtime: third?.mtime ?? 0 }).data);
  });

  it("keeps the fold without the user's renames beside the SDK's own, which a mirrored title reaches", async () => {
    const store = storeOn(open());
    await store.append(MAIN, [prompt("u1", "Fix the receipts"), aiTitle("Fixing the receipt sweep")]);
    await store.append(MAIN, [rename("My own name for it")]);
    const [summary] = await store.listSessionSummaries(HARNESS);
    const [unrenamed] = await store.listUnrenamedSummaries(HARNESS);
    expect(summary?.data["customTitle"]).toBe("My own name for it");
    expect(unrenamed?.data["customTitle"]).toBeUndefined();
    expect(unrenamed?.data["aiTitle"]).toBe("Fixing the receipt sweep");
    expect(unrenamed?.mtime).toBe(summary?.mtime);
  });

  it("names the entry type the SDK's own renameSession appends", async () => {
    const appended: SessionStoreEntry[] = [];
    const recording: SessionStore = { append: async (_key, entries) => void appended.push(...entries), load: async () => null };
    await renameSession(PROVIDER, "A title", { sessionStore: recording });
    expect(appended).toEqual([expect.objectContaining({ type: RENAME_ENTRY_TYPE, customTitle: "A title" })]);
  });

  it("drops the summary with the main transcript's delete, which takes every subkey", async () => {
    const store = storeOn(open());
    await store.append(MAIN, [prompt("u1", "Go")]);
    await store.append(SUB, [prompt("s1", "Sub")]);
    await store.delete(MAIN);
    expect(await store.listSessionSummaries(HARNESS)).toEqual([]);
    expect(await store.listSessions(HARNESS)).toEqual([]);
    expect(await store.load(SUB)).toBeNull();
  });

  it("reads the latest write time through an index on mtime, not a scan of every summary", () => {
    const log = open();
    const plan = log.read<{ detail: string }>("EXPLAIN QUERY PLAN SELECT MAX(mtime) AS latest FROM provider_transcript_summaries");
    expect(plan.map((row) => row.detail).join(" ")).toMatch(/USING COVERING INDEX provider_transcript_summaries_by_mtime/);
  });

  it("keeps what it holds across a restart", async () => {
    const path = join(tempDir(), "environment.db");
    const first = openEventLog({ path });
    await storeOn(first).append(MAIN, [prompt("u1", "Go")]);
    first.close();
    expect(await storeOn(open(path)).load(MAIN)).toEqual([prompt("u1", "Go")]);
  });
});

describe("a fork's copy", () => {
  it("copies everything one harness session holds under another's id, in the transaction open, and leaves the source as it was", async () => {
    const log = open();
    const store = storeOn(log);
    await store.append(MAIN, [prompt("u1", "Go"), aiTitle("Going")]);
    await store.append(SUB, [prompt("s1", "Sub")]);
    log.atomically((tx) => store.copySession(tx, HARNESS, OTHER));
    expect(await store.load({ ...MAIN, projectKey: OTHER })).toEqual([prompt("u1", "Go"), aiTitle("Going")]);
    expect(await store.load({ ...SUB, projectKey: OTHER })).toEqual([prompt("s1", "Sub")]);
    expect(await store.listSessionSummaries(OTHER)).toEqual(await store.listSessionSummaries(HARNESS));
    // The fork's own writes go under its own key and never reach the source's.
    await store.append({ ...MAIN, projectKey: OTHER }, [prompt("u2", "Only the fork")]);
    expect(await store.load(MAIN)).toEqual([prompt("u1", "Go"), aiTitle("Going")]);
  });
});

describe("the purge's cascade", () => {
  const stream = (id: string): StreamRef => ({ kind: "session", id });
  const actor = "client_session:cs-1";
  const created: EventInput = {
    type: "session.created",
    payload: { title: null, tags: [], groupId: null, workspace: { kind: "directory", path: "/work" }, repositoryIdentity: null, account: null, model: null, mode: null },
  };
  const deleted = (deleteProviderTranscript: boolean): EventInput => ({
    type: "session.deleted",
    payload: { deletedAt: at, purgeAt: "2026-10-25T01:00:00.000Z", deleteProviderTranscript },
  });

  it.each([false, true])("removes a purged session's store entries whether or not its provider transcript was asked to go too (asked: %s)", async (asked) => {
    const log = open();
    const store = storeOn(log);
    for (const id of [HARNESS, OTHER]) {
      log.append(stream(id), [created], { actor });
      await store.append({ ...MAIN, projectKey: id }, [prompt("u1", "Go")]);
      await store.append({ ...SUB, projectKey: id }, [prompt("s1", "Sub")]);
    }
    log.append(stream(HARNESS), [deleted(asked)], { actor });
    const deletion = createDeletion({ log, providerStore: store });
    const tombstone = log.atomically((tx) => deletion.purgeSession(HARNESS, { tx, actor }));

    expect(tombstone.payload).toEqual({ providerTranscript: { outcome: asked ? "unsupported" : "kept" } });
    expect(await store.load(MAIN)).toBeNull();
    expect(await store.load(SUB)).toBeNull();
    expect(await store.listSessions(HARNESS)).toEqual([]);
    expect(await store.load({ ...MAIN, projectKey: OTHER })).toEqual([prompt("u1", "Go")]);
  });

  it("drops a mirror write that lands after the purge, and the startup sweep clears what one left under a purged key", async () => {
    const log = open();
    const store = storeOn(log);
    for (const id of [HARNESS, OTHER]) log.append(stream(id), [created], { actor });
    log.append(stream(HARNESS), [deleted(false)], { actor });
    const deletion = createDeletion({ log, providerStore: store });
    log.atomically((tx) => deletion.purgeSession(HARNESS, { tx, actor }));

    // A process still flushing its mirror after the tombstone.
    await store.append(MAIN, [prompt("u1", "Late")]);
    await store.append(SUB, [prompt("s1", "Late too")]);
    expect(await store.load(MAIN)).toBeNull();
    expect(await store.load(SUB)).toBeNull();
    expect(await store.listSessions(HARNESS)).toEqual([]);

    // What a write racing the purge left before the drop existed: rows under the purged key, beside a live session's.
    log.atomically((tx) => log.providerTranscripts.insert(tx, { projectKey: HARNESS, sessionId: PROVIDER, subpath: "" }, [{ uuid: "u2", json: JSON.stringify(prompt("u2", "Raced")) }]));
    await store.append({ ...MAIN, projectKey: OTHER }, [prompt("u1", "Live")]);
    expect(store.sweepOrphans()).toEqual([HARNESS]);
    expect(await store.load(MAIN)).toBeNull();
    expect(await store.load({ ...MAIN, projectKey: OTHER })).toEqual([prompt("u1", "Live")]);
    expect(store.sweepOrphans()).toEqual([]);
  });

  it("rolls the store's delete back with a purge that does not commit", async () => {
    const log = open();
    const store = storeOn(log);
    log.append(stream(HARNESS), [created, deleted(false)], { actor });
    await store.append(MAIN, [prompt("u1", "Go")]);
    const deletion = createDeletion({ log, providerStore: store });
    expect(() =>
      log.atomically((tx) => {
        deletion.purgeSession(HARNESS, { tx, actor });
        throw new Error("The tombstone did not commit.");
      }),
    ).toThrow("did not commit");
    expect(await store.load(MAIN)).toEqual([prompt("u1", "Go")]);
  });
});
