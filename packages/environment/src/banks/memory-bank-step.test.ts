import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ENVIRONMENT_STREAM_KIND, registry, type BankRecord, type EventFrame, type Frame, type ParamsOf, type ResponseOf, type StepResult } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { changed, markdown, PERSONAL_BANK, personalManifest, TEAM_BANK } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { end, fakeAdapter, say, type Script } from "../../test/fake-adapter.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { get } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import { branchesOf, git } from "../../test/workspaces.js";
import * as gitRunner from "../workspace/git.js";
import { TRIGGER_WINDOW_MS } from "../setup/scheduler.js";
import { describeRepositoryAt } from "./describe-repository.js";

/**
 * The Memory bank step (setup spec, "6. Memory bank"; banks spec, "The
 * Memory bank step and the orientation block"; ADR 0019, ADR 0031; #586,
 * #1025) through the primary seam: an in-process environment and a real
 * client over a real WebSocket, the banks git repositories on disk
 * registered through `banks.register` and verified by the BankService, a
 * team bank's repository and owners on the fake forge: a valid personal and
 * team bank, an invalid one, one with no BANK.md, an unreachable one, one
 * awaiting review and a team bank with an unknown owner. What is asserted
 * is what `setup.check` answers a client, and the step's result in the
 * snapshot once a trigger has checked it.
 */

const { onCleanup, tempDir } = useCleanups();

/** The step's line when every check holds: one sentence of what was found, never its checks' conditions (#1698). */
const ALL_HOLD = "Your notebook is ready.";

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  await t.env.setup.startPass;
  return t;
};

/** A git repository at a folder named `name` holding `files` in one commit on main. */
const gitBank = (files: Readonly<Record<string, string>>, name: string): string => {
  const root = join(tempDir("agent-harness-bank-"), name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "--allow-empty", "-m", "The bank.");
  return root;
};

/** The bank `banks.register` made of the checkout `path`; throws unless it was accepted. */
const register = async (client: WireClient, path: string, params: Partial<Omit<ParamsOf<"banks.register">, "commandId" | "path">> = {}): Promise<BankRecord> => {
  const answer: ResponseOf<"banks.register"> = await client.request("banks.register", {
    commandId: randomUUID(),
    bankId: randomUUID(),
    path,
    role: "read-write",
    accounts: "all",
    repositories: "all",
    defaultFor: [],
    ...params,
  });
  if (answer.result === undefined) throw new Error(`banks.register was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.bank;
};

/** A fake forge with the test's forge account on it. */
const forgeFor = async (client: WireClient): Promise<FakeForge> => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  await added(client, { url: forge.origin, kind: "forgejo" });
  return forge;
};

/** Scripts whether the forge has a user by each login. */
const users = (forge: FakeForge, found: Readonly<Record<string, boolean>>): void => {
  for (const [login, is] of Object.entries(found)) {
    forge.answer(TOKEN, `GET /api/v1/users/${login}`, is ? { status: 200, body: { id: 7, login } } : { status: 404, body: { message: "user does not exist" } });
  }
};

/** The team bank `files` in a checkout whose origin is `acme/bank` on the fake forge, which answers for it and both its owners. */
const teamBank = (forge: FakeForge, files: Readonly<Record<string, string>> = TEAM_BANK): string => {
  const checkout = gitBank(files, "acme");
  git(checkout, "remote", "add", "origin", `${forge.origin}/acme/bank.git`);
  forge.repository(TOKEN, "acme/bank");
  users(forge, { "maya-reyes": true, "sam-ortiz": true });
  return checkout;
};

/** The bank as a target of `action`. */
const target = (action: string, bank: BankRecord) => ({ action, kind: "bank", id: bank.id, label: bank.name });

/** The one result `setup.check` answers for the Memory bank step. */
const checkMemoryBank = async (client: WireClient): Promise<StepResult> => {
  const { results } = await client.request("setup.check", { step: "memory-bank" });
  expect(results.map((result) => result.step)).toEqual(["memory-bank"]);
  return results[0] as StepResult;
};

/** Appends `type` for the bank on the environment stream, as the Lander and the registry's updates do. */
const appendBankEvent = (t: TestEnvironment, type: string, payload: Record<string, unknown>): void =>
  void t.env.log.atomically((tx) => t.env.log.append({ kind: ENVIRONMENT_STREAM_KIND, id: t.env.id }, [{ type, payload }], { tx, actor: "system:banks" }));

describe("the Memory bank step's checks", () => {
  it("answers skipped with memory-bank.present's line when no bank is registered", async () => {
    const skipped = { step: "memory-bank", state: "skipped", reason: "No notebook yet. Optional.", failing: [], actions: [], checkedAt: MANUAL_CLOCK_START };
    expect(await checkMemoryBank(await (await start()).client())).toEqual(skipped);
  });

  it("is done on a valid personal and team bank, its line every check's, offering revise targeting each enabled bank", async () => {
    const client = await (await start()).client();
    const forge = await forgeFor(client);
    const personal = await register(client, gitBank(PERSONAL_BANK, "maya-memory"));
    const team = await register(client, teamBank(forge));
    expect([personal.name, team.name, team.location]).toEqual(["maya-memory", "acme", { kind: "remote", origin: forge.origin, repository: "acme/bank" }]);
    expect(await checkMemoryBank(client)).toEqual({
      step: "memory-bank",
      state: "done",
      reason: "Your 2 notebooks are ready.",
      details: ["maya-memory", "acme"],
      failing: [],
      actions: ["revise"],
      targets: [target("revise", personal), target("revise", team)],
      checkedAt: MANUAL_CLOCK_START,
    });
  });

  it("reports a valid describe PR as awaiting review without claiming its manifest is on main", async () => {
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.user(TOKEN, DAVID);
    const remote = forge.gitRepository("acme/bank", { files: changed(TEAM_BANK, { "BANK.md": null }) });
    const client = await (await start({ harnessCommand: [process.execPath, "fake-credential-helper.mjs"], harnessGitConfig: [[`url.${pathToFileURL(remote).href}.insteadOf`, `${forge.origin}/acme/bank.git`]] })).client();
    await added(client, { url: forge.origin, kind: "forgejo" });
    const checkout = tempDir("agent-harness-bank-clone-");
    git(checkout, "clone", "--quiet", remote, ".");
    git(checkout, "remote", "set-url", "origin", `${forge.origin}/acme/bank.git`);
    forge.repository(TOKEN, "acme/bank");
    users(forge, { "maya-reyes": true, "sam-ortiz": true });
    const bank = await register(client, checkout);
    const sessionId = await minted(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    // Finish the run's before-run sync before authoring the review fixture and verifying it.
    await runEnded(client, sessionId);
    const workspace = (await get(client, sessionId)).workspace;
    if (workspace.kind !== "worktree") throw new Error("Describe needs a worktree.");
    const { path } = workspace;
    writeFileSync(join(path, "BANK.md"), TEAM_BANK["BANK.md"] ?? "");
    git(path, "add", "BANK.md");
    git(path, "commit", "--quiet", "-m", "Describe the bank.");
    git(path, "push", "--quiet", remote, `HEAD:refs/heads/setup/describe-${TODAY}`);
    forge.pullRequest(TOKEN, "acme/bank", 7, { head: `setup/describe-${TODAY}`, sha: git(path, "rev-parse", "HEAD").trim(), state: "open" });
    const verified = await client.request("banks.verify", { bankId: bank.id });
    expect(verified.banks[0]?.status.manifest).toEqual({ state: "awaiting-review", pullRequest: `${forge.origin}/acme/bank/pulls/7`, since: MANUAL_CLOCK_START });
    expect(await checkMemoryBank(client)).toMatchObject({
      state: "done",
      failing: [],
      actions: ["revise"],
      targets: [target("revise", bank)],
      // The pull request is named once: the manifest's line says the description waits, so the landing's does not again (#1698, #1854).
      reason: `${ALL_HOLD} ${bank.name}'s description is waiting for your approval on ${new URL(forge.origin).host}.`,
      details: [bank.name, `${forge.origin}/acme/bank/pulls/7`],
    });
    expect(existsSync(join(checkout, "BANK.md"))).toBe(false);
  });

  it("leaves an invalid describe PR needing attention rather than counting its manifest as awaiting review", async () => {
    const client = await (await start()).client();
    const forge = await forgeFor(client);
    const checkout = teamBank(forge, changed(TEAM_BANK, { "BANK.md": null }));
    const bank = await register(client, checkout);
    const sessionId = await minted(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    await runEnded(client, sessionId);
    const { path } = (await get(client, sessionId)).workspace;
    writeFileSync(join(path, "BANK.md"), (TEAM_BANK["BANK.md"] ?? "").replace("where-work-is-tracked", "missing-orientation"));
    git(path, "add", "BANK.md");
    git(path, "commit", "--quiet", "-m", "Describe the bank.");
    forge.pullRequest(TOKEN, "acme/bank", 7, { head: `setup/describe-${TODAY}`, sha: git(path, "rev-parse", "HEAD").trim(), state: "open" });
    expect(await checkMemoryBank(client)).toMatchObject({ state: "needs-attention", failing: ["memory-bank.manifest", "memory-bank.landing"], details: expect.arrayContaining([expect.stringContaining("orientation_missing")]) });
    expect((await client.request("banks.get", { bankId: bank.id })).bank?.status.manifest.state).toBe("missing");
  });

  it("does not count a local describe commit as the manifest of a PR still on an older head", async () => {
    const client = await (await start()).client();
    const forge = await forgeFor(client);
    const checkout = teamBank(forge, changed(TEAM_BANK, { "BANK.md": null }));
    const bank = await register(client, checkout);
    const sessionId = await minted(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    await runEnded(client, sessionId);
    const { path } = (await get(client, sessionId)).workspace;
    const oldHead = git(path, "rev-parse", "HEAD").trim();
    writeFileSync(join(path, "BANK.md"), TEAM_BANK["BANK.md"] ?? "");
    git(path, "add", "BANK.md");
    git(path, "commit", "--quiet", "-m", "Describe the bank.");
    forge.pullRequest(TOKEN, "acme/bank", 7, { head: `setup/describe-${TODAY}`, sha: oldHead, state: "open" });
    expect(await checkMemoryBank(client)).toMatchObject({ state: "needs-attention", failing: ["memory-bank.manifest"] });
  });

  it("needs attention on an invalid bank, naming the validator's rule it fails, with revise targeting it", async () => {
    const client = await (await start()).client();
    const invalid = await register(client, gitBank(changed(PERSONAL_BANK, { "BANK.md": markdown(personalManifest({ description: "The old key purpose replaces." })) }), "maya-memory"));
    expect(await checkMemoryBank(client)).toEqual({
      step: "memory-bank",
      state: "needs-attention",
      reason: "maya-memory's description has a problem: it uses keys from an older layout.",
      details: [expect.stringMatching(/^maya-memory: retired_key: .+/)],
      failing: ["memory-bank.manifest"],
      actions: ["revise"],
      targets: [target("revise", invalid)],
      checkedAt: MANUAL_CLOCK_START,
    });
  });

  it("registers a checkout with no BANK.md by its folder's name, and needs attention on it, with revise targeting it", async () => {
    const client = await (await start()).client();
    const missing = await register(client, gitBank(changed(PERSONAL_BANK, { "BANK.md": null }), "david-memory"));
    expect([missing.name, missing.kind, missing.line, missing.status.manifest]).toEqual(["david-memory", null, null, { state: "missing", since: MANUAL_CLOCK_START }]);
    expect(await checkMemoryBank(client)).toMatchObject({
      reason: "david-memory needs a description.",
      failing: ["memory-bank.manifest"],
      actions: ["revise"],
      targets: [target("revise", missing)],
    });
  });

  it("needs attention on a bank whose forge has no repository for it, saying so, with check-again targeting it", async () => {
    const client = await (await start()).client();
    const forge = await forgeFor(client);
    const checkout = teamBank(forge);
    forge.answer(TOKEN, "GET /api/v1/repos/acme/bank", { status: 404, body: { message: "repository does not exist" } });
    const unreachable = await register(client, checkout);
    expect(await checkMemoryBank(client)).toMatchObject({
      state: "needs-attention",
      reason: `The repository for acme is missing on ${new URL(forge.origin).host}.`,
      details: [`acme: ${forge.origin} has no repository acme/bank`],
      failing: ["memory-bank.reachable"],
      actions: ["check-again"],
      targets: [target("check-again", unreachable)],
    });
  });

  it("names a forge account missing on this computer, never a repository to check, when the forge refuses an anonymous read", async () => {
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    const client = await (await start()).client();
    const checkout = teamBank(forge);
    const bank = await register(client, checkout);
    const host = new URL(forge.origin).host;
    expect(await checkMemoryBank(client)).toMatchObject({
      state: "needs-attention",
      reason: `acme needs a forge account for ${host} on this computer.`,
      details: [`acme: agent-harness needed a forge for ${host} and found none. Add ${host}. (${forge.origin}: it refused an anonymous read (HTTP 401))`],
      failing: ["memory-bank.reachable"],
      targets: [target("check-again", bank)],
    });
    expect((await client.request("banks.get", { bankId: bank.id })).bank.status.reachable).toMatchObject({ state: "unreachable", cause: "no-forge-account" });
  });

  it("names the computer a bank was copied from when its forge account is there and not here", async () => {
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    const client = await (await start()).client();
    await register(client, teamBank(forge), { copiedFrom: { environmentId: randomUUID(), environmentName: "office-server" } });
    expect(await checkMemoryBank(client)).toMatchObject({
      reason: `Your ${new URL(forge.origin).host} account is connected on office-server, not here. Connect it here too.`,
      failing: ["memory-bank.reachable"],
    });
  });

  it("needs attention on a local bank whose repository is gone, with check-again targeting it", async () => {
    const client = await (await start()).client();
    const checkout = gitBank(PERSONAL_BANK, "maya-memory");
    const gone = await register(client, checkout);
    rmSync(checkout, { recursive: true, force: true });
    expect(await checkMemoryBank(client)).toMatchObject({
      reason: "maya-memory's folder on this computer is missing.",
      details: [`maya-memory: its repository at ${checkout} is not there`],
      failing: ["memory-bank.reachable"],
      targets: [target("check-again", gone)],
    });
  });

  it("needs attention on a team bank whose owner does not resolve on its forge, naming the owner, with no action", async () => {
    const client = await (await start()).client();
    const forge = await forgeFor(client);
    const checkout = teamBank(forge);
    users(forge, { "sam-ortiz": false });
    await register(client, checkout);
    expect(await checkMemoryBank(client)).toEqual({
      step: "memory-bank",
      state: "needs-attention",
      reason: `${new URL(forge.origin).host} does not know sam-ortiz, listed as an owner of acme.`,
      failing: ["memory-bank.owners"],
      actions: [],
      checkedAt: MANUAL_CLOCK_START,
    });
    users(forge, { "maya-reyes": false });
    const host = new URL(forge.origin).host;
    expect((await checkMemoryBank(client)).reason).toBe(`${host} does not know maya-reyes, listed as an owner of acme. ${host} does not know sam-ortiz, listed as an owner of acme.`);
  });

  it("needs attention on orientation names that name no memory, beside the validator's refusal of them", async () => {
    const client = await (await start()).client();
    await register(client, gitBank(changed(PERSONAL_BANK, { "BANK.md": markdown(personalManifest({ orientation: ["secrets-layout", "who-is-who"] })) }), "maya-memory"));
    expect(await checkMemoryBank(client)).toMatchObject({
      reason: expect.stringContaining("maya-memory's summary names notes that do not exist."),
      details: expect.arrayContaining(["maya-memory: who-is-who"]),
      failing: ["memory-bank.manifest", "memory-bank.orientation"],
    });
  });

  it("shows a reviewed landing as awaiting your review with its pull request", async () => {
    const t = await start();
    const client = await t.client();
    const bank = await register(client, gitBank(PERSONAL_BANK, "maya-memory"));
    const pullRequest = "https://git.example.test/maya/memory/pulls/7";
    appendBankEvent(t, "bank.awaiting-review", { bankId: bank.id, sessionId: null, pullRequest });
    expect(await checkMemoryBank(client)).toMatchObject({
      state: "done",
      failing: [],
      actions: ["revise"],
      targets: [target("revise", bank)],
      reason: `${ALL_HOLD} maya-memory's latest changes are waiting for your approval on git.example.test.`,
      details: ["maya-memory", pullRequest],
    });
    appendBankEvent(t, "bank.landed", { bankId: bank.id, sessionId: null, pullRequest, files: [] });
    expect(await checkMemoryBank(client)).toMatchObject({ state: "done", failing: [], reason: ALL_HOLD });
  });

  it("keeps a failed landing's step and reason through verifications until a landing passes, check-again targeting the bank", async () => {
    const t = await start();
    const client = await t.client();
    const bank = await register(client, gitBank(PERSONAL_BANK, "maya-memory"));
    appendBankEvent(t, "bank.landing-failed", { bankId: bank.id, sessionId: null, step: "push", reason: "The forge refused the push." });
    expect(await checkMemoryBank(client)).toMatchObject({
      reason: "The last change to maya-memory could not be saved.",
      details: ["maya-memory: push: The forge refused the push."],
      failing: ["memory-bank.landing"],
      actions: ["check-again"],
      targets: [target("check-again", bank)],
    });
    expect(await checkMemoryBank(client)).toMatchObject({ failing: ["memory-bank.landing"] });
    appendBankEvent(t, "bank.landed", { bankId: bank.id, sessionId: null, pullRequest: null, files: ["projects/personal/homelab/memories/backup-schedule.md"] });
    expect(await checkMemoryBank(client)).toMatchObject({ state: "done", failing: [] });
  });

  it("names every failing bank in one line, each check's lines in the registry's order", async () => {
    const client = await (await start()).client();
    const forge = await forgeFor(client);
    const missing = await register(client, gitBank(changed(PERSONAL_BANK, { "BANK.md": null }), "david-memory"));
    const checkout = teamBank(forge);
    users(forge, { "sam-ortiz": false });
    forge.answer(TOKEN, "GET /api/v1/repos/acme/bank", { status: 404, body: { message: "repository does not exist" } });
    const team = await register(client, checkout);
    expect(await checkMemoryBank(client)).toMatchObject({
      reason:
        `The repository for acme is missing on ${new URL(forge.origin).host}. ` +
        "david-memory needs a description. " +
        `${new URL(forge.origin).host} does not know sam-ortiz, listed as an owner of acme.`,
      failing: ["memory-bank.reachable", "memory-bank.manifest", "memory-bank.owners"],
      actions: ["check-again", "revise"],
      targets: [target("check-again", team), target("revise", missing)],
    });
  });

  it("leaves a disabled bank out of every check but memory-bank.present, and of revise's targets", async () => {
    const t = await start();
    const client = await t.client();
    const valid = await register(client, gitBank(PERSONAL_BANK, "maya-memory"));
    const disabled = await register(client, gitBank(changed(PERSONAL_BANK, { "BANK.md": null }), "david-memory"));
    appendBankEvent(t, "bank.updated", { bankId: disabled.id, enabled: false });
    expect(await checkMemoryBank(client)).toMatchObject({ state: "done", reason: ALL_HOLD, targets: [target("revise", valid)] });
  });

  it("verifies the banks before it answers, from the records' status as that verification left it", async () => {
    const client = await (await start()).client();
    const checkout = gitBank(PERSONAL_BANK, "maya-memory");
    await register(client, checkout);
    expect(await checkMemoryBank(client)).toMatchObject({ state: "done" });
    git(checkout, "rm", "--quiet", "BANK.md");
    git(checkout, "commit", "--quiet", "-m", "No manifest.");
    expect(await checkMemoryBank(client)).toMatchObject({ state: "needs-attention", failing: ["memory-bank.manifest"] });
  });

  it("answers within the git budget: a verification that never ends answers timed out after 30 s, with check-again and the last good result", async () => {
    const t = await start();
    const client = await t.client();
    const forge = await forgeFor(client);
    await register(client, teamBank(forge));
    expect(await checkMemoryBank(client)).toMatchObject({ state: "done" });
    let asked!: () => void;
    const hung = new Promise<void>((resolve) => (asked = resolve));
    forge.answer(TOKEN, "GET /api/v1/repos/acme/bank", () => {
      asked();
      return { status: 200, body: {}, after: new Promise(() => undefined) };
    });
    const answer = checkMemoryBank(client);
    await hung;
    t.clock.advance(30_000);
    expect(await answer).toMatchObject({
      state: "needs-attention",
      reason: "Checking took too long. Choose Check again.",
      failing: ["memory-bank.reachable", "memory-bank.manifest", "memory-bank.orientation", "memory-bank.owners", "memory-bank.landing"],
      actions: ["check-again"],
      lastGood: { state: "done", reason: ALL_HOLD, checkedAt: MANUAL_CLOCK_START },
    });
  });
});

/** The snapshot's result for `step`, cached by the last check that ran, whoever started it. */
const snapshotResult = async (t: TestEnvironment, client: WireClient, step: string): Promise<StepResult | undefined> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() + 100 });
  const frame = await client.next((f): f is Extract<Frame, { type: "snapshot" }> => f.type === "snapshot" && f.subscription === subscription);
  return registry["environment.subscribe"].result.parse(frame.payload).setup?.find((result) => result.step === step);
};

/** Lets the step scheduler's window pass, and waits for the Memory bank step's check it starts to change the step's result. */
const windowPasses = async (t: TestEnvironment, client: WireClient): Promise<void> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
  t.clock.advance(TRIGGER_WINDOW_MS);
  await client.next(
    (f): f is EventFrame =>
      f.type === "event" && f.subscription === subscription && f.event.type === "setup.result-changed" && (f.event.payload as StepResult).step === "memory-bank",
  );
};

describe("the Memory bank step's triggers", () => {
  it("checks the Memory bank and Instructions steps again within a second of a bank.* notice: a registration, then a verification that found a change", async () => {
    const t = await start();
    const client = await t.client();
    const checkout = gitBank(PERSONAL_BANK, "maya-memory");
    await register(client, checkout);
    await windowPasses(t, client);
    const first = new Date(Date.parse(MANUAL_CLOCK_START) + TRIGGER_WINDOW_MS).toISOString();
    expect(await snapshotResult(t, client, "memory-bank")).toMatchObject({ state: "done", checkedAt: first });

    git(checkout, "rm", "--quiet", "BANK.md");
    git(checkout, "commit", "--quiet", "-m", "No manifest.");
    await client.request("banks.verify", {});
    await windowPasses(t, client);
    const after = new Date(Date.parse(first) + TRIGGER_WINDOW_MS).toISOString();
    expect(await snapshotResult(t, client, "memory-bank")).toMatchObject({ state: "needs-attention", failing: ["memory-bank.manifest"], checkedAt: after });
    expect(await snapshotResult(t, client, "instructions")).toMatchObject({ checkedAt: after });
  });
});

/** A bank's repository as the BankService keeps it: a bare origin holding main's first commit, and the checkout cloned from it. */
const bankRepository = (files: Readonly<Record<string, string>> = { "README.md": "# david-memory\n" }): { readonly origin: string; readonly checkout: string } => {
  const root = tempDir();
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(root, "clone", "--quiet", origin, seed);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    writeFileSync(join(seed, path), text);
  }
  git(seed, "add", "--all");
  git(seed, "commit", "--quiet", "-m", "The bank's first commit.");
  git(seed, "push", "--quiet", "origin", "HEAD:main");
  const checkout = join(root, "david-memory");
  git(root, "clone", "--quiet", origin, checkout);
  return { origin, checkout };
};

/** `setup.mint` with a fresh command id. */
const mint = async (client: WireClient, params: Omit<ParamsOf<"setup.mint">, "commandId">): Promise<ResponseOf<"setup.mint">> =>
  client.request("setup.mint", { commandId: randomUUID(), ...params });

/** The session `setup.mint` answered, or fails the test with its receipt. */
const minted = async (client: WireClient, params: Omit<ParamsOf<"setup.mint">, "commandId">): Promise<string> => {
  const answer = await mint(client, params);
  expect(answer.receipt, JSON.stringify(answer.receipt)).toMatchObject({ status: "accepted" });
  if (answer.result === undefined) throw new Error("setup.mint answered no session.");
  return answer.result.sessionId;
};

/** Waits for the session's first run to end. */
const runEnded = async (client: WireClient, sessionId: string): Promise<void> => {
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence: 0 });
  await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === "run.ended");
};

/** The manual clock's day, as a describe session's branch is named by it. */
const TODAY = MANUAL_CLOCK_START.slice(0, 10);

describe("the describe session", () => {
  it("is minted for a bank in a writable worktree of it on a branch setup/describe-<date>, from its main and never in its checkout, starting with the describe prompt rendered from the bank", async () => {
    const { checkout } = bankRepository();
    const t = await start();
    const client = await t.client();
    const bank = await register(client, checkout);
    const sessionId = await minted(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    await runEnded(client, sessionId);

    const summary = await get(client, sessionId);
    expect(summary).toMatchObject({
      title: "Set up: Memory bank (david-memory)",
      tags: ["memory-bank", "setup"],
      workspace: { kind: "worktree", branch: `setup/describe-${TODAY}` },
    });
    const { path } = summary.workspace;
    expect(path).not.toBe(checkout);
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("# david-memory\n");
    writeFileSync(join(path, "BANK.md"), "kind: personal\n");
    expect(existsSync(join(checkout, "BANK.md"))).toBe(false);
    expect(git(checkout, "branch", "--show-current").trim()).toBe("main");
    const [prompt] = t.adapter.lastRun().input.prompt.map((message) => message.text);
    expect(prompt).toMatch(/^Describe the memory bank david-memory, a personal bank, by writing its BANK\.md\./);
  });

  it("mints concurrent describe sessions on distinct branches while the first ref is still locked", async () => {
    const { checkout } = bankRepository();
    const t = await start();
    const client = await t.client();
    const bank = await register(client, checkout);
    const repository = describeRepositoryAt(t.dataDir, checkout);
    const branch = `setup/describe-${TODAY}`;
    const lock = join(repository, "refs", "heads", `${branch}.lock`);
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const realGit = gitRunner.runGit;
    const spy = vi.spyOn(gitRunner, "runGit").mockImplementation(async (cwd, args, options) => {
      if (cwd === repository && args[0] === "branch" && args[2] === branch && !existsSync(lock)) {
        // Hold the ref exactly where a slow git writer has locked it but has not published it.
        mkdirSync(dirname(lock), { recursive: true });
        writeFileSync(lock, "");
        signalLocked();
        await held;
        rmSync(lock);
      }
      return realGit(cwd, args, options);
    });
    const first = mint(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    onCleanup(async () => {
      release();
      try { await first; } finally { spy.mockRestore(); }
    });
    await locked;
    let second: ResponseOf<"setup.mint">;
    try {
      second = await mint(client, { step: "memory-bank", subject: bank.id, variant: "revise" });
    } finally {
      release();
    }
    const answers = [await first, second];
    for (const answer of answers) expect(answer.receipt, JSON.stringify(answer.receipt)).toMatchObject({ status: "accepted" });
    const sessions = answers.map((answer) => {
      if (answer.result === undefined) throw new Error("setup.mint answered no session.");
      return answer.result.sessionId;
    });
    const summaries = await Promise.all(sessions.map((id) => get(client, id)));
    expect(summaries.map(({ workspace }) => workspace.kind === "worktree" ? workspace.branch : null).sort()).toEqual([
      `setup/describe-${TODAY}`, `setup/describe-${TODAY}-2`,
    ]);
    expect(branchesOf(checkout)).toEqual(["main"]);
    await Promise.all(sessions.map((id) => runEnded(client, id)));
  });

  it("releases a failed branch reservation so a later describe can reuse the available name", async () => {
    const { checkout } = bankRepository();
    const t = await start();
    const client = await t.client();
    const bank = await register(client, checkout);
    const repository = describeRepositoryAt(t.dataDir, checkout);
    const branch = `setup/describe-${TODAY}`;
    const lock = join(repository, "refs", "heads", `${branch}.lock`);
    const realGit = gitRunner.runGit;
    let blocked = false;
    const spy = vi.spyOn(gitRunner, "runGit").mockImplementation(async (cwd, args, options) => {
      if (cwd !== repository || args[0] !== "branch" || blocked) return realGit(cwd, args, options);
      blocked = true;
      mkdirSync(dirname(lock), { recursive: true });
      writeFileSync(lock, "");
      try {
        return await realGit(cwd, args, options);
      } finally {
        rmSync(lock);
      }
    });
    onCleanup(() => spy.mockRestore());
    const refused = await mint(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    expect(refused.receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", data: { reason: "git_failed", operation: "branch", diagnostic: "exit_128" } },
    });
    expect((await client.request("sessions.list", {})).sessions).toEqual([]);
    const sessionId = await minted(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    expect((await get(client, sessionId)).workspace).toMatchObject({ branch });
    await runEnded(client, sessionId);
  });

  it("takes the next free branch for a second session on the same day, the first one's branch kept", async () => {
    const { checkout } = bankRepository();
    const t = await start();
    const client = await t.client();
    const bank = await register(client, checkout);
    const first = await minted(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    const again = await minted(client, { step: "memory-bank", subject: bank.id, variant: "revise" });
    expect((await get(client, first)).workspace).toMatchObject({ branch: `setup/describe-${TODAY}` });
    expect((await get(client, again)).workspace).toMatchObject({ branch: `setup/describe-${TODAY}-2` });
    expect(branchesOf(checkout)).toEqual(["main"]);
    const repository = (await get(client, first)).workspace;
    if (repository.kind !== "worktree") throw new Error("The describe session needs a worktree.");
    expect(branchesOf(repository.repository)).toEqual(["main", `setup/describe-${TODAY}`, `setup/describe-${TODAY}-2`]);
    await runEnded(client, again);
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)[0]).toMatch(/^Revise BANK\.md of the memory bank david-memory, a personal bank\./);
  });

  it("starts a later describe session from the checkout's fresh main while preserving the first worktree", async () => {
    const { checkout } = bankRepository();
    const t = await start();
    const client = await t.client();
    const bank = await register(client, checkout);
    const first = await minted(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    const firstWorkspace = (await get(client, first)).workspace;
    writeFileSync(join(firstWorkspace.path, "draft.md"), "The first conversation's unfinished draft.");
    writeFileSync(join(checkout, "README.md"), "The bank's refreshed main.\n");
    git(checkout, "add", "README.md");
    git(checkout, "commit", "--quiet", "-m", "Refresh the bank.");
    const second = await minted(client, { step: "memory-bank", subject: bank.id, variant: "revise" });
    const secondWorkspace = (await get(client, second)).workspace;
    expect(readFileSync(join(secondWorkspace.path, "README.md"), "utf8")).toBe("The bank's refreshed main.\n");
    expect(readFileSync(join(firstWorkspace.path, "README.md"), "utf8")).toBe("# david-memory\n");
    expect(readFileSync(join(firstWorkspace.path, "draft.md"), "utf8")).toBe("The first conversation's unfinished draft.");
    expect(secondWorkspace).toMatchObject({ branch: `setup/describe-${TODAY}-2` });
  });

  it("keeps describe branches already in a registered checkout when naming a new session", async () => {
    const { checkout } = bankRepository();
    git(checkout, "branch", `setup/describe-${TODAY}`);
    const t = await start();
    const client = await t.client();
    const bank = await register(client, checkout);
    const sessionId = await minted(client, { step: "memory-bank", subject: bank.id, variant: "revise" });
    expect((await get(client, sessionId)).workspace).toMatchObject({ branch: `setup/describe-${TODAY}-2` });
    expect(branchesOf(checkout)).toEqual(["main", `setup/describe-${TODAY}`]);
  });

  it("reports a safe filesystem cause when describe metadata cannot be created", async () => {
    const { checkout } = bankRepository();
    const t = await start();
    const client = await t.client();
    const bank = await register(client, checkout);
    mkdirSync(join(t.dataDir, "worktrees"), { recursive: true });
    writeFileSync(join(t.dataDir, "worktrees", "bank-describe"), "A file blocks the metadata directory.");
    const answer = await mint(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    expect(answer.receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", data: { reason: "filesystem_failed", bankId: bank.id, errno: expect.stringMatching(/^(EEXIST|ENOTDIR)$/), repository: expect.stringContaining("bank-describe") } },
    });
    expect((await client.request("sessions.list", {})).sessions).toEqual([]);
  });

  it("identifies a stale describe destination without removing its contents, and can mint after it is repaired", async () => {
    const { checkout } = bankRepository();
    const t = await start();
    const client = await t.client();
    const bank = await register(client, checkout);
    const repository = describeRepositoryAt(t.dataDir, checkout);
    mkdirSync(repository, { recursive: true });
    const draft = join(repository, "draft.md");
    writeFileSync(draft, "Keep this draft.");
    const answer = await mint(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    expect(answer.receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", data: { reason: "filesystem_failed", repository, errno: expect.stringMatching(/^(ENOTEMPTY|EEXIST|EPERM)$/) } },
    });
    expect(readFileSync(draft, "utf8")).toBe("Keep this draft.");
    rmSync(repository, { recursive: true });
    await minted(client, { step: "memory-bank", subject: bank.id, variant: "first" });
  });

  it("reports only safe git status when a checkout has no main to describe", async () => {
    const { checkout } = bankRepository();
    const t = await start();
    const client = await t.client();
    const bank = await register(client, checkout);
    git(checkout, "checkout", "--quiet", "--detach");
    git(checkout, "branch", "-D", "main");
    git(checkout, "remote", "set-url", "origin", "https://user:token-for-tests@forge.invalid/memory.git");
    const answer = await mint(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    expect(answer.receipt).toMatchObject({
      status: "rejected",
      error: {
        code: "conflict",
        message: `agent-harness could not get ${bank.name} ready to describe. Choose Describe it to try again.`,
        data: { reason: "git_failed", operation: "clone", diagnostic: "exit_128" },
      },
    });
    expect(JSON.stringify(answer)).not.toContain("token-for-tests");
  });

  it("refuses a bank whose checkout is not there, and a call naming no bank, conflict bank_missing; a bank not registered is not_found; nothing is minted", async () => {
    const { checkout } = bankRepository();
    const t = await start();
    const client = await t.client();
    const gone = await register(client, checkout);
    rmSync(checkout, { recursive: true, force: true });
    expect((await mint(client, { step: "memory-bank", subject: gone.id, variant: "first" })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", message: `${gone.name}'s folder on this computer is missing.`, data: { reason: "bank_missing", bankId: gone.id, path: checkout } },
    });
    expect((await mint(client, { step: "memory-bank", variant: "first" })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", message: "Choose which notebook to describe.", data: { reason: "bank_missing" } },
    });
    expect((await mint(client, { step: "memory-bank", subject: "bank-9", variant: "first" })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "not_found", data: { kind: "subject", step: "memory-bank", subject: "bank-9" } },
    });
    expect((await client.request("sessions.list", {})).sessions).toEqual([]);
    expect(t.adapter.runs).toEqual([]);
  });

  it("whose run end lands BANK.md turns the step done, with nobody asking", async () => {
    const { checkout } = bankRepository(changed(PERSONAL_BANK, { "BANK.md": null }));
    // The session writes BANK.md in its worktree, commits it and lands it on the bank's main, as a review path's merge would.
    const describes: Script = async function* ({ input }) {
      writeFileSync(join(input.workspace.path, "BANK.md"), PERSONAL_BANK["BANK.md"] ?? "");
      git(input.workspace.path, "add", "BANK.md");
      git(input.workspace.path, "commit", "--quiet", "-m", "Describe the bank.");
      git(input.workspace.path, "push", "--quiet", "origin", "HEAD:main");
      yield say("BANK.md is landed.");
      yield end();
    };
    const t = await start({ adapter: fakeAdapter({ script: describes }) });
    const client = await t.client();
    const bank = await register(client, checkout);
    await windowPasses(t, client);
    expect(await snapshotResult(t, client, "memory-bank")).toMatchObject({ state: "needs-attention", failing: ["memory-bank.manifest"] });

    const sessionId = await minted(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    await runEnded(client, sessionId);
    // The before-run sync, standing in: the checkout fast-forwards to its origin's main.
    git(checkout, "pull", "--quiet", "--ff-only", "origin", "main");
    await windowPasses(t, client);
    expect(await snapshotResult(t, client, "memory-bank")).toEqual({
      step: "memory-bank",
      state: "done",
      reason: ALL_HOLD,
      details: ["maya-memory"],
      failing: [],
      actions: ["revise"],
      // The bank takes the name its landed BANK.md gives it.
      targets: [{ ...target("revise", bank), label: "maya-memory" }],
      checkedAt: new Date(Date.parse(MANUAL_CLOCK_START) + 2 * TRIGGER_WINDOW_MS).toISOString(),
    });
  });
});
