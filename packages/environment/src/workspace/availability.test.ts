import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionSnapshot, registry, type ParamsOf, type ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { command, create, get, listStream, patchOf, refusal, rename } from "../../test/sessions.js";
import { terminalCommand } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";
import { formatActor } from "../event-log/event-log.js";
import { createSessionIn } from "../sessions/methods.js";
import { acceptAnyRunParameters } from "../sessions/run-parameters.js";
import { MAX_UNANSWERED, PASS_INTERVAL_MS } from "./availability.js";

/**
 * Missing workspaces (workspace-picker spec, "Missing workspaces"; ADR 0021;
 * #328) through the primary seam: an in-process environment with the
 * scripted fake adapter and its manual clock, a real client over a real
 * WebSocket, and workspace directories made, removed and made again in the
 * test's temporary directory.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** The actor the availability watcher appends as, as a client reads it. */
const WORKSPACES = { kind: "system", id: "workspaces" };

type RunCommand = "runs.start" | "runs.send" | "runs.readNow";

/** Sends a run command with a fresh command id; resolves with its response, checked against its schema. */
const run = async <N extends RunCommand>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params })) as ResponseOf<N>;

/** Starts a run and resolves once it has ended; throws unless the start was accepted. */
const runToEnd = async (client: WireClient, sessionId: string, from: number): Promise<string> => {
  const list = await listStream(client, from);
  const answer = await run(client, "runs.start", { sessionId, text: "Fix the receipts" });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  const { runId } = answer.result;
  for (let event = await list.next(); event.type !== "run.ended" || event.payload["runId"] !== runId; event = await list.next());
  return runId;
};

/** A directory of its own for a session to work in. */
const directory = (): string => {
  const path = join(tempDir("agent-harness-availability-"), "work");
  mkdirSync(path);
  return path;
};

describe("a run on a session whose workspace is gone", () => {
  it("is refused conflict workspace_missing with the path, and the watcher marks the session missing as system:workspaces, updatedAt kept", async () => {
    const t = await start();
    const client = await t.client();
    const path = directory();
    const { id, result } = await create(client, { workspace: { kind: "directory", path } });
    const list = await listStream(client, t.env.log.head());
    rmSync(path, { recursive: true });
    t.clock.advance(60_000);
    const found = t.clock.now().toISOString();

    const answer = await run(client, "runs.start", { sessionId: id, text: "Go on" });

    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "workspace_missing", sessionId: id, path } } });
    const event = await list.next();
    expect(event).toMatchObject({ type: "session.workspace-status-changed", streamId: id, actor: WORKSPACES, payload: { status: "missing" } });
    // The mark alone: the system's finding moves no organisation time.
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { workspaceMissingSince: found } });
    expect(await get(client, id)).toMatchObject({ workspaceMissingSince: found, updatedAt: result?.summary.updatedAt });
    expect(t.adapter.runs).toEqual([]);
  });

  it("refuses runs.send and runs.readNow as well while it is missing, and starts the run once the directory is back, clearing the mark first", async () => {
    const t = await start();
    const client = await t.client();
    const path = directory();
    const { id } = await create(client, { workspace: { kind: "directory", path } });
    rmSync(path, { recursive: true });
    expect((await run(client, "runs.send", { sessionId: id, text: "Go on" })).receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { data: { reason: "workspace_missing", sessionId: id, path } },
    });
    // Marked by the send's look: read now is refused on the mark as its own look finds it gone too.
    expect((await get(client, id)).workspaceMissingSince).not.toBeNull();
    expect((await run(client, "runs.readNow", { sessionId: id })).receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { data: { reason: "workspace_missing", sessionId: id, path } },
    });
    const list = await listStream(client, t.env.log.head());

    mkdirSync(path);
    const answer = await run(client, "runs.start", { sessionId: id, text: "Go on" });

    expect(answer.receipt).toMatchObject({ status: "accepted" });
    const back = await list.next();
    expect(back).toMatchObject({ type: "session.workspace-status-changed", streamId: id, actor: WORKSPACES, payload: { status: "present" } });
    expect(patchOf(back)).toEqual({ op: "set", sessionId: id, fields: { workspaceMissingSince: null } });
    expect((await list.next()).type).toBe("run.started");
  });
});

describe("a session whose workspace is missing", () => {
  it("still lists and opens, with its transcript, diffs.session and the organisation commands", async () => {
    const t = await start();
    const client = await t.client();
    const path = directory();
    const { id } = await create(client, { workspace: { kind: "directory", path } });
    const runId = await runToEnd(client, id, t.env.log.head());
    rmSync(path, { recursive: true });
    await run(client, "runs.start", { sessionId: id, text: "Go on" });

    const listed = (await client.request("sessions.list", {})).sessions.find((summary) => summary.id === id);
    expect(listed?.workspaceMissingSince).not.toBeNull();
    const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: t.env.log.head() + 1000 });
    const frame = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
    const snapshot = SessionSnapshot.parse(frame.type === "snapshot" && frame.payload);
    expect(snapshot.runs.map((one) => one.runId)).toEqual([runId]);
    expect(snapshot.summary.workspaceMissingSince).toBe(listed?.workspaceMissingSince);
    expect(await client.request("diffs.session", { sessionId: id })).toMatchObject({ files: [] });
    await rename(client, id, "The gone one");
    await command(client, "sessions.tag", { sessionId: id, tag: "moved" });
    await command(client, "sessions.pin", { sessionId: id });
    expect((await command(client, "sessions.archive", { sessionId: id })).receipt).toMatchObject({ status: "accepted" });
    expect(await get(client, id)).toMatchObject({ title: "The gone one", tags: ["moved"], workspaceMissingSince: listed?.workspaceMissingSince });
  });
});

describe("the methods that need the workspace", () => {
  it("mark the session by what they find, gone or back: terminals.open, files.list, diffs.workingTree and files.read, appended only on a change", async () => {
    const t = await start();
    const client = await t.client();
    const path = directory();
    const { id } = await create(client, { workspace: { kind: "directory", path } });
    const list = await listStream(client, t.env.log.head());
    const status = async () => {
      const event = await list.next();
      expect(event).toMatchObject({ type: "session.workspace-status-changed", streamId: id, actor: WORKSPACES });
      return event.payload["status"];
    };

    rmSync(path, { recursive: true });
    const opened = await terminalCommand(client, "terminals.open", { id: randomUUID(), sessionId: id });
    expect(opened.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "workspace_missing", path } } });
    expect(await status()).toBe("missing");

    mkdirSync(path);
    expect(await client.request("files.list", { sessionId: id })).toMatchObject({ files: [] });
    expect(await status()).toBe("present");

    rmSync(path, { recursive: true });
    expect(await refusal(client.request("diffs.workingTree", { sessionId: id }))).toMatchObject({ code: "conflict", data: { reason: "workspace_missing" } });
    expect(await status()).toBe("missing");

    mkdirSync(path);
    await rename(client, id, "Back");
    expect(await refusal(client.request("files.read", { sessionId: id, path: "none.txt" }))).toMatchObject({ code: "not_found", data: { kind: "file" } });
    // The rename came first; the read found the directory back.
    expect((await list.next()).type).toBe("session.title-set");
    expect(await status()).toBe("present");

    // Found there again, and again: no change, no event. The next event is the rename after.
    await client.request("files.list", { sessionId: id });
    await client.request("diffs.workingTree", { sessionId: id });
    await rename(client, id, "Still here");
    expect((await list.next()).type).toBe("session.title-set");
  });
});

describe("the availability pass", () => {
  it("looks at every session after a start on one data directory and marks the one whose directory went while it was down, and it alone", async () => {
    const dataDir = join(tempDir("agent-harness-availability-data-"), "data");
    const first = await start({ dataDir });
    const kept = directory();
    const gone = directory();
    const one = await create(await first.client(), { workspace: { kind: "directory", path: kept } });
    const other = await create(await first.client(), { workspace: { kind: "directory", path: gone } });
    const from = first.env.log.head();
    await first.close();
    rmSync(gone, { recursive: true });

    const again = await start({ dataDir });
    await again.env.workspaces.availabilityPass;
    const client = await again.client();
    const list = await listStream(client, from);

    expect(await list.next()).toMatchObject({ type: "session.workspace-status-changed", streamId: other.id, actor: WORKSPACES, payload: { status: "missing" } });
    await rename(client, one.id, "Kept");
    expect(await list.next()).toMatchObject({ type: "session.title-set", streamId: one.id });
  });

  it("looks hourly on the environment's clock: a directory removed is marked at the next hour, and cleared at the one after it is made again", async () => {
    const t = await start();
    await t.env.workspaces.availabilityPass;
    const client = await t.client();
    const path = directory();
    const { id } = await create(client, { workspace: { kind: "directory", path } });
    const list = await listStream(client, t.env.log.head());

    rmSync(path, { recursive: true });
    t.clock.advance(PASS_INTERVAL_MS);
    const missing = await list.next();
    expect(missing).toMatchObject({ type: "session.workspace-status-changed", streamId: id, actor: WORKSPACES, payload: { status: "missing" } });
    expect(patchOf(missing)).toEqual({ op: "set", sessionId: id, fields: { workspaceMissingSince: t.clock.now().toISOString() } });

    mkdirSync(path);
    t.clock.advance(PASS_INTERVAL_MS);
    expect(await list.next()).toMatchObject({ type: "session.workspace-status-changed", streamId: id, payload: { status: "present" } });
    expect((await get(client, id)).workspaceMissingSince).toBeNull();
  });
});

/**
 * How long a look may take in the tests of a directory that never answers:
 * short, since only that directory's look ever reaches it, the scripted
 * look answering every other path at once.
 */
const LOOK_BOUND_MS = 50;

describe("a look at a directory that does not answer, as on a network mount whose server is gone", () => {
  it("stalls neither the environment nor the run's start: the start waits out the look's bound and is refused, and the path is not asked again until its call returns", async () => {
    const dead = directory();
    /** Every path looked at, in order. */
    const asked: string[] = [];
    let answerDead: ((there: boolean) => void) | undefined;
    let deadAsked: () => void = () => undefined;
    const lookedAtDead = new Promise<void>((resolve) => (deadAsked = resolve));
    const t = await start({
      workspaces: {
        // Every other path answers at once; the bound is only ever reached by the one that never does.
        lookTimeoutMs: LOOK_BOUND_MS,
        isDirectory: async (path) => {
          asked.push(path);
          if (path !== dead || answerDead !== undefined) return true;
          deadAsked();
          return new Promise<boolean>((resolve) => (answerDead = resolve));
        },
      },
    });
    await t.env.workspaces.availabilityPass;
    const client = await t.client();
    const { id } = await create(client, { workspace: { kind: "directory", path: dead } });
    const other = await create(client, { workspace: { kind: "directory", path: directory() } });

    const starting = run(client, "runs.start", { sessionId: id, text: "Go on" });
    await lookedAtDead;
    // While that look waits, the environment answers everything else: a run on another session starts.
    expect((await run(client, "runs.start", { sessionId: other.id, text: "Here" })).receipt).toMatchObject({ status: "accepted" });

    const refused = { status: "rejected", reason: "conflict", error: { data: { reason: "workspace_missing", sessionId: id, path: dead } } };
    expect((await starting).receipt).toMatchObject(refused);
    expect((await get(client, id)).workspaceMissingSince).toBe(t.clock.now().toISOString());
    // Its first call has not returned: the next start is refused without asking again.
    expect((await run(client, "runs.start", { sessionId: id, text: "Again" })).receipt).toMatchObject(refused);
    expect(asked.filter((path) => path === dead)).toHaveLength(1);

    // The call returns at last: the next look asks again, finds it there, and the run starts.
    answerDead?.(true);
    expect((await run(client, "runs.start", { sessionId: id, text: "Now" })).receipt).toMatchObject({ status: "accepted" });
    expect(asked.filter((path) => path === dead)).toHaveLength(2);
    expect((await get(client, id)).workspaceMissingSince).toBeNull();
  });

  it("asks about no other path while two looks are overdue, keeping the rest of the thread pool free: the session's mark stays as it was", async () => {
    const dead = Array.from({ length: MAX_UNANSWERED }, () => directory());
    const asked: string[] = [];
    const t = await start({
      workspaces: {
        lookTimeoutMs: LOOK_BOUND_MS,
        isDirectory: async (path) => {
          asked.push(path);
          return dead.includes(path) ? new Promise<boolean>(() => undefined) : true;
        },
      },
    });
    await t.env.workspaces.availabilityPass;
    const client = await t.client();
    for (const path of dead) {
      const { id } = await create(client, { workspace: { kind: "directory", path } });
      expect((await run(client, "runs.start", { sessionId: id, text: "Go on" })).receipt).toMatchObject({ status: "rejected", error: { data: { reason: "workspace_missing" } } });
    }
    const healthy = directory();
    const { id } = await create(client, { workspace: { kind: "directory", path: healthy } });

    expect((await run(client, "runs.start", { sessionId: id, text: "Here" })).receipt).toMatchObject({ status: "accepted" });
    expect(asked).not.toContain(healthy);
    expect((await get(client, id)).workspaceMissingSince).toBeNull();
  });
});

describe("the Carry over import's entry", () => {
  it("lets an in-process caller record a session whose directory is gone and mark it missing right after its session.created, in the same transaction", async () => {
    const t = await start();
    const client = await t.client();
    const list = await listStream(client, t.env.log.head());
    const id = randomUUID();
    const gone = join(tempDir("agent-harness-availability-"), "gone");

    t.env.log.atomically((tx) => {
      const created = createSessionIn(
        t.env.log,
        { tx, actor: formatActor({ kind: "system", id: "carry-over" }) },
        { id, title: "Imported", workspace: { kind: "directory", path: gone } },
        { validateRunParameters: acceptAnyRunParameters, clampMode: (mode) => mode },
      );
      expect(created.rejected).toBeUndefined();
      t.env.workspaces.markMissing(tx, id);
    });

    const created = await list.next();
    expect(created).toMatchObject({ type: "session.created", streamId: id });
    const marked = await list.next();
    expect(marked).toMatchObject({ type: "session.workspace-status-changed", streamId: id, actor: WORKSPACES, payload: { status: "missing" } });
    expect(marked.sequence).toBe(created.sequence + 1);
    expect(patchOf(marked)).toEqual({ op: "set", sessionId: id, fields: { workspaceMissingSince: created.occurredAt } });
    expect((await run(client, "runs.start", { sessionId: id, text: "Go on" })).receipt).toMatchObject({
      status: "rejected",
      error: { data: { reason: "workspace_missing", path: gone } },
    });
  });
});
