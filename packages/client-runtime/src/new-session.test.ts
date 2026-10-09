import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import type { WorkspaceRequest } from "@agent-harness/contracts";
import type { ModelOption } from "../../environment/src/adapter/contract.js";
import { fakeAdapter, signedInAs, usageOf, usageWindow, type FakeAdapter } from "../../environment/test/fake-adapter.js";
import { grantReader, holds, useHarness } from "../test/harness.js";
import { pickerFixtures } from "../test/picker.js";
import { uuidv4 } from "./ids.js";
import type { NewSessionChips, NewSessionContext, NewSessionView } from "./projections/new-session.js";
import type { Runtime } from "./runtime.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";

/**
 * Starting a session begins with where (workspace-picker spec, "The picker
 * in the client runtime"; ADR 0005; #333): `projections.newSession` and
 * `commands.startSession`, through the primary seam: a runtime paired with
 * two in-process environments over a real WebSocket, sessions made in real
 * git repositories and plain directories of the test's own, one environment
 * made unreachable or disabled where a case needs it; no network, no forge.
 */

const harness = useHarness();
const { directory, repository, twoEnvironments, create } = pickerFixtures(harness);

/** The harness's own repository on the forge, over https with the web server's port. */
const FORGE = { origin: "https://git.systemtech.dev:5526/david/agent-harness" };
/** The identity every spelling of it comes down to. */
const IDENTITY = "https://git.systemtech.dev/david/agent-harness";
/** Another repository, and its identity. */
const SHOP = "https://github.com/x/moon-gems";
const SHOP_IDENTITY = "https://github.com/x/moon-gems";

/** The card's answer for `context` once `condition` holds, followed for the rest of the test so what it reads stays fetched. */
const card = (runtime: Runtime, context: NewSessionContext, condition: (view: NewSessionView) => boolean = () => true): Promise<NewSessionView> => {
  const view = runtime.projections.newSession(context);
  onTestFinished(view.subscribe(() => undefined));
  return holds(view, condition);
};

/** Who each account is signed in as; an account not named is signed out. */
const LOGINS: Readonly<Record<string, string>> = {
  "desk-max": "max@example.com",
  "desk-david": "david@example.com",
  "laptop-david": "david@example.com",
};

/** An adapter whose accounts sign in as `LOGINS` says, their plan usage read as the same login, offering `models` (the fake's opus, sonnet and haiku without). */
const signingIn = (models?: readonly ModelOption[]): FakeAdapter =>
  fakeAdapter({
    status: (account) => signedInAs(LOGINS[account.id] ?? null),
    usage: (account, now) => usageOf(LOGINS[account.id] ?? `${account.id}@example.com`, [usageWindow("five_hour", 0.25, "2026-09-24T05:00:00.000Z")], now),
    ...(models !== undefined && { models }),
  });

/** Desk holding max's login and david's; laptop holding milo's account, signed out, and david's login, and offering no sonnet. */
const withAccounts = () => {
  const desk = signingIn();
  const laptop = signingIn([
    { id: "opus", family: "opus", tier: 3, efforts: [] },
    { id: "haiku", family: "haiku", tier: 1, efforts: [] },
  ]);
  const accounts = (adapter: FakeAdapter, ids: readonly string[]) => ids.map((id) => ({ id, provider: adapter.descriptor.provider }));
  return twoEnvironments({
    desk: { adapter: desk, accounts: accounts(desk, ["desk-max", "desk-david"]) },
    laptop: { adapter: laptop, accounts: accounts(laptop, ["laptop-milo", "laptop-david"]) },
  });
};

/** The account and model chips have read what they read: an account and its model are preset. */
const presetAccountAndModel = (view: NewSessionView) => view.account.value !== null && view.model.value !== null;

/** Each environment the chip offers, by name, with why it is greyed (null when it is not). */
const offered = (view: NewSessionView) => view.environment.options.map((option) => [option.environment.name, option.unusable]);

describe("projections.newSession: the environment chip", () => {
  it("presets an environment heading's own environment over the last used, and offers every environment in the connection list's order", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    await runtime.connections.setLastUsed(desk.env.id);

    const view = await card(runtime, { focus: { kind: "environment", environmentId: laptop.env.id } });

    expect(view.environment).toMatchObject({ value: laptop.env.id, reason: "heading" });
    expect(offered(view)).toEqual([
      ["desk", null],
      ["laptop", null],
    ]);
  });

  it("presets the focused session's environment over the last used", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    const sessionId = await create(runtime, laptop, { kind: "scratch" });
    await runtime.connections.setLastUsed(desk.env.id);

    expect((await card(runtime, { focus: { kind: "session", environmentId: laptop.env.id, sessionId } })).environment).toMatchObject({ value: laptop.env.id, reason: "session" });
    expect((await card(runtime, { focus: { kind: "none" } })).environment).toMatchObject({ value: desk.env.id, reason: "last-used" });
  });

  it("presets a merged heading's primary environment when it holds a member group, else the environment of the heading's most recently active session", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    const server = await harness.environment({ name: "server" });
    await runtime.connections.add({ link: (await server.createPairing()).link });
    /** A session in the group `name` on `t`, made at that environment's time now. */
    const inGroup = async (t: typeof desk, name: string) => {
      const sessionId = await create(runtime, t, { kind: "scratch" });
      expect(await runtime.commands.moveToGroup(t.env.id, sessionId, name)).toMatchObject({ ok: true });
    };
    // Receipts on desk, the primary, and on laptop, whose session is the more recent.
    await inGroup(desk, "Receipts");
    laptop.clock.advance(60_000);
    await inGroup(laptop, "receipts");
    // Moon-Gems on laptop and on server, not on the primary; server's session the more recent.
    laptop.clock.advance(60_000);
    await inGroup(laptop, "Moon-Gems");
    server.clock.advance(180_000);
    await inGroup(server, "Moon-Gems");
    await runtime.connections.setLastUsed(desk.env.id);
    const heading = async (name: string) => {
      const list = await holds(runtime.projections.sessionList, (view) => view.groups.find((group) => group.name === name)?.groups.length === 2);
      return { kind: "group", key: list.groups.find((group) => group.name === name)?.key as string } as const;
    };

    expect((await card(runtime, { focus: await heading("Receipts") })).environment).toMatchObject({ value: desk.env.id, reason: "group" });
    expect((await card(runtime, { focus: await heading("Moon-Gems") })).environment).toMatchObject({ value: server.env.id, reason: "group" });

    // A session of laptop's in the heading becomes the most recently active.
    laptop.clock.advance(300_000);
    await inGroup(laptop, "moon-gems");
    expect((await card(runtime, { focus: await heading("Moon-Gems") })).environment).toMatchObject({ value: laptop.env.id, reason: "group" });
  });

  it("with a repository in focus presets an environment holding it: the last used among its holders, else the one with its most recent session", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    await create(runtime, desk, { kind: "directory", path: repository(FORGE) });
    laptop.clock.advance(60_000);
    // Another spelling of the same remote: the same identity.
    await create(runtime, laptop, { kind: "directory", path: repository({ origin: "git@git.systemtech.dev:david/agent-harness.git" }) });
    await create(runtime, desk, { kind: "directory", path: repository({ origin: SHOP }) });
    const focus = (repositoryIdentity: string) => ({ focus: { kind: "repository", repositoryIdentity } }) as const;

    // Nothing used yet: the holder whose session is the most recent.
    expect((await card(runtime, focus(IDENTITY))).environment).toMatchObject({ value: laptop.env.id, reason: "repository" });
    await runtime.connections.setLastUsed(desk.env.id);
    expect((await card(runtime, focus(IDENTITY))).environment).toMatchObject({ value: desk.env.id, reason: "repository" });
    // An environment without the repository is never preset for it, even last used.
    await runtime.connections.setLastUsed(laptop.env.id);
    expect((await card(runtime, focus(SHOP_IDENTITY))).environment).toMatchObject({ value: desk.env.id, reason: "repository" });
    // A repository no environment holds: the rest of the rule.
    expect((await card(runtime, focus("https://github.com/x/elsewhere"))).environment).toMatchObject({ value: laptop.env.id, reason: "last-used" });
  });

  it("else presets the last used, then this machine's environment, passing over one disabled", async () => {
    const desk = await harness.environment({ name: "desk" });
    const laptop = await harness.environment({ name: "laptop" });
    // Desk is this machine's: the runtime reads its grant. Laptop is paired, and put first.
    const runtime = harness.runtime(inMemoryPlatform({ grant: grantReader(desk) }));
    await runtime.start();
    await runtime.connections.add({ link: (await laptop.createPairing()).link });
    await runtime.connections.setOrder([laptop.env.id, desk.env.id]);
    const none = { focus: { kind: "none" } } as const;

    expect((await card(runtime, none)).environment).toMatchObject({ value: desk.env.id, reason: "local" });
    await runtime.connections.setLastUsed(laptop.env.id);
    expect((await card(runtime, none)).environment).toMatchObject({ value: laptop.env.id, reason: "last-used" });
    await runtime.connections.setEnabled(laptop.env.id, false);
    const passed = await card(runtime, none);
    expect(passed.environment).toMatchObject({ value: desk.env.id, reason: "local" });
    expect(offered(passed)).toEqual([
      ["laptop", "laptop is disabled on this client."],
      ["desk", null],
    ]);
  });

  it("else presets the first enabled environment in the connection list's order, and none when none is usable", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    const none = { focus: { kind: "none" } } as const;

    expect((await card(runtime, none)).environment).toMatchObject({ value: desk.env.id, reason: "first-enabled" });
    await runtime.connections.setOrder([laptop.env.id, desk.env.id]);
    expect((await card(runtime, none)).environment).toMatchObject({ value: laptop.env.id, reason: "first-enabled" });
    await runtime.connections.setEnabled(laptop.env.id, false);
    expect((await card(runtime, none)).environment).toMatchObject({ value: desk.env.id, reason: "first-enabled" });
    await runtime.connections.setEnabled(desk.env.id, false);
    const asks = await card(runtime, none);
    expect(asks.environment).toMatchObject({ value: null, reason: "none-usable" });
    expect(offered(asks)).toEqual([
      ["laptop", "laptop is disabled on this client."],
      ["desk", "desk is disabled on this client."],
    ]);
    // Nothing after it is preset either: the card asks where first.
    expect(asks).toMatchObject({ account: { value: null, reason: "none" }, model: { value: null, reason: "none" }, workspace: { value: null, reason: "none" } });
  });

  it("passes over an environment that cannot be reached at every step, offering it greyed with its reason", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    const sessionId = await create(runtime, desk, { kind: "directory", path: repository(FORGE) });
    await create(runtime, laptop, { kind: "directory", path: repository(FORGE) });
    await runtime.connections.setLastUsed(desk.env.id);
    await desk.close();
    await runtime.connections.retryNow(desk.env.id);

    // Desk's session still lists from what this client holds; runs cannot start there, so the repository's other holder is preset.
    const view = await card(runtime, { focus: { kind: "session", environmentId: desk.env.id, sessionId } });
    expect(view.environment).toMatchObject({ value: laptop.env.id, reason: "repository" });
    expect(offered(view)).toEqual([
      ["desk", "desk cannot be reached."],
      ["laptop", null],
    ]);
    expect((await card(runtime, { focus: { kind: "environment", environmentId: desk.env.id } })).environment).toMatchObject({ value: laptop.env.id, reason: "first-enabled" });
  });
});

describe("projections.newSession: the account and model chips", () => {
  it("preset the focused session's login on whichever environment has it, with its plan gauge pooled across environments, and its model where the account offers it", async () => {
    const { desk, laptop, runtime } = await withAccounts();
    const sessionId = await create(runtime, desk, { kind: "scratch" }, { account: "desk-david", model: "sonnet" });
    expect(await runtime.commands.dispatch(desk.env.id, "runs.start", { sessionId, text: "Fix the receipts" })).toMatchObject({ ok: true });
    await holds(runtime.projections.sessionList, (view) => view.rows.some((row) => row.summary.id === sessionId && row.summary.accountId === "desk-david" && row.summary.model === "sonnet"));
    const focus = { kind: "session", environmentId: desk.env.id, sessionId } as const;

    const here = await card(runtime, { focus }, presetAccountAndModel);
    expect(here.account).toMatchObject({ value: { id: "desk-david" }, reason: "session" });
    expect(here.model).toMatchObject({ value: { id: "sonnet" }, reason: "session" });

    // The environment chip moves: the same login there, and the account's default model, as it offers no sonnet.
    const pooled = (view: NewSessionView) => presetAccountAndModel(view) && view.account.gauge?.accounts.length === 2;
    const there = await card(runtime, { focus, chips: { environmentId: laptop.env.id } }, pooled);
    expect(there.environment).toMatchObject({ value: laptop.env.id, reason: "chosen" });
    expect(there.account).toMatchObject({ value: { id: "laptop-david" }, reason: "session" });
    expect(there.model).toMatchObject({ value: { id: "opus" }, reason: "default" });
    expect(there.account.options.map((account) => account.id)).toEqual(["laptop-milo", "laptop-david"]);
    expect(there.model.options.map((model) => model.id)).toEqual(["opus", "haiku"]);
    // One login on two environments is one gauge.
    expect(there.account.gauge).toMatchObject({
      identity: { email: "david@example.com" },
      accounts: [
        { environmentId: desk.env.id, accountId: "desk-david" },
        { environmentId: laptop.env.id, accountId: "laptop-david" },
      ],
    });
  });

  it("else preset the environment's default account, else its first signed-in one, and the account's default model", async () => {
    const { desk, laptop, runtime } = await withAccounts();
    const on = (t: typeof desk) => ({ focus: { kind: "environment", environmentId: t.env.id } }) as const;

    // Laptop's first account is signed out.
    const first = await card(runtime, on(laptop), presetAccountAndModel);
    expect(first.account).toMatchObject({ value: { id: "laptop-david" }, reason: "first-signed-in" });
    expect(first.model).toMatchObject({ value: { id: "opus" }, reason: "default" });
    expect((await card(runtime, on(desk), presetAccountAndModel)).account).toMatchObject({ value: { id: "desk-max" }, reason: "first-signed-in" });

    const values = { "accounts.defaultAccount": "desk-david", "accounts.defaultModelFamily": "sonnet" };
    expect(await runtime.requests.call(desk.env.id, "settings.update", { commandId: randomUUID(), values })).toMatchObject({ ok: true });
    const defaults = await card(runtime, on(desk), (view) => view.account.reason === "default" && view.model.value?.id === "sonnet");
    expect(defaults.account).toMatchObject({ value: { id: "desk-david" }, reason: "default" });
    expect(defaults.model).toMatchObject({ value: { id: "sonnet" }, reason: "default" });
  });

  it("keep a chosen account's login and a chosen model across a change of environment, where the new environment has them", async () => {
    const { desk, laptop, runtime } = await withAccounts();
    const chosen = (environmentId: string, accountId: string, model: string) =>
      ({ focus: { kind: "none" }, chips: { environmentId, account: { environmentId: desk.env.id, accountId }, model } }) as const;

    const own = await card(runtime, chosen(desk.env.id, "desk-max", "haiku"), presetAccountAndModel);
    expect(own.account).toMatchObject({ value: { id: "desk-max" }, reason: "chosen" });
    expect(own.model).toMatchObject({ value: { id: "haiku" }, reason: "chosen" });

    const kept = await card(runtime, chosen(laptop.env.id, "desk-david", "haiku"), presetAccountAndModel);
    expect(kept.account).toMatchObject({ value: { id: "laptop-david" }, reason: "kept" });
    expect(kept.model).toMatchObject({ value: { id: "haiku" }, reason: "chosen" });

    // Laptop has neither max's login nor sonnet: the presets run again.
    const lacking = await card(runtime, chosen(laptop.env.id, "desk-max", "sonnet"), presetAccountAndModel);
    expect(lacking.account).toMatchObject({ value: { id: "laptop-david" }, reason: "first-signed-in" });
    expect(lacking.model).toMatchObject({ value: { id: "opus" }, reason: "default" });
  });
});

describe("projections.newSession: the effort chip", () => {
  it("presets accounts.defaultEffort where the model takes it, else the model's own, and holds an effort chosen for the model, its own among them (#1950)", async () => {
    const { desk, runtime } = await withAccounts();
    const on = (chips: NewSessionChips = {}) => ({ focus: { kind: "environment", environmentId: desk.env.id }, chips }) as const;

    expect((await card(runtime, on(), presetAccountAndModel)).effort).toEqual({ value: null, reason: "own" });
    expect(await runtime.requests.call(desk.env.id, "settings.update", { commandId: randomUUID(), values: { "accounts.defaultEffort": "high" } })).toMatchObject({ ok: true });
    expect((await card(runtime, on(), (view) => view.effort.reason === "default")).effort).toEqual({ value: "high", reason: "default" });
    // The fake's haiku takes no effort; its sonnet takes no max.
    expect((await card(runtime, on({ model: "haiku" }), presetAccountAndModel)).effort).toEqual({ value: null, reason: "own" });
    expect((await card(runtime, on({ model: "sonnet", effort: "max" }), presetAccountAndModel)).effort).toEqual({ value: "high", reason: "default" });
    expect((await card(runtime, on({ model: "opus", effort: "max" }), presetAccountAndModel)).effort).toEqual({ value: "max", reason: "chosen" });
    expect((await card(runtime, on({ model: "opus", effort: null }), presetAccountAndModel)).effort).toEqual({ value: null, reason: "chosen" });
  });
});

describe("projections.newSession: the workspace chip", () => {
  it("presets the focused session's workspace while it is present, else a directory holding the repository in focus there, else the environment's most recent directory, else scratch", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    // Laptop has no directory yet.
    expect((await card(runtime, { focus: { kind: "environment", environmentId: laptop.env.id } })).workspace).toMatchObject({ value: { kind: "scratch" }, reason: "scratch" });

    const deskClone = repository(FORGE);
    const sessionId = await create(runtime, desk, { kind: "directory", path: deskClone });
    const laptopClone = repository({ origin: "ssh://git@git.systemtech.dev:2222/david/agent-harness.git" });
    await create(runtime, laptop, { kind: "directory", path: laptopClone });
    // Each environment's most recently used directory holds no repository.
    desk.clock.advance(60_000);
    laptop.clock.advance(60_000);
    const deskPlain = directory();
    const laptopPlain = directory();
    await create(runtime, desk, { kind: "directory", path: deskPlain });
    await create(runtime, laptop, { kind: "directory", path: laptopPlain });
    const focus = { kind: "session", environmentId: desk.env.id, sessionId } as const;

    // The focused session's environment: a session request, sharing its workspace.
    const shared = await card(runtime, { focus });
    expect(shared.workspace).toMatchObject({ value: { kind: "session", sessionId }, reason: "session" });
    expect(shared.workspace.options.map((known) => known.path)).toEqual([deskPlain, deskClone]);
    // The environment chip moved: the focused session's repository there, over a more recent directory.
    expect((await card(runtime, { focus, chips: { environmentId: laptop.env.id } })).workspace).toMatchObject({
      value: { kind: "directory", path: laptopClone },
      reason: "repository",
    });
    // A repository heading.
    expect((await card(runtime, { focus: { kind: "repository", repositoryIdentity: IDENTITY }, chips: { environmentId: desk.env.id } })).workspace).toMatchObject({
      value: { kind: "directory", path: deskClone },
      reason: "repository",
    });
    // Nothing in focus.
    expect((await card(runtime, { focus: { kind: "environment", environmentId: desk.env.id } })).workspace).toMatchObject({
      value: { kind: "directory", path: deskPlain },
      reason: "recent",
    });

    // The focused session's directory goes: a run is refused, and the session is marked missing.
    rmSync(deskClone, { recursive: true, force: true });
    expect(await runtime.commands.dispatch(desk.env.id, "runs.start", { sessionId, text: "Fix the receipts" })).toMatchObject({ ok: false, error: { data: { reason: "workspace_missing" } } });
    await holds(runtime.projections.sessionList, (view) => view.rows.some((row) => row.summary.id === sessionId && row.summary.workspaceMissingSince !== null));
    // Neither it nor its gone directory is preset.
    expect((await card(runtime, { focus })).workspace).toMatchObject({ value: { kind: "directory", path: deskPlain }, reason: "recent" });
  });

  it("keeps a chosen workspace's repository, or scratch, across a change of environment", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    const deskClone = repository(FORGE);
    const deskPlain = directory();
    await create(runtime, desk, { kind: "directory", path: deskClone });
    await create(runtime, desk, { kind: "directory", path: deskPlain });
    const laptopClone = repository({ origin: "https://git.systemtech.dev/david/agent-harness.git" });
    await create(runtime, laptop, { kind: "directory", path: laptopClone });
    laptop.clock.advance(60_000);
    const laptopPlain = directory();
    await create(runtime, laptop, { kind: "directory", path: laptopPlain });
    const chosen = (environmentId: string, request: WorkspaceRequest) =>
      ({ focus: { kind: "none" }, chips: { environmentId, workspace: { environmentId: desk.env.id, request } } }) as const;
    const worktree: WorkspaceRequest = { kind: "worktree", repository: deskClone, newBranch: { name: "receipts" } };

    expect((await card(runtime, chosen(desk.env.id, worktree))).workspace).toMatchObject({ value: worktree, reason: "chosen" });
    expect((await card(runtime, chosen(laptop.env.id, worktree))).workspace).toMatchObject({ value: { kind: "directory", path: laptopClone }, reason: "kept" });
    expect((await card(runtime, chosen(laptop.env.id, { kind: "directory", path: deskClone }))).workspace).toMatchObject({
      value: { kind: "directory", path: laptopClone },
      reason: "kept",
    });
    expect((await card(runtime, chosen(laptop.env.id, { kind: "scratch" }))).workspace).toMatchObject({ value: { kind: "scratch" }, reason: "kept" });
    // A directory in no repository is not kept: the presets run again.
    expect((await card(runtime, chosen(laptop.env.id, { kind: "directory", path: deskPlain }))).workspace).toMatchObject({
      value: { kind: "directory", path: laptopPlain },
      reason: "recent",
    });
  });
});

describe("commands.startSession", () => {
  it("creates the group a focused merged heading lacks on the environment first, then the session in it, then notes the environment last used", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    const first = await create(runtime, desk, { kind: "scratch" });
    expect(await runtime.commands.moveToGroup(desk.env.id, first, "Receipts")).toMatchObject({ ok: true });
    await runtime.connections.setLastUsed(desk.env.id);
    const clone = repository(FORGE);

    const started = await runtime.commands.startSession(laptop.env.id, { workspace: { kind: "directory", path: clone }, account: "claude-max", model: "haiku", groupName: "Receipts" });

    expect(started.answer).toMatchObject({ ok: true, result: { summary: { id: started.sessionId, workspace: { kind: "directory", path: clone }, repositoryIdentity: IDENTITY } } });
    const list = await holds(runtime.projections.sessionList, (view) => view.rows.some((row) => row.summary.id === started.sessionId));
    // Laptop gained its own group of the heading's name, and the session is in it: one heading across both environments.
    expect(list.rows.find((row) => row.summary.id === started.sessionId)).toMatchObject({ environmentId: laptop.env.id, groupName: "Receipts" });
    expect(list.groups.map((heading) => [heading.name, heading.groups.map((member) => member.environmentId)])).toEqual([["Receipts", [desk.env.id, laptop.env.id]]]);
    expect(runtime.preferences.read()["environments.lastUsed"]).toBe(laptop.env.id);

    // A heading the environment has, however its name is cased: no second group.
    const again = await runtime.commands.startSession(desk.env.id, { workspace: { kind: "session", sessionId: first }, groupName: "receipts" });
    expect(again.answer).toMatchObject({ ok: true });
    const after = await holds(runtime.projections.sessionList, (view) => view.rows.some((row) => row.summary.id === again.sessionId));
    expect(after.rows.find((row) => row.summary.id === again.sessionId)).toMatchObject({ environmentId: desk.env.id, groupName: "Receipts" });
    expect(after.groups.map((heading) => heading.groups.length)).toEqual([2]);
    expect(runtime.preferences.read()["environments.lastUsed"]).toBe(desk.env.id);
  });

  it("answers a refused create with its problem, and leaves the last used as it was", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    await runtime.connections.setLastUsed(desk.env.id);
    const gone = directory();
    rmSync(gone, { recursive: true, force: true });

    const refused = await runtime.commands.startSession(laptop.env.id, { workspace: { kind: "directory", path: gone } });

    expect(refused.answer).toMatchObject({ ok: false, error: { code: "conflict", data: { reason: "workspace_unusable", problem: "does_not_exist", path: gone } } });
    expect(runtime.projections.sessionList.read().rows.some((row) => row.summary.id === refused.sessionId)).toBe(false);
    expect(runtime.preferences.read()["environments.lastUsed"]).toBe(desk.env.id);
  });

  it("starts the session under the id the renderer minted, so a new worktree branch is the preset name it showed, and a refused create leaves the id for the next", async () => {
    const { desk, runtime } = await twoEnvironments();
    const clone = repository(FORGE);
    const gone = directory();
    rmSync(gone, { recursive: true, force: true });
    const id = uuidv4();

    const refused = await runtime.commands.startSession(desk.env.id, { id, workspace: { kind: "directory", path: gone } });
    expect(refused).toMatchObject({ sessionId: id, answer: { ok: false, error: { data: { problem: "does_not_exist" } } } });

    const started = await runtime.commands.startSession(desk.env.id, { id, workspace: { kind: "worktree", repository: clone, newBranch: {} } });

    expect(started.sessionId).toBe(id);
    expect(started.answer).toMatchObject({ ok: true, result: { summary: { id, workspace: { kind: "worktree", repository: clone, branch: `agent-harness/${id.slice(0, 8)}` } } } });
  });
});
