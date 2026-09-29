import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry, type EventEnvelope, type ParamsOf, type ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, gate, say, type FakeAdapterOptions, type Gate, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, get, listStream, patchOf } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";
import { autoMemoryName } from "./auto-memory.js";

/**
 * `sessions.setWorkspace` (workspace-picker spec, "Missing workspaces"; ADR
 * 0021; #328) through the primary seam: an in-process environment with the
 * scripted fake adapter, a real client over a real WebSocket, and workspace
 * directories and git repositories made and removed in the test's
 * temporary directory.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (adapter: FakeAdapterOptions = {}, options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

/** The identity every spelling of the harness's own repository comes down to. */
const IDENTITY = "https://git.systemtech.dev/david/agent-harness";

/** A run that links the provider conversation `provider-1`, as a Claude run's first init does, then replies. */
const linking: Script = () => [{ type: "session.provider-linked", payload: { providerSessionId: "provider-1" } }, say("Done"), end()];

/** A script held open until its gate opens. */
const held = (opened: Gate): Script =>
  async function* () {
    yield say("Working");
    await opened.opened;
    yield end();
  };

/** Sends `sessions.setWorkspace` with a fresh command id; resolves with its response, checked against its schema. */
const setWorkspace = async (client: WireClient, sessionId: string, workspace: ParamsOf<"sessions.setWorkspace">["workspace"]): Promise<ResponseOf<"sessions.setWorkspace">> =>
  registry["sessions.setWorkspace"].response.parse(await client.request("sessions.setWorkspace", { commandId: randomUUID(), sessionId, workspace }));

type RunCommand = "runs.start" | "runs.send";

const run = async <N extends RunCommand>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params })) as ResponseOf<N>;

/** The list events a client reads from `from` until one of `type` for the session. */
const until = async (client: WireClient, from: number, type: string, sessionId: string): Promise<EventEnvelope[]> => {
  const list = await listStream(client, from);
  const seen: EventEnvelope[] = [];
  for (;;) {
    const event = await list.next();
    seen.push(event);
    if (event.type === type && event.streamId === sessionId) return seen;
  }
};

/** A directory of its own for a session to work in. */
const directory = (): string => {
  const path = join(tempDir("agent-harness-set-workspace-"), "work");
  mkdirSync(path);
  return path;
};

/** A repository with one commit and `origin` at `url`. */
const repository = (url: string): string => {
  const path = directory();
  git(path, "init", "-q");
  git(path, "commit", "-q", "--allow-empty", "-m", "first");
  git(path, "remote", "add", "origin", url);
  return path;
};

/** Removes the session's directory and has a run's start find it gone, which marks the session missing. */
const lose = async (client: WireClient, sessionId: string, path: string): Promise<void> => {
  rmSync(path, { recursive: true });
  const refused = await run(client, "runs.send", { sessionId, text: "Anyone there?" });
  expect(refused.receipt).toMatchObject({ status: "rejected", error: { data: { reason: "workspace_missing" } } });
};

describe("sessions.setWorkspace", () => {
  it("is refused conflict workspace_present, with the path, while the session's workspace is there, and not_found for a session not here", async () => {
    const t = await start();
    const client = await t.client();
    const path = directory();
    const { id } = await create(client, { workspace: { kind: "directory", path } });

    const answer = await setWorkspace(client, id, { kind: "scratch" });

    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "workspace_present", sessionId: id, path } } });
    expect((await get(client, id)).workspace).toEqual({ kind: "directory", path });
    expect((await setWorkspace(client, randomUUID(), { kind: "scratch" })).receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "session" } } });
  });

  it("is refused conflict run_active while a run is live, whatever its workspace, then accepted once the run has ended", async () => {
    const opened = gate();
    const t = await start({ script: held(opened) });
    const client = await t.client();
    const path = directory();
    const { id } = await create(client, { workspace: { kind: "directory", path } });
    const started = await run(client, "runs.start", { sessionId: id, text: "Work on" });
    const runId = started.result?.runId;
    rmSync(path, { recursive: true });
    await client.request("files.list", { sessionId: id }).catch(() => undefined);
    expect((await get(client, id)).workspaceMissingSince).not.toBeNull();

    const refused = await setWorkspace(client, id, { kind: "scratch" });

    expect(refused.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "run_active", sessionId: id, runId } } });
    const from = t.env.log.head();
    opened.open();
    await until(client, from, "run.ended", id);
    const answer = await setWorkspace(client, id, { kind: "scratch" });
    expect(answer.receipt).toMatchObject({ status: "accepted" });
    expect(answer.result?.summary.workspace).toEqual({ kind: "scratch", path: join(t.dataDir, "scratch", id) });
  });

  it("appends session.workspace-set with the workspace its request resolves to and the identity resolved afresh, clearing the mark and moving updatedAt", async () => {
    const t = await start();
    const client = await t.client();
    const path = directory();
    const { id } = await create(client, { workspace: { kind: "directory", path } });
    await lose(client, id, path);
    const moved = repository("ssh://git@git.systemtech.dev:2222/david/agent-harness.git");
    t.clock.advance(60_000);
    const from = t.env.log.head();

    const answer = await setWorkspace(client, id, { kind: "directory", path: moved });

    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    const at = t.clock.now().toISOString();
    expect(answer.result?.summary).toMatchObject({ workspace: { kind: "directory", path: moved }, repositoryIdentity: IDENTITY, workspaceMissingSince: null, updatedAt: at });
    const [event] = await until(client, from, "session.workspace-set", id);
    expect(event).toMatchObject({
      type: "session.workspace-set",
      actor: { kind: "client_session", id: client.hello.clientSessionId },
      payload: { workspace: { kind: "directory", path: moved }, repositoryIdentity: IDENTITY },
    });
    expect(patchOf(event as EventEnvelope)).toEqual({
      op: "set",
      sessionId: id,
      fields: { workspace: { kind: "directory", path: moved }, repositoryIdentity: IDENTITY, workspaceMissingSince: null, updatedAt: at },
    });
    expect(await get(client, id)).toEqual(answer.result?.summary);
  });

  it("refuses what the resolver refuses, as a create's request, and changes nothing", async () => {
    const t = await start();
    const client = await t.client();
    const path = directory();
    const { id } = await create(client, { workspace: { kind: "directory", path } });
    await lose(client, id, path);
    const nowhere = join(tempDir("agent-harness-set-workspace-"), "nowhere");

    const answer = await setWorkspace(client, id, { kind: "directory", path: nowhere });

    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "workspace_unusable", problem: "does_not_exist", path: nowhere } } });
    expect(await get(client, id)).toMatchObject({ workspace: { kind: "directory", path }, workspaceMissingSince: expect.any(String) });
  });

  it("stops the session's kept provider process, and the next run resumes the provider's conversation in the new workspace", async () => {
    const t = await start({ script: linking });
    const client = await t.client();
    const path = directory();
    const { id } = await create(client, { workspace: { kind: "directory", path } });
    const first = t.env.log.head();
    await run(client, "runs.start", { sessionId: id, text: "Begin" });
    await until(client, first, "run.ended", id);
    expect(t.adapter.processesOf(id)).toMatchObject([{ stopped: false }]);
    await lose(client, id, path);
    const moved = directory();

    expect((await setWorkspace(client, id, { kind: "directory", path: moved })).receipt).toMatchObject({ status: "accepted" });

    await vi.waitFor(() => expect(t.adapter.processesOf(id).at(-1)?.stopped).toBe(true), { timeout: WAIT_MS });
    expect((await client.request("providers.processes.list", {})).processes.find((process) => process.sessionId === id)).toMatchObject({ stopReason: "moved" });
    const second = t.env.log.head();
    expect((await run(client, "runs.start", { sessionId: id, text: "Go on" })).receipt).toMatchObject({ status: "accepted" });
    await until(client, second, "run.ended", id);
    expect(t.adapter.lastRun().input).toMatchObject({ workspace: { kind: "directory", path: moved }, target: { kind: "resume", providerSessionId: "provider-1" } });
    // A fresh process, in the new place.
    expect(t.adapter.processesOf(id).map((process) => process.stopped)).toEqual([true, false]);
  });

  it("carries the session's auto memory from its old key to the new one, leaving the old", async () => {
    const t = await start();
    const client = await t.client();
    const path = directory();
    const { id } = await create(client, { workspace: { kind: "directory", path } });
    const root = join(t.dataDir, "auto-memory");
    const old = join(root, autoMemoryName({ workspace: { kind: "directory", path }, repositoryIdentity: null }));
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "MEMORY.md"), "- The receipts sweep runs hourly.\n");
    await lose(client, id, path);
    const moved = repository("https://github.com/david/agent-harness.git");

    expect((await setWorkspace(client, id, { kind: "directory", path: moved })).receipt).toMatchObject({ status: "accepted" });

    const carried = join(root, autoMemoryName({ workspace: { kind: "directory", path: moved }, repositoryIdentity: "https://github.com/david/agent-harness" }));
    await vi.waitFor(() => expect(readFileSync(join(carried, "MEMORY.md"), "utf8")).toContain("The receipts sweep runs hourly."), { timeout: WAIT_MS });
    expect(readFileSync(join(old, "MEMORY.md"), "utf8")).toBe("- The receipts sweep runs hourly.\n");
  });
});
