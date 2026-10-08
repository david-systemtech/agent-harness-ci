import { EnvironmentNotice, registry, type Frame, type SnapshotFrame, type StepResult } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { installFakeGh, type FakeGh, type FakeGhState } from "../../test/fake-gh.js";
import { DAVID, TOKEN, added, list, remove, setPrimary } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";

/**
 * The Forges step's check (forge spec, "The Forges step"; setup spec,
 * "Skipped"; ADR 0020, ADR 0031; #319) through the primary seam: an
 * in-process environment and a real client over a real WebSocket, beside the
 * scripted fake forge and a fake `gh`, on the manual clock. What is asserted
 * is what `setup.check` answers a client: the step's state, its line, the
 * checks that failed, the actions offered and the forge accounts or tools
 * they apply to.
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

const fakeGh = (state: FakeGhState): FakeGh => installFakeGh(tempDir(), state);

/** An environment beside a fake forge that answers the test's token as David and lets it list no repository. */
const withForge = async () => {
  const forge = await fakeForge();
  forge.user(TOKEN, DAVID);
  forge.repositories(TOKEN, []);
  const t = await start({ forgeFetch: forge.fetch });
  return { t, forge, client: await t.client() };
};


/** The manual clock's time `ms` after its start. */
const after = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** A promise the test settles: what holds a fake forge's answer back. */
const hold = (): { readonly held: Promise<void>; readonly release: () => void } => {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  return { held, release };
};

/** How a check's line and targets name a forge account on `forge` answering as David. */
const davidOn = (forge: FakeForge): string => `david on ${forge.origin.replace("http://", "")}`;

/** The step's line when every check holds on one forge account answering as David: what was found, never its checks' conditions (#1698; setup-copy.md §5.6). */
const holds = (forge: FakeForge): string => `${davidOn(forge)} is connected.`;

/** The one result `setup.check` answers for the Forges step. */
const checkForges = async (client: WireClient): Promise<StepResult> => {
  const { results } = await client.request("setup.check", { step: "forges" });
  expect(results.map((result) => result.step)).toEqual(["forges"]);
  return results[0] as StepResult;
};

/** The Forges step's result in a `setup.result-changed` on `subscription`, when `frame` is one. */
const forgesNotice = (subscription: string, frame: Frame): StepResult | undefined => {
  if (frame.type !== "event" || frame.subscription !== subscription) return undefined;
  const notice = EnvironmentNotice.safeParse(frame.event);
  return notice.success && notice.data.type === "setup.result-changed" && notice.data.payload.step === "forges" ? notice.data.payload : undefined;
};

/** The Forges step's next changed result `client` hears on `subscription`, an environment stream it subscribed to. */
const nextForgesResult = async (client: WireClient, subscription: string): Promise<StepResult> => {
  const result = forgesNotice(subscription, await client.next((frame) => forgesNotice(subscription, frame) !== undefined));
  if (result === undefined) throw new Error("The frame waited for carries no Forges result.");
  return result;
};

describe("the Forges step with no forge account", () => {
  it("answers skipped with forges.present's line, asking no forge and no gh anything", async () => {
    const forge = await fakeForge();
    const gh = fakeGh({ version: "2.63.2" });
    const t = await start({ forgeFetch: forge.fetch, managedTools: gh.managedTools });
    const client = await t.client();
    // The Managed tools registry's start probe asks gh its version (#373); the check asks it nothing.
    await client.request("tools.list", {});
    const before = gh.calls().length;
    expect(await checkForges(client)).toEqual({
      step: "forges",
      state: "skipped",
      reason: "No forge account is on this environment.",
      failing: [],
      actions: [],
      checkedAt: MANUAL_CLOCK_START,
    });
    expect(forge.requests).toEqual([]);
    expect(gh.calls().slice(before)).toEqual([]);
  });
});

describe("the Forges step with forge accounts", () => {
  it("verifies every forge account as it checks, once however many checks read it, and is done when all seven hold", async () => {
    const { forge, client } = await withForge();
    await added(client, { url: forge.origin, kind: "forgejo" });
    const asked = forge.requests.length;

    expect(await checkForges(client)).toEqual({ step: "forges", state: "done", reason: holds(forge), details: [forge.origin], failing: [], actions: [], checkedAt: MANUAL_CLOCK_START });
    expect(forge.requests.slice(asked)).toEqual([
      { method: "GET", path: "/api/v1/user", scheme: "token" },
      { method: "GET", path: "/api/v1/user/repos", query: "limit=1", scheme: "token" },
    ]);
  });
});

describe("forges.identity", () => {
  it("names each forge account that does not answer as its identity with its action: Sign in again for a refused credential, Check again for a forge that did not answer", async () => {
    const { forge: refusing, client } = await withForge();
    const silent = await fakeForge();
    silent.user(TOKEN, DAVID);
    await added(client, { url: refusing.origin, kind: "forgejo" });
    await added(client, { url: silent.origin, kind: "gitea" });
    refusing.answer(TOKEN, "GET /api/v1/user", { status: 401, body: { message: "token is required" } });
    silent.answer(TOKEN, "GET /api/v1/user", { status: 502 });

    expect(await checkForges(client)).toEqual({
      step: "forges",
      state: "needs-attention",
      reason: `The forge refused the credential of ${davidOn(refusing)}: Sign in again to give it a new one. ${davidOn(silent)} did not answer its verification: Check again once its forge is reachable.`,
      failing: ["forges.identity"],
      actions: ["sign-in-again", "check-again"],
      targets: [
        { action: "sign-in-again", kind: "forge-account", id: refusing.origin, label: davidOn(refusing) },
        { action: "check-again", kind: "forge-account", id: silent.origin, label: davidOn(silent) },
      ],
      checkedAt: MANUAL_CLOCK_START,
    });
  });

  it("asks a copy awaiting a credential for one, named by its origin's host, and a credential that now answers as another user to be replaced", async () => {
    const { forge, client } = await withForge();
    const copy = await fakeForge();
    await added(client, { url: forge.origin, kind: "forgejo" });
    await added(client, { url: copy.origin, kind: "forgejo", credential: { kind: "none" } });
    forge.user(TOKEN, { login: "eve", id: 7 });
    const host = copy.origin.replace("http://", "");

    const result = await checkForges(client);
    expect(result).toMatchObject({
      state: "needs-attention",
      reason: `The credential of ${davidOn(forge)} now answers as another user: Sign in again as david. ${host} has no credential on this environment: Sign in again to give it one.`,
      failing: ["forges.identity"],
      targets: [
        { action: "sign-in-again", kind: "forge-account", id: forge.origin, label: davidOn(forge) },
        { action: "sign-in-again", kind: "forge-account", id: copy.origin, label: host },
      ],
    });
    expect(copy.requests).toEqual([]);
  });
});

describe("forges.reads", () => {
  it("names each forge account a read did not pass for, refused with the status it answered or not answered yet, with Check again", async () => {
    const { forge: refusing, client } = await withForge();
    const silent = await fakeForge();
    silent.user(TOKEN, DAVID);
    await added(client, { url: refusing.origin, kind: "forgejo" });
    await added(client, { url: silent.origin, kind: "gitea" });
    refusing.answer(TOKEN, "GET /api/v1/user/repos", { status: 403, body: { message: "token does not have at least one of required scope(s): [read:repository]" } });
    silent.answer(TOKEN, "GET /api/v1/user/repos", { status: 502 });

    expect(await checkForges(client)).toEqual({
      step: "forges",
      state: "needs-attention",
      reason:
        `${davidOn(refusing)} was refused reading repositories (HTTP 403) and releases (HTTP 403): Check again once its token may read them. ` +
        `${davidOn(silent)} has no answer yet reading repositories and releases: Check again once its forge answers.`,
      failing: ["forges.reads"],
      actions: ["check-again"],
      targets: [
        { action: "check-again", kind: "forge-account", id: refusing.origin, label: davidOn(refusing) },
        { action: "check-again", kind: "forge-account", id: silent.origin, label: davidOn(silent) },
      ],
      checkedAt: MANUAL_CLOCK_START,
    });
  });
});

describe("forges.primary", () => {
  it("needs attention once removing the primary leaves none, naming the forge accounts one of which to make primary, and holds again once one is", async () => {
    const { forge: first, client } = await withForge();
    const second = await fakeForge();
    const third = await fakeForge();
    for (const forge of [second, third]) {
      forge.user(TOKEN, DAVID);
      forge.repositories(TOKEN, []);
    }
    const primary = await added(client, { url: first.origin, kind: "forgejo" });
    const other = await added(client, { url: second.origin, kind: "forgejo" });
    await added(client, { url: third.origin, kind: "gitea" });
    expect(await remove(client, primary.id)).toMatchObject({ receipt: { status: "accepted" } });

    expect(await checkForges(client)).toEqual({
      step: "forges",
      state: "needs-attention",
      reason: `No forge account is primary: choose ${davidOn(second)} or ${davidOn(third)} with Make primary.`,
      failing: ["forges.primary"],
      actions: [],
      checkedAt: MANUAL_CLOCK_START,
    });

    await setPrimary(client, other.id);
    expect(await checkForges(client)).toMatchObject({ state: "done", reason: "2 forges connected." });
  });
});

describe("forges.gh", () => {
  /** A token gh holds, as short and obviously fake as the other suites' own. */
  const GH_TOKEN = "gho_fake";

  /** A fake forge as a GitHub Enterprise origin answering gh's token as David, and a fake gh signed in to its host as david. */
  const withGhSource = async (dataDir: string) => {
    const forge = await fakeForge();
    forge.user(GH_TOKEN, DAVID);
    forge.repositories(GH_TOKEN, []);
    const host = forge.origin.replace("http://", "");
    const gh = fakeGh({ version: "2.63.2", accounts: [{ host, login: "david", token: GH_TOKEN }] });
    const t = await startTestEnvironment({ dataDir, managedTools: gh.managedTools });
    const client = await t.client();
    await added(client, { url: forge.origin, kind: "github", credential: { kind: "gh", login: "david" } });
    return { t, forge, gh, host, client };
  };

  it("holds when gh is installed at 2.40 or later and signed in as the login each gh forge account reads, which it asks gh", async () => {
    const { t, forge, gh, client } = await withGhSource(`${tempDir()}/data`);
    onCleanup(() => t.close());
    expect(await checkForges(client)).toMatchObject({ state: "done", reason: holds(forge) });
    expect(gh.calls().map((call) => call.argv.slice(0, 2))).toContainEqual(["auth", "status"]);
  });

  it("names a gh signed out of the forge account's host and login with Sign in again, and a gh older than 2.40 with Update, gh the tool it applies to", async () => {
    const { t, forge, gh, host, client } = await withGhSource(`${tempDir()}/data`);
    onCleanup(() => t.close());
    const account = { kind: "forge-account", id: forge.origin, label: `david on ${host}` } as const;

    gh.set({ version: "2.63.2", accounts: [] });
    expect(await checkForges(client)).toEqual({
      step: "forges",
      state: "needs-attention",
      reason: `The credential of david on ${host} could not be read: Sign in again to give it a new one. gh on this environment is not signed in to ${host} as david: Sign in again.`,
      failing: ["forges.identity", "forges.gh"],
      actions: ["sign-in-again", "check-again", "install", "update"],
      targets: [{ action: "sign-in-again", ...account }],
      checkedAt: MANUAL_CLOCK_START,
    });

    gh.set({ version: "2.39.1", accounts: [{ host, login: "david", token: GH_TOKEN }] });
    // gh's version is the Managed tools registry's row (#373), read again on a refresh fifteen minutes on.
    t.clock.advance(15 * 60_000);
    await client.request("tools.list", { refresh: true });
    expect(await checkForges(client)).toMatchObject({
      reason: `The credential of david on ${host} could not be read: Sign in again to give it a new one. gh 2.39.1 on this environment is older than 2.40.0 for david on ${host}: Update gh.`,
      failing: ["forges.identity", "forges.gh"],
      targets: [
        { action: "sign-in-again", ...account },
        { action: "update", kind: "tool", id: "gh", label: "gh" },
      ],
    });
  });

  it("asks for gh to be installed when it is not on the environment's PATH, naming the forge accounts that read it", async () => {
    const dataDir = `${tempDir()}/data`;
    const first = await withGhSource(dataDir);
    await first.t.close();
    // The helper's login shell has nothing on its PATH.
    const t = await start({ dataDir });
    const result = await checkForges(await t.client());
    expect(result).toMatchObject({ state: "needs-attention", failing: ["forges.identity", "forges.gh"] });
    expect(result.reason).toContain(`gh is not installed on this environment for david on ${first.host}: Install gh 2.40.0 or later.`);
    expect(result.targets).toContainEqual({ action: "install", kind: "tool", id: "gh", label: "gh" });
  });

  it("is checked again a second after tools.updated, so a gh updated past 2.40 and read on a refresh fifteen minutes on changes the step's cached result and raises setup.result-changed with no setup.check asked (#677)", async () => {
    const forge = await fakeForge();
    forge.user(GH_TOKEN, DAVID);
    forge.repositories(GH_TOKEN, []);
    const host = forge.origin.replace("http://", "");
    const gh = fakeGh({ version: "2.39.1", accounts: [{ host, login: "david", token: GH_TOKEN }] });
    const t = await start({ managedTools: gh.managedTools });
    await t.env.setup.startPass;
    const client = await t.client();
    // The start probe has ended: finding gh, it appended tools.updated, which checks the step a second on. With no forge account
    // yet that check answers skipped at once, as the start pass did, so it changes nothing.
    await client.request("tools.list", {});
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    t.clock.advance(1_000);
    await new Promise((resolve) => setImmediate(resolve));

    // Added five minutes on, so the step's cadence, counted from the check the addition triggers, falls due only after the refresh below.
    t.clock.advance(5 * 60_000 - 1_000);
    await added(client, { url: forge.origin, kind: "github", credential: { kind: "gh", login: "david" } });
    t.clock.advance(1_000);
    const before = await nextForgesResult(client, subscription);
    expect(before).toEqual({
      step: "forges",
      state: "needs-attention",
      reason: `The credential of ${host} could not be read: Sign in again to give it a new one. gh 2.39.1 on this environment is older than 2.40.0 for ${host}: Update gh.`,
      failing: ["forges.identity", "forges.gh"],
      actions: ["sign-in-again", "check-again", "install", "update"],
      targets: [
        { action: "sign-in-again", kind: "forge-account", id: forge.origin, label: host },
        { action: "update", kind: "tool", id: "gh", label: "gh" },
      ],
      checkedAt: after(5 * 60_000 + 1_000),
    });

    // gh updated from a terminal: the registry's row, which forges.gh reads, changes on the refresh fifteen minutes after its start probe.
    gh.set({ version: "2.63.2", accounts: [{ host, login: "david", token: GH_TOKEN }] });
    t.clock.advance(10 * 60_000);
    await client.request("tools.list", { refresh: true });
    t.clock.advance(1_000);
    // forges.gh holds at once. The credential's read is the last verification's, five minutes on, younger than the step's cadence (#680).
    expect(await nextForgesResult(client, subscription)).toEqual({
      step: "forges",
      state: "needs-attention",
      reason: `The credential of ${host} could not be read: Sign in again to give it a new one.`,
      failing: ["forges.identity"],
      actions: ["sign-in-again", "check-again"],
      targets: [{ action: "sign-in-again", kind: "forge-account", id: forge.origin, label: host }],
      checkedAt: after(15 * 60_000 + 2_000),
    });

    // The verifier's own schedule, fifteen minutes after that verification ended, reads the credential through the gh updated: the step reads it a second on.
    t.clock.advance(5 * 60_000 - 1_000);
    await vi.waitFor(async () => expect((await list(client))[0]?.problem).toBeNull(), { timeout: WAIT_MS });
    t.clock.advance(1_000);
    const result = await nextForgesResult(client, subscription);
    expect(result).toEqual({ step: "forges", state: "done", reason: holds(forge), details: [forge.origin], failing: [], actions: [], checkedAt: after(20 * 60_000 + 2_000) });

    // The cache holds it: the snapshot a client subscribing now is sent.
    const { subscription: later } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() + 100 });
    const { payload } = await client.next((f): f is SnapshotFrame => f.type === "snapshot" && f.subscription === later);
    expect(registry["environment.subscribe"].result.parse(payload).setup?.find((cached) => cached.step === "forges")).toEqual(result);
  });
});

describe("forges.expiry", () => {
  it("names a forge account whose token expires within thirty days of the environment's clock, or has expired, with the time and Sign in again, and holds for one that lasts longer", async () => {
    const forge = await fakeForge();
    const t = await start();
    const client = await t.client();
    const token = "ghp_classic-for-tests";
    const expiresAt = (expiration: string) =>
      forge.answer(token, "GET /api/v3/user", { status: 200, body: { ...DAVID, full_name: "", email: "" }, headers: { "github-authentication-token-expiration": expiration } });
    forge.repositories(token, []);
    expiresAt("2026-10-24 00:00:01 UTC");
    await added(client, { url: forge.origin, kind: "github", credential: { kind: "stored", provenance: "pasted", token } });
    expect(await checkForges(client)).toMatchObject({ state: "done", reason: holds(forge) });

    expiresAt("2026-10-20 12:00:00 UTC");
    expect(await checkForges(client)).toEqual({
      step: "forges",
      state: "needs-attention",
      reason: `The token of ${davidOn(forge)} expires at 2026-10-20 12:00 UTC: Sign in again to give it a new one before then.`,
      failing: ["forges.expiry"],
      actions: ["sign-in-again"],
      targets: [{ action: "sign-in-again", kind: "forge-account", id: forge.origin, label: davidOn(forge) }],
      checkedAt: MANUAL_CLOCK_START,
    });

    // Past its expiry the forge refuses the token, and the expiry the last verification read says why.
    expiresAt("2026-09-24 00:00:30 UTC");
    expect(await checkForges(client)).toMatchObject({ failing: ["forges.expiry"] });
    t.clock.advance(60_000);
    forge.answer(token, "GET /api/v3/user", { status: 401, body: { message: "Bad credentials" } });
    expect(await checkForges(client)).toMatchObject({
      reason:
        `The forge refused the credential of ${davidOn(forge)}: Sign in again to give it a new one. ` +
        `The token of ${davidOn(forge)} expired at 2026-09-24 00:00 UTC: Sign in again to give it a new one.`,
      failing: ["forges.identity", "forges.expiry"],
      targets: [{ action: "sign-in-again", kind: "forge-account", id: forge.origin, label: davidOn(forge) }],
    });
  });
});

describe("forges.coverage", () => {
  it("names each origin a harness operation was refused on for want of a forge account, with the operation, until a forge account covers it", async () => {
    const { t, forge, client } = await withForge();
    await added(client, { url: forge.origin, kind: "forgejo" });
    const uncovered = await fakeForge();
    uncovered.detectable("forgejo", "16.0.3+gitea-1.22.0");
    uncovered.answer(null, "GET /api/v1/repos/david/bank/releases", { status: 404, body: { message: "Not Found" } });
    expect(await t.env.forge.releases.list({ origin: uncovered.origin, repository: "david/bank", limit: 50, purpose: "read the release channel" })).toMatchObject({
      outcome: "refused",
    });

    expect(await checkForges(client)).toEqual({
      step: "forges",
      state: "needs-attention",
      reason: `No forge account covers ${uncovered.origin}, where the harness could not read the release channel at 2026-09-24 00:00 UTC: add a forge account for it.`,
      failing: ["forges.coverage"],
      actions: [],
      checkedAt: MANUAL_CLOCK_START,
    });

    uncovered.user(TOKEN, DAVID);
    uncovered.repositories(TOKEN, []);
    await added(client, { url: uncovered.origin, kind: "forgejo" });
    expect(await checkForges(client)).toMatchObject({ state: "done", reason: "2 forges connected." });
  });
});

describe("the Forges step beside the verifier's own schedule (#680)", () => {
  const MINUTE = 60_000;
  const QUARTER = 15 * MINUTE;

  /** How many times `forge` has been asked who the token is: once by its add, then once per verification of its forge account. */
  const askedWho = (forge: FakeForge): number => forge.requests.filter((request) => request.path === "/api/v1/user").length;

  /** The forge account on `forge`, as `forge.accounts.list` answers it. */
  const accountOn = async (client: WireClient, forge: FakeForge) => (await list(client)).find((account) => account.origin === forge.origin);

  /** Resolves once the forge account on `forge` holds what a verification at `at` found, its next one scheduled from then. */
  const verifiedAt = (client: WireClient, forge: FakeForge, at: string) =>
    vi.waitFor(async () => expect((await accountOn(client, forge))?.capabilities.readRepository.verifiedAt).toBe(at), { timeout: WAIT_MS });

  /** The Forges step's cached result, as the snapshot a client subscribing now is sent. */
  const cachedForges = async (t: TestEnvironment, client: WireClient): Promise<StepResult | undefined> => {
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() + 100 });
    const { payload } = await client.next((frame): frame is SnapshotFrame => frame.type === "snapshot" && frame.subscription === subscription);
    return registry["environment.subscribe"].result.parse(payload).setup?.find((cached) => cached.step === "forges");
  };

  /** Moves the clock a second on, to the step's check its cadence or a trigger holds there, and resolves once that check is cached. */
  const checkedASecondOn = async (t: TestEnvironment, client: WireClient): Promise<StepResult | undefined> => {
    t.clock.advance(1_000);
    const at = t.clock.now().toISOString();
    await vi.waitFor(async () => expect((await cachedForges(t, client))?.checkedAt).toBe(at), { timeout: WAIT_MS });
    return cachedForges(t, client);
  };

  it("over an hour reads what the verifier found on its cadence and triggers: each forge account verified once every fifteen minutes, and one the forge paused asked nothing until its time", async () => {
    const steady = await fakeForge();
    const limited = await fakeForge();
    for (const forge of [steady, limited]) {
      forge.user(TOKEN, DAVID);
      forge.repositories(TOKEN, []);
    }
    const t = await start();
    await t.env.setup.startPass;
    const client = await t.client();
    await added(client, { url: steady.origin, kind: "forgejo" });
    await added(client, { url: limited.origin, kind: "forgejo" });
    // Each is verified at once, as a forge account given a credential is, and the additions check the step a second on.
    t.clock.advance(0);
    await verifiedAt(client, steady, MANUAL_CLOCK_START);
    await verifiedAt(client, limited, MANUAL_CLOCK_START);
    const steadyAsked = askedWho(steady);
    const limitedAsked = askedWho(limited);
    expect(await checkedASecondOn(t, client)).toMatchObject({ state: "done", reason: "2 forges connected." });
    expect([askedWho(steady) - steadyAsked, askedWho(limited) - limitedAsked]).toEqual([0, 0]);

    // Fifteen minutes on, the verifier's schedule: the forge limits the second forge account's credential for forty minutes.
    limited.answer(TOKEN, "GET /api/v1/user", { status: 429, headers: { "retry-after": String(40 * 60) } });
    t.clock.advance(QUARTER - 1_000);
    await verifiedAt(client, steady, after(QUARTER));
    await vi.waitFor(async () => expect((await accountOn(client, limited))?.problem).toMatchObject({ kind: "unreachable", since: after(QUARTER) }), { timeout: WAIT_MS });
    limited.user(TOKEN, DAVID);
    // Its verification, a forge.account.* event, checks the step a second on, as the step's cadence falls due then too: it reads what was found.
    expect(await checkedASecondOn(t, client)).toMatchObject({
      state: "needs-attention",
      reason: `${davidOn(limited)} did not answer its verification: Check again once its forge is reachable.`,
      failing: ["forges.identity"],
    });
    expect([askedWho(steady) - steadyAsked, askedWho(limited) - limitedAsked]).toEqual([1, 1]);

    // Thirty and forty-five minutes on, the verifier's schedule and a second later the step's cadence: the paused forge account is asked nothing.
    for (const quarter of [2, 3]) {
      t.clock.advance(QUARTER - 1_000);
      await verifiedAt(client, steady, after(quarter * QUARTER));
      expect(await checkedASecondOn(t, client)).toMatchObject({ state: "needs-attention", failing: ["forges.identity"] });
    }
    expect([askedWho(steady) - steadyAsked, askedWho(limited) - limitedAsked]).toEqual([3, 1]);

    // Its time, fifty-five minutes on, it is verified again, and the step reads it so a second later; an hour on, the steady one is verified the fourth time.
    t.clock.advance(10 * MINUTE - 1_000);
    await vi.waitFor(async () => expect((await accountOn(client, limited))?.problem).toBeNull(), { timeout: WAIT_MS });
    expect(await checkedASecondOn(t, client)).toMatchObject({ state: "done", reason: "2 forges connected." });
    t.clock.advance(5 * MINUTE - 1_000);
    await verifiedAt(client, steady, after(4 * QUARTER));
    expect([askedWho(steady) - steadyAsked, askedWho(limited) - limitedAsked]).toEqual([4, 2]);
  });

  it("checks fresh when a client asks, so Check again verifies a forge account verified a moment ago, but asks a forge that paused it nothing", async () => {
    const { t, forge, client } = await withForge();
    await added(client, { url: forge.origin, kind: "forgejo" });
    t.clock.advance(0);
    await verifiedAt(client, forge, MANUAL_CLOCK_START);
    const asked = askedWho(forge);
    forge.answer(TOKEN, "GET /api/v1/user", { status: 429, headers: { "retry-after": String(60 * 60) } });

    const unreachable = { state: "needs-attention", reason: `${davidOn(forge)} did not answer its verification: Check again once its forge is reachable.`, failing: ["forges.identity"] };
    expect(await checkForges(client)).toMatchObject(unreachable);
    expect(askedWho(forge)).toBe(asked + 1);

    // The forge asked for an hour: a client's check reads what that verification found until then, however the forge would answer now.
    forge.user(TOKEN, DAVID);
    expect(await checkForges(client)).toMatchObject(unreachable);
    expect(askedWho(forge)).toBe(asked + 1);
  });
});

describe("the verification setup.check awaits (ADR 0031's ten seconds)", () => {
  /** Resolves once the fake forge has been asked who the token is `count` times, whatever the wall clock. */
  const askedWhoTimes = (forge: FakeForge, count: number) =>
    vi.waitFor(() => expect(forge.requests.filter((request) => request.path === "/api/v1/user")).toHaveLength(count), { timeout: WAIT_MS });

  it("answers what the verification found once the forge answers, within the budget on the environment's clock", async () => {
    const { t, forge, client } = await withForge();
    await added(client, { url: forge.origin, kind: "forgejo" });
    const { held, release } = hold();
    forge.user(TOKEN, DAVID, held);

    const checking = checkForges(client);
    await askedWhoTimes(forge, 2);
    t.clock.advance(9_999);
    release();
    expect(await checking).toMatchObject({ state: "done", reason: holds(forge), checkedAt: MANUAL_CLOCK_START });
  });

  it("answers could not check with Check again past ten seconds, naming the checks still awaiting it, the last good result beneath, whatever the forge answers later", async () => {
    const { t, forge, client } = await withForge();
    await added(client, { url: forge.origin, kind: "forgejo" });
    expect(await checkForges(client)).toMatchObject({ state: "done" });
    t.clock.advance(60_000);
    const { held, release } = hold();
    forge.user(TOKEN, DAVID, held);

    const checking = checkForges(client);
    await askedWhoTimes(forge, 3);
    t.clock.advance(10_000);
    const timedOut = await checking;
    release();
    expect(timedOut).toEqual({
      step: "forges",
      state: "needs-attention",
      reason: "Checking took too long. Choose Check again.",
      details: ["Stopped after 10 seconds."],
      failing: ["forges.identity", "forges.reads", "forges.expiry"],
      actions: ["check-again"],
      checkedAt: after(60_000),
      lastGood: { state: "done", reason: holds(forge), checkedAt: MANUAL_CLOCK_START },
    });
  });
});
