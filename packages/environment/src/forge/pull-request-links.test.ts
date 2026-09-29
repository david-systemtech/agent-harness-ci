import { randomUUID } from "node:crypto";
import type { EventEnvelope, EventFrame, PullRequest, ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, say, type Script } from "../../test/fake-adapter.js";
import { MERGED_OR_CLOSED_AT, startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added, rejection } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { command, create, get, listStream, patchOf } from "../../test/sessions.js";
import { updateSettings } from "../../test/shelf.js";
import { git } from "../../test/workspaces.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * A session's pull requests (#317; forge spec, "Pull-request links and
 * status"; ADR 0012) through the primary seam: an in-process environment
 * with the scripted fake forge, whose pull requests are read by number and
 * listed by head per token, the fake adapter's runs, real git repositories
 * with a branch and an upstream, and the manual clock. What was linked is
 * seen in the summary a client reads and the session's events; what was
 * read in the fake forge's record of what it was asked.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const fakeForge = async (): Promise<FakeForge> => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  return forge;
};

/** An environment whose fake forge answers the test's token as David, with a Forgejo forge account on it, and a client. */
const withAccount = async (options: TestEnvironmentOptions = {}) => {
  const forge = await fakeForge();
  forge.user(TOKEN, DAVID);
  const t = await start({ forgeFetch: forge.fetch, ...options });
  const client = await t.client();
  const account = await added(client, { url: forge.origin, kind: "forgejo" });
  return { t, forge, client, account };
};

const link = (client: WireClient, sessionId: string, url: string): Promise<ResponseOf<"forge.pullRequests.link">> =>
  client.request("forge.pullRequests.link", { commandId: randomUUID(), sessionId, url });

const unlink = (client: WireClient, sessionId: string, url: string): Promise<ResponseOf<"forge.pullRequests.unlink">> =>
  client.request("forge.pullRequests.unlink", { commandId: randomUUID(), sessionId, url });

/** A pull request as a session keeps it. */
const pull = (url: string, state: PullRequest["state"] = "open", times: Partial<Pick<PullRequest, "mergedAt" | "closedAt">> = {}): PullRequest => ({
  url,
  state,
  mergedAt: times.mergedAt ?? null,
  closedAt: times.closedAt ?? null,
});

/**
 * A repository in a temporary directory with one commit on `main` and
 * `remotes` by name, checked out on `branch`, whose upstream is the branch
 * `upstream` names when it names one.
 */
const repositoryOn = (remotes: Readonly<Record<string, string>>, branch: string, upstream?: { readonly remote: string; readonly branch: string }): string => {
  const directory = tempDir("agent-harness-pull-requests-");
  git(directory, "init", "--quiet");
  git(directory, "commit", "--quiet", "--allow-empty", "-m", "first");
  for (const [name, url] of Object.entries(remotes)) git(directory, "remote", "add", name, url);
  if (branch !== "main") git(directory, "checkout", "--quiet", "-b", branch);
  if (upstream !== undefined) {
    git(directory, "config", `branch.${branch}.remote`, upstream.remote);
    git(directory, "config", `branch.${branch}.merge`, `refs/heads/${upstream.branch}`);
  }
  return directory;
};

/** A tool call the run makes, and what it answered: `output`, whose strings a run's end reads. */
const toolCall = (output: unknown) => {
  const toolCallId = `toolu_${randomUUID()}`;
  return [
    { type: "tool.started", payload: { toolCallId, name: "Bash", input: { command: "tea pulls" }, title: null, agentId: null, parentToolCallId: null } },
    { type: "tool.ended", payload: { toolCallId, status: "ok", output, durationMs: 5 } },
  ] as const;
};

/** Runs the session once to its end as the fake adapter's next script plays it (preset: its reply), then waits for what the end found to be appended. */
const runToEnd = async (t: TestEnvironment, client: WireClient, sessionId: string, script?: Script): Promise<void> => {
  if (script !== undefined) t.adapter.nextScripts.push(script);
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence: t.env.log.head() });
  await client.apply("runs.start", { commandId: randomUUID(), sessionId, text: "Open the pull request" });
  await client.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "run.ended");
  await t.env.forge.links.idle();
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Moves the environment's clock on by `ms`, then waits for the reads its timers began to end. */
const after = async (t: TestEnvironment, ms: number): Promise<void> => {
  t.clock.advance(ms);
  await t.env.forge.links.idle();
};

/** How many times the fake forge was asked for the pull request `number` of `david/bank` by number. */
const readsOf = (forge: FakeForge, number: number): number => forge.requests.filter((request) => request.path === `/api/v1/repos/david/bank/pulls/${number}`).length;

/** The session's pull-request events a client reads on `sessions.subscribeSession` after `afterSequence`, up to where it is synchronized. */
const pullRequestEvents = async (client: WireClient, sessionId: string, afterSequence = 0): Promise<EventEnvelope[]> => {
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence });
  const events: EventEnvelope[] = [];
  for (;;) {
    const frame = await client.next((f) => "subscription" in f && f.subscription === subscription && (f.type === "event" || f.type === "synchronized"));
    if (frame.type === "synchronized") return events.filter((event) => event.type.startsWith("session.pull-request-"));
    events.push((frame as EventFrame).event);
  }
};

describe("forge.pullRequests.link", () => {
  it("links a pull request by any page of its URL, read with the forge account serving its origin, as the linking client session", async () => {
    const { forge, client } = await withAccount();
    forge.pullRequest(TOKEN, "david/bank", 3);
    const { id } = await create(client);
    const asked = forge.requests.length;

    const answer = await link(client, id, `${forge.origin}/david/bank/pulls/3/files?style=split#diff`);

    const url = `${forge.origin}/david/bank/pulls/3`;
    expect(answer.receipt.status).toBe("accepted");
    expect(answer.result?.summary.pullRequests).toEqual([pull(url)]);
    expect(forge.requests.slice(asked).map((request) => [request.method, request.path, request.scheme])).toEqual([["GET", "/api/v1/repos/david/bank/pulls/3", "token"]]);
    const events = await pullRequestEvents(client, id);
    expect(events.map((event) => [event.type, event.payload, event.actor])).toEqual([
      ["session.pull-request-linked", pull(url), { kind: "client_session", id: client.hello.clientSessionId }],
    ]);
  });

  it("reads a pull request anonymously on an origin no forge account serves, GitHub's shape as GitHub Enterprise's, and keeps it on that origin", async () => {
    const { forge, client } = await withAccount();
    const other = await fakeForge();
    other.pullRequest(null, "someone/tool", 12);
    const { id } = await create(client);

    const answer = await link(client, id, `${other.origin}/someone/tool/pull/12#issuecomment-1`);

    expect(answer.result?.summary.pullRequests).toEqual([pull(`${other.origin}/someone/tool/pull/12`)]);
    expect(other.requests.map((request) => [request.path, request.scheme])).toEqual([["/api/v3/repos/someone/tool/pulls/12", null]]);
    expect(forge.requests.filter((request) => request.path.includes("/pulls/"))).toEqual([]);
  });

  it("changes nothing when the pull request is linked already as the forge answers it, and links its new state as the client session when it is not", async () => {
    const { forge, client } = await withAccount();
    forge.pullRequest(TOKEN, "david/bank", 3);
    const { id } = await create(client);
    const url = `${forge.origin}/david/bank/pulls/3`;
    await link(client, id, url);

    const again = await link(client, id, `${url}/files`);
    expect(again.receipt).toMatchObject({ status: "accepted", changed: false });
    forge.pullRequest(TOKEN, "david/bank", 3, { state: "closed" });
    const closed = await link(client, id, url);
    expect(closed.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(closed.result?.summary.pullRequests).toEqual([pull(url, "closed", { closedAt: "2026-09-24T00:00:30.000Z" })]);
    expect((await pullRequestEvents(client, id)).map((event) => event.type)).toEqual(["session.pull-request-linked", "session.pull-request-linked"]);
  });

  it("refuses a URL no provider reads as a pull request not_a_pull_request, naming its origin, before anything is asked", async () => {
    const { forge, client } = await withAccount();
    const { id } = await create(client);
    const asked = forge.requests.length;

    const onGitHubShape = await link(client, id, `${forge.origin}/david/bank/pull/3`);
    expect(rejection(onGitHubShape.receipt)).toMatchObject({ reason: "not_a_pull_request", data: { origin: forge.origin } });
    const anIssue = await link(client, id, `${forge.origin}/david/bank/issues/3`);
    expect(rejection(anIssue.receipt)).toMatchObject({ reason: "not_a_pull_request", data: { origin: forge.origin } });
    const noForge = await link(client, id, "pull request 3");
    expect(rejection(noForge.receipt)).toMatchObject({ reason: "not_a_pull_request", data: { origin: null } });
    expect(forge.requests.length).toBe(asked);
  });

  it("refuses a pull request the forge does not have not_found, a refused anonymous read forge_account_missing, and a forge that does not answer unreachable, linking nothing", async () => {
    const { forge, client } = await withAccount();
    const other = await fakeForge();
    const { id } = await create(client);
    forge.answer(TOKEN, "GET /api/v1/repos/david/bank/pulls/4", { status: 404, body: { message: "Not Found" } });
    forge.answer(TOKEN, "GET /api/v1/repos/david/bank/pulls/5", { status: 403, body: { message: "token does not have at least one of required scope(s)" } });

    const missing = await link(client, id, `${forge.origin}/david/bank/pulls/4`);
    expect(rejection(missing.receipt)).toMatchObject({ reason: "not_found", data: { kind: "pull_request", url: `${forge.origin}/david/bank/pulls/4` } });
    const denied = await link(client, id, `${forge.origin}/david/bank/pulls/5`);
    expect(rejection(denied.receipt)).toMatchObject({ reason: "verification_failed", data: { origin: forge.origin, status: 403 } });
    const anonymous = await link(client, id, `${other.origin}/someone/private/pulls/1`);
    expect(rejection(anonymous.receipt)).toMatchObject({ reason: "forge_account_missing", data: { origin: other.origin, step: "forges" } });
    await other.close();
    const gone = await link(client, id, `${other.origin}/someone/private/pulls/1`);
    expect(rejection(gone.receipt)).toMatchObject({ reason: "unreachable", data: { origin: other.origin } });
    expect(await pullRequestEvents(client, id)).toEqual([]);
  });

  it("refuses a session that is not on the environment not_found, asking the forge nothing", async () => {
    const { forge, client } = await withAccount();
    forge.pullRequest(TOKEN, "david/bank", 3);
    const asked = forge.requests.length;

    const answer = await link(client, randomUUID(), `${forge.origin}/david/bank/pulls/3`);
    expect(rejection(answer.receipt)).toMatchObject({ reason: "not_found", data: { kind: "session" } });
    expect(forge.requests.length).toBe(asked);
  });
});

describe("forge.pullRequests.unlink", () => {
  it("unlinks the linked pull request any page of its URL names, as the client session, and changes nothing for one not linked", async () => {
    const { forge, client } = await withAccount();
    forge.pullRequest(TOKEN, "david/bank", 3);
    forge.pullRequest(TOKEN, "david/bank", 4);
    const { id } = await create(client);
    const [third, fourth] = [`${forge.origin}/david/bank/pulls/3`, `${forge.origin}/david/bank/pulls/4`];
    await link(client, id, third);
    await link(client, id, fourth);
    const from = (await pullRequestEvents(client, id)).at(-1)?.sequence ?? 0;

    const answer = await unlink(client, id, `${forge.origin}/David/Bank/pulls/3/files`);
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(answer.result?.summary.pullRequests).toEqual([pull(fourth)]);
    const none = await unlink(client, id, `${forge.origin}/david/bank/pulls/5`);
    expect(none.receipt).toMatchObject({ status: "accepted", changed: false });
    expect(none.result?.summary.pullRequests).toEqual([pull(fourth)]);

    const events = await pullRequestEvents(client, id, from);
    expect(events.map((event) => [event.type, event.payload, event.actor])).toEqual([
      ["session.pull-request-unlinked", { url: third }, { kind: "client_session", id: client.hello.clientSessionId }],
    ]);
  });

  it("refuses a session that is not on the environment not_found", async () => {
    const { forge, client } = await withAccount();
    const answer = await unlink(client, randomUUID(), `${forge.origin}/david/bank/pulls/3`);
    expect(rejection(answer.receipt)).toMatchObject({ reason: "not_found", data: { kind: "session" } });
  });
});

describe("the summary's pullRequests", () => {
  it("follows a link, a sync and an unlink over sessions.subscribe, each patch naming the list as it is", async () => {
    const { t, forge, client } = await withAccount();
    forge.pullRequest(TOKEN, "david/bank", 3);
    const { id } = await create(client);
    const url = `${forge.origin}/david/bank/pulls/3`;
    const list = await listStream(client, t.env.log.head());

    await link(client, id, url);
    const linked = await list.next();
    expect([linked.type, patchOf(linked)]).toEqual(["session.pull-request-linked", { op: "set", sessionId: id, fields: { pullRequests: [pull(url)] } }]);

    forge.pullRequest(TOKEN, "david/bank", 3, { state: "merged" });
    expect(await client.request("forge.pullRequests.refresh", { sessionId: id })).toEqual({
      pullRequests: [pull(url, "merged", { mergedAt: "2026-09-24T00:00:30.000Z", closedAt: "2026-09-24T00:00:30.000Z" })],
    });
    const synced = await list.next();
    expect([synced.type, synced.actor, patchOf(synced)]).toEqual([
      "session.pull-request-synced",
      { kind: "system", id: "forge" },
      { op: "set", sessionId: id, fields: { pullRequests: [pull(url, "merged", { mergedAt: "2026-09-24T00:00:30.000Z", closedAt: "2026-09-24T00:00:30.000Z" })] } },
    ]);

    await unlink(client, id, url);
    const unlinked = await list.next();
    expect([unlinked.type, patchOf(unlinked)]).toEqual(["session.pull-request-unlinked", { op: "set", sessionId: id, fields: { pullRequests: [] } }]);
  });
});

describe("at a run's end", () => {
  it("links the pull requests from the workspace's branch on origin, open, or closed or merged since the session was created, as system:forge", async () => {
    const { t, forge, client } = await withAccount();
    forge.repository(TOKEN, "david/bank");
    forge.pullRequest(TOKEN, "david/bank", 4, { state: "merged", mergedAt: "2026-09-23T12:00:00Z", closedAt: "2026-09-23T12:00:00Z" });
    forge.pullRequest(TOKEN, "david/bank", 5, { state: "closed" });
    forge.pullRequest(TOKEN, "david/bank", 6);
    forge.pullRequest(TOKEN, "david/bank", 7, { head: "other" });
    forge.pullRequest(TOKEN, "david/bank", 8, { headRepository: "someone/bank" });
    const repository = repositoryOn({ origin: `${forge.origin}/david/bank.git` }, "feature");
    const { id } = await create(client, { workspace: { kind: "directory", path: repository } });

    await runToEnd(t, client, id);

    const [open, closed] = [`${forge.origin}/david/bank/pulls/6`, `${forge.origin}/david/bank/pulls/5`];
    expect((await get(client, id)).pullRequests).toEqual([pull(open), pull(closed, "closed", { closedAt: new Date(MERGED_OR_CLOSED_AT).toISOString() })]);
    const events = await pullRequestEvents(client, id);
    expect(events.map((event) => [event.type, event.actor])).toEqual([
      ["session.pull-request-linked", { kind: "system", id: "forge" }],
      ["session.pull-request-linked", { kind: "system", id: "forge" }],
    ]);
  });

  it("links the pull-request URLs on an origin a forge account serves in the run's tool outputs and assistant text, the first twenty not linked yet, each read first", async () => {
    const { t, forge, client } = await withAccount();
    const other = await fakeForge();
    for (let number = 1; number <= 23; number++) forge.pullRequest(TOKEN, "david/bank", number);
    forge.answer(TOKEN, "GET /api/v1/repos/david/bank/pulls/2", { status: 404, body: { message: "Not Found" } });
    other.pullRequest(null, "someone/tool", 3);
    const { id } = await create(client);
    const on = (number: number) => `${forge.origin}/david/bank/pulls/${number}`;
    const from = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => first + index);
    await link(client, id, on(6));
    const asked = forge.requests.length;

    await runToEnd(t, client, id, () => [
      ...toolCall({ stdout: `${on(1)}\n${on(2)}\t${other.origin}/someone/tool/pulls/3\n${forge.origin}/david/bank/issues/9`, stderr: "" }),
      say(`Opened ${on(1)}/files, see (${on(4)}). And [#5](${on(5)}), beside ${on(6)}.`),
      ...toolCall([{ type: "text", text: from(7, 23).map(on).join(" ") }]),
      end(),
    ]);

    // Twenty candidates: 1, 2, 4, 5, then 7 to 22; 6 is linked already, read as one that has not merged; 23 is the twenty-first.
    const read = forge.requests.slice(asked).flatMap((request) => /\/pulls\/(\d+)$/.exec(request.path)?.[1] ?? []).map(Number);
    expect(read.filter((number) => number !== 6).sort((a, b) => a - b)).toEqual([1, 2, 4, 5, ...from(7, 22)]);
    expect(other.requests).toEqual([]);
    const linked = (await get(client, id)).pullRequests.map((pullRequest) => pullRequest.url);
    expect(linked).toEqual([on(6), on(1), on(4), on(5), ...from(7, 22).map(on)]);
    const events = await pullRequestEvents(client, id);
    expect(events.slice(1).every((event) => event.actor.kind === "system" && event.actor.id === "forge")).toBe(true);
  });

  it("never links again a pull request whose latest event is an unlink, and a person's link still does", async () => {
    const { t, forge, client } = await withAccount();
    forge.repository(TOKEN, "david/bank");
    forge.pullRequest(TOKEN, "david/bank", 6);
    forge.pullRequest(TOKEN, "david/bank", 7, { head: "other" });
    const repository = repositoryOn({ origin: `${forge.origin}/david/bank.git` }, "feature");
    const { id } = await create(client, { workspace: { kind: "directory", path: repository } });
    const [fromBranch, inText] = [`${forge.origin}/david/bank/pulls/6`, `${forge.origin}/david/bank/pulls/7`];
    const mentioning = () => [say(`Opened ${inText}.`), end()];
    await runToEnd(t, client, id, mentioning);
    expect((await get(client, id)).pullRequests.map((pullRequest) => pullRequest.url)).toEqual([fromBranch, inText]);

    await unlink(client, id, fromBranch);
    await unlink(client, id, inText);
    await runToEnd(t, client, id, mentioning);
    expect((await get(client, id)).pullRequests).toEqual([]);

    await link(client, id, fromBranch);
    await unlink(client, id, fromBranch);
    await link(client, id, fromBranch);
    await runToEnd(t, client, id, mentioning);
    expect((await get(client, id)).pullRequests.map((pullRequest) => pullRequest.url)).toEqual([fromBranch]);
  });

  it("looks on the upstream's remote for the upstream's branch, and finds nothing on the default branch, a detached head or an origin no forge account serves", async () => {
    const { t, forge, client } = await withAccount();
    const other = await fakeForge();
    forge.repository(TOKEN, "david/bank");
    forge.pullRequest(TOKEN, "david/bank", 9, { head: "feature-x" });
    forge.pullRequest(TOKEN, "david/bank", 10, { head: "main" });
    other.pullRequest(null, "someone/tool", 2, { head: "feature" });
    const tracking = repositoryOn({ origin: `${other.origin}/someone/tool.git`, mine: `${forge.origin}/david/bank.git` }, "feature", { remote: "mine", branch: "feature-x" });
    const onMain = repositoryOn({ origin: `${forge.origin}/david/bank.git` }, "main");
    const detached = repositoryOn({ origin: `${forge.origin}/david/bank.git` }, "feature-x");
    git(detached, "checkout", "--quiet", "--detach");
    const unserved = repositoryOn({ origin: `${other.origin}/someone/tool.git` }, "feature");
    const sessions = await Promise.all([tracking, onMain, detached, unserved].map(async (path) => (await create(client, { workspace: { kind: "directory", path } })).id));

    for (const id of sessions) await runToEnd(t, client, id);

    const linked = await Promise.all(sessions.map(async (id) => (await get(client, id)).pullRequests));
    expect(linked).toEqual([[pull(`${forge.origin}/david/bank/pulls/9`)], [], [], []]);
    expect(other.requests).toEqual([]);
  });
});

describe("the sync", () => {
  it("reads an open pull request every five minutes while its session is in the active list and hourly once it is not, appending only a change, and a merged one never again", async () => {
    const { t, forge, client } = await withAccount();
    forge.pullRequest(TOKEN, "david/bank", 3);
    const { id } = await create(client);
    const url = `${forge.origin}/david/bank/pulls/3`;
    await link(client, id, url);
    expect(readsOf(forge, 3)).toBe(1);

    await after(t, 4 * MINUTE + 59_000);
    expect(readsOf(forge, 3)).toBe(1);
    await after(t, 1000);
    expect(readsOf(forge, 3)).toBe(2);
    await after(t, 5 * MINUTE);
    expect(readsOf(forge, 3)).toBe(3);
    expect(await pullRequestEvents(client, id)).toHaveLength(1);

    // Pinned is in the active list; archived is not.
    await command(client, "sessions.pin", { sessionId: id });
    await after(t, 5 * MINUTE);
    expect(readsOf(forge, 3)).toBe(4);
    await command(client, "sessions.archive", { sessionId: id });
    await after(t, 55 * MINUTE);
    expect(readsOf(forge, 3)).toBe(4);
    forge.pullRequest(TOKEN, "david/bank", 3, { state: "merged", mergedAt: "2026-09-24T00:30:00Z", closedAt: "2026-09-24T00:30:00Z" });
    await after(t, 5 * MINUTE);
    expect(readsOf(forge, 3)).toBe(5);
    expect((await get(client, id)).pullRequests).toEqual([pull(url, "merged", { mergedAt: "2026-09-24T00:30:00.000Z", closedAt: "2026-09-24T00:30:00.000Z" })]);

    // Open on the archived session, it would be read an hour on.
    await after(t, 2 * HOUR);
    expect(readsOf(forge, 3)).toBe(5);
    expect((await pullRequestEvents(client, id)).map((event) => [event.type, event.actor])).toEqual([
      ["session.pull-request-linked", { kind: "client_session", id: client.hello.clientSessionId }],
      ["session.pull-request-synced", { kind: "system", id: "forge" }],
    ]);
  });

  it("reads a closed pull request daily for fourteen days after it closed, then no more", async () => {
    const { t, forge, client } = await withAccount();
    // Closed thirteen days before the clock's start: its fourteenth day is the first day after it.
    forge.pullRequest(TOKEN, "david/bank", 4, { state: "closed", closedAt: "2026-09-11T00:00:00Z" });
    const { id } = await create(client);
    await link(client, id, `${forge.origin}/david/bank/pulls/4`);

    await after(t, DAY - MINUTE);
    expect(readsOf(forge, 4)).toBe(1);
    await after(t, MINUTE);
    expect(readsOf(forge, 4)).toBe(2);
    await after(t, DAY);
    expect(readsOf(forge, 4)).toBe(2);
  });

  it("reads each pull request that has not merged at a run's end, a merged one never, and keeps the last state on a 404, which stops its reads until a refresh", async () => {
    const { t, forge, client } = await withAccount();
    forge.pullRequest(TOKEN, "david/bank", 5);
    forge.pullRequest(TOKEN, "david/bank", 6, { state: "closed" });
    forge.pullRequest(TOKEN, "david/bank", 7, { state: "merged" });
    const { id } = await create(client);
    for (const number of [5, 6, 7]) await link(client, id, `${forge.origin}/david/bank/pulls/${number}`);
    const held = (await get(client, id)).pullRequests;

    await runToEnd(t, client, id);
    expect([5, 6, 7].map((number) => readsOf(forge, number))).toEqual([2, 2, 1]);

    forge.answer(TOKEN, "GET /api/v1/repos/david/bank/pulls/5", { status: 404, body: { message: "Not Found" } });
    await after(t, 5 * MINUTE);
    expect(readsOf(forge, 5)).toBe(3);
    await after(t, HOUR);
    await runToEnd(t, client, id);
    expect(readsOf(forge, 5)).toBe(3);
    expect((await get(client, id)).pullRequests).toEqual(held);

    // A refresh reads it again, and its reads go on from there.
    forge.pullRequest(TOKEN, "david/bank", 5);
    expect(await client.request("forge.pullRequests.refresh", { sessionId: id })).toEqual({ pullRequests: held });
    expect(readsOf(forge, 5)).toBe(4);
    await after(t, 5 * MINUTE);
    expect(readsOf(forge, 5)).toBe(5);
  });

  it("settles a session with auto-settle on merge once the pull request its run's end found merges on the forge", async () => {
    const { t, forge, client } = await withAccount();
    await updateSettings(client, { "sessions.autoSettleAfterIdle": null, "sessions.autoSettleOnMerge": true });
    forge.repository(TOKEN, "david/bank");
    forge.pullRequest(TOKEN, "david/bank", 6);
    const repository = repositoryOn({ origin: `${forge.origin}/david/bank.git` }, "feature");
    const { id } = await create(client, { workspace: { kind: "directory", path: repository } });
    await runToEnd(t, client, id);
    expect((await get(client, id)).pullRequests).toEqual([pull(`${forge.origin}/david/bank/pulls/6`)]);

    await after(t, 10 * MINUTE);
    expect((await get(client, id)).settledAt).toBeNull();
    forge.pullRequest(TOKEN, "david/bank", 6, { state: "merged", mergedAt: "2026-09-24T00:12:00Z", closedAt: "2026-09-24T00:12:00Z" });
    await after(t, 5 * MINUTE);
    expect((await get(client, id)).pullRequests[0]?.state).toBe("merged");
    await after(t, 5 * MINUTE);
    expect(await get(client, id)).toMatchObject({ settledBy: "auto-merge", settledAt: "2026-09-24T00:20:00.000Z" });
  });
});

