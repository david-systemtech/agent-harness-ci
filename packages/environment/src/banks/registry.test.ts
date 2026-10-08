import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BankRecord, EventEnvelope, EventFrame, ParamsOf, ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { changed, markdown, memory, PERSONAL_BANK, personalManifest, scopeFile, TEAM_BANK } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import type { WireClient } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";

/**
 * The BankRegistry and the BankService's register, list, get and verify
 * (banks spec, "The registry" and "The BankService's methods"; #1025)
 * through the primary seam: an in-process environment and a real client,
 * fixture banks as git repositories on disk. What is asserted is what the
 * bank methods answer a client and the events the environment stream
 * carries.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** A git repository holding `files` in one commit on main. */
const gitBank = (files: Readonly<Record<string, string>>): string => {
  const root = tempDir("agent-harness-bank-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "The bank.");
  return root;
};

type RegisterParams = Omit<ParamsOf<"banks.register">, "commandId" | "bankId" | "role" | "accounts" | "repositories" | "defaultFor"> &
  Partial<Pick<ParamsOf<"banks.register">, "bankId" | "role" | "accounts" | "repositories" | "defaultFor">>;

/** Sends `banks.register` with a fresh command id and bank id unless given, read-write in every scope unless said. */
const register = (client: WireClient, params: RegisterParams): Promise<ResponseOf<"banks.register">> =>
  client.request("banks.register", { commandId: randomUUID(), bankId: randomUUID(), role: "read-write", accounts: "all", repositories: "all", defaultFor: [], ...params });

/** The bank a register made; throws unless it was accepted. */
const registered = async (client: WireClient, params: RegisterParams): Promise<BankRecord> => {
  const answer = await register(client, params);
  if (answer.result === undefined) throw new Error(`banks.register was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.bank;
};

const list = async (client: WireClient): Promise<BankRecord[]> => (await client.request("banks.list", {})).banks;

/** The bank events a client reads on `environment.subscribe` after `afterSequence`, up to where it is synchronized. */
const bankEvents = async (client: WireClient, afterSequence: number): Promise<EventEnvelope[]> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence });
  const events: EventEnvelope[] = [];
  for (;;) {
    const frame = await client.next((f) => "subscription" in f && f.subscription === subscription && (f.type === "event" || f.type === "synchronized"));
    if (frame.type === "synchronized") return events.filter((event) => event.type.startsWith("bank."));
    events.push((frame as EventFrame).event);
  }
};

const PERSONAL_LINE = "## maya-memory (personal, read-write) — 5 memories in 3 folders — Maya Reyes's private memory: her machines, projects and companies. Team facts go to the team's own bank.";

describe("banks.register and banks.list", () => {
  it("registers a local checkout by its path, keeping it, and lists it with its settings, status, counts and bank line", async () => {
    const t = await start();
    const client = await t.client();
    const checkout = gitBank(PERSONAL_BANK);
    const bankId = randomUUID();

    const bank = await registered(client, { bankId, path: checkout });

    const since = MANUAL_CLOCK_START;
    expect(bank).toEqual({
      id: bankId,
      name: "maya-memory",
      kind: "personal",
      location: { kind: "local" },
      checkout,
      checkoutOwnership: "registered",
      role: "read-write",
      enabled: true,
      accounts: "all",
      repositories: "all",
      defaultFor: [],
      pins: [],
      mergeOverride: "none",
      privateCopy: false,
      credential: "forge",
      status: {
        reachable: { state: "reachable", since },
        manifest: { state: "valid", since },
        orientation: { missing: [], since },
        owners: { unresolved: [], since },
        lastSync: null,
        landing: { state: "ok", since },
      },
      importedFrom: null,
      copiedFrom: null,
      createdAt: since,
      memories: 5,
      folders: 3,
      line: PERSONAL_LINE,
      sharedAliases: [],
      validator: { installedVersion: null, currentVersion: 1, needsUpdate: true },
    });
    expect(await list(client)).toEqual([bank]);
  });

  it("answers a repeated importedFrom with the bank registered from it, appending nothing", async () => {
    const t = await start();
    const client = await t.client();
    const first = await registered(client, { path: gitBank(PERSONAL_BANK), importedFrom: "notebook" });
    const from = t.env.log.head();
    const again = await registered(client, { path: gitBank(PERSONAL_BANK), importedFrom: "notebook" });
    expect(again).toEqual(first);
    expect(await bankEvents(client, from)).toEqual([]);
    expect(await list(client)).toEqual([first]);
  });

  it("refuses a second bank of a name another holds, conflict name_taken, registering nothing", async () => {
    const t = await start();
    const client = await t.client();
    await registered(client, { path: gitBank(PERSONAL_BANK) });
    const answer = await register(client, { path: gitBank(PERSONAL_BANK) });
    expect(answer.receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "name_taken", name: "maya-memory" } } });
    expect(await list(client)).toHaveLength(1);
  });

  it("refuses an id a bank was registered under already, conflict exists, registering nothing", async () => {
    const t = await start();
    const client = await t.client();
    const bank = await registered(client, { path: gitBank(PERSONAL_BANK) });
    const from = t.env.log.head();
    const answer = await register(client, { path: gitBank(changed(PERSONAL_BANK, { "BANK.md": null })), bankId: bank.id });
    expect(answer.receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "exists", bankId: bank.id } } });
    expect(await list(client)).toEqual([bank]);
    expect(await bankEvents(client, from)).toEqual([]);
  });

  it("refuses a path that holds no git repository, or is not absolute, invalid_params", async () => {
    const client = await (await start()).client();
    const answer = await register(client, { path: tempDir("agent-harness-not-a-bank-") });
    expect(answer.receipt).toMatchObject({ status: "rejected", error: { code: "invalid_params" } });
    expect((await register(client, { path: "banks/maya-memory" })).receipt).toMatchObject({ status: "rejected", error: { code: "invalid_params" } });
    expect(await list(client)).toEqual([]);
  });
});

/**
 * A personal bank named `name` holding one memory in each of `projects` projects, each with a long line: about 160 bytes
 * of root breadcrumbs a project, so three of 20 come past 8 KB of fixed tiers together and two do not.
 */
const wideBank = (name: string, projects: number): Record<string, string> => {
  const files: Record<string, string> = {
    "BANK.md": markdown(personalManifest({ name, orientation: [] }), "\n# How agents use this bank\n"),
    "projects/personal/ORG.md": markdown({ line: "The org every project of this bank is in" }),
  };
  for (let n = 1; n <= projects; n += 1) {
    files[`projects/personal/project-${n}/PROJECT.md`] = scopeFile(`Project ${n}: ${"a long one-line summary of what the project holds, ".repeat(2).trim()}`);
    files[`projects/personal/project-${n}/memories/fact-${n}.md`] = memory(`fact-${n}`, { description: `When project ${n} needs its one fact - the fact this bank holds about it` });
  }
  return files;
};

describe("the 8 KB rule", () => {
  it("refuses a register under which an account and repository would carry over 8 KB of fixed tiers, conflict index_too_large naming the banks and scopes", async () => {
    const t = await start();
    const client = await t.client();
    await registered(client, { path: gitBank(wideBank("bank-one", 20)) });
    await registered(client, { path: gitBank(wideBank("bank-two", 20)) });
    const from = t.env.log.head();

    const answer = await register(client, { path: gitBank(wideBank("bank-three", 20)) });
    expect(answer.receipt).toMatchObject({
      status: "rejected",
      error: {
        code: "conflict",
        message: expect.stringMatching(/^The fixed tiers of bank-one, bank-two and bank-three would come to \d+ bytes for every account in every repository, over the 8192-byte limit\.$/),
        data: { reason: "index_too_large", limitBytes: 8192, banks: ["bank-one", "bank-two", "bank-three"], scopes: [{ account: "all", repository: "all" }] },
      },
    });
    expect(await bankEvents(client, from)).toEqual([]);
  });

  it("admits a bank whose scope no other bank of its size shares", async () => {
    const client = await (await start()).client();
    const account = randomUUID();
    await registered(client, { path: gitBank(wideBank("bank-one", 20)), accounts: [randomUUID()] });
    await registered(client, { path: gitBank(wideBank("bank-two", 20)), repositories: ["https://git.example/acme/web"] });
    const third = await registered(client, { path: gitBank(wideBank("bank-three", 20)), accounts: [account], repositories: ["https://git.example/acme/api"] });
    expect(third.name).toBe("bank-three");
  });
});

describe("alias collisions", () => {
  it("warns on each bank of an alias another bank claims too, whatever its case, leaving each bank as it was", async () => {
    const client = await (await start()).client();
    const personal = await registered(client, { path: gitBank(PERSONAL_BANK) });
    const otherManifest = personalManifest({ name: "sam-memory", entities: [{ name: "Storage", aliases: ["NAS", "storage"] }], orientation: [] });
    const other = await registered(client, { path: gitBank(changed(PERSONAL_BANK, { "BANK.md": markdown(otherManifest) })) });
    expect(other.sharedAliases).toEqual([{ alias: "nas", banks: ["maya-memory"] }]);
    expect((await list(client)).map((bank) => [bank.name, bank.sharedAliases])).toEqual([
      ["maya-memory", [{ alias: "nas", banks: ["sam-memory"] }]],
      ["sam-memory", [{ alias: "nas", banks: ["maya-memory"] }]],
    ]);
    expect((await client.request("banks.get", { bankId: personal.id })).bank).toMatchObject({ role: "read-write", sharedAliases: [{ alias: "nas", banks: ["sam-memory"] }] });
  });
});

describe("banks.get", () => {
  it("answers one bank, and not_found for one not registered", async () => {
    const client = await (await start()).client();
    const bank = await registered(client, { path: gitBank(PERSONAL_BANK) });
    expect((await client.request("banks.get", { bankId: bank.id })).bank).toEqual(bank);
    await expect(client.request("banks.get", { bankId: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("banks.verify", () => {
  it("records bank.verified as system:banks only when a status changed, each unchanged part keeping its since", async () => {
    const t = await start();
    const client = await t.client();
    const checkout = gitBank(PERSONAL_BANK);
    const bank = await registered(client, { path: checkout });
    const from = t.env.log.head();

    t.clock.advance(60_000);
    expect((await client.request("banks.verify", {})).banks).toEqual([bank]);
    expect(await bankEvents(client, from)).toEqual([]);

    git(checkout, "rm", "--quiet", "BANK.md");
    git(checkout, "commit", "--quiet", "-m", "No manifest.");
    t.clock.advance(60_000);
    const later = new Date(Date.parse(MANUAL_CLOCK_START) + 120_000).toISOString();
    const [after] = (await client.request("banks.verify", { bankId: bank.id })).banks;
    const status = { ...bank.status, manifest: { state: "missing", since: later } };
    expect(after?.status).toEqual(status);
    const events = await bankEvents(client, from);
    expect(events.map(({ type, actor, payload }) => ({ type, actor, payload }))).toEqual([{ type: "bank.verified", actor: { kind: "system", id: "banks" }, payload: { bankId: bank.id, status } }]);
    expect((await client.request("banks.verify", {})).banks.map((each) => each.status)).toEqual([status]);
    expect(await bankEvents(client, from)).toHaveLength(1);
  });

  it("takes the name and kind a BANK.md landed since registration names, as system:banks", async () => {
    const t = await start();
    const client = await t.client();
    const checkout = gitBank(changed(PERSONAL_BANK, { "BANK.md": null }));
    const bank = await registered(client, { path: checkout });
    expect([bank.kind, bank.line]).toEqual([null, null]);
    writeFileSync(join(checkout, "BANK.md"), PERSONAL_BANK["BANK.md"] ?? "");
    git(checkout, "add", "BANK.md");
    git(checkout, "commit", "--quiet", "-m", "Describe the bank.");
    const from = t.env.log.head();

    const [after] = (await client.request("banks.verify", {})).banks;
    expect(after).toMatchObject({ name: "maya-memory", kind: "personal", line: PERSONAL_LINE, status: { manifest: { state: "valid" } } });
    expect((await bankEvents(client, from)).map(({ type, actor, payload }) => ({ type, actor, payload }))).toEqual([
      { type: "bank.updated", actor: { kind: "system", id: "banks" }, payload: { bankId: bank.id, name: "maya-memory", kind: "personal" } },
      { type: "bank.verified", actor: { kind: "system", id: "banks" }, payload: { bankId: bank.id, status: after?.status } },
    ]);
  });

  it("joins a verification of every bank running rather than starting a second: the forge is asked once", async () => {
    const t = await start();
    const client = await t.client();
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.user(TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo" });
    const checkout = gitBank(changed(TEAM_BANK, { "BANK.md": null }));
    git(checkout, "remote", "add", "origin", `${forge.origin}/acme/bank.git`);
    forge.repository(TOKEN, "acme/bank");
    await registered(client, { path: checkout });
    const reads = () => forge.requests.filter((request) => request.path === "/api/v1/repos/acme/bank").length;
    const before = reads();
    let release!: () => void;
    let asked!: () => void;
    const held = new Promise<void>((resolve) => (asked = resolve));
    const body = { full_name: "acme/bank", private: true, default_branch: "main", html_url: `${forge.origin}/acme/bank` };
    forge.answer(TOKEN, "GET /api/v1/repos/acme/bank", () => {
      asked();
      return { status: 200, body, after: new Promise<void>((resolve) => (release = resolve)) };
    });
    const first = client.request("banks.verify", {});
    await held;
    const second = client.request("banks.verify", {});
    release();
    expect(await second).toEqual(await first);
    expect(reads()).toBe(before + 1);
  });

  it("records a bank with a remote whose checkout is gone as unreachable, its other parts as last found", async () => {
    const t = await start();
    const client = await t.client();
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.user(TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo" });
    const checkout = gitBank(changed(TEAM_BANK, { "BANK.md": null }));
    git(checkout, "remote", "add", "origin", `${forge.origin}/acme/bank.git`);
    forge.repository(TOKEN, "acme/bank");
    const bank = await registered(client, { path: checkout });
    expect(bank.status.reachable.state).toBe("reachable");
    rmSync(checkout, { recursive: true, force: true });
    t.clock.advance(60_000);
    const later = new Date(Date.parse(MANUAL_CLOCK_START) + 60_000).toISOString();
    const [after] = (await client.request("banks.verify", { bankId: bank.id })).banks;
    expect(after?.status).toEqual({ ...bank.status, reachable: { state: "unreachable", reason: `its repository at ${checkout} is not there`, cause: "folder-missing", since: later } });
  });

  it("keeps an owner last found unresolved, and a pull request last found holding BANK.md, while the forge does not answer: nothing is recorded", async () => {
    const t = await start();
    const client = await t.client();
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.user(TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo" });
    const onForge = (files: Readonly<Record<string, string>>, name: string): string => {
      const checkout = gitBank(files);
      git(checkout, "remote", "add", "origin", `${forge.origin}/acme/${name}.git`);
      forge.repository(TOKEN, `acme/${name}`);
      return checkout;
    };
    forge.answer(TOKEN, "GET /api/v1/users/maya-reyes", { status: 404, body: { message: "user does not exist" } });
    forge.answer(TOKEN, "GET /api/v1/users/sam-ortiz", { status: 200, body: { id: 7, login: "sam-ortiz" } });
    const team = await registered(client, { path: onForge(TEAM_BANK, "team") });
    const reviewed = onForge(changed(TEAM_BANK, { "BANK.md": null }), "reviewed");
    git(reviewed, "switch", "--quiet", "--create", "setup/describe-2026-09-24");
    writeFileSync(join(reviewed, "BANK.md"), TEAM_BANK["BANK.md"] ?? "");
    git(reviewed, "add", "BANK.md");
    git(reviewed, "commit", "--quiet", "-m", "Describe the bank.");
    git(reviewed, "switch", "--quiet", "main");
    forge.pullRequest(TOKEN, "acme/reviewed", 7, { head: "setup/describe-2026-09-24", sha: git(reviewed, "rev-parse", "setup/describe-2026-09-24").trim(), state: "open" });
    const awaiting = await registered(client, { path: reviewed });
    expect([team.status.owners.unresolved, awaiting.status.manifest.state]).toEqual([["maya-reyes"], "awaiting-review"]);
    const from = t.env.log.head();

    const down = { status: 503, body: { message: "The forge is down for maintenance." } };
    for (const route of ["GET /api/v1/users/maya-reyes", "GET /api/v1/users/sam-ortiz", "GET /api/v1/repos/acme/reviewed/pulls"]) forge.answer(TOKEN, route, down);
    t.clock.advance(60_000);
    expect((await client.request("banks.verify", {})).banks.map((bank) => bank.status)).toEqual([team.status, awaiting.status]);
    expect(await bankEvents(client, from)).toEqual([]);
  });
});
