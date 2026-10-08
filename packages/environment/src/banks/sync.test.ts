import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BankRecord, ParamsOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { PERSONAL_BANK } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { added, DAVID, TOKEN } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { create, workspace } from "../../test/sessions.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { autoMemoryName } from "../workspace/auto-memory.js";
import type { ForgeGitRequest } from "../forge/harness-git.js";
import { forgeAccountMissing } from "../forge/missing-origins.js";
import type { EventEnvelope } from "../event-log/event-log.js";
import { composeInstructions } from "../instructions/composer.js";
import { git } from "../../test/workspaces.js";

const { tempDir, onCleanup } = useCleanups();

/** A fixture remote and its registered or managed checkout, reached by the harness helper's canonical URL. */
const start = async (options: TestEnvironmentOptions = {}, scopes: Partial<ParamsOf<"banks.register">>[] = [{}], ownership: "registered" | "managed" = "registered") => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  const root = tempDir("bank-remotes-");
  const fixtures = scopes.map((scope, index) => {
    const name = index === 0 ? "memory" : `memory-${index + 1}`;
    forge.repository(TOKEN, `maya/${name}`);
    const remote = join(root, `${name}.git`);
    mkdirSync(remote);
    git(remote, "init", "--quiet", "--initial-branch=main");
    for (const [path, text] of Object.entries(PERSONAL_BANK)) {
      mkdirSync(dirname(join(remote, path)), { recursive: true });
      writeFileSync(join(remote, path), index === 0 ? text : text.replaceAll("maya-memory", `maya-memory-${index + 1}`));
    }
    git(remote, "add", "--all");
    git(remote, "commit", "--quiet", "-m", "The bank.");
    const checkout = tempDir("bank-checkout-");
    git(checkout, "clone", "--quiet", remote, ".");
    const url = `${forge.origin}/maya/${name}.git`;
    git(checkout, "remote", "set-url", "origin", url);
    return { remote, checkout, url, scope };
  });
  const t = await startTestEnvironment({
    dataDir: tempDir("bank-env-"),
    harnessCommand: [process.execPath],
    harnessGitConfig: [[`url.${pathToFileURL(root).href}/.insteadOf`, `${forge.origin}/maya/`]],
    ...options,
  });
  onCleanup(() => t.close());
  const client = await t.client();
  await added(client, { url: forge.origin, kind: "forgejo" });
  const banks = [];
  for (const fixture of fixtures) {
    const answer = ownership === "managed"
      ? await client.request("banks.join", { commandId: randomUUID(), bankId: randomUUID(), url: fixture.url, accounts: [], repositories: "all" })
      : await client.request("banks.register", { commandId: randomUUID(), bankId: randomUUID(), path: fixture.checkout, role: "read-write", accounts: "all", repositories: "all", defaultFor: [], ...fixture.scope });
    if (answer.result === undefined) throw new Error("The fixture bank did not register.");
    banks.push({ ...fixture, checkout: answer.result.bank.checkout, bank: answer.result.bank });
  }
  return { t, client, forge, banks, ...banks[0]! };
};

/** Holds network fetches at the external git boundary; shutdown always releases an aborted operation. */
const observedGit = () => {
  const requests: ForgeGitRequest[] = [];
  let gate: Promise<void> | null = null;
  return {
    requests,
    hold() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => { release = resolve; });
      return () => { gate = null; release(); };
    },
    wrap: (async (request, git) => {
      requests.push(request);
      if (gate !== null) await Promise.race([gate, new Promise<void>((resolve) => {
        if (request.signal?.aborted === true) resolve();
        else request.signal?.addEventListener("abort", () => resolve(), { once: true });
      })]);
      return git(request);
    }) satisfies NonNullable<TestEnvironmentOptions["banksGit"]>,
  };
};

const until = (assertion: () => void | Promise<void>) => vi.waitFor(assertion, { timeout: WAIT_MS });
const run = async (t: TestEnvironment, client: WireClient) => {
  const { id } = await create(client);
  const answer = await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Go." });
  const runId = answer.result?.runId;
  if (runId === undefined) throw new Error("The fixture run did not start.");
  return () => until(() => expect(t.env.log.readStream({ kind: "session", id }).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true));
};

const events = (t: TestEnvironment, after: number): EventEnvelope[] => t.env.log.readStream({ kind: "environment", id: t.env.id }, after).filter((event) => event.type.startsWith("bank."));
const pull = async (client: WireClient, bank: BankRecord) => (await client.request("banks.sync", { bankId: bank.id })).banks.find((record) => record.id === bank.id);

/** Work belonging to the retained checkout's owner, including files git normally hides. */
const retainWork = (checkout: string, committed = false) => {
  writeFileSync(join(checkout, "BANK.md"), PERSONAL_BANK["BANK.md"]!.replace("private memory", "retained memory"));
  if (committed) {
    git(checkout, "add", "BANK.md");
    git(checkout, "commit", "--quiet", "-m", "Retain local history.");
  }
  writeFileSync(join(checkout, "untracked.md"), "Retained untracked work.");
  writeFileSync(join(checkout, ".git", "info", "exclude"), "ignored.md\n");
  writeFileSync(join(checkout, "ignored.md"), "Retained ignored work.");
  const head = git(checkout, "rev-parse", "HEAD").trim();
  const status = git(checkout, "status", "--porcelain", "--ignored");
  return () => {
    expect(git(checkout, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(checkout, "status", "--porcelain", "--ignored")).toBe(status);
    expect(readFileSync(join(checkout, "BANK.md"), "utf8")).toContain("retained memory");
    expect(readFileSync(join(checkout, "untracked.md"), "utf8")).toBe("Retained untracked work.");
    expect(readFileSync(join(checkout, "ignored.md"), "utf8")).toBe("Retained ignored work.");
  };
};

const advanceRemote = (remote: string) => {
  writeFileSync(join(remote, "remote.md"), "New remote work.");
  git(remote, "add", "remote.md");
  git(remote, "commit", "--quiet", "-m", "Advance remote main.");
};

describe("banks.sync", () => {
  it("preserves a registered checkout's dirty tracked, untracked and ignored work and reports Health", async () => {
    const { t, client, bank, remote, checkout } = await start();
    const previousHead = git(checkout, "rev-parse", "HEAD").trim();
    writeFileSync(join(checkout, "BANK.md"), "Retained tracked work.");
    writeFileSync(join(checkout, "untracked.md"), "Retained untracked work.");
    writeFileSync(join(checkout, ".git", "info", "exclude"), "ignored.md\n");
    writeFileSync(join(checkout, "ignored.md"), "Retained ignored work.");
    writeFileSync(join(remote, "remote.md"), "New remote work.");
    git(remote, "add", "remote.md");
    git(remote, "commit", "--quiet", "-m", "Advance remote main.");
    const from = t.env.log.head();

    const synced = await pull(client, bank);

    expect(git(checkout, "rev-parse", "HEAD").trim()).toBe(previousHead);
    expect(readFileSync(join(checkout, "BANK.md"), "utf8")).toBe("Retained tracked work.");
    expect(readFileSync(join(checkout, "untracked.md"), "utf8")).toBe("Retained untracked work.");
    expect(readFileSync(join(checkout, "ignored.md"), "utf8")).toBe("Retained ignored work.");
    expect(synced?.status.lastSync).toBeNull();
    expect(synced?.status.reachable).toMatchObject({ state: "unreachable", reason: expect.stringMatching(/commit or stash/i) });
    expect(events(t, from).filter((event) => event.type === "bank.synced")).toEqual([]);
    const health = await client.request("setup.check", { step: "memory-bank" });
    expect(health.results).toEqual(expect.arrayContaining([expect.objectContaining({
      failing: expect.arrayContaining(["memory-bank.reachable"]),
      reason: expect.stringContaining(`agent-harness cannot reach ${bank.name}. Choose Check again.`),
      details: expect.arrayContaining([expect.stringMatching(/commit or stash/i)]),
    })]));

    git(checkout, "checkout", "--", "BANK.md");
    expect((await pull(client, bank))?.status.reachable.state).toBe("reachable");
    expect((await client.request("setup.check", { step: "memory-bank" })).results[0]?.state).toBe("done");
    expect(readFileSync(join(checkout, "untracked.md"), "utf8")).toBe("Retained untracked work.");
    expect(readFileSync(join(checkout, "ignored.md"), "utf8")).toBe("Retained ignored work.");
  });

  it.each([false, true])("clears blocked Health after a successful pull overlapping verification, newer finishes last: %s", async (newerLast) => {
    const { client, bank, remote, checkout, forge } = await start();
    writeFileSync(join(checkout, "BANK.md"), "Retained tracked work.");
    expect((await pull(client, bank))?.status.reachable.state).toBe("unreachable");
    git(checkout, "checkout", "--", "BANK.md");
    advanceRemote(remote);
    let asked!: () => void;
    let newerAsked!: () => void;
    let release!: () => void;
    let releaseNewer!: () => void;
    const held = new Promise<void>((resolve) => { asked = resolve; });
    const newerHeld = new Promise<void>((resolve) => { newerAsked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const newerGate = new Promise<void>((resolve) => { releaseNewer = resolve; });
    onCleanup(() => { release(); releaseNewer(); });
    let reads = 0;
    forge.answer(TOKEN, "GET /api/v1/repos/maya/memory", () => {
      const body = { full_name: "maya/memory", private: true, default_branch: "main", html_url: `${forge.origin}/maya/memory` };
      if (reads++ === 0) { asked(); return { status: 200, body, after: gate }; }
      newerAsked();
      return { status: 200, body, ...(newerLast && { after: newerGate }) };
    });
    const pulling = pull(client, bank);
    await held;
    const verifying = client.request("banks.verify", { bankId: bank.id });
    await newerHeld;
    if (!newerLast) await verifying;
    release();
    const synced = await pulling;
    releaseNewer();
    await verifying;
    expect(synced?.status.reachable.state).toBe("reachable");
    expect((await client.request("banks.get", { bankId: bank.id })).bank.status.reachable.state).toBe("reachable");
    expect((await client.request("setup.check", { step: "memory-bank" })).results[0]?.state).toBe("done");
  });

  it("preserves staged tracked work even when merge autostash is configured", async () => {
    const { client, bank, remote, checkout } = await start();
    git(checkout, "config", "merge.autostash", "true");
    writeFileSync(join(checkout, "BANK.md"), "Retained staged work.");
    git(checkout, "add", "BANK.md");
    const staged = git(checkout, "diff", "--cached");
    const head = git(checkout, "rev-parse", "HEAD");
    advanceRemote(remote);

    const synced = await pull(client, bank);

    expect(git(checkout, "rev-parse", "HEAD")).toBe(head);
    expect(git(checkout, "diff", "--cached")).toBe(staged);
    expect(readFileSync(join(checkout, "BANK.md"), "utf8")).toBe("Retained staged work.");
    expect(synced?.status.reachable.state).toBe("unreachable");
  });

  it.each([false, true])("preserves registered commits when remote main has advanced: %s", async (remoteMoved) => {
    const { client, bank, remote, checkout } = await start();
    const preserved = retainWork(checkout, true);
    if (remoteMoved) advanceRemote(remote);

    const synced = await pull(client, bank);

    preserved();
    expect(synced?.status.reachable).toMatchObject({ state: "unreachable", reason: expect.stringContaining("Reconcile them with origin/main") });
    const health = await client.request("setup.check", { step: "memory-bank" });
    expect(health.results[0]).toMatchObject({ state: "needs-attention", failing: ["memory-bank.reachable"] });
  });

  it("fast-forwards a clean registered checkout without cleaning untracked or ignored files", async () => {
    const { t, client, bank, remote, checkout } = await start();
    writeFileSync(join(checkout, "untracked.md"), "Retained untracked work.");
    writeFileSync(join(checkout, ".git", "info", "exclude"), "ignored.md\n");
    writeFileSync(join(checkout, "ignored.md"), "Retained ignored work.");
    advanceRemote(remote);

    const synced = await pull(client, bank);

    expect(git(checkout, "rev-parse", "HEAD").trim()).toBe(git(remote, "rev-parse", "HEAD").trim());
    expect(synced?.status.lastSync).toBe(t.clock.now().toISOString());
    expect(synced?.status.reachable.state).toBe("reachable");
    expect(readFileSync(join(checkout, "untracked.md"), "utf8")).toBe("Retained untracked work.");
    expect(readFileSync(join(checkout, "ignored.md"), "utf8")).toBe("Retained ignored work.");
  });

  it.each([false, true])("refuses a fast-forward over an obstructing retained file, ignored: %s", async (ignored) => {
    const { client, bank, remote, checkout } = await start();
    const previousHead = git(checkout, "rev-parse", "HEAD").trim();
    writeFileSync(join(checkout, "remote.md"), "Retained work at the incoming path.");
    if (ignored) writeFileSync(join(checkout, ".git", "info", "exclude"), "remote.md\n");
    advanceRemote(remote);

    const synced = await pull(client, bank);

    expect(git(checkout, "rev-parse", "HEAD").trim()).toBe(previousHead);
    expect(readFileSync(join(checkout, "remote.md"), "utf8")).toBe("Retained work at the incoming path.");
    expect(synced?.status.reachable).toMatchObject({ state: "unreachable", reason: expect.stringContaining("obstructing untracked or ignored files") });
    expect((await client.request("setup.check", { step: "memory-bank" })).results[0]?.state).toBe("needs-attention");
  });

  it("syncs another bank while checkout work is held and continues after that work fails", async () => {
    const { t, client, banks } = await start({}, [{}, {}]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    onCleanup(release);
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => { entered = resolve; });
    const bank = banks[0]!.bank;
    const held = t.env.banks.withCheckout(bank.id, async () => {
      entered();
      await gate;
      throw new Error("The preceding checkout operation failed.");
    });
    const failed = expect(held).rejects.toThrow("The preceding checkout operation failed.");
    await holding;
    const pulling = pull(client, bank);
    expect((await pull(client, banks[1]!.bank))?.status.reachable.state).toBe("reachable");
    release();
    await failed;
    expect((await pulling)?.status.reachable.state).toBe("reachable");
    expect((await client.request("banks.get", { bankId: bank.id })).bank.status.lastSync).not.toBeNull();
  });

  it("keeps a fetch failure when an older verification completes afterward", async () => {
    const { client, bank, forge } = await start({ banksGit: async () => { throw new Error("The fetch failed."); } });
    let asked!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { asked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    forge.answer(TOKEN, "GET /api/v1/repos/maya/memory", () => {
      asked();
      return { status: 200, body: { full_name: "maya/memory", private: true, default_branch: "main", html_url: `${forge.origin}/maya/memory` }, after: gate };
    });
    const verifying = client.request("banks.verify", { bankId: bank.id });
    await held;
    expect((await pull(client, bank))?.status.reachable.state).toBe("unreachable");
    release();
    await verifying;
    expect((await client.request("banks.get", { bankId: bank.id })).bank.status.reachable.state).toBe("unreachable");
  });

  it("keeps the refreshed reading when an older verification finishes after the sync", async () => {
    const { client, bank, remote, forge } = await start();
    let asked!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { asked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    forge.answer(TOKEN, "GET /api/v1/repos/maya/memory", () => {
      const body = { full_name: "maya/memory", private: true, default_branch: "main", html_url: `${forge.origin}/maya/memory` };
      if (reads++ === 0) { asked(); return { status: 200, body, after: gate }; }
      return { status: 200, body };
    });
    const verifying = client.request("banks.verify", { bankId: bank.id });
    await held;
    writeFileSync(join(remote, "BANK.md"), PERSONAL_BANK["BANK.md"]!.replace("private memory", "refreshed memory"));
    git(remote, "add", "BANK.md");
    git(remote, "commit", "--quiet", "-m", "Refresh the purpose.");
    expect((await pull(client, bank))?.line).toContain("refreshed memory");
    release();
    await verifying;
    expect((await client.request("banks.get", { bankId: bank.id })).bank.line).toContain("refreshed memory");
  });

  it("resets an owned checkout with local commits to remote main, including when main has no new commit", async () => {
    const { client, bank, remote, checkout } = await start({}, [{}], "managed");
    writeFileSync(join(checkout, "local.md"), "A change made outside the bank's write path.");
    git(checkout, "add", "local.md");
    git(checkout, "commit", "--quiet", "-m", "An unowned change.");
    await pull(client, bank);
    expect(git(checkout, "rev-parse", "HEAD").trim()).toBe(git(remote, "rev-parse", "HEAD").trim());
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });

  it.each([false, true])("discards tracked, untracked and ignored edits on Pull now when remote main moved: %s", async (remoteMoved) => {
    const { t, client, bank, remote, checkout } = await start({}, [{}], "managed");
    writeFileSync(join(checkout, ".git", "info", "exclude"), "ignored/\n");
    writeFileSync(join(checkout, "BANK.md"), "An edit made outside the bank's write path.");
    writeFileSync(join(checkout, "untracked.md"), "An untracked edit.");
    mkdirSync(join(checkout, "ignored"));
    writeFileSync(join(checkout, "ignored", "memory.md"), "An ignored edit.");
    if (remoteMoved) {
      writeFileSync(join(remote, "remote.md"), "An unrelated remote change.");
      git(remote, "add", "remote.md");
      git(remote, "commit", "--quiet", "-m", "A remote change.");
    }
    const from = t.env.log.head();

    const synced = await pull(client, bank);

    expect(synced?.status.lastSync).toBe(t.clock.now().toISOString());
    expect(git(checkout, "rev-parse", "HEAD").trim()).toBe(git(remote, "rev-parse", "HEAD").trim());
    expect(readFileSync(join(checkout, "BANK.md"), "utf8")).toBe(PERSONAL_BANK["BANK.md"]);
    expect(git(checkout, "status", "--porcelain", "--ignored")).toBe("");
    expect(existsSync(join(checkout, "untracked.md"))).toBe(false);
    expect(existsSync(join(checkout, "ignored"))).toBe(false);
    expect(events(t, from).filter((event) => event.type === "bank.synced")).toHaveLength(remoteMoved ? 1 : 0);
  });

  it("pulls main through the canonical origin, refreshes the record, and records only a moved head as bank.synced", async () => {
    const { t, client, bank, remote, checkout } = await start();
    const previousHead = git(checkout, "rev-parse", "HEAD").trim();
    // A configured origin must not redirect the BankService's fetch.
    git(checkout, "remote", "set-url", "origin", "https://wrong.example.test/other/bank.git");
    writeFileSync(join(remote, "BANK.md"), PERSONAL_BANK["BANK.md"]!.replace("Maya Reyes's private memory", "Maya Reyes's refreshed memory"));
    git(remote, "add", "BANK.md");
    git(remote, "commit", "--quiet", "-m", "Refresh the purpose.");
    const head = git(remote, "rev-parse", "HEAD").trim();
    const from = t.env.log.head();

    const synced = await pull(client, bank);

    expect(git(checkout, "rev-parse", "HEAD").trim()).toBe(head);
    expect(synced?.line).toContain("refreshed memory");
    expect(synced?.status.lastSync).toBe(t.clock.now().toISOString());
    expect(events(t, from)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "bank.synced", actor: "system:banks", payload: { bankId: bank.id, head, previousHead } }),
      expect.objectContaining({ type: "bank.updated", actor: "system:banks" }),
    ]));
    const after = t.env.log.head();
    t.clock.advance(1_000);
    expect((await pull(client, bank))?.status.lastSync).toBe(t.clock.now().toISOString());
    expect(events(t, after).filter((event) => event.type === "bank.synced")).toEqual([]);
  });

  it("resets divergent history to main without creating a merge commit", async () => {
    const { client, bank, remote, checkout } = await start({}, [{}], "managed");
    writeFileSync(join(checkout, "local.md"), "A local branch of history.");
    git(checkout, "add", "local.md");
    git(checkout, "commit", "--quiet", "-m", "The local change.");
    writeFileSync(join(remote, "remote.md"), "A remote branch of history.");
    git(remote, "add", "remote.md");
    git(remote, "commit", "--quiet", "-m", "The remote change.");
    await pull(client, bank);
    expect(git(checkout, "rev-parse", "HEAD").trim()).toBe(git(remote, "rev-parse", "HEAD").trim());
    expect(git(checkout, "rev-list", "--count", "HEAD").trim()).toBe("2");
  });

  it("keeps the last successful sync on a failed fetch and exposes the failure without a bank.synced event", async () => {
    let fail = false;
    const { t, client, bank } = await start({ banksGit: async (request, git) => {
      if (fail) throw new Error("A network failure.");
      return git(request);
    } });
    const before = await pull(client, bank);
    fail = true;
    t.clock.jump(1_000);
    const from = t.env.log.head();
    const after = await pull(client, bank);
    expect(after?.status.lastSync).toBe(before?.status.lastSync);
    expect(after?.status.reachable).toMatchObject({ state: "unreachable", since: t.clock.now().toISOString() });
    expect(events(t, from).map((event) => event.type)).toEqual(["bank.updated"]);
    const failedAt = t.env.log.head();
    t.clock.jump(1_000);
    expect((await pull(client, bank))?.status).toEqual(after?.status);
    expect(events(t, failedAt)).toEqual([]);
  });
});

describe("a fetch the forge asked a credential for", () => {
  it("records why, the origin and the cause, not only the line that a forge is needed (#1850)", async () => {
    let refuse = false;
    const { t, client, bank } = await start({ banksGit: async (request, git) => {
      if (!refuse) return git(request);
      const { origin } = new URL(request.repository);
      return { outcome: "refused", error: forgeAccountMissing(origin, "it asked for a credential") };
    } });
    await pull(client, bank);
    refuse = true;
    t.clock.jump(1_000);
    const after = await pull(client, bank);
    expect(after?.status.reachable).toMatchObject({ state: "unreachable", reason: expect.stringMatching(/^[a-z]+:\/\/[^ ]+: it asked for a credential$/) });
  });
});

describe("before a run", () => {
  it.each([false, true])("preserves retained work before composing a run, committed: %s", async (committed) => {
    const { t, client, bank, remote, checkout } = await start();
    const preserved = retainWork(checkout, committed);
    advanceRemote(remote);

    await (await run(t, client))();

    preserved();
    expect(t.adapter.runs).toHaveLength(1);
    expect((await client.request("banks.get", { bankId: bank.id })).bank.status.reachable.state).toBe("unreachable");
  });

  it("finishes a fast fetch before composing the run's instructions", async () => {
    const checkout: { path?: string } = {};
    const composedHeads: string[] = [];
    const compose = composeInstructions();
    const fixture = await start({ adapterSeams: { instructions: async (scope) => {
      composedHeads.push(git(checkout.path!, "rev-parse", "HEAD").trim());
      return compose(scope);
    } } });
    checkout.path = fixture.checkout;
    writeFileSync(join(fixture.remote, "remote.md"), "New content.");
    git(fixture.remote, "add", "remote.md");
    git(fixture.remote, "commit", "--quiet", "-m", "The remote change.");
    await (await run(fixture.t, fixture.client))();
    expect(composedHeads).toEqual([git(fixture.remote, "rev-parse", "HEAD").trim()]);
  });

  it("aborts a held fetch on shutdown and ends a waiting run without reaching the provider", async () => {
    const observed = observedGit();
    const { t, client } = await start({ banksGit: observed.wrap });
    observed.hold();
    await run(t, client);
    await until(() => expect(observed.requests).toHaveLength(1));
    await t.close();
    expect(observed.requests[0]?.signal?.aborted).toBe(true);
    expect(t.adapter.runs).toEqual([]);
  });

  it("fetches a never-fetched bank, then keeps it at exactly 60 seconds and fetches it a millisecond later", async () => {
    const observed = observedGit();
    const { t, client } = await start({ banksGit: observed.wrap });
    await (await run(t, client))();
    expect(observed.requests).toHaveLength(1);
    t.clock.advance(60_000);
    await (await run(t, client))();
    expect(observed.requests).toHaveLength(1);
    t.clock.advance(1);
    await (await run(t, client))();
    expect(observed.requests).toHaveLength(2);
  });

  it("fetches only enabled banks within both the run's account and repository scopes", async () => {
    const observed = observedGit();
    const { t, client, banks } = await start({ banksGit: observed.wrap }, [
      { accounts: ["claude-max"] },
      { accounts: ["another-account"] },
      { repositories: ["https://repo.example.test/acme/project"] },
      {},
    ]);
    const disabled = banks[3]!.bank;
    t.env.log.append({ kind: "environment", id: t.env.id }, [{ type: "bank.updated", payload: { bankId: disabled.id, enabled: false } }], { actor: "system:banks" });
    await (await run(t, client))();
    expect(observed.requests.map((request) => request.repository)).toEqual([banks[0]!.url]);
  });

  it("refreshes a bank scoped to the run's repository identity", async () => {
    const observed = observedGit();
    const repositoryIdentity = "https://repo.example.test/acme/project";
    const path = tempDir("bank-session-");
    const { t, client, url } = await start({
      banksGit: observed.wrap,
      workspaceResolver: { resolve: async () => ({ workspace: { kind: "directory", path }, repositoryIdentity }) },
    }, [{ repositories: [repositoryIdentity] }]);
    await (await run(t, client))();
    expect(observed.requests.map((request) => request.repository)).toEqual([url]);
  });

  it("shares three seconds among several delayed banks, starts on current checkouts, and lets Pull now join their background completion", async () => {
    const observed = observedGit();
    const { t, client, banks } = await start({ banksGit: observed.wrap }, [{}, {}, {}]);
    await client.request("banks.sync", {});
    const previous = banks.map(({ checkout }) => git(checkout, "rev-parse", "HEAD").trim());
    const heads = banks.map(({ remote }) => {
      writeFileSync(join(remote, "BANK.md"), git(remote, "show", "HEAD:BANK.md").replace("private memory", "updated memory"));
      git(remote, "add", "BANK.md");
      git(remote, "commit", "--quiet", "-m", "The new purpose.");
      return git(remote, "rev-parse", "HEAD").trim();
    });
    t.clock.advance(60_001);
    const release = observed.hold();
    const ended = await run(t, client);
    await until(() => expect(observed.requests).toHaveLength(6));
    const pullNow = client.request("banks.sync", {});
    t.clock.advance(2_999);
    expect(t.adapter.runs).toHaveLength(0);
    t.clock.advance(1);
    await ended();
    expect(t.adapter.runs).toHaveLength(1);
    expect(banks.map(({ checkout }) => git(checkout, "rev-parse", "HEAD").trim())).toEqual(previous);
    release();
    const synced = await pullNow;
    expect(observed.requests).toHaveLength(6);
    expect(banks.map(({ checkout }) => git(checkout, "rev-parse", "HEAD").trim())).toEqual(heads);
    expect(synced.banks.map((bank) => bank.line)).toEqual(Array(3).fill(expect.stringContaining("updated memory")));
    expect(synced.banks.map((bank) => bank.status.lastSync)).toEqual(Array(3).fill(t.clock.now().toISOString()));
  });
});

describe("idle sync", () => {
  it.each([false, true])("preserves retained work at startup and on the idle scheduler, committed: %s", async (committed) => {
    const observed = observedGit();
    const fixture = await start();
    const { t, bank, remote, checkout } = fixture;
    const preserved = retainWork(checkout, committed);
    advanceRemote(remote);
    await t.close();
    const restarted = await startTestEnvironment({ dataDir: t.dataDir, clock: t.clock, harnessCommand: [process.execPath], harnessGitConfig: [[`url.${pathToFileURL(remote).href}.insteadOf`, fixture.url]], banksGit: observed.wrap });
    onCleanup(() => restarted.close());
    const client = await restarted.client();
    await until(async () => expect((await client.request("banks.get", { bankId: bank.id })).bank.status.reachable.state).toBe("unreachable"));
    preserved();
    const from = restarted.env.log.head();
    expect(observed.requests).toHaveLength(1);
    restarted.clock.advance(30 * 60_000);
    await until(() => expect(observed.requests).toHaveLength(2));
    await pull(client, bank);
    expect(events(restarted, from).filter((event) => event.type === "bank.synced")).toEqual([]);
    preserved();
    expect(restarted.adapter.runs).toEqual([]);
    expect((await client.request("setup.check", { step: "memory-bank" })).results[0]?.state).toBe("needs-attention");
  });

  it("fetches on startup and again at thirty minutes without a run, publishing refreshed records", async () => {
    const observed = observedGit();
    const fixture = await start({ banksGit: observed.wrap });
    const { t, client, bank, remote } = fixture;
    await pull(client, bank);
    await t.close();
    writeFileSync(join(remote, "BANK.md"), PERSONAL_BANK["BANK.md"]!.replace("private memory", "startup memory"));
    git(remote, "add", "BANK.md");
    git(remote, "commit", "--quiet", "-m", "A startup change.");
    const restarted = await startTestEnvironment({ dataDir: t.dataDir, clock: t.clock, harnessCommand: [process.execPath], harnessGitConfig: [[`url.${pathToFileURL(remote).href}.insteadOf`, fixture.url]], banksGit: observed.wrap });
    onCleanup(() => restarted.close());
    const nextClient = await restarted.client();
    await until(async () => expect((await nextClient.request("banks.get", { bankId: bank.id })).bank.line).toContain("startup memory"));
    expect(observed.requests).toHaveLength(2);
    writeFileSync(join(remote, "BANK.md"), PERSONAL_BANK["BANK.md"]!.replace("private memory", "scheduled memory"));
    git(remote, "add", "BANK.md");
    git(remote, "commit", "--quiet", "-m", "An idle change.");
    restarted.clock.advance(30 * 60_000 - 1);
    expect(observed.requests).toHaveLength(2);
    restarted.clock.advance(1);
    await until(() => expect(observed.requests).toHaveLength(3));
    await until(async () => expect((await nextClient.request("banks.get", { bankId: bank.id })).bank.line).toContain("scheduled memory"));
    expect(observed.requests).toHaveLength(3);
    expect(restarted.adapter.runs).toEqual([]);
  });
});


it("rewrites a repository's shared memory block when a bank sync changes its head", async () => {
  const adapter = fakeAdapter({ provider: "claude" });
  const { t, client, bank, remote } = await start({ adapter, accounts: [{ id: "claude-max", provider: "claude" }] });
  const { id } = await create(client);
  await client.request("instructions.preview", { sessionId: id });
  const memory = join(t.dataDir, "auto-memory", autoMemoryName({ workspace, repositoryIdentity: null }), "MEMORY.md");
  expect(readFileSync(memory, "utf8")).toContain("Maya Reyes's private memory");
  writeFileSync(join(remote, "BANK.md"), PERSONAL_BANK["BANK.md"]!.replace("private memory", "synced memory"));
  git(remote, "add", "BANK.md");
  git(remote, "commit", "--quiet", "-m", "Refresh the bank purpose.");
  const after = t.env.log.head();
  await pull(client, bank);
  await until(() => expect(readFileSync(memory, "utf8")).toContain("Maya Reyes's synced memory"));
  expect(events(t, after).some((event) => event.type === "bank.synced")).toBe(true);
  const unchanged = readFileSync(memory, "utf8");
  const next = t.env.log.head();
  await pull(client, bank);
  expect(events(t, next).some((event) => event.type === "bank.synced")).toBe(false);
  expect(readFileSync(memory, "utf8")).toBe(unchanged);
});
