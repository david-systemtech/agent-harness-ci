import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TITLE, registry, type EventFrame, type ParamsOf, type SessionCreatedPayload, type SessionSummary } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { snapshotOf } from "../../test/accounts.js";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, gate, type FakeAdapterOptions } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, refusal } from "../../test/sessions.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";
import type { ProviderSessionInfo } from "../adapter/contract.js";
import type { EventEnvelope } from "../event-log/event-log.js";

/**
 * Carry over's session import (setup spec, "2. Carry over"; ADR 0021; #578)
 * through the primary seam: an in-process environment with a real client
 * over a real WebSocket, and the fake adapter listing the sessions of a
 * fixture adopted directory as the test scripts them. The directory is the
 * preset account's, `claude-max`, adopted in place.
 */

const { onCleanup, tempDir } = useCleanups();

const ACCOUNT = "claude-max";
const IDENTITY = "https://git.systemtech.dev/david/agent-harness";
const BEGAN = "2026-08-01T09:00:00.000Z";
/** The memory part of a report on a directory that holds none. */
const NO_MEMORY = { folders: [], unmappable: [] };
const WRITTEN = "2026-08-03T17:30:00.000Z";

/** An adopted provider directory as it stands on disk: a login, and a transcript in a project folder. */
const adoptedDirectory = (): string => {
  const directory = join(tempDir(), ".fake");
  mkdirSync(join(directory, "projects", "-work-repo"), { recursive: true });
  writeFileSync(join(directory, ".credentials.json"), '{"claudeAiOauth":"never read by the harness"}', { mode: 0o600 });
  writeFileSync(join(directory, "projects", "-work-repo", `${randomUUID()}.jsonl`), '{"type":"user"}\n');
  return directory;
};

/** A git checkout whose origin is the harness's own repository. */
const checkout = (): string => {
  const path = tempDir();
  git(path, "init", "-q");
  git(path, "remote", "add", "origin", `${IDENTITY}.git`);
  return path;
};

/** A session as the adapter lists it: fresh ids and a plain directory, unless the test says otherwise. */
const listed = (fields: Partial<ProviderSessionInfo> = {}): ProviderSessionInfo => ({
  providerSessionId: randomUUID(),
  customTitle: null,
  summary: null,
  firstPrompt: null,
  workingDirectory: tempDir(),
  tag: null,
  createdAt: BEGAN,
  lastModified: WRITTEN,
  ...fields,
});

interface Start extends Omit<TestEnvironmentOptions, "adapter"> {
  readonly fake?: FakeAdapterOptions;
}

/** An environment whose preset account adopts a fixture directory, which the fake lists as `sessions`. */
const start = async (sessions: FakeAdapterOptions["sessions"], options: Start = {}) => {
  const directory = adoptedDirectory();
  const { fake, ...rest } = options;
  // With no Set up step, whose Carry over check lists the adopted directory as the environment starts and on each import (#581).
  const t = await startTestEnvironment({
    setupSteps: NO_SETUP_STEPS,
    ...rest,
    adapter: fakeAdapter({ ambientDirectory: directory, ...(sessions !== undefined && { sessions }), ...fake }),
  });
  onCleanup(() => t.close());
  return { t, directory };
};

type RunParams = Omit<ParamsOf<"carryOver.run">, "commandId">;

/** Runs an import of the preset account's directory, not dry unless asked, with a fresh command id. */
const run = async (client: WireClient, params: Partial<RunParams> = {}) =>
  registry["carryOver.run"].response.parse(
    await client.request("carryOver.run", { commandId: randomUUID(), accountId: ACCOUNT, dryRun: false, skills: false, ...params }),
  );

/** The `session.created` events of imported sessions, in the order they were appended. */
const imports = (t: TestEnvironment): EventEnvelope[] =>
  t.env.log.readStream({ kinds: ["session"] }).filter((event) => event.type === "session.created" && (event.payload as SessionCreatedPayload).origin?.kind === "import");

/** The summary of the session imported from the provider session `providerSessionId`. */
const summaryOf = async (t: TestEnvironment, client: WireClient, providerSessionId: string): Promise<SessionSummary> => {
  const created = imports(t).find((event) => (event.payload as SessionCreatedPayload).origin?.providerSessionId === providerSessionId);
  if (created === undefined) throw new Error(`Nothing imported the provider session ${providerSessionId}.`);
  return (await client.request("sessions.get", { sessionId: created.streamId })).summary;
};

/** Settles once the session's run has ended: listened for on the log before the run starts, so no end is missed. */
const runEnded = (t: TestEnvironment, sessionId: string): Promise<void> =>
  new Promise((resolve) => {
    const stop = t.env.log.subscribe((event) => {
      if (event.streamId !== sessionId || event.type !== "run.ended") return;
      stop();
      resolve();
    });
  });

describe("carryOver.run", () => {
  it("imports every listed session as an imported session: its title, its workspace with the identity there, its times, and its provider session linked to the account", async () => {
    const repository = checkout();
    const plain = tempDir();
    const renamed = listed({ customTitle: "Fix the receipts", summary: "Receipts", firstPrompt: "The receipts are wrong", workingDirectory: repository });
    const summarised = listed({ summary: "Retention sweep", firstPrompt: "Write the sweep", workingDirectory: plain });
    const prompted = listed({ firstPrompt: "Look at the logs", workingDirectory: plain, createdAt: null });
    const { t } = await start([renamed, summarised, prompted]);
    const client = await t.client();

    const answer = await run(client);

    expect(answer.receipt).toMatchObject({ status: "accepted" });
    expect(answer.result).toEqual({
      accountId: ACCOUNT,
      dryRun: false,
      sessions: { listed: 3, imported: 3, archived: 0, missingDirectory: 0, held: 0 },
      memory: NO_MEMORY,
      failed: [],
    });
    const origin = (session: ProviderSessionInfo, createdAt = BEGAN) => ({ kind: "import", accountId: ACCOUNT, providerSessionId: session.providerSessionId, createdAt, lastActivityAt: WRITTEN });
    const created = (title: string, path: string, repositoryIdentity: string | null, session: ProviderSessionInfo, createdAt?: string) => ({
      actor: `client_session:${client.hello.clientSessionId}`,
      payload: { title, tags: [], groupId: null, workspace: { kind: "directory", path }, repositoryIdentity, account: ACCOUNT, model: null, mode: null, origin: origin(session, createdAt) },
    });
    expect(imports(t).map(({ actor, payload }) => ({ actor, payload }))).toEqual([
      created("Fix the receipts", repository, IDENTITY, renamed),
      created("Retention sweep", plain, null, summarised),
      // A listing with no created-at: the session began, as far as anyone can say, when it was last written.
      created("Look at the logs", plain, null, prompted, WRITTEN),
    ]);
    expect(await summaryOf(t, client, renamed.providerSessionId)).toMatchObject({
      title: "Fix the receipts",
      createdAt: BEGAN,
      lastActivityAt: WRITTEN,
      workspace: { kind: "directory", path: repository },
      repositoryIdentity: IDENTITY,
      archivedAt: null,
      workspaceMissingSince: null,
      activity: { state: "idle", since: WRITTEN },
    });
  });

  it("titles a session on one line, cut to a title's 200 characters with an ellipsis, and leaves one with no text to the default", async () => {
    const long = listed({ customTitle: "   ", summary: `Refactor\n\n  the ${"receipts ".repeat(40)}`, firstPrompt: "Unused" });
    const blank = listed({ customTitle: "", summary: " ", firstPrompt: null });
    const { t } = await start([long, blank]);
    const client = await t.client();
    await run(client);

    const titled = await summaryOf(t, client, long.providerSessionId);
    expect(titled.title).toHaveLength(200);
    expect(titled.title).toMatch(/^Refactor the (?:receipts ){20}receip…$/);
    expect(await summaryOf(t, client, blank.providerSessionId)).toMatchObject({ title: DEFAULT_TITLE, titleSource: "default" });
  });

  it("imports archived, at its last-modified time, a session tagged archived and one the provider's scheduler began, and no other", async () => {
    const tagged = listed({ summary: "Old work", tag: "archived" });
    const fired = listed({ summary: "Nightly check", firstPrompt: '<scheduled-task name="nightly" file="/home/david/.claude/scheduled/nightly.md">\nRun the nightly check' });
    const quoted = listed({ summary: "About the scheduler", firstPrompt: 'Why does <scheduled-task name="nightly"> fire twice?', tag: "later" });
    const { t } = await start([tagged, fired, quoted]);
    const client = await t.client();

    expect((await run(client)).result?.sessions).toEqual({ listed: 3, imported: 3, archived: 2, missingDirectory: 0, held: 0 });

    for (const session of [tagged, fired]) {
      const created = imports(t).find((event) => (event.payload as SessionCreatedPayload).origin?.providerSessionId === session.providerSessionId);
      const stream = t.env.log.readStream({ kind: "session", id: created?.streamId ?? "" });
      expect(stream.map(({ type, payload, actor }) => ({ type, payload, actor }))).toEqual([
        expect.objectContaining({ type: "session.created" }),
        { type: "session.archived", payload: { archivedAt: WRITTEN }, actor: `client_session:${client.hello.clientSessionId}` },
      ]);
      expect(await summaryOf(t, client, session.providerSessionId)).toMatchObject({ archivedAt: WRITTEN });
    }
    expect(await summaryOf(t, client, quoted.providerSessionId)).toMatchObject({ archivedAt: null });
  });

  it("marks a session whose working directory is gone missing, right after its session.created, and records it with no identity", async () => {
    const gone = join(tempDir(), "deleted-since");
    const lost = listed({ summary: "In a folder since deleted", workingDirectory: gone });
    const lostArchived = listed({ summary: "Archived, and gone", workingDirectory: gone, tag: "archived" });
    const { t } = await start([lost, lostArchived]);
    const client = await t.client();

    expect((await run(client)).result?.sessions).toEqual({ listed: 2, imported: 2, archived: 1, missingDirectory: 2, held: 0 });

    const created = imports(t).find((event) => (event.payload as SessionCreatedPayload).origin?.providerSessionId === lostArchived.providerSessionId);
    const stream = t.env.log.readStream({ kind: "session", id: created?.streamId ?? "" });
    expect(stream.map(({ type, sequence }) => ({ type, sequence }))).toEqual([
      { type: "session.created", sequence: created?.sequence },
      { type: "session.workspace-status-changed", sequence: (created?.sequence ?? 0) + 1 },
      { type: "session.archived", sequence: (created?.sequence ?? 0) + 2 },
    ]);
    expect(stream[1]).toMatchObject({ actor: "system:workspaces", payload: { status: "missing" } });
    const summary = await summaryOf(t, client, lost.providerSessionId);
    expect(summary).toMatchObject({ workspace: { kind: "directory", path: gone }, repositoryIdentity: null, workspaceMissingSince: expect.any(String) });
    // It lists and opens, and runs nothing until it is given a workspace (#328).
    expect(
      await client.request("runs.start", { commandId: randomUUID(), sessionId: summary.id, text: "Go on" }).then((answer) => answer.receipt),
    ).toMatchObject({ status: "rejected", error: { data: { reason: "workspace_missing", path: gone } } });
  });

  it("imports a provider session listed twice once, as it was last written", async () => {
    const earlier = listed({ summary: "As first listed", lastModified: "2026-08-02T08:00:00.000Z" });
    const later = { ...earlier, summary: "As last written", lastModified: WRITTEN };
    // The listing's order is newest first, as the SDK's is; the latest is kept whatever the order.
    const { t } = await start([later, earlier]);
    const client = await t.client();

    expect((await run(client)).result?.sessions).toEqual({ listed: 1, imported: 1, archived: 0, missingDirectory: 0, held: 0 });
    expect(imports(t)).toHaveLength(1);
    expect(await summaryOf(t, client, earlier.providerSessionId)).toMatchObject({ title: "As last written", lastActivityAt: WRITTEN });
  });

  it("imports again only what the environment does not hold: what an earlier import brought in and what a harness run was linked to are left alone", async () => {
    const first = listed({ summary: "Imported the first time" });
    const continued = listed({ summary: "A harness run went on with it" });
    const appeared = listed({ summary: "Appeared since" });
    const listing: ProviderSessionInfo[] = [first];
    const { t } = await start(() => listing);
    const client = await t.client();
    expect((await run(client)).result?.sessions).toEqual({ listed: 1, imported: 1, archived: 0, missingDirectory: 0, held: 0 });
    // A harness session whose run the provider linked to a session of the directory: a run continued it there.
    t.adapter.nextScripts.push(() => [{ type: "session.provider-linked", payload: { providerSessionId: continued.providerSessionId } }, end()]);
    const { id } = await create(client, { account: ACCOUNT });
    const ended = runEnded(t, id);
    await client.apply("runs.start", { commandId: randomUUID(), sessionId: id, text: "Go on with it" });
    await ended;
    listing.push(continued, appeared);

    const again = await run(client);

    expect(again.result?.sessions).toEqual({ listed: 3, imported: 1, archived: 0, missingDirectory: 0, held: 2 });
    expect(imports(t).map((event) => (event.payload as SessionCreatedPayload).origin?.providerSessionId)).toEqual([first.providerSessionId, appeared.providerSessionId]);
  });

  it("answers a dry run with the report the import then makes, having written nothing", async () => {
    const sessions = [listed({ summary: "Kept" }), listed({ summary: "Archived", tag: "archived" }), listed({ summary: "Gone", workingDirectory: join(tempDir(), "gone") })];
    const { t } = await start(sessions);
    const client = await t.client();
    const head = t.env.log.head();

    const dry = await run(client, { dryRun: true });

    const counts = { listed: 3, imported: 3, archived: 1, missingDirectory: 1, held: 0 };
    expect(dry.result).toEqual({ accountId: ACCOUNT, dryRun: true, sessions: counts, memory: NO_MEMORY, failed: [] });
    expect(t.env.log.head()).toBe(head);
    expect((await run(client)).result).toEqual({ accountId: ACCOUNT, dryRun: false, sessions: counts, memory: NO_MEMORY, failed: [] });
    expect(imports(t)).toHaveLength(3);
  });

  it("ends with carry-over.imported on the environment stream as the client session that ran it, which environment.subscribe delivers", async () => {
    const sessions = [listed({ summary: "One" }), listed({ summary: "Two", tag: "archived" })];
    const { t } = await start(sessions);
    const client = await t.client();
    const watcher = await t.client();
    const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    await watcher.next((frame) => frame.type === "synchronized" && "subscription" in frame && frame.subscription === subscription);
    const commandId = randomUUID();

    await client.request("carryOver.run", { commandId, accountId: ACCOUNT, dryRun: false, skills: false });

    const report = { accountId: ACCOUNT, sessions: { listed: 2, imported: 2, archived: 1, missingDirectory: 0, held: 0 }, memory: NO_MEMORY, failed: [] };
    const frame = await watcher.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === "carry-over.imported");
    expect(frame.event).toMatchObject({ streamKind: "environment", type: "carry-over.imported", payload: report, commandId, actor: { kind: "client_session", id: client.hello.clientSessionId } });
    // In the transaction of what it imported: the sessions' events come just before it.
    expect(frame.event.sequence).toBe(t.env.log.head());
    expect(Math.max(...imports(t).map((event) => event.sequence))).toBeLessThan(frame.event.sequence);
  });
});

describe("an import that fails part way", () => {
  it("records each session it could not import, with why, and keeps the rest", async () => {
    const kept = listed({ summary: "Imports" });
    const foreign = listed({ summary: "Ran on another machine", workingDirectory: "C:relative\\work" });
    const { t } = await start([kept, foreign]);
    const client = await t.client();

    const answer = await run(client);

    const failed = [{ providerSessionId: foreign.providerSessionId, message: "Its working directory C:relative\\work is not an absolute path on this environment." }];
    expect(answer.result).toEqual({ accountId: ACCOUNT, dryRun: false, sessions: { listed: 2, imported: 1, archived: 0, missingDirectory: 0, held: 0 }, memory: NO_MEMORY, failed });
    expect(t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "carry-over.imported").map((event) => event.payload)).toEqual([
      { accountId: ACCOUNT, sessions: answer.result?.sessions, memory: NO_MEMORY, failed },
    ]);
    expect(imports(t).map((event) => (event.payload as SessionCreatedPayload).origin?.providerSessionId)).toEqual([kept.providerSessionId]);
    // A re-run tries it again; what was imported stays as it is.
    expect((await run(client)).result).toMatchObject({ sessions: { imported: 0, held: 1 }, failed });
  });

  it("records a directory it could not list as what failed, importing nothing", async () => {
    const { t, directory } = await start(() => {
      throw new Error("EACCES: permission denied, scandir");
    });
    const client = await t.client();

    const answer = await run(client);

    const failed = [{ providerSessionId: null, message: `Listing the sessions in ${directory} failed: EACCES: permission denied, scandir` }];
    const nothing = { listed: 0, imported: 0, archived: 0, missingDirectory: 0, held: 0 };
    expect(answer.result).toEqual({ accountId: ACCOUNT, dryRun: false, sessions: nothing, memory: NO_MEMORY, failed });
    expect(t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "carry-over.imported").map((event) => event.payload)).toEqual([
      { accountId: ACCOUNT, sessions: nothing, memory: NO_MEMORY, failed },
    ]);
    expect(await refusal(client.request("carryOver.inventory", { accountId: ACCOUNT }))).toEqual({ code: "internal", data: {} });
  });
});

describe("the adopted directory", () => {
  it("has nothing created, linked or deleted in it by an inventory, a dry run or an import", async () => {
    const { t, directory } = await start([listed({ summary: "One" }), listed({ summary: "Two", tag: "archived" }), listed({ workingDirectory: join(tempDir(), "gone") })]);
    const client = await t.client();
    const before = snapshotOf(directory);

    await client.request("carryOver.inventory", { accountId: ACCOUNT });
    await run(client, { dryRun: true });
    expect((await run(client)).result?.sessions).toMatchObject({ imported: 3 });

    expect(snapshotOf(directory)).toEqual(before);
    expect(t.adapter.sessionListings.map((account) => account.directory)).toEqual([directory, directory, directory]);
  });
});

describe("carryOver.inventory", () => {
  it("counts the listed sessions, each provider session once: every one, the archived, those whose directory is gone, and those new since the last import", async () => {
    const gone = join(tempDir(), "gone");
    const plain = listed({ summary: "Plain" });
    const tagged = listed({ summary: "Tagged", tag: "archived" });
    const fired = listed({ summary: "Fired", firstPrompt: "<scheduled-task name=\"hourly\">\nCheck" });
    const lost = listed({ summary: "Lost", workingDirectory: gone });
    const listing: ProviderSessionInfo[] = [plain, tagged, fired, lost, { ...lost, lastModified: BEGAN }];
    const { t } = await start(() => listing);
    const client = await t.client();

    expect(await client.request("carryOver.inventory", { accountId: ACCOUNT })).toMatchObject({ accountId: ACCOUNT, sessions: { total: 4, archived: 2, missingDirectory: 1, new: 4 } });
    await run(client);
    listing.push(listed({ summary: "Appeared since" }));
    expect(await client.request("carryOver.inventory", { accountId: ACCOUNT })).toMatchObject({ accountId: ACCOUNT, sessions: { total: 5, archived: 2, missingDirectory: 1, new: 1 } });
  });
});

describe("carryOver.run's refusals", () => {
  // Each refusal's words name no account id: it is in the data, which a client's Details show (setup-copy.md §5.3; #1844).
  it("refuses an account the environment does not hold, not_found", async () => {
    const { t } = await start([listed()]);
    const client = await t.client();
    expect((await run(client, { accountId: "someone-else" })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "not_found", message: "This account is not on this computer.", data: { kind: "account", accountId: "someone-else" } },
    });
    expect(await refusal(client.request("carryOver.inventory", { accountId: "someone-else" }))).toEqual({ code: "not_found", data: { kind: "account", accountId: "someone-else" } });
  });

  it("refuses an account whose directory the environment owns, not_adopted, and lists nothing", async () => {
    const { t } = await start([listed()]);
    const client = await t.client();
    const added = await client.apply("accounts.add", { commandId: randomUUID(), label: "Work" });

    expect((await run(client, { accountId: added.account.id })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", message: "This account has no Claude Code folder to bring over.", data: { reason: "not_adopted", accountId: added.account.id } },
    });
    expect(await refusal(client.request("carryOver.inventory", { accountId: added.account.id }))).toEqual({
      code: "conflict",
      data: { reason: "not_adopted", accountId: added.account.id },
    });
    expect(t.adapter.sessionListings).toEqual([]);
  });

  it("refuses a second import of the account while one is under way, import_in_progress, and takes one once it has ended", async () => {
    const opened = gate();
    const slow = listed({ summary: "Slow to list" });
    const { t } = await start(async () => {
      await opened.opened;
      return [slow];
    });
    const client = await t.client();
    const first = run(client);
    await vi.waitFor(() => expect(t.adapter.sessionListings).toHaveLength(1), { timeout: WAIT_MS });

    expect((await run(client, { dryRun: true })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", message: "Bringing over past work is under way already. Wait for it to finish.", data: { reason: "import_in_progress", accountId: ACCOUNT } },
    });
    opened.open();
    expect((await first).result?.sessions).toMatchObject({ imported: 1 });
    expect((await run(client)).result?.sessions).toMatchObject({ imported: 0, held: 1 });
  });

  it("refuses an adapter that cannot list its sessions, unsupported", async () => {
    const { t } = await start(undefined);
    const client = await t.client();
    expect(await refusal(run(client))).toEqual({
      code: "invalid_params",
      data: expect.objectContaining({ reason: "unsupported", capability: "sessionListing", provider: "fake" }),
    });
    expect(await refusal(client.request("carryOver.inventory", { accountId: ACCOUNT }))).toMatchObject({ code: "invalid_params", data: { capability: "sessionListing" } });
  });
});
