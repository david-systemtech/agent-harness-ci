import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry, type EventFrame, type Frame, type ParamsOf, type ResponseOf, type StepResult } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { end, fakeAdapter, say, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { get } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import { branchesOf, git } from "../../test/workspaces.js";
import { TRIGGER_WINDOW_MS } from "../setup/scheduler.js";
import type { BankRecord, BankRecords } from "./records.js";

/**
 * The Memory bank step (setup spec, "6. Memory bank"; banks spec, "The
 * Memory bank step and the orientation block"; ADR 0019, ADR 0031; #586)
 * through the primary seam: an in-process environment and a real client
 * over a real WebSocket, the registered banks a fixture standing for the
 * banks build's registry and verification (#90): a valid bank, an invalid
 * one, one awaiting review, an unreachable one and a team bank with an
 * unknown owner. What is asserted is what `setup.check` answers a client,
 * and the step's result in the snapshot once a trigger has checked it.
 */

const { onCleanup, tempDir } = useCleanups();

/** The step's line when every check holds. */
const ALL_HOLD =
  "At least one memory bank is registered on this environment. Each enabled bank's remote answers, or its local repository exists. " +
  "Each enabled bank's BANK.md on main passes the validator, or waits for review in an open pull request on a bank whose merges are reviewed. " +
  "Every orientation memory each enabled bank names exists. Each enabled team bank's owners resolve on its forge. No landing on an enabled bank has failed.";

/** A personal bank whose every check holds, as its last verification recorded it. */
const valid = (fields: Partial<BankRecord> = {}): BankRecord => ({
  id: "bank-personal",
  name: "david-memory",
  kind: "personal",
  enabled: true,
  checkout: "/data/banks/david-memory",
  entities: [{ name: "Homelab", aliases: ["home lab"] }],
  scopes: ["projects/personal/homelab/"],
  status: { reachable: { state: "reachable" }, manifest: { state: "valid" }, missingOrientation: [], unresolvedOwners: [], landingFailed: null },
  ...fields,
});

/** `bank` with its status as `status` changes it. */
const withStatus = (bank: BankRecord, status: Partial<BankRecord["status"]>): BankRecord => ({ ...bank, status: { ...bank.status, ...status } });

/** A team bank whose every check holds. */
const team = (fields: Partial<BankRecord> = {}): BankRecord =>
  valid({ id: "bank-team", name: "brandsolidate", kind: "team", checkout: "/data/banks/brandsolidate", scopes: ["projects/brandsolidate/cool-jams/"], ...fields });

/** The bank as a target of `action`. */
const target = (action: string, bank: BankRecord) => ({ action, kind: "bank", id: bank.id, label: bank.name });

/** Fixture banks: what is registered, each verification answering them as the test last set, counted. */
interface FixtureBanks extends BankRecords {
  set(banks: readonly BankRecord[]): void;
  verifications(): number;
}

const fixtureBanks = (initial: readonly BankRecord[]): FixtureBanks => {
  let banks = initial;
  let verifications = 0;
  return {
    list: () => banks,
    verify: async () => {
      verifications += 1;
      return banks;
    },
    set: (next) => void (banks = next),
    verifications: () => verifications,
  };
};

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  await t.env.setup.startPass;
  return t;
};

/** The one result `setup.check` answers for the Memory bank step. */
const checkMemoryBank = async (client: WireClient): Promise<StepResult> => {
  const { results } = await client.request("setup.check", { step: "memory-bank" });
  expect(results.map((result) => result.step)).toEqual(["memory-bank"]);
  return results[0] as StepResult;
};

/** The checked banks' result. */
const checked = async (banks: readonly BankRecord[]): Promise<StepResult> => checkMemoryBank(await (await start({ banks: fixtureBanks(banks) })).client());

describe("the Memory bank step's checks", () => {
  it("answers skipped with memory-bank.present's line when no bank is registered, as on an environment the banks build has not reached", async () => {
    const skipped = { step: "memory-bank", state: "skipped", reason: "No memory bank is registered on this environment.", failing: [], actions: [], checkedAt: MANUAL_CLOCK_START };
    expect(await checkMemoryBank(await (await start()).client())).toEqual(skipped);
    expect(await checked([])).toEqual(skipped);
  });

  it("is done on a valid bank, its line every check's, offering revise targeting each enabled bank", async () => {
    const other = team();
    expect(await checked([valid(), other])).toEqual({
      step: "memory-bank",
      state: "done",
      reason: ALL_HOLD,
      failing: [],
      actions: ["revise"],
      targets: [target("revise", valid()), target("revise", other)],
      checkedAt: MANUAL_CLOCK_START,
    });
  });

  it("counts a reviewed bank's open pull request holding BANK.md as landed and awaiting review: done", async () => {
    const awaiting = withStatus(team(), { manifest: { state: "awaiting-review", pullRequest: "https://git.example/brandsolidate/bank/pulls/7" } });
    expect(await checked([awaiting])).toMatchObject({ state: "done", reason: ALL_HOLD, failing: [] });
  });

  it("needs attention on an invalid bank, naming the validator's rule it fails, with revise targeting it", async () => {
    const invalid = withStatus(valid(), { manifest: { state: "invalid", rule: "purpose_too_long", message: "The purpose is longer than 160 characters." } });
    expect(await checked([invalid, team()])).toEqual({
      step: "memory-bank",
      state: "needs-attention",
      reason: "The BANK.md of david-memory on main fails the validator's rule purpose_too_long: The purpose is longer than 160 characters. Revise it.",
      failing: ["memory-bank.manifest"],
      actions: ["revise"],
      targets: [target("revise", invalid)],
      checkedAt: MANUAL_CLOCK_START,
    });
  });

  it("needs attention on a bank with no BANK.md on main, with revise targeting it", async () => {
    const missing = withStatus(valid(), { manifest: { state: "missing" } });
    expect(await checked([missing])).toMatchObject({
      reason: "david-memory has no BANK.md on main: Revise to write one.",
      failing: ["memory-bank.manifest"],
      actions: ["revise"],
      targets: [target("revise", missing)],
    });
  });

  it("needs attention on an unreachable bank, saying why, with check-again targeting it", async () => {
    const unreachable = withStatus(team(), { reachable: { state: "unreachable", reason: "git.example did not answer within 30 s." } });
    expect(await checked([valid(), unreachable])).toMatchObject({
      state: "needs-attention",
      reason: "brandsolidate cannot be reached: git.example did not answer within 30 s. Check again once it answers.",
      failing: ["memory-bank.reachable"],
      actions: ["check-again"],
      targets: [target("check-again", unreachable)],
    });
  });

  it("needs attention on a team bank whose owner does not resolve on its forge, naming the owner, with no action", async () => {
    const unknownOwner = withStatus(team(), { unresolvedOwners: ["albert-gone"] });
    expect(await checked([unknownOwner])).toEqual({
      step: "memory-bank",
      state: "needs-attention",
      reason: "The owner albert-gone of the team bank brandsolidate does not resolve on its forge.",
      failing: ["memory-bank.owners"],
      actions: [],
      checkedAt: MANUAL_CLOCK_START,
    });
    const twoUnknown = withStatus(team(), { unresolvedOwners: ["albert-gone", "seth-gone"] });
    expect((await checked([twoUnknown])).reason).toBe("The owners albert-gone and seth-gone of the team bank brandsolidate do not resolve on its forge.");
  });

  it("needs attention on orientation names that name no memory, and on a failed landing, check-again targeting the bank", async () => {
    const orientation = withStatus(valid(), { missingOrientation: ["homelab-map", "who-is-who"] });
    expect(await checked([orientation])).toMatchObject({
      reason: "The orientation of david-memory names homelab-map and who-is-who, which are no memory in the bank.",
      failing: ["memory-bank.orientation"],
      actions: [],
    });
    const landing = withStatus(team(), { landingFailed: { step: "push", reason: "The forge refused the push." } });
    expect(await checked([landing])).toMatchObject({
      reason: "The last landing on brandsolidate failed at its push step: The forge refused the push. Check again once a landing passes.",
      failing: ["memory-bank.landing"],
      actions: ["check-again"],
      targets: [target("check-again", landing)],
    });
  });

  it("names every failing bank in one line, each check's lines in the registry's order", async () => {
    const unreachable = withStatus(valid(), { reachable: { state: "unreachable", reason: "Its repository at /data/banks/david-memory is not there." } });
    const unknownOwner = withStatus(team(), { unresolvedOwners: ["albert-gone"], manifest: { state: "missing" } });
    expect(await checked([unreachable, unknownOwner])).toMatchObject({
      reason:
        "david-memory cannot be reached: Its repository at /data/banks/david-memory is not there. Check again once it answers. " +
        "brandsolidate has no BANK.md on main: Revise to write one. " +
        "The owner albert-gone of the team bank brandsolidate does not resolve on its forge.",
      failing: ["memory-bank.reachable", "memory-bank.manifest", "memory-bank.owners"],
      actions: ["check-again", "revise"],
      targets: [target("check-again", unreachable), target("revise", unknownOwner)],
    });
  });

  it("leaves a disabled bank out of every check but memory-bank.present, and of revise's targets", async () => {
    const disabled = withStatus(team({ enabled: false }), { reachable: { state: "unreachable", reason: "git.example did not answer within 30 s." }, unresolvedOwners: ["albert-gone"] });
    expect(await checked([disabled])).toMatchObject({ state: "done", reason: ALL_HOLD, actions: ["revise"] });
    expect(await checked([disabled])).not.toHaveProperty("targets");
    expect(await checked([valid(), disabled])).toMatchObject({ state: "done", targets: [target("revise", valid())] });
  });

  it("verifies the banks before it answers, from the records' status as that verification left it", async () => {
    const banks = fixtureBanks([valid()]);
    const client = await (await start({ banks })).client();
    const before = banks.verifications();
    banks.set([withStatus(valid(), { manifest: { state: "missing" } })]);
    expect(await checkMemoryBank(client)).toMatchObject({ state: "needs-attention", failing: ["memory-bank.manifest"] });
    expect(banks.verifications()).toBeGreaterThan(before);
  });

  it("answers within the git budget: a verification that never ends answers timed out after 30 s, with check-again and the last good result", async () => {
    let hang = false;
    let verifying!: () => void;
    const hung = new Promise<void>((resolve) => (verifying = resolve));
    const banks: BankRecords = {
      list: () => [valid()],
      verify: () => {
        if (!hang) return Promise.resolve([valid()]);
        verifying();
        return new Promise(() => undefined);
      },
    };
    const t = await start({ banks });
    const client = await t.client();
    hang = true;
    const answer = checkMemoryBank(client);
    // The budget's timer is set as the check starts, before it asks for the verification.
    await hung;
    t.clock.advance(30_000);
    expect(await answer).toMatchObject({
      state: "needs-attention",
      reason: "could not check: timed out after 30 s",
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

describe("the Memory bank step's triggers", () => {
  it("checks the Memory bank and Instructions steps again within a second of a bank.* notice, as the banks build appends them", async () => {
    const banks = fixtureBanks([valid()]);
    const t = await start({ banks });
    const client = await t.client();
    banks.set([withStatus(valid(), { reachable: { state: "unreachable", reason: "git.example did not answer within 30 s." } })]);
    t.env.log.append({ kind: "test", id: "banks" }, [{ type: "bank.verified", payload: {} }], { actor: "system:banks" });
    t.clock.advance(TRIGGER_WINDOW_MS);
    await new Promise((resolve) => setImmediate(resolve));
    const after = new Date(Date.parse(MANUAL_CLOCK_START) + TRIGGER_WINDOW_MS).toISOString();
    expect(await snapshotResult(t, client, "memory-bank")).toMatchObject({ state: "needs-attention", failing: ["memory-bank.reachable"], checkedAt: after });
    expect(await snapshotResult(t, client, "instructions")).toMatchObject({ checkedAt: after });
  });
});

/** A bank's repository as the BankService keeps it: a bare origin holding main's first commit, and the checkout cloned from it. */
const bankRepository = (): { readonly origin: string; readonly checkout: string } => {
  const root = tempDir();
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(root, "clone", "--quiet", origin, seed);
  writeFileSync(join(seed, "README.md"), "# david-memory\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "--quiet", "-m", "The bank's first commit.");
  git(seed, "push", "--quiet", "origin", "HEAD:main");
  const checkout = join(root, "checkout");
  git(root, "clone", "--quiet", origin, checkout);
  return { origin, checkout };
};

/** `setup.mint` with a fresh command id. */
const mint = async (client: WireClient, params: Omit<ParamsOf<"setup.mint">, "commandId">): Promise<ResponseOf<"setup.mint">> =>
  client.request("setup.mint", { commandId: randomUUID(), ...params });

/** The session `setup.mint` answered, or fails the test with its receipt. */
const minted = async (client: WireClient, params: Omit<ParamsOf<"setup.mint">, "commandId">): Promise<string> => {
  const answer = await mint(client, params);
  expect(answer.receipt).toMatchObject({ status: "accepted" });
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
    const bank = valid({ checkout });
    const t = await start({ banks: fixtureBanks([bank]) });
    const client = await t.client();
    const sessionId = await minted(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    await runEnded(client, sessionId);

    const summary = await get(client, sessionId);
    expect(summary).toMatchObject({
      title: "Set up: Memory bank (david-memory)",
      tags: ["memory-bank", "setup"],
      workspace: { kind: "worktree", repository: checkout, branch: `setup/describe-${TODAY}` },
    });
    const { path } = summary.workspace;
    expect(path).not.toBe(checkout);
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("# david-memory\n");
    writeFileSync(join(path, "BANK.md"), "kind: personal\n");
    expect(existsSync(join(checkout, "BANK.md"))).toBe(false);
    expect(git(checkout, "branch", "--show-current").trim()).toBe("main");
    const [prompt] = t.adapter.lastRun().input.prompt.map((message) => message.text);
    expect(prompt).toMatch(/^Describe the memory bank david-memory, a personal bank, by writing its BANK\.md\./);
    expect(prompt).toContain("Homelab (home lab)");
  });

  it("takes the next free branch for a second session on the same day, the first one's branch kept", async () => {
    const { checkout } = bankRepository();
    const bank = valid({ checkout });
    const t = await start({ banks: fixtureBanks([bank]) });
    const client = await t.client();
    const first = await minted(client, { step: "memory-bank", subject: bank.id, variant: "first" });
    const again = await minted(client, { step: "memory-bank", subject: bank.id, variant: "revise" });
    expect((await get(client, first)).workspace).toMatchObject({ branch: `setup/describe-${TODAY}` });
    expect((await get(client, again)).workspace).toMatchObject({ branch: `setup/describe-${TODAY}-2` });
    expect(branchesOf(checkout)).toEqual(["main", `setup/describe-${TODAY}`, `setup/describe-${TODAY}-2`]);
    await runEnded(client, again);
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)[0]).toMatch(/^Revise BANK\.md of the memory bank david-memory, a personal bank\./);
  });

  it("refuses a bank whose checkout is not there, and a call naming no bank, conflict bank_missing; a bank not registered is not_found; nothing is minted", async () => {
    const gone = valid({ checkout: join(tempDir(), "gone") });
    const t = await start({ banks: fixtureBanks([gone]) });
    const client = await t.client();
    expect((await mint(client, { step: "memory-bank", subject: gone.id, variant: "first" })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", data: { reason: "bank_missing", bankId: gone.id } },
    });
    expect((await mint(client, { step: "memory-bank", variant: "first" })).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "bank_missing" } } });
    expect((await mint(client, { step: "memory-bank", subject: "bank-9", variant: "first" })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "not_found", data: { kind: "subject", step: "memory-bank", subject: "bank-9" } },
    });
    expect((await client.request("sessions.list", {})).sessions).toEqual([]);
    expect(t.adapter.runs).toEqual([]);
  });

  it("whose run end lands BANK.md turns the step done, with nobody asking", async () => {
    const { origin, checkout } = bankRepository();
    // The banks build's verification, standing in: BANK.md on the origin's main passes, else it is missing.
    const verified = (): BankRecord =>
      withStatus(valid({ checkout }), { manifest: git(origin, "ls-tree", "--name-only", "main").split("\n").includes("BANK.md") ? { state: "valid" } : { state: "missing" } });
    const banks: BankRecords = { list: () => [verified()], verify: async () => [verified()] };
    // The session writes BANK.md in its worktree, commits it and lands it on the bank's main, as a review path's merge would.
    const describes: Script = async function* ({ input }) {
      writeFileSync(join(input.workspace.path, "BANK.md"), "---\nkind: personal\n---\n");
      git(input.workspace.path, "add", "BANK.md");
      git(input.workspace.path, "commit", "--quiet", "-m", "Describe the bank.");
      git(input.workspace.path, "push", "--quiet", "origin", "HEAD:main");
      yield say("BANK.md is landed.");
      yield end();
    };
    const t = await start({ banks, adapter: fakeAdapter({ script: describes }) });
    const client = await t.client();
    expect(await snapshotResult(t, client, "memory-bank")).toMatchObject({ state: "needs-attention", failing: ["memory-bank.manifest"] });

    const sessionId = await minted(client, { step: "memory-bank", subject: "bank-personal", variant: "first" });
    await runEnded(client, sessionId);
    t.clock.advance(TRIGGER_WINDOW_MS);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await snapshotResult(t, client, "memory-bank")).toEqual({
      step: "memory-bank",
      state: "done",
      reason: ALL_HOLD,
      failing: [],
      actions: ["revise"],
      targets: [target("revise", verified())],
      checkedAt: new Date(Date.parse(MANUAL_CLOCK_START) + TRIGGER_WINDOW_MS).toISOString(),
    });
  });
});
