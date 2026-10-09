import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  registry,
  type AccountRecord,
  type AccountUpdatedPayload,
  type AuthStatus,
  type EventFrame,
  type ParamsOf,
  type ResponseOf,
  type ResultOf,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { snapshotOf } from "../../test/accounts.js";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { end, fakeAdapter, say, signedInAs, type FakeAdapter, type FakeAdapterOptions } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, refusal, workspace } from "../../test/sessions.js";
import { updateSettings } from "../../test/shelf.js";
import { scriptedSignIn } from "../../test/signin.js";
import type { WireClient } from "../../test/wire-client.js";
import type { EventEnvelope } from "../event-log/event-log.js";
import { ACCOUNTS_DIRECTORY, STATUS_READ_INTERVAL_MS } from "./account-service.js";

/**
 * The account store through the primary seam (claude-adapter spec, "The
 * account store" and "Testing Decisions"; ADR 0018): an in-process
 * environment with the fake adapter's status probe scripted per directory,
 * a real client over a real WebSocket, and the manual clock for the
 * fifteen-minute rule. Adopt, add, relabel, the duplicate-identity refusal,
 * remove with and without its directory, status reads, the notices, the
 * identity cross-check against a run, the models and commands queries and
 * the Account step's settings keys.
 */

const { onCleanup, tempDir } = useCleanups();

const DAVID = "david@example.com";

interface Start extends Omit<TestEnvironmentOptions, "adapter"> {
  readonly fake?: FakeAdapterOptions;
}

/** An environment with no account unless told otherwise: the tests adopt and add their own. */
const start = async (options: Start = {}): Promise<TestEnvironment> => {
  const { fake, ...rest } = options;
  const t = await startTestEnvironment({ accounts: [], ...rest, adapter: fakeAdapter(fake) });
  onCleanup(() => t.close());
  return t;
};

/**
 * The machine's own directory for the fake provider, as a signed-in Claude
 * Code directory looks: a login, settings, a transcript in a project folder.
 */
const makeAmbient = (): string => {
  const directory = join(tempDir(), ".fake");
  mkdirSync(join(directory, "projects", "-work-repo"), { recursive: true });
  writeFileSync(join(directory, ".credentials.json"), '{"claudeAiOauth":"never read by the harness"}', { mode: 0o600 });
  writeFileSync(join(directory, "settings.json"), '{"theme":"dark"}\n');
  writeFileSync(join(directory, "projects", "-work-repo", "a1b2.jsonl"), '{"type":"user"}\n');
  return directory;
};

/** A status probe that says `ambient` is signed in as David, and every other account as `<id>@example.com`, unless `emails` names its directory. */
const statusBy =
  (ambient: string | null, emails: Record<string, string | null> = {}) =>
  (account: { readonly id: string; readonly directory: string | null }): AuthStatus => {
    if (account.directory !== null && account.directory in emails) return signedInAs(emails[account.directory] ?? null);
    if (account.directory === ambient) return signedInAs(DAVID);
    return signedInAs(`${account.id}@example.com`);
  };

/** Every symbolic link under `root`. */
const linksUnder = (root: string): string[] => {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) found.push(path);
      else if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return found;
};

type AccountCommand = "accounts.adopt" | "accounts.add" | "accounts.relabel" | "accounts.remove";

/** Sends an account command with a fresh command id; resolves with its response, checked against its schema. */
const command = async <N extends AccountCommand>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

/** Applies an account command, throwing unless it was accepted with a result. */
const applied = async <N extends AccountCommand>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResultOf<N>> => {
  const answer = (await command(client, method, params)) as { readonly receipt: unknown; readonly result?: ResultOf<N> };
  if (answer.result === undefined) throw new Error(`${method} was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result;
};

/** The account events in the log, as type and payload. */
const accountEvents = (t: TestEnvironment, accountId?: string) =>
  t.env.log
    .readStream({ kinds: ["account"] })
    .filter((event) => accountId === undefined || event.streamId === accountId)
    .map((event) => ({ type: event.type, payload: event.payload }));

/** The `account.updated` notices on the environment's stream, in order. */
const notices = (t: TestEnvironment): AccountUpdatedPayload[] =>
  t.env.log
    .readStream({ kind: "environment", id: t.env.id })
    .filter((event) => event.type === "account.updated")
    .map((event) => event.payload as AccountUpdatedPayload);

const list = async (client: WireClient): Promise<AccountRecord[]> => (await client.request("accounts.list", {})).accounts;

/** Adopts the ambient directory, probed first as the Account step does. */
const adoptAmbient = async (client: WireClient, label?: string) => {
  await client.request("accounts.probe", {});
  return (await applied(client, "accounts.adopt", label === undefined ? {} : { label })).account;
};

/** Starts a run on the session, with the model and effort `asked` names; throws unless it was accepted. */
const startRun = async (client: WireClient, sessionId: string, asked: { readonly model?: string; readonly effort?: string | null } = {}): Promise<void> => {
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Go", ...asked }));
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
};

/** The status reads of the account whose directory is `directory`. */
const readsOf = (adapter: FakeAdapter, directory: string): number => adapter.statusReads.filter((ref) => ref.directory === directory).length;

describe("accounts.probe", () => {
  it("reports whether the machine's own directory is there and signed in, and as whom", async () => {
    const ambient = makeAmbient();
    const t = await start({ fake: { ambientDirectory: ambient, status: statusBy(ambient) } });
    const client = await t.client();
    expect(await client.request("accounts.probe", {})).toEqual({
      provider: "fake",
      directory: ambient,
      present: true,
      signedIn: true,
      identity: { provider: "fake", email: DAVID, organisation: null },
      accountId: null,
      detail: null,
      checkedAt: MANUAL_CLOCK_START,
    });
    t.adapter.setStatus(() => signedInAs(null));
    expect(await client.request("accounts.probe", {})).toMatchObject({ present: true, signedIn: false, identity: null });
  });

  it("reports a directory that is not there without reading its status, since a read may create what it names", async () => {
    const missing = join(tempDir(), "never-made");
    const t = await start({ fake: { ambientDirectory: missing } });
    const client = await t.client();
    expect(await client.request("accounts.probe", {})).toMatchObject({ directory: missing, present: false, signedIn: false, identity: null });
    expect(readsOf(t.adapter, missing)).toBe(0);
    expect(existsSync(missing)).toBe(false);
  });
});

describe("accounts.adopt", () => {
  it("registers the machine's own directory in place, labelled with its email, signed in, and never moves, links or deletes anything in it", async () => {
    const ambient = makeAmbient();
    const before = snapshotOf(ambient);
    const t = await start({ fake: { ambientDirectory: ambient, status: statusBy(ambient) } });
    const client = await t.client();
    const account = await adoptAmbient(client);
    expect(account).toEqual({
      id: expect.any(String),
      provider: "fake",
      label: DAVID,
      directory: { kind: "adopted", path: ambient },
      identity: { provider: "fake", email: DAVID, organisation: null },
      status: { state: "signed-in", checkedAt: MANUAL_CLOCK_START, detail: null },
      createdAt: MANUAL_CLOCK_START,
    });
    expect(accountEvents(t)).toEqual([
      { type: "account.adopted", payload: { accountId: account.id, provider: "fake", label: DAVID, directory: ambient } },
      { type: "account.identity-set", payload: { accountId: account.id, identity: account.identity } },
      { type: "account.status-changed", payload: { accountId: account.id, status: "signed-in", previous: "signed-out", detail: null } },
    ]);
    expect(await list(client)).toEqual([account]);
    expect(await client.request("accounts.probe", {})).toMatchObject({ accountId: account.id });

    // A run on it gets the directory itself; relabelled, then removed with the directory kept, the directory is as it was.
    const { id } = await create(client, { account: account.id });
    await startRun(client, id);
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(1));
    // Handed its label too, for what a person reads of the run (#229: a run's error names the account by it).
    expect(t.adapter.lastRun().input.account).toEqual({ id: account.id, directory: ambient, label: account.label });
    await applied(client, "accounts.relabel", { accountId: account.id, label: "Personal" });
    const refused = await command(client, "accounts.remove", { accountId: account.id, deleteDirectory: true });
    expect(refused.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "adopted_directory", accountId: account.id } } });
    expect(await applied(client, "accounts.remove", { accountId: account.id })).toEqual({ accountId: account.id, directoryDeleted: false });
    expect(snapshotOf(ambient)).toEqual(before);
    expect(linksUnder(t.dataDir)).toEqual([]);
    expect(existsSync(join(t.dataDir, ACCOUNTS_DIRECTORY))).toBe(false);
  });

  it("takes a label of its own, and refuses the directory twice or an identity another account holds, already added as its label", async () => {
    const ambient = makeAmbient();
    const t = await start({ fake: { ambientDirectory: ambient, status: statusBy(ambient) } });
    const client = await t.client();
    const account = await adoptAmbient(client, "Personal");
    expect(account.label).toBe("Personal");
    const again = await command(client, "accounts.adopt", {});
    expect(again.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "already_added", accountId: account.id } } });
    // setup-copy.md §5.1: the holder by its label, with no path or id in the line.
    expect(again.receipt.status === "rejected" && again.receipt.error.message).toBe("This sign-in is already used by Personal.");
    expect(accountEvents(t)).toHaveLength(3);
  });

  it("refuses the directory unless its latest read found it there and signed in, conflict ambient_unavailable", async () => {
    const ambient = makeAmbient();
    const t = await start({ fake: { ambientDirectory: ambient, status: statusBy(ambient) } });
    const client = await t.client();
    t.adapter.setStatus(() => signedInAs(null));
    await client.request("accounts.probe", {});
    const signedOut = await command(client, "accounts.adopt", {});
    expect(signedOut.receipt).toMatchObject({ status: "rejected", error: { data: { reason: "ambient_unavailable" } } });
    // setup-copy.md §5.1: no method to call and no path in the line; the directory is the refusal's data.
    expect(signedOut.receipt.status === "rejected" && signedOut.receipt.error).toMatchObject({
      message: "Claude Code on this computer is not signed in. Sign in with Claude instead.",
      data: { reason: "ambient_unavailable", directory: ambient },
    });
    expect(accountEvents(t)).toEqual([]);
  });

  it("refuses a sign-in with no email when no label is given, conflict no_email, its folder in the data", async () => {
    const ambient = makeAmbient();
    const t = await start({ fake: { ambientDirectory: ambient, status: statusBy(ambient) } });
    const client = await t.client();
    t.adapter.setStatus(() => ({ ...signedInAs(DAVID), email: null }));
    await client.request("accounts.probe", {});
    const unnamed = await command(client, "accounts.adopt", {});
    // setup-copy.md §5.1: an account store refusal like its siblings, so a client says its line rather than a generic one.
    expect(unnamed.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { message: "This sign-in has no email to name the account by. Enter a name.", data: { reason: "no_email", directory: ambient } } });
    expect(accountEvents(t)).toEqual([]);
    expect((await applied(client, "accounts.adopt", { label: "Home" })).account.label).toBe("Home");
  });

  it("refuses a label another account holds, ignoring case, conflict label_taken", async () => {
    const ambient = makeAmbient();
    const t = await start({ fake: { ambientDirectory: ambient, status: statusBy(ambient) } });
    const client = await t.client();
    const owned = (await applied(client, "accounts.add", { label: "DAVID@example.com" })).account;
    await client.request("accounts.probe", {});
    const taken = await command(client, "accounts.adopt", {});
    expect(taken.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { message: "Another account is already called david@example.com. Choose another name.", data: { reason: "label_taken", accountId: owned.id } } });
  });
});

describe("accounts.add", () => {
  it("makes an owned directory under the data directory, private to its owner, and says when its provider cannot sign in from the environment", async () => {
    const t = await start();
    const client = await t.client();
    const { account, signIn } = await applied(client, "accounts.add", { label: "Work" });
    const directory = join(t.dataDir, ACCOUNTS_DIRECTORY, account.id);
    expect(account).toEqual({
      id: expect.any(String),
      provider: "fake",
      label: "Work",
      directory: { kind: "owned", path: directory },
      identity: null,
      status: { state: "signed-out", checkedAt: null, detail: null },
      createdAt: MANUAL_CLOCK_START,
    });
    expect(statSync(directory).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(statSync(directory).mode & 0o777).toBe(0o700);
    // The fake provider has no sign-in program (the director's own tests run a Claude one): the message names the directory.
    // This pins the director's wording for an unavailable provider (`signin-director.ts`); change both together.
    expect(signIn).toEqual({ started: false, message: expect.stringContaining("not available for the fake provider") });
    expect(signIn.message).toContain(directory);
    expect(accountEvents(t)).toEqual([{ type: "account.added", payload: { accountId: account.id, provider: "fake", label: "Work", directory } }]);
    expect(notices(t)).toEqual([{ accountId: account.id, change: "added", warning: null }]);
  });

  it("starts a sign-in through the director, and records the identity the sign-in yields", async () => {
    const signIn = scriptedSignIn();
    const t = await start({ signIn: signIn.factory });
    const client = await t.client();
    const added = await applied(client, "accounts.add", { label: "Work" });
    expect(added.signIn).toEqual({ started: true, message: null });
    expect(signIn.started.map((account) => account.id)).toEqual([added.account.id]);
    t.adapter.setStatus(statusBy(null, { [added.account.directory.path]: "work@example.com" }));
    const outcome = await signIn.finish(added.account.id);
    expect(outcome).toMatchObject({ signedIn: true, account: { identity: { email: "work@example.com" }, status: { state: "signed-in" } } });
    expect(accountEvents(t, added.account.id).map((event) => event.type)).toEqual(["account.added", "account.identity-set", "account.status-changed"]);
    expect(notices(t).map((notice) => notice.change)).toEqual(["added", "status-changed"]);
  });

  it("refuses a sign-in that yields an identity another account holds, already added as its label, and deletes the new directory", async () => {
    const ambient = makeAmbient();
    const before = snapshotOf(ambient);
    const signIn = scriptedSignIn();
    const t = await start({ fake: { ambientDirectory: ambient, status: statusBy(ambient) }, signIn: signIn.factory });
    const client = await t.client();
    const adopted = await adoptAmbient(client);
    const added = (await applied(client, "accounts.add", { label: "Second" })).account;
    expect(existsSync(added.directory.path)).toBe(true);
    await updateSettings(client, { "credentials.injectionByAccount": { [added.id]: "deny" } });
    // The sign-in went to David's login again.
    t.adapter.setStatus(statusBy(ambient, { [added.directory.path]: DAVID }));
    const outcome = await signIn.finish(added.id);
    expect(outcome).toEqual({ signedIn: false, reason: "identity_held", message: `This sign-in is already used by ${DAVID}.` });
    expect(existsSync(added.directory.path)).toBe(false);
    expect((await list(client)).map((account) => account.id)).toEqual([adopted.id]);
    expect(accountEvents(t, added.id)).toEqual([
      { type: "account.added", payload: expect.objectContaining({ accountId: added.id }) },
      { type: "account.removed", payload: { accountId: added.id, reason: "duplicate-identity" } },
      { type: "account.directory-deleted", payload: { accountId: added.id, directory: added.directory.path } },
    ]);
    expect(notices(t).at(-1)).toEqual({ accountId: added.id, change: "removed", warning: expect.stringContaining(`already added as ${DAVID}`) });
    // Its injection entry goes with it (#367).
    expect(await client.request("settings.get", { keys: ["credentials.injectionByAccount"] })).toEqual({ values: { "credentials.injectionByAccount": {} } });
    expect(snapshotOf(ambient)).toEqual(before);
  });

  it("only warns when an account that has been signed in, with no identity read, later reads as an identity another account holds", async () => {
    const ambient = makeAmbient();
    const t = await start({ fake: { ambientDirectory: ambient, status: statusBy(ambient) } });
    const client = await t.client();
    const adopted = await adoptAmbient(client);
    const added = (await applied(client, "accounts.add", { label: "Second" })).account;
    // Signed in by hand, its status names no email: signed in, with no identity to hold.
    t.adapter.setStatus((ref) => (ref.directory === added.directory.path ? { ...signedInAs("unnamed@example.com"), email: null } : statusBy(ambient)(ref)));
    await client.request("accounts.refresh", { accountId: added.id });
    expect((await list(client)).find((account) => account.id === added.id)).toMatchObject({ identity: null, status: { state: "signed-in" } });
    // Then it reads as David's login, which the adopted account holds: it ran as signed in, so it is kept, and warned of.
    t.adapter.setStatus(statusBy(ambient, { [added.directory.path]: DAVID }));
    await client.request("accounts.refresh", { accountId: added.id });
    expect((await list(client)).map((account) => account.id)).toEqual([adopted.id, added.id]);
    expect(existsSync(added.directory.path)).toBe(true);
    expect(notices(t).at(-1)).toEqual({ accountId: added.id, change: "identity-mismatch", warning: expect.stringContaining(`already added as ${DAVID}`) });
  });

  it("only warns, and keeps the directory, when an account signed in once with no identity read has since expired and then reads as a held identity", async () => {
    const ambient = makeAmbient();
    const t = await start({ fake: { ambientDirectory: ambient, status: statusBy(ambient) } });
    const client = await t.client();
    const adopted = await adoptAmbient(client);
    const added = (await applied(client, "accounts.add", { label: "Second" })).account;
    const only = (status: AuthStatus) => (ref: { readonly id: string; readonly directory: string | null }) =>
      ref.directory === added.directory.path ? status : statusBy(ambient)(ref);
    t.adapter.setStatus(only({ ...signedInAs("unnamed@example.com"), email: null }));
    await client.request("accounts.refresh", { accountId: added.id });
    // It has run as signed in; now its login lapses, so the snapshot says neither signed in nor an identity.
    t.adapter.setStatus(only({ ...signedInAs(null), expired: true }));
    await client.request("accounts.refresh", { accountId: added.id });
    expect((await list(client)).find((account) => account.id === added.id)).toMatchObject({ identity: null, status: { state: "expired" } });
    t.adapter.setStatus(statusBy(ambient, { [added.directory.path]: DAVID }));
    await client.request("accounts.refresh", { accountId: added.id });
    expect((await list(client)).map((account) => account.id)).toEqual([adopted.id, added.id]);
    expect(existsSync(added.directory.path)).toBe(true);
    expect(accountEvents(t, added.id).map((event) => event.type)).not.toContain("account.removed");
    // Its status changed back to signed in by the same read, which the notice names, with the warning.
    expect(notices(t).at(-1)).toEqual({ accountId: added.id, change: "status-changed", warning: expect.stringContaining(`already added as ${DAVID}`) });
  });
});

describe("accounts.relabel", () => {
  it("preserves an explicitly chosen default-looking name, including a rename to the same name", async () => {
    const t = await start();
    const client = await t.client();
    const typed = (await applied(client, "accounts.add", { label: "Claude account 2" })).account;
    const automatic = (await applied(client, "accounts.add", { label: "Claude account", nameByEmail: true })).account;
    expect(automatic.nameByEmail).toBe(true);
    await applied(client, "accounts.relabel", { accountId: typed.id, label: "typed@example.test", onlyIfNameByEmail: true });
    expect((await list(client)).find(account => account.id === typed.id)?.label).toBe("Claude account 2");
    await applied(client, "accounts.relabel", { accountId: automatic.id, label: "Claude account" });
    await applied(client, "accounts.relabel", { accountId: automatic.id, label: "automatic@example.test", onlyIfNameByEmail: true });
    expect((await list(client)).find(account => account.id === automatic.id)?.label).toBe("Claude account");
    const fresh = (await applied(client, "accounts.add", { label: "Claude account 3", nameByEmail: true })).account;
    await applied(client, "accounts.relabel", { accountId: fresh.id, label: "fresh@example.test", onlyIfNameByEmail: true });
    expect((await list(client)).find(account => account.id === fresh.id)?.label).toBe("fresh@example.test");
    await client.request("environment.rebuildProjections", { commandId: randomUUID() });
    expect((await list(client)).find(account => account.id === automatic.id)?.nameByEmail).not.toBe(true);
  });

  it("changes the label, unique on the environment ignoring case, and changes nothing for the label it has", async () => {
    const t = await start();
    const client = await t.client();
    const work = (await applied(client, "accounts.add", { label: "Work" })).account;
    const home = (await applied(client, "accounts.add", { label: "Home" })).account;
    const taken = await command(client, "accounts.relabel", { accountId: home.id, label: "WORK" });
    expect(taken.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "label_taken", accountId: work.id } } });
    expect((await command(client, "accounts.add", { label: "home" })).receipt).toMatchObject({ status: "rejected", error: { data: { reason: "label_taken" } } });
    // Its own label in another case is its own to take.
    expect((await applied(client, "accounts.relabel", { accountId: work.id, label: "WORK" })).account.label).toBe("WORK");
    const same = await command(client, "accounts.relabel", { accountId: work.id, label: "WORK" });
    expect(same.receipt).toMatchObject({ status: "accepted", changed: false });
    expect(accountEvents(t, work.id).filter((event) => event.type === "account.relabelled")).toEqual([
      { type: "account.relabelled", payload: { accountId: work.id, label: "WORK", previous: "Work" } },
    ]);
    const unknown = await command(client, "accounts.relabel", { accountId: "nobody", label: "Nobody" });
    expect(unknown.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "account", accountId: "nobody" } } });
    expect(await refusal(client.request("accounts.relabel", { commandId: randomUUID(), accountId: work.id, label: " padded" }))).toMatchObject({ code: "invalid_params" });
  });
});

describe("accounts.remove", () => {
  it("keeps an owned directory unless deleteDirectory is set, which deletes it and records account.directory-deleted", async () => {
    const t = await start();
    const client = await t.client();
    const kept = (await applied(client, "accounts.add", { label: "Kept" })).account;
    const deleted = (await applied(client, "accounts.add", { label: "Deleted" })).account;
    writeFileSync(join(deleted.directory.path, ".credentials.json"), "{}");

    expect(await applied(client, "accounts.remove", { accountId: kept.id })).toEqual({ accountId: kept.id, directoryDeleted: false });
    expect(existsSync(kept.directory.path)).toBe(true);
    expect(accountEvents(t, kept.id).map((event) => event.type)).toEqual(["account.added", "account.removed"]);

    expect(await applied(client, "accounts.remove", { accountId: deleted.id, deleteDirectory: true })).toEqual({ accountId: deleted.id, directoryDeleted: true });
    expect(existsSync(deleted.directory.path)).toBe(false);
    expect(accountEvents(t, deleted.id)).toEqual([
      { type: "account.added", payload: expect.objectContaining({ accountId: deleted.id }) },
      { type: "account.removed", payload: { accountId: deleted.id, reason: "user" } },
      { type: "account.directory-deleted", payload: { accountId: deleted.id, directory: deleted.directory.path } },
    ]);
    expect(await list(client)).toEqual([]);
    expect(notices(t).filter((notice) => notice.change === "removed").map((notice) => notice.accountId)).toEqual([kept.id, deleted.id]);
    // A removed account is not on this environment: removing it again is not found, and so is a run on it.
    expect((await command(client, "accounts.remove", { accountId: kept.id })).receipt).toMatchObject({ status: "rejected", reason: "not_found" });
    // Its label is free again.
    expect((await applied(client, "accounts.add", { label: "Kept" })).account.label).toBe("Kept");
  });

  it("drops the account's entry from credentials.injectionByAccount in its own transaction, as the command's settings.updated, and leaves the others' (#367)", async () => {
    const t = await start();
    const client = await t.client();
    const kept = (await applied(client, "accounts.add", { label: "Kept" })).account;
    const removed = (await applied(client, "accounts.add", { label: "Removed" })).account;
    await updateSettings(client, { "credentials.injectionByAccount": { [kept.id]: "allow", [removed.id]: "deny" } });
    const head = t.env.log.head();

    const commandId = randomUUID();
    const answer = await client.request("accounts.remove", { commandId, accountId: removed.id });
    expect(answer.receipt.status).toBe("accepted");

    expect(await client.request("settings.get", { keys: ["credentials.injectionByAccount"] })).toEqual({ values: { "credentials.injectionByAccount": { [kept.id]: "allow" } } });
    const updated = t.env.log.readStream({ kind: "settings", id: t.env.id }, head);
    expect(updated.map((event) => [event.type, event.payload, event.commandId])).toEqual([
      ["settings.updated", { values: { "credentials.injectionByAccount": { [kept.id]: "allow" } } }, commandId],
    ]);
    // An account with no entry leaves the setting as it is.
    const after = t.env.log.head();
    await applied(client, "accounts.remove", { accountId: (await applied(client, "accounts.add", { label: "Unlisted" })).account.id });
    expect(t.env.log.readStream({ kind: "settings", id: t.env.id }, after)).toEqual([]);
  });

  it("at the next start removes what a recorded deletion or an uncommitted add left, and keeps a removed account's directory", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await startTestEnvironment({ accounts: [], dataDir });
    const client = await first.client();
    const kept = (await applied(client, "accounts.add", { label: "Kept" })).account;
    await applied(client, "accounts.remove", { accountId: kept.id });
    await first.close();
    const stray = join(dataDir, ACCOUNTS_DIRECTORY, randomUUID());
    mkdirSync(stray);
    const second = await startTestEnvironment({ accounts: [], dataDir });
    onCleanup(() => second.close());
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(kept.directory.path)).toBe(true);
  });

  it("at the next start never removes a directory under the owned root that another account or the machine's own directory uses", async () => {
    const dataDir = join(tempDir(), "data");
    const root = join(dataDir, ACCOUNTS_DIRECTORY);
    const configured = join(root, "configured");
    const ambient = join(root, "ambient");
    const stray = join(root, randomUUID());
    for (const directory of [configured, ambient, stray]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(configured, ".credentials.json"), "{}");
    writeFileSync(join(ambient, ".credentials.json"), "{}");
    const t = await startTestEnvironment({
      accounts: [{ id: "claude-max", provider: "fake", directory: configured }],
      adapter: fakeAdapter({ ambientDirectory: ambient }),
      dataDir,
    });
    onCleanup(() => t.close());
    expect(existsSync(stray)).toBe(false);
    expect(readdirSync(configured)).toEqual([".credentials.json"]);
    expect(readdirSync(ambient)).toEqual([".credentials.json"]);
    expect((await list(await t.client())).map((account) => account.directory)).toEqual([{ kind: "adopted", path: configured }]);
  });
});

describe("status", () => {
  it("is read at most every fifteen minutes on the clock, and appends account.status-changed and a notice only on a change", async () => {
    const t = await startTestEnvironment({ accounts: [{ id: "claude-max", provider: "fake" }] });
    onCleanup(() => t.close());
    const client = await t.client();
    const [account] = await list(client);
    const directory = account?.directory.path as string;
    expect(account).toMatchObject({ id: "claude-max", label: "claude-max", directory: { kind: "adopted" }, status: { state: "signed-in", checkedAt: MANUAL_CLOCK_START } });
    expect(readsOf(t.adapter, directory)).toBe(1);
    const changes = () => accountEvents(t, "claude-max").filter((event) => event.type === "account.status-changed");
    const before = changes().length;

    t.clock.advance(STATUS_READ_INTERVAL_MS - 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readsOf(t.adapter, directory)).toBe(1);
    t.clock.advance(1);
    await vi.waitFor(() => expect(readsOf(t.adapter, directory)).toBe(2));
    expect(changes()).toHaveLength(before);
    expect(notices(t)).toEqual([]);

    // Signed out in a terminal: the next read, fifteen minutes on, records it once and says so.
    t.adapter.setStatus(() => signedInAs(null));
    t.clock.advance(STATUS_READ_INTERVAL_MS);
    await vi.waitFor(() => expect(changes()).toHaveLength(before + 1));
    expect(changes().at(-1)).toEqual({ type: "account.status-changed", payload: { accountId: "claude-max", status: "signed-out", previous: "signed-in", detail: null } });
    await vi.waitFor(() => expect(notices(t)).toEqual([{ accountId: "claude-max", change: "status-changed", warning: null }]));
    t.clock.advance(STATUS_READ_INTERVAL_MS);
    await vi.waitFor(() => expect(readsOf(t.adapter, directory)).toBe(4));
    expect(changes()).toHaveLength(before + 1);

    // accounts.refresh reads now, and the next timed read is fifteen minutes after it.
    t.clock.advance(STATUS_READ_INTERVAL_MS / 3);
    t.adapter.setStatus((ref) => signedInAs(`${ref.id}@example.com`));
    const refreshed = await client.request("accounts.refresh", {});
    expect(readsOf(t.adapter, directory)).toBe(5);
    expect(refreshed.accounts[0]?.status).toEqual({ state: "signed-in", checkedAt: t.clock.now().toISOString(), detail: null });
    t.clock.advance(STATUS_READ_INTERVAL_MS - 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readsOf(t.adapter, directory)).toBe(5);
    t.clock.advance(1);
    await vi.waitFor(() => expect(readsOf(t.adapter, directory)).toBe(6));
  });

  it("reads expired when the provider says the login lapsed, and unreadable with the reason when the read fails", async () => {
    const t = await startTestEnvironment({ accounts: [{ id: "claude-max", provider: "fake" }], probeTimeoutMs: 20 });
    onCleanup(() => t.close());
    const client = await t.client();
    t.adapter.setStatus(() => ({ ...signedInAs(null), expired: true }));
    expect((await client.request("accounts.refresh", { accountId: "claude-max" })).accounts[0]?.status).toMatchObject({ state: "expired", detail: null });
    t.adapter.setStatus(() => ({ ...signedInAs(null), error: "The binary could not be run." }));
    expect((await client.request("accounts.refresh", {})).accounts[0]?.status).toMatchObject({ state: "unreadable", detail: "The binary could not be run." });
    // A probe that never answers gives up after the timeout, and reads unreadable.
    t.adapter.setStatus(() => signedInAs("claude-max@example.com"));
    await client.request("accounts.refresh", {});
    t.adapter.setStatus(() => new Promise<AuthStatus>(() => undefined));
    const answer = await client.request("accounts.refresh", {});
    expect(answer.accounts[0]?.status).toMatchObject({ state: "unreadable", detail: expect.stringContaining("20 ms") });
    expect(accountEvents(t, "claude-max").filter((event) => event.type === "account.status-changed").map((event) => event.payload["status"])).toEqual([
      "signed-in",
      "expired",
      "unreadable",
      "signed-in",
      "unreadable",
    ]);
    expect(await refusal(client.request("accounts.refresh", { accountId: "nobody" }))).toMatchObject({ code: "not_found", data: { kind: "account" } });
  });

  it("goes out as account.updated on environment.subscribe once the change has committed", async () => {
    const t = await startTestEnvironment({ accounts: [{ id: "claude-max", provider: "fake" }] });
    onCleanup(() => t.close());
    const client = await t.client();
    const watcher = await t.client();
    const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    await watcher.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
    await applied(client, "accounts.relabel", { accountId: "claude-max", label: "Max" });
    const frame = await watcher.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
    expect(frame.event).toMatchObject({ streamKind: "environment", type: "account.updated", payload: { accountId: "claude-max", change: "relabelled", warning: null } });
    const relabelled = t.env.log.readStream({ kinds: ["account"] }).find((event) => event.type === "account.relabelled") as EventEnvelope;
    expect(frame.event.sequence).toBeGreaterThan(relabelled.sequence);
  });

  it("is cross-checked against the identity a run's provider reports, and a mismatch is an account.updated with a warning", async () => {
    const t = await startTestEnvironment({
      accounts: [{ id: "claude-max", provider: "fake" }],
      adapter: fakeAdapter({
        script: ({ context }) => {
          context.reportIdentity({ provider: "fake", email: "someone-else@example.com", organisation: "Acme" });
          return [say("Done"), end()];
        },
      }),
    });
    onCleanup(() => t.close());
    const client = await t.client();
    const { id } = await create(client);
    const directory = (await list(client))[0]?.directory.path as string;
    const reads = readsOf(t.adapter, directory);
    await startRun(client, id);
    await vi.waitFor(() => expect(notices(t)).toHaveLength(1));
    const [notice] = notices(t);
    expect(notice).toEqual({ accountId: "claude-max", change: "identity-mismatch", warning: expect.stringMatching(/someone-else@example\.com \(Acme\).*claude-max@example\.com/) });
    // The status is read again at once.
    await vi.waitFor(() => expect(readsOf(t.adapter, directory)).toBe(reads + 1));
  });

  it("is read again at once when a run's provider finds the account's login lapsed, and a status that says expired is recorded and noticed (#229)", async () => {
    let lapsed = false;
    const t = await startTestEnvironment({
      accounts: [{ id: "claude-max", provider: "fake" }],
      adapter: fakeAdapter({
        status: () => (lapsed ? { ...signedInAs(null), expired: true } : signedInAs("claude-max@example.com")),
        script: ({ context }) => {
          // As the Claude adapter does when the refresh of an expired login before a cold resume fails.
          lapsed = true;
          context.recheckAccount();
          return [end("error", { error: { message: "The Claude account claude-max has an expired login.", code: "login_expired" } })];
        },
      }),
    });
    onCleanup(() => t.close());
    const client = await t.client();
    const { id } = await create(client);
    const directory = (await list(client))[0]?.directory.path as string;
    const reads = readsOf(t.adapter, directory);
    await startRun(client, id);
    await vi.waitFor(() => expect(readsOf(t.adapter, directory)).toBe(reads + 1));
    await vi.waitFor(async () => expect((await list(client))[0]?.status.state).toBe("expired"));
    expect(notices(t)).toEqual([{ accountId: "claude-max", change: "status-changed", warning: null }]);
    expect(accountEvents(t, "claude-max").filter((event) => event.type === "account.status-changed").at(-1)?.payload).toMatchObject({ status: "expired", previous: "signed-in" });
  });

  it("matches a run's identity on the email ignoring case when either side names no organisation, and tells two organisations apart", async () => {
    const reported: { email: string; organisation: string | null }[] = [
      { email: "CLAUDE-MAX@example.com", organisation: null },
      { email: "claude-max@example.com", organisation: "Acme" },
      { email: "claude-max@example.com", organisation: "Other" },
    ];
    const t = await startTestEnvironment({
      accounts: [{ id: "claude-max", provider: "fake" }],
      adapter: fakeAdapter({
        status: () => signedInAs("claude-max@example.com", "Acme"),
        script: ({ context }) => {
          const next = reported.shift();
          if (next !== undefined) context.reportIdentity({ provider: "fake", ...next });
          return [say("Done"), end()];
        },
      }),
    });
    onCleanup(() => t.close());
    const client = await t.client();
    for (let run = 0; run < 3; run += 1) {
      const { id } = await create(client);
      const before = t.adapter.runs.length;
      await startRun(client, id);
      await vi.waitFor(() => expect(t.adapter.runs.length).toBe(before + 1));
      await vi.waitFor(() => expect(reported).toHaveLength(2 - run));
    }
    await vi.waitFor(() => expect(notices(t)).toHaveLength(1));
    expect(notices(t)[0]).toMatchObject({ change: "identity-mismatch", warning: expect.stringContaining("(Other)") });
  });
});

describe("the default account and the Account step's settings keys", () => {
  it("reads and writes accounts.defaultAccount, defaultModelFamily and defaultEffort through settings.get and settings.update", async () => {
    const t = await startTestEnvironment({ accounts: [{ id: "claude-max", provider: "fake" }] });
    onCleanup(() => t.close());
    const client = await t.client();
    const keys = ["accounts.defaultAccount", "accounts.defaultModelFamily", "accounts.defaultEffort", "providers.processIdleMinutes"] as const;
    expect(await client.request("settings.get", { keys: [...keys] })).toEqual({
      values: { "accounts.defaultAccount": null, "accounts.defaultModelFamily": null, "accounts.defaultEffort": null, "providers.processIdleMinutes": 30 },
    });
    const values = { "accounts.defaultAccount": "claude-max", "accounts.defaultModelFamily": "sonnet", "accounts.defaultEffort": "high", "providers.processIdleMinutes": 45 };
    const updated = await client.request("settings.update", { commandId: randomUUID(), values });
    expect(updated.result?.values).toMatchObject(values);
    expect(await client.request("settings.get", { keys: [...keys] })).toEqual({ values });
    expect(await refusal(client.request("settings.update", { commandId: randomUUID(), values: { "accounts.defaultEffort": "" } }))).toMatchObject({ code: "invalid_params" });
  });

  it("runs a session with no account on accounts.defaultAccount, else the first account, in the default family at the default effort", async () => {
    const t = await startTestEnvironment({ accounts: [{ id: "first", provider: "fake" }, { id: "second", provider: "fake" }] });
    onCleanup(() => t.close());
    const client = await t.client();
    const runOnce = async (): Promise<{ account: string; model: string; effort: string | null }> => {
      const { id } = await create(client);
      const before = t.adapter.runs.length;
      await startRun(client, id);
      await vi.waitFor(() => expect(t.adapter.runs.length).toBe(before + 1));
      const { input } = t.adapter.lastRun();
      return { account: input.account.id, model: input.model, effort: input.effort };
    };
    expect(await runOnce()).toEqual({ account: "first", model: "opus", effort: null });
    await client.request("settings.update", {
      commandId: randomUUID(),
      values: { "accounts.defaultAccount": "second", "accounts.defaultModelFamily": "sonnet", "accounts.defaultEffort": "high" },
    });
    expect(await runOnce()).toEqual({ account: "second", model: "sonnet", effort: "high" });
    // An effort the model does not take is left to the model; a family the catalogue lacks takes the strongest.
    await client.request("settings.update", { commandId: randomUUID(), values: { "accounts.defaultModelFamily": "haiku" } });
    expect(await runOnce()).toMatchObject({ model: "haiku", effort: null });
    await client.request("settings.update", { commandId: randomUUID(), values: { "accounts.defaultModelFamily": "gpt" } });
    expect(await runOnce()).toMatchObject({ model: "opus", effort: "high" });
    // The default account removed, the first the environment still holds stands in.
    await applied(client, "accounts.remove", { accountId: "second" });
    expect(await runOnce()).toMatchObject({ account: "first" });
  });

  it("runs a command asking effort null at the model's own effort, though accounts.defaultEffort is set (#1950)", async () => {
    const t = await startTestEnvironment({ accounts: [{ id: "first", provider: "fake" }] });
    onCleanup(() => t.close());
    const client = await t.client();
    await client.request("settings.update", { commandId: randomUUID(), values: { "accounts.defaultEffort": "high" } });
    const runAsking = async (asked: { readonly model?: string; readonly effort?: string | null }): Promise<string | null> => {
      const { id } = await create(client);
      const before = t.adapter.runs.length;
      await startRun(client, id, asked);
      await vi.waitFor(() => expect(t.adapter.runs.length).toBe(before + 1));
      return t.adapter.lastRun().input.effort;
    };
    expect(await runAsking({ model: "opus" })).toBe("high");
    expect(await runAsking({ model: "opus", effort: null })).toBeNull();
    expect(await runAsking({ model: "opus", effort: "low" })).toBe("low");
  });

  it("carries over #119's configured accounts only into a store that has never held one", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await startTestEnvironment({ accounts: [{ id: "claude-max", provider: "fake" }], dataDir });
    await first.close();
    const second = await startTestEnvironment({ accounts: [{ id: "other", provider: "fake" }], dataDir });
    onCleanup(() => second.close());
    const client = await second.client();
    expect((await list(client)).map((account) => account.id)).toEqual(["claude-max"]);
  });

  it("carries over the first of two configured accounts whose ids are one label ignoring case, and starts", async () => {
    const t = await startTestEnvironment({ accounts: [{ id: "Max", provider: "fake" }, { id: "max", provider: "fake" }] });
    onCleanup(() => t.close());
    expect((await list(await t.client())).map((account) => account.id)).toEqual(["Max"]);
  });
});

describe("the fifteen-minute reads", () => {
  it("read again the models a failed read left unknown, and stop when the environment closes", async () => {
    let listings = 0;
    const base = fakeAdapter();
    const flaky = {
      ...base,
      models: async () => {
        listings += 1;
        if (listings === 1) throw new Error("The listing failed.");
        return { live: false, models: [{ id: "opus", family: "opus", tier: 3, efforts: ["high"] }] };
      },
    } as FakeAdapter;
    const t = await startTestEnvironment({ accounts: [{ id: "claude-max", provider: "fake" }], adapter: flaky });
    expect(listings).toBe(1);
    t.clock.advance(STATUS_READ_INTERVAL_MS);
    await vi.waitFor(() => expect(listings).toBe(2));
    t.clock.advance(STATUS_READ_INTERVAL_MS);
    await vi.waitFor(() => expect(base.statusReads.length).toBe(3));
    expect(listings).toBe(2);
    await t.close();
    t.clock.advance(STATUS_READ_INTERVAL_MS * 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(base.statusReads.length).toBe(3);
  });
});

describe("models.list and commands.list", () => {
  it("lists each account's models with family, ordinal tier and efforts, flagged static when the adapter cannot enumerate them", async () => {
    const t = await startTestEnvironment({ accounts: [{ id: "claude-max", provider: "fake" }] });
    onCleanup(() => t.close());
    const client = await t.client();
    const expected = {
      accountId: "claude-max",
      live: false,
      models: [
        { id: "opus", family: "opus", tier: 3, efforts: ["low", "medium", "high", "max"], label: null },
        { id: "sonnet", family: "sonnet", tier: 2, efforts: ["low", "medium", "high"], label: null },
        { id: "haiku", family: "haiku", tier: 1, efforts: [], label: null },
      ],
    };
    expect(await client.request("models.list", {})).toEqual({ catalogues: [expected] });
    expect(await client.request("models.list", { accountId: "claude-max" })).toEqual({ catalogues: [expected] });
    expect(await refusal(client.request("models.list", { accountId: "nobody" }))).toMatchObject({ code: "not_found" });
  });

  it("flags a catalogue live and carries only a provider-reported context window", async () => {
    const live = { ...fakeAdapter(), models: async () => ({ live: true, models: [{ id: "fable", family: "fable", tier: 4, efforts: ["high"], label: "Fable", contextWindow: 4096 }] }) } as FakeAdapter;
    const t = await startTestEnvironment({ accounts: [{ id: "claude-max", provider: "fake" }], adapter: live });
    onCleanup(() => t.close());
    const client = await t.client();
    expect(await client.request("models.list", {})).toEqual({
      catalogues: [{ accountId: "claude-max", live: true, models: [{ id: "fable", family: "fable", tier: 4, efforts: ["high"], label: "Fable", contextWindow: 4096 }] }],
    });
  });

  it("lists the provider's commands for a session's account and workspace without a run, and refuses an adapter without the capability", async () => {
    const t = await startTestEnvironment({
      accounts: [{ id: "claude-max", provider: "fake" }],
      adapter: fakeAdapter({ commands: [{ name: "review", description: "Review the branch.", builtin: false }] }),
    });
    onCleanup(() => t.close());
    const client = await t.client();
    const { id } = await create(client);
    expect(await client.request("commands.list", { sessionId: id })).toEqual({
      accountId: "claude-max",
      entries: [{ kind: "command", name: "review", description: "Review the branch.", builtin: false }],
    });
    // Under the session's trust and its skill set, as its next run would be: undecided, and the own directory's set, empty (#495, #496, #503).
    const empty = { generation: null, fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/), members: [], hiddenNativeNames: [] };
    expect(t.adapter.commandListings).toEqual([
      { account: { id: "claude-max", directory: expect.any(String) }, workspace: workspace.path, scope: { trusted: false, skillSet: empty } },
    ]);
    expect(t.adapter.runs).toEqual([]);

    const bare = await startTestEnvironment({ accounts: [{ id: "claude-max", provider: "fake" }] });
    onCleanup(() => bare.close());
    const other = await bare.client();
    const session = await create(other);
    expect(await refusal(other.request("commands.list", { sessionId: session.id }))).toMatchObject({ code: "invalid_params", data: { reason: "unsupported", capability: "commands" } });
  });

  it("keeps providers.list as #120 registered it: every adapter's descriptor", async () => {
    const t = await start();
    const client = await t.client();
    expect(await client.request("providers.list", {})).toEqual({ providers: [t.adapter.descriptor] });
  });
});
