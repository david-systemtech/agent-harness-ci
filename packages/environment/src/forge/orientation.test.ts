import { randomUUID } from "node:crypto";
import { EMPTY_RUN_SKILL_SET, RUN_SECRET_VARIABLE, registry, type KeyManagerReference, type RunInstructionsComposedPayload } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, OTHER_TOKEN, TOKEN, added, pasted, remove, setPrimary, update, verify } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { scriptedKeyManagers } from "../../test/key-managers.js";
import { create, workspace } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import type { InjectionDecision } from "../adapter/process-environment.js";
import { undecidedTrust, type InstructionScope } from "../adapter/seams.js";
import type { OrientationContent } from "../instructions/orientation.js";

/**
 * The orientation block's forges section (forge spec, "Orientation";
 * key-managers spec, "The orientation block"; ADR 0012, ADR 0020; #318)
 * through the primary seam: an in-process environment whose git names a
 * stand-in as its credential helper, the fake forge answering its API, the
 * scripted fake adapter reporting the instructions each run was handed and
 * each process was spawned with, and the manual clock. What is asserted is
 * the text a run is handed and which process serves it.
 */

const { onCleanup } = useCleanups();

/** The command git would name as its helper: never run here. */
const HELPER = ["/opt/agent-harness/bin/agent-harness"];

const fakeForge = async (): Promise<FakeForge> => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  return forge;
};

const start = async (forge: FakeForge, options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ forgeFetch: forge.fetch, harnessCommand: HELPER, ...options });
  onCleanup(() => t.close());
  return t;
};

const ended = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended");

/** Starts a run on the session, waits for its end, and answers the instructions it was handed. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<string> => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1));
  return t.adapter.lastRun().input.instructions;
};

const MINUTE = 60_000;

/** The fake forge's origin as the section names it: its host and port. */
const hostOf = (forge: FakeForge): string => forge.origin.replace(/^https?:\/\//, "");

describe("the forges section", () => {
  it("names each forge account on one line with its slug, kind, login and status since that status last changed", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    forge.user(OTHER_TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    await added(client, { url: "https://github.com", credential: pasted(OTHER_TOKEN) });
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    expect(text).toContain(
      [
        `- home: ${hostOf(forge)} (Forgejo), login david: verified, unchanged since 2026-09-24 00:00 UTC.`,
        "- github: GitHub, login david: verified, unchanged since 2026-09-24 00:00 UTC.",
      ].join("\n"),
    );
  });

  it("is byte-identical across verifications that find nothing new, never naming when one ran, so the session's process is reused", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    const session = await create(client);
    const first = await runTo(t, client, session.id);
    const identityReads = () => forge.requests.filter((request) => request.path === "/api/v1/user").length;
    const readsBefore = identityReads();

    // The scheduled verification at 00:15, then one asked for at 00:20: neither finds anything new.
    t.clock.advance(16 * MINUTE);
    await vi.waitFor(() => expect(identityReads()).toBe(readsBefore + 1));
    t.clock.advance(4 * MINUTE);
    await verify(client);
    const second = await runTo(t, client, session.id, "After the verifications");

    expect(second).toBe(first);
    expect(second).toContain("verified, unchanged since 2026-09-24 00:00 UTC.");
    expect(second).not.toMatch(/00:1[56]|00:20/);
    expect(t.adapter.processesOf(session.id)).toHaveLength(1);
  });

  it("states a problem with when it began, and the session's next run gets a fresh process spawned with the new text", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    const session = await create(client);
    const before = await runTo(t, client, session.id);

    t.clock.advance(7 * MINUTE);
    forge.answer(TOKEN, "GET /api/v1/user", { status: 401, body: { message: "token is required" } });
    await verify(client);
    const after = await runTo(t, client, session.id, "After the rejection");

    expect(after).not.toBe(before);
    expect(after).toContain(
      `- home: ${hostOf(forge)} (Forgejo), login david: credential rejected since 2026-09-24 00:07 UTC. ${hostOf(forge)} did not accept the token for david. Create a new token and add it.`,
    );
    const processes = t.adapter.processesOf(session.id);
    expect(processes).toHaveLength(2);
    expect(processes.map((process) => process.instructions)).toEqual([before, after]);
  });

  it("names the primary with the rest as also connected, and says repositories go to it unless the user names another", async () => {
    const forge = await fakeForge();
    const work = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    for (const at of [forge, work]) at.user(TOKEN, DAVID);
    forge.user(OTHER_TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    const session = await create(client);
    const alone = await runTo(t, client, session.id);
    const github = await added(client, { url: "https://github.com", credential: pasted(OTHER_TOKEN) });
    await added(client, { url: work.origin, kind: "gitea", slug: "work" });
    const three = await runTo(t, client, session.id, "Three forges");
    await setPrimary(client, github.id);
    const moved = await runTo(t, client, session.id, "GitHub primary");
    await remove(client, github.id);
    const none = await runTo(t, client, session.id, "No primary");

    const repositories = "Repositories go to the primary forge unless the user names another.";
    expect(alone).toContain(`Your primary forge is ${hostOf(forge)} (Forgejo). ${repositories}`);
    expect(three).toContain(`Your primary forge is ${hostOf(forge)} (Forgejo); GitHub and ${hostOf(work)} (Gitea) are also connected. ${repositories}`);
    expect(moved).toContain(`Your primary forge is GitHub; ${hostOf(forge)} (Forgejo) and ${hostOf(work)} (Gitea) are also connected. ${repositories}`);
    expect(none).toContain(`No forge is primary here; ${hostOf(forge)} (Forgejo) and ${hostOf(work)} (Gitea) are connected. Ask the user which forge a new repository goes to.`);
    expect(none).not.toContain(repositories);
    expect(t.adapter.processesOf(session.id)).toHaveLength(4);
  });

  it("lists each slug's variables and API base", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    forge.user(OTHER_TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    await added(client, { url: "https://github.com", credential: pasted(OTHER_TOKEN) });
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    expect(text).toContain(
      [
        "Variables each run is given, by slug (the origin in *_URL, the token in *_TOKEN, the kind in *_KIND), with each forge's API base:",
        `- home: FORGE_HOME_URL, FORGE_URL, FORGE_HOME_TOKEN, FORGE_TOKEN, FORGE_HOME_KIND and FORGE_KIND; API base ${forge.origin}/api/v1.`,
        "- github: FORGE_GITHUB_URL, FORGE_GITHUB_TOKEN, GH_TOKEN and FORGE_GITHUB_KIND; API base https://api.github.com.",
      ].join("\n"),
    );
  });

  it("names each forge account's failed and unknown writes, and a write learned changes the text for a fresh process", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    forge.user(OTHER_TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    await added(client, { url: "https://github.com", credential: pasted(OTHER_TOKEN) });
    const session = await create(client);
    const before = await runTo(t, client, session.id);
    const createBank = () => t.env.forge.repositories.create({ name: "bank", private: true, purpose: "create a bank" });

    forge.answer(TOKEN, "POST /api/v1/user/repos", { status: 403, body: { message: "token does not have at least one of required scope(s)" } });
    expect(await createBank()).toMatchObject({ outcome: "failed", status: 403 });
    const failed = await runTo(t, client, session.id, "After the refusal");
    forge.answer(TOKEN, "POST /api/v1/user/repos", { status: 201, body: { full_name: "david/bank", private: true, default_branch: "main", html_url: `${forge.origin}/david/bank` } });
    expect(await createBank()).toMatchObject({ outcome: "done" });
    const verified = await runTo(t, client, session.id, "After the success");

    const heading = "Writes not known to work, by slug:";
    const github = "- github: writing issues, writing pull requests and creating repositories not known yet.";
    expect(before).toContain([heading, "- home: writing issues, writing pull requests and creating repositories not known yet.", github].join("\n"));
    expect(failed).toContain([heading, "- home: creating repositories failed (HTTP 403); writing issues and writing pull requests not known yet.", github].join("\n"));
    expect(verified).toContain([heading, "- home: writing issues and writing pull requests not known yet.", github].join("\n"));
    expect(t.adapter.processesOf(session.id).map((process) => process.instructions)).toEqual([before, failed, verified]);
  });

  it("names each forge account left out of runs with the reason: no credential, another identity, or a credential that could not be read", async () => {
    const forge = await fakeForge();
    const other = await fakeForge();
    const keyManagers = scriptedKeyManagers();
    const reference: KeyManagerReference = { provider: "openbao", connectionId: "c0ffee00-0000-4000-8000-000000000001", mount: "personal", path: "forge/work", key: "token" };
    keyManagers.answer(reference, OTHER_TOKEN);
    const t = await start(forge, { keyManagers: keyManagers.registry });
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    other.user(TOKEN, DAVID);
    other.user(OTHER_TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    await added(client, { url: "https://github.com", credential: { kind: "none" } });
    await added(client, { url: other.origin, kind: "gitea", slug: "changed" });
    await added(client, { url: "https://git.example", kind: "forgejo", slug: "work", credential: { kind: "reference", reference } });
    other.user(TOKEN, { login: "someone", id: 7 });
    keyManagers.answer(reference, null);
    // The spawn logs the token it cannot read.
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    const verified = await verify(client);
    expect(verified.map((account) => [account.slug, account.problem?.kind ?? null])).toEqual([
      ["home", null],
      ["github", "needs-credential"],
      ["changed", "identity-changed"],
      ["work", "credential-unavailable"],
    ]);
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    expect(text).toContain(
      [
        "Left out of runs, by slug:",
        "- github: no credential on this environment yet, so runs get no variables or git credential for it.",
        "- changed: its credential now answers as another user, so runs get no variables or git credential for it.",
        "- work: its credential could not be read when last checked, so runs may get no token or git credential for it.",
      ].join("\n"),
    );
  });

  it("says git over https to the served origins just works while ssh uses the user's keys, and other origins have no credential here", async () => {
    const forge = await fakeForge();
    const tailnet = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    for (const at of [forge, tailnet]) at.user(TOKEN, DAVID);
    forge.user(OTHER_TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home", aliases: [tailnet.origin, "http://127.0.0.1:1"] });
    await added(client, { url: "https://github.com", credential: pasted(OTHER_TOKEN) });
    await added(client, { url: "https://git.example", kind: "forgejo", slug: "copy", credential: { kind: "none" } });
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    // The alias that never verified is not served, and neither is the copy awaiting its credential.
    expect(text.split("\n\n").at(-1)).toBe(
      `Git over https to these origins just works, the harness's credential helper answering for it: ${forge.origin}, ${tailnet.origin} and https://github.com. ` +
        "ssh uses the user's own keys. Other origins have no credential here.",
    );
  });

  it("with no forge account says none is connected, and one added gives the next run a fresh process with its lines", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    const session = await create(client);
    const none = await runTo(t, client, session.id);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    const one = await runTo(t, client, session.id, "One forge");

    expect(
      none.endsWith(
        [
          "## Forges",
          "No forge is connected here: git over https has no credential here, and ssh uses the user's own keys. Ask the user to connect a forge in Set up, Forges rather than searching for a token.",
        ].join("\n\n"),
      ),
    ).toBe(true);
    expect(one).toContain(`- home: ${hostOf(forge)} (Forgejo), login david: verified, unchanged since 2026-09-24 00:00 UTC.`);
    expect(t.adapter.processesOf(session.id).map((process) => process.instructions)).toEqual([none, one]);
  });

  it("tells a run denied injection its forges and primary, and in one line that it is given no forge variables or git credential and who denied it; allowed after, the next run gets the whole section in a fresh process", async () => {
    const forge = await fakeForge();
    let decision: InjectionDecision = { answer: "deny", level: { kind: "account", id: "claude-max" } };
    const t = await start(forge, { adapterSeams: { injection: () => decision } });
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    forge.user(OTHER_TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    await added(client, { url: "https://github.com", credential: pasted(OTHER_TOKEN) });
    await added(client, { url: "https://git.example", kind: "forgejo", slug: "copy", credential: { kind: "none" } });
    const session = await create(client);

    const denied = await runTo(t, client, session.id);
    decision = { answer: "allow", level: { kind: "environment" } };
    const allowed = await runTo(t, client, session.id, "Allowed now");

    expect(
      denied.endsWith(
        [
          "## Forges",
          [
            `- home: ${hostOf(forge)} (Forgejo), login david: verified, unchanged since 2026-09-24 00:00 UTC.`,
            "- github: GitHub, login david: verified, unchanged since 2026-09-24 00:00 UTC.",
            "- copy: git.example (Forgejo), login not known yet: needs a credential since 2026-09-24 00:00 UTC. git.example has no token yet. Add one.",
          ].join("\n"),
          `Your primary forge is ${hostOf(forge)} (Forgejo); GitHub and git.example (Forgejo) are also connected. Repositories go to the primary forge unless the user names another.`,
          "This run is given no forge variables or git credential: credential injection is denied for it by the account claude-max. ssh uses the user's own keys.",
        ].join("\n\n"),
      ),
      denied,
    ).toBe(true);
    for (const withheld of ["FORGE_", "GH_TOKEN", "API base", "just works", "Writes not known to work", "Left out of runs"]) expect(denied).not.toContain(withheld);
    expect(allowed).toContain("Variables each run is given, by slug");
    expect(allowed).toContain(`- home: FORGE_HOME_URL, FORGE_URL, FORGE_HOME_TOKEN, FORGE_TOKEN, FORGE_HOME_KIND and FORGE_KIND; API base ${forge.origin}/api/v1.`);
    expect(allowed).toContain("Writes not known to work, by slug:");
    expect(allowed).toContain("- copy: no credential on this environment yet, so runs get no variables or git credential for it.");
    expect(allowed).toContain(`Git over https to these origins just works, the harness's credential helper answering for it: ${forge.origin} and https://github.com.`);
    expect(allowed).not.toContain("credential injection is denied");
    expect(t.adapter.processesOf(session.id).map((process) => process.instructions)).toEqual([denied, allowed]);
  });

  it("names who denied the run injection: this environment's setting, or the routine or bot by id, each answer a fresh process", async () => {
    const forge = await fakeForge();
    const routine = "c0ffee00-0000-4000-8000-00000000000a";
    const bot = "c0ffee00-0000-4000-8000-00000000000b";
    const levels: InjectionDecision["level"][] = [{ kind: "environment" }, { kind: "routine", id: routine }, { kind: "bot", id: bot }];
    let level = levels[0] as InjectionDecision["level"];
    const t = await start(forge, { adapterSeams: { injection: () => ({ answer: "deny", level }) } });
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    const session = await create(client);

    const texts: string[] = [];
    for (const denying of levels) {
      level = denying;
      texts.push(await runTo(t, client, session.id, `Denied by ${denying.kind}`));
    }

    const given = "This run is given no forge variables or git credential: credential injection is denied for it by";
    const ssh = "ssh uses the user's own keys.";
    expect(texts.map((text) => text.split("\n\n").at(-1))).toEqual([
      `${given} this environment's setting. ${ssh}`,
      `${given} the routine ${routine}. ${ssh}`,
      `${given} the bot ${bot}. ${ssh}`,
    ]);
    expect(t.adapter.processesOf(session.id).map((process) => process.instructions)).toEqual(texts);
  });

  it("names a renamed slug and its variables, and the next run gets a fresh process", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    const home = await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    const session = await create(client);
    const before = await runTo(t, client, session.id);

    await update(client, { forgeAccountId: home.id, slug: "house" });
    const after = await runTo(t, client, session.id, "After the rename");

    expect(after).toContain(`- house: ${hostOf(forge)} (Forgejo), login david: verified, unchanged since 2026-09-24 00:00 UTC.`);
    expect(after).toContain(`- house: FORGE_HOUSE_URL, FORGE_URL, FORGE_HOUSE_TOKEN, FORGE_TOKEN, FORGE_HOUSE_KIND and FORGE_KIND; API base ${forge.origin}/api/v1.`);
    expect(after).not.toContain("FORGE_HOME_");
    expect(t.adapter.processesOf(session.id).map((process) => process.instructions)).toEqual([before, after]);
  });

  it("never holds a token, the run's secret or when anything was last verified", async () => {
    const forge = await fakeForge();
    const keyManagers = scriptedKeyManagers();
    const reference: KeyManagerReference = { provider: "openbao", connectionId: "c0ffee00-0000-4000-8000-000000000001", mount: "personal", path: "forge/home", key: "token" };
    keyManagers.answer(reference, TOKEN);
    const t = await start(forge, { keyManagers: keyManagers.registry });
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    forge.user(OTHER_TOKEN, DAVID);
    forge.repositories(TOKEN, ["david/receipts"]);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home", credential: { kind: "reference", reference } });
    await added(client, { url: "https://github.com", credential: pasted(OTHER_TOKEN) });
    // A write shown at 00:03, a verification that reads the repository at 00:09.
    t.clock.advance(3 * MINUTE);
    forge.answer(TOKEN, "POST /api/v1/user/repos", { status: 201, body: { full_name: "david/bank", private: true, default_branch: "main", html_url: `${forge.origin}/david/bank` } });
    expect(await t.env.forge.repositories.create({ name: "bank", private: true, purpose: "create a bank" })).toMatchObject({ outcome: "done" });
    t.clock.advance(6 * MINUTE);
    const records = await verify(client);
    expect(records.flatMap((account) => Object.values(account.capabilities).map((capability) => capability.verifiedAt))).toEqual(
      expect.arrayContaining(["2026-09-24T00:03:00.000Z", "2026-09-24T00:09:00.000Z"]),
    );
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    const secret = (await t.adapter.processesOf(session.id).at(-1)?.supplied)?.[RUN_SECRET_VARIABLE] ?? "";
    expect(secret).not.toBe("");
    for (const value of [TOKEN, OTHER_TOKEN, secret, "00:03", "00:09"]) expect(text).not.toContain(value);
  });
});

describe("the forges section in the orientation block", () => {
  /** The manifest of the session's latest composition. */
  const manifestOf = (t: TestEnvironment, sessionId: string) =>
    (t.env.log.readStream({ kind: "session", id: sessionId }).findLast((event) => event.type === "run.instructions.composed")?.payload as RunInstructionsComposedPayload | undefined)?.manifest;

  it("is registered after this environment's, the accounts' and the key managers' sections, in the user layer's orientation part", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    expect(text.startsWith("# Orientation\n\n## This environment\n\n")).toBe(true);
    expect(text.match(/^## .+$/gm)).toEqual(["## This environment", "## Accounts", "## Key managers", "## Forges"]);
    expect(text).toContain(`## Forges\n\n- home: ${hostOf(forge)} (Forgejo)`);
    expect(manifestOf(t, session.id)).toMatchObject({ layers: [{ layer: "user", parts: [{ id: "orientation", characters: text.length }] }], unreadRegistries: [] });
  });

  it("has the renderer's provider shape: its name and title, and its paragraphs from state at once", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    const session = await create(client);
    const section = t.env.forge.orientation;
    if (section === undefined) throw new Error("The ForgeService gave no forges section.");
    const scope: InstructionScope = {
      sessionId: session.id,
      accountId: "claude-max",
      workspace,
      repositoryIdentity: null,
      trust: undecidedTrust({ workspace, repositoryIdentity: null }),
      skillSet: EMPTY_RUN_SKILL_SET,
      origin: "client",
      containment: "off",
      injection: { answer: "allow", level: { kind: "environment" } },
      bot: null,
      alwaysOn: [],
      channel: { kind: "system-prompt-append", maxCharacters: null },
      nativeProjectInstructions: true,
    };

    const rendered = section.render(scope);

    expect({ name: section.name, title: section.title }).toEqual({ name: "forges", title: "Forges" });
    // Paragraphs, not a promise: read from the read model with nothing awaited, well within the renderer's one second.
    expect(Array.isArray(rendered)).toBe(true);
    expect((rendered as OrientationContent)[0]).toEqual({ items: [`home: ${hostOf(forge)} (Forgejo), login david: verified, unchanged since 2026-09-24 00:00 UTC.`] });
  });
});
