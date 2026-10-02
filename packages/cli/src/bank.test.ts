import { randomUUID } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { SCOPES, type JsonObject } from "@agent-harness/contracts";
import { expect, it, vi } from "vitest";
import { validateBank } from "@agent-harness/contracts/bank-validator";
import { PERSONAL_BANK, RULE_FIXTURES, TEAM_BANK, markdown, memory, personalManifest, type FixtureBank } from "../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../environment/test/cleanups.js";
import { callHostTool, end, fakeAdapter, type HostToolCallScript } from "../../environment/test/fake-adapter.js";
import { startFakeForge } from "../../environment/test/fake-forge.js";
import { added, DAVID, TOKEN } from "../../environment/test/forge.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../environment/test/helper.js";
import { create } from "../../environment/test/sessions.js";
import { WAIT_MS } from "../../environment/test/wire-client.js";
import { git } from "../../environment/test/workspaces.js";
import { runCli } from "./cli.js";

/**
 * The `bank` verbs (#1044): a Claude Code session outside the harness
 * reaching the banks of the environment on its machine through a local
 * client session, against an in-process environment and fixture banks as
 * git repositories, the memory tools of a scripted run answering the same
 * calls beside it.
 */

const { onCleanup, tempDir } = useCleanups();

/** `files` as a bank's working tree, each of its `unreadable` files a link to nothing, as `validate.mjs`'s tests lay one out. */
const bankFolder = (files: FixtureBank, unreadable: Readonly<Record<string, string>> = {}): string => {
  const root = tempDir("bank-cli-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  for (const path of Object.keys(unreadable)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(join(root, "nowhere.md"), join(root, path));
  }
  return root;
};

/** `files` committed on `main` in a fresh repository. */
const bankRepository = (files: FixtureBank): string => {
  const root = bankFolder(files);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "The bank.");
  return root;
};

const start = async (options: TestEnvironmentOptions = {}) => {
  const adapter = fakeAdapter();
  const t = await startTestEnvironment({ adapter, ...options });
  onCleanup(() => t.close());
  return { t, adapter, client: await t.client() };
};
type Harness = Awaited<ReturnType<typeof start>>;

const register = async (h: Harness, files: FixtureBank, settings: JsonObject = {}, path = bankRepository(files)): Promise<string> => {
  const bankId = randomUUID();
  const answer = await h.client.request("banks.register", { commandId: randomUUID(), bankId, path, role: "read-write", accounts: "all", repositories: "all", defaultFor: [], ...settings });
  expect(answer.receipt.status).toBe("accepted");
  return bankId;
};

/** The personal bank as a local-only bank, which lands by committing on its main. */
const LOCAL_ONLY_BANK: FixtureBank = { ...PERSONAL_BANK, "BANK.md": markdown(personalManifest({ write: { ...(personalManifest()["write"] as Record<string, unknown>), land: "commit" } })) };

const DESCRIPTION = "When deploying the homelab service, use the documented rollout and verification steps.";

const tool = (name: string, input: JsonObject = {}): HostToolCallScript => ({ server: "memory", name, input });

/** What the memory tools answer `calls` in one run of a new session of the environment's default account. */
const toolAnswers = async (h: Harness, calls: readonly HostToolCallScript[]): Promise<{ text: string; isError: boolean }[]> => {
  const { id } = await create(h.client);
  const answers: { text: string; isError: boolean }[] = [];
  h.adapter.nextScripts.push(async function* (controls) {
    for (const request of calls) answers.push(yield* callHostTool(controls, request));
    yield end();
  });
  const run = await h.client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Look these up." });
  if (!run.result) throw new Error("The run was refused.");
  await vi.waitFor(() => expect(h.t.env.log.readStream({ kind: "session", id }).some((event) => event.type === "run.ended" && event.payload["runId"] === run.result?.runId)).toBe(true), { timeout: WAIT_MS });
  return answers;
};

interface CliOptions {
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  readonly cwd?: string;
}

/** The CLI in-process, `bank` and `args` against the environment's data directory: its exit code, its output, and every URL its network was given. */
const bankCli = (h: Harness, args: readonly string[], options: CliOptions = {}) => cli([...args, "--data-dir", h.t.dataDir], options);

/** The CLI in-process, `bank` and `args`: its exit code, its output, and every URL its network was given. */
const cli = async (args: readonly string[], options: CliOptions = {}) => {
  let out = "";
  let err = "";
  const urls: string[] = [];
  const Native = globalThis.WebSocket;
  class RecordingWebSocket extends Native {
    constructor(url: string | URL, protocols?: ConstructorParameters<typeof WebSocket>[1]) {
      urls.push(`WS ${String(url)}`);
      super(url, protocols);
    }
  }
  const code = await runCli(["bank", ...args], {
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    net: {
      fetch: (input, init) => {
        urls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return fetch(input, init);
      },
      WebSocket: RecordingWebSocket,
    },
    env: options.env ?? {},
    stdin: async () => options.stdin ?? "",
    // Outside any repository unless the test names one.
    cwd: options.cwd ?? tempDir("bank-cli-cwd-"),
  });
  return { code, out, err, urls };
};

it("searches the banks in scope through a local client session, printing what the memory tool answers", async () => {
  const h = await start();
  await register(h, PERSONAL_BANK);
  await register(h, TEAM_BANK, { role: "read-only" });
  const [limited, named, scoped, prefixed] = await toolAnswers(h, [
    tool("search", { query: "storefront needs", limit: 2 }),
    tool("search", { query: "storefront needs", bank: "acme" }),
    tool("search", { query: "disk", bank: "maya-memory", scope: { org: "personal", project: "homelab", area: "nas" } }),
    tool("search", { query: "storefront", scope: { org: "personal" } }),
  ]);
  expect(limited?.text).toMatch(/^- acme:storefront-fact-01 — .*\n- acme:storefront-fact-02 — .*\n2 of 40\n$/);

  const cli = await bankCli(h, ["search", "storefront needs", "--limit", "2"]);
  expect(cli).toMatchObject({ code: 0, out: limited?.text, err: "" });
  expect(cli.urls).toEqual([`POST http://127.0.0.1:${h.t.address.port}/api/bootstrap`, `WS ws://127.0.0.1:${h.t.address.port}/ws`]);
  expect(await bankCli(h, ["search", "storefront needs", "--bank", "acme"])).toMatchObject({ code: 0, out: named?.text, err: "" });
  expect(await bankCli(h, ["search", "disk", "--bank", "maya-memory", "--scope", "personal/homelab/nas"])).toMatchObject({ code: 0, out: scoped?.text, err: "" });
  expect(await bankCli(h, ["search", "storefront", "--scope", "personal"])).toMatchObject({ code: 0, out: prefixed?.text, err: "" });
});

it("reads every kind of pointer through a local client session, printing the memory tool's exact text and its sideways count", async () => {
  const h = await start();
  await register(h, PERSONAL_BANK);
  await register(h, TEAM_BANK, { role: "read-only" });
  const pointers = [undefined, "maya-memory", "maya-memory:personal/homelab/", "maya-memory:personal/homelab/memories/deploys/", "maya-memory:rollback-steps", "acme:storefront-fact-01"];
  const answers = await toolAnswers(h, pointers.map((pointer) => tool("read", pointer === undefined ? {} : { pointer })));
  expect(answers[4]?.text).toContain("In maya-memory:personal/homelab/memories/deploys/ (1)");
  for (const [i, pointer] of pointers.entries()) {
    expect(answers[i]?.isError).toBe(false);
    expect(await bankCli(h, ["read", ...(pointer === undefined ? [] : [pointer])])).toMatchObject({ code: 0, out: answers[i]?.text, err: "" });
  }
  expect(await bankCli(h, ["read", "maya-memory:no-such-memory"])).toMatchObject({ code: 1, out: "", err: expect.stringMatching(/^The environment refused banks\.memory\.read: .+\n$/) });
});

it("drafts in one invocation and another, each its own client session, then promotes the outside session's queue to the bank's main", async () => {
  const h = await start();
  const checkout = bankRepository(LOCAL_ONLY_BANK);
  const bankId = await register(h, LOCAL_ONLY_BANK, {}, checkout);
  const session = randomUUID();
  const claude = { CLAUDE_CODE_SESSION_ID: session };

  const first = await bankCli(h, ["draft", "rollout-steps", "--scope", "personal/homelab", "--type", "project", "--description", DESCRIPTION, "--body", "-"], { env: claude, stdin: "Roll out once, then check the health endpoint.\n" });
  expect(first).toMatchObject({ code: 0, err: "", out: `Queued rollout-steps for maya-memory at projects/personal/homelab/memories/rollout-steps.md (session ${session}).\n` });
  const second = await bankCli(h, ["draft", "canary-deploys", "--scope", "personal/homelab", "--topic", "deploys", "--type", "reference", "--description", "Before a risky homelab deploy - how to send it to the canary first and what to watch", "--body", "One canary for an hour.", "--session", session]);
  expect(second).toMatchObject({ code: 0, err: "" });
  expect(await bankCli(h, ["draft", "orphan", "--scope", "personal/homelab", "--type", "project", "--description", DESCRIPTION, "--body", "No session names its queue."])).toMatchObject({ code: 2, out: "", err: expect.stringContaining("--session") });

  const promoted = await bankCli(h, ["promote"], { env: claude });
  expect(promoted).toMatchObject({ code: 0, err: "" });
  expect(promoted.out).toBe([
    "Landed in maya-memory:",
    "  present projects/personal/homelab/memories/rollout-steps.md",
    "  present projects/personal/homelab/memories/deploys/canary-deploys.md",
    "",
  ].join("\n"));
  expect(git(checkout, "show", "main:projects/personal/homelab/memories/rollout-steps.md")).toContain("Roll out once, then check the health endpoint.");
  expect(git(checkout, "show", "main:projects/personal/homelab/memories/deploys/canary-deploys.md")).toContain("One canary for an hour.");
  const landed = h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).filter((event) => event.type === "bank.landed");
  expect(landed.map((event) => event.payload)).toEqual([expect.objectContaining({ bankId, sessionId: session })]);
  expect(await bankCli(h, ["promote", "--session", session])).toMatchObject({ code: 0, out: "Landed in maya-memory: no queued changes.\n" });
  // Each invocation revoked the client session it was exchanged for.
  expect((await h.client.request("access.sessions.list", { live: true })).sessions.map((entry) => entry.label).filter((label) => label.includes(" bank "))).toEqual([]);
});

it("refuses a draft as the memory tool does: with the validator's rule ids, for several writable banks none named, and for a read-only bank", async () => {
  const h = await start();
  await register(h, PERSONAL_BANK);
  await register(h, TEAM_BANK);
  await register(h, { ...PERSONAL_BANK, "BANK.md": markdown(personalManifest({ name: "maya-archive" })) }, { role: "read-only" });
  const fact = { scope: { org: "personal", project: "homelab" }, name: "short-fact", description: "Too short.", body: "Roll out once.", type: "project" };
  const [invalid, unnamed, readOnly] = await toolAnswers(h, [
    tool("draft", { ...fact, bank: "maya-memory" }),
    tool("draft", { ...fact, description: DESCRIPTION }),
    tool("draft", { ...fact, description: DESCRIPTION, bank: "maya-archive" }),
  ]);
  const wire = (answer: { text: string } | undefined) => JSON.parse(answer?.text ?? "null") as { code: string; message: string; data: { findings?: { severity: string; rule: string; message: string }[] } };
  expect([invalid, unnamed, readOnly].map((answer) => wire(answer).code)).toEqual(["validation_failed", "bank_required", "bank_read_only"]);

  const args = (description: string, ...more: string[]) => ["draft", "short-fact", "--scope", "personal/homelab", "--type", "project", "--description", description, "--body", "Roll out once.", "--session", randomUUID(), ...more];
  const refused = await bankCli(h, args("Too short.", "--bank", "maya-memory"));
  expect(refused).toMatchObject({ code: 1, out: "" });
  expect(refused.err).toMatch(/^refused description_length: /);
  expect(refused.err).toBe([
    ...(wire(invalid).data.findings ?? []).map((finding) => `${finding.severity === "refusal" ? "refused" : "warning"} ${finding.rule}: ${finding.message}`),
    `The environment refused banks.memory.draft: ${wire(invalid).message}`,
    "",
  ].join("\n"));
  expect(await bankCli(h, args(DESCRIPTION))).toMatchObject({
    code: 1, out: "", err: `The environment refused banks.memory.draft: ${wire(unnamed).message} The writable banks in scope: maya-memory, acme; name one with --bank.\n`,
  });
  expect(await bankCli(h, args(DESCRIPTION, "--bank", "maya-archive"))).toMatchObject({ code: 1, out: "", err: `The environment refused banks.memory.draft: ${wire(readOnly).message}\n` });
  expect(await bankCli(h, ["promote", "--session", randomUUID()])).toMatchObject({ code: 1, err: expect.stringContaining("The writable banks in scope: maya-memory, acme; name one with --bank.") });
});

it("reaches the banks in scope for the environment's default account and the repository it works in, and records no session's use", async () => {
  const h = await start();
  await register(h, PERSONAL_BANK, { repositories: ["https://github.com/maya-reyes/homelab"] });
  await register(h, TEAM_BANK, { accounts: ["claude-max"] });
  await register(h, { ...PERSONAL_BANK, "BANK.md": markdown(personalManifest({ name: "sam-memory" })) }, { accounts: ["sam-account"] });
  const repository = tempDir("bank-cli-homelab-");
  git(repository, "init", "--quiet", "--initial-branch=main");
  git(repository, "remote", "add", "origin", "git@github.com:Maya-Reyes/homelab.git");
  mkdirSync(join(repository, "scripts"));

  const elsewhere = await bankCli(h, ["read"]);
  expect(elsewhere).toMatchObject({ code: 0, err: "" });
  expect(elsewhere.out).toMatch(/^## acme \(team, read-write\)/m);
  expect(elsewhere.out).not.toMatch(/^## (maya|sam)-memory /m);
  const inRepository = await bankCli(h, ["read"], { cwd: join(repository, "scripts") });
  expect(inRepository.out).toMatch(/^## acme \(team, read-write\)/m);
  expect(inRepository.out).toMatch(/^## maya-memory \(personal, read-write\)/m);
  expect(inRepository.out).not.toMatch(/^## sam-memory /m);
  // With one writable bank in scope outside the repository, a draft goes to it unnamed.
  const session = randomUUID();
  expect(await bankCli(h, ["search", "storefront", "--limit", "1"])).toMatchObject({ code: 0, err: "" });
  const queued = await bankCli(h, ["draft", "release-train", "--scope", "acme/bank", "--type", "project", "--description", "When shipping the storefront - which day the release train leaves and who signs off on it", "--body", "Thursdays.", "--session", session]);
  expect(queued, queued.err).toMatchObject({
    code: 0, out: `Queued release-train for acme at projects/acme/bank/memories/release-train.md (session ${session}).\n`,
  });
  expect(h.t.env.log.readStream({ kind: "session", id: session })).toEqual([]);
});

/**
 * `files` as a bank on a fake forge's `maya/memory`, whose git is a bare
 * repository beside it, checked out and registered on an environment with
 * the forge's account, which the harness's git reaches through its
 * credential helper, as the Lander's tests set it up.
 */
const forgeBank = async (files: FixtureBank) => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  forge.repository(TOKEN, "maya/memory");
  forge.gitCredential("david", TOKEN);
  const remote = join(tempDir("bank-cli-origin-"), "memory.git");
  git(tempDir(), "clone", "--quiet", "--bare", bankRepository(files), remote);
  const checkout = tempDir("bank-cli-checkout-");
  git(checkout, "clone", "--quiet", remote, ".");
  git(checkout, "remote", "set-url", "origin", `${forge.origin}/maya/memory.git`);
  const helper = join(tempDir("bank-cli-helper-"), "helper.mjs");
  writeFileSync(helper, `import { readFileSync } from "node:fs";
if (process.argv.at(-1) !== "get") process.exit(0);
const attrs = Object.fromEntries(readFileSync(0, "utf8").trim().split("\\n").map(line => line.split("=")));
const response = await fetch("http://" + process.env.AGENT_HARNESS_ADDRESS + "/api/internal/git-credential", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.AGENT_HARNESS_RUN_SECRET }, body: JSON.stringify({ action: "get", slug: process.argv.at(-2), protocol: attrs.protocol, host: attrs.host }) });
if (response.ok) { const answer = await response.json(); process.stdout.write("username=" + answer.username + "\\npassword=" + answer.password + "\\n\\n"); }
`);
  const h = await start({ forgeFetch: forge.fetch, harnessCommand: [process.execPath, helper], harnessGitConfig: [[`url.${pathToFileURL(remote).href}.insteadOf`, `${forge.origin}/maya/memory.git`]] });
  await added(h.client, { url: forge.origin, kind: "forgejo" });
  const bankId = await register(h, files, {}, checkout);
  return { ...h, forge, remote, checkout, bankId };
};

it("prints the pull request and each pending file of a landing awaiting review, and the step and reason of a failed one", async () => {
  const reviewed = { ...(personalManifest()["write"] as Record<string, unknown>), merge: { memories: "review", reviewed: ["orientation", "decisions", "status", "manifest"] } };
  const h = await forgeBank({ ...PERSONAL_BANK, "BANK.md": markdown(personalManifest({ write: reviewed })) });
  const pullRequest = `${h.forge.origin}/maya/memory/pulls/1`;
  h.forge.answer(TOKEN, "POST /api/v1/repos/maya/memory/pulls", (request) => {
    const branch = (request.body as { head: string }).head;
    h.forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch });
    return { status: 201, body: { number: 1, title: "Memories", state: "open", head: { ref: branch, sha: git(h.remote, "rev-parse", branch).trim(), repo: { full_name: "maya/memory" } }, base: { ref: "main" }, html_url: pullRequest } };
  });
  const elsewhere = bankRepository({ ...PERSONAL_BANK, "BANK.md": markdown(personalManifest({ name: "sam-memory" })) });
  git(elsewhere, "remote", "add", "origin", "https://git.example.test/sam/memory.git");
  await register(h, {}, {}, elsewhere);
  const session = randomUUID();
  const draft = (bank: string) => bankCli(h, ["draft", "rollout-steps", "--bank", bank, "--scope", "personal/homelab", "--type", "project", "--description", DESCRIPTION, "--body", "Roll out once.", "--session", session]);
  expect(await draft("maya-memory")).toMatchObject({ code: 0, err: "" });
  expect(await draft("sam-memory")).toMatchObject({ code: 0, err: "" });

  const awaiting = await bankCli(h, ["promote", "--bank", "maya-memory", "--session", session]);
  expect(awaiting).toMatchObject({ code: 0, err: "", out: `Awaiting review in maya-memory: ${pullRequest}\n  pending projects/personal/homelab/memories/rollout-steps.md\n` });
  const failed = await bankCli(h, ["promote", "--bank", "sam-memory", "--session", session]);
  const landing = h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).findLast((event) => event.type === "bank.landing-failed");
  // No forge account serves the origin: the landing cannot fetch the bank.
  expect(landing?.payload).toMatchObject({ sessionId: session, step: "fetch", reason: expect.any(String) });
  expect(failed).toMatchObject({ code: 1, out: "", err: `Landing in sam-memory failed at ${String(landing?.payload["step"])}: ${String(landing?.payload["reason"])}\n` });
});

it("answers the memory methods to a local client session only: a paired client is forbidden, reason local, and queues nothing", async () => {
  const h = await start();
  const bankId = await register(h, PERSONAL_BANK);
  const paired = await h.t.client({ token: (await h.t.pair({ scopes: [...SCOPES] })).token });
  const sessionId = randomUUID();
  const fact = { scope: { org: "personal", project: "homelab" }, name: "rollout-steps", description: DESCRIPTION, body: "Roll out once.", type: "project" as const };
  await expect(paired.request("banks.memory.search", { query: "homelab", repositoryIdentity: null })).rejects.toMatchObject({ code: "forbidden", data: { scope: "read", reason: "local" } });
  await expect(paired.request("banks.memory.read", { repositoryIdentity: null })).rejects.toMatchObject({ code: "forbidden", data: { scope: "read", reason: "local" } });
  await expect(paired.request("banks.memory.draft", { ...fact, sessionId, repositoryIdentity: null })).rejects.toMatchObject({ code: "forbidden", data: { scope: "admin", reason: "local" } });
  await expect(paired.request("banks.memory.promote", { sessionId, repositoryIdentity: null })).rejects.toMatchObject({ code: "forbidden", data: { scope: "admin", reason: "local" } });
  expect(h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).filter((event) => event.payload["bankId"] === bankId && event.type.startsWith("bank.dra"))).toEqual([]);
  // The local client session the bank verbs exchange is answered.
  expect(await h.client.request("banks.memory.draft", { ...fact, sessionId, repositoryIdentity: null })).toMatchObject({ bank: "maya-memory", change: { kind: "draft", name: "rollout-steps" } });
});

it("validates a bank's working tree with the contracts' versioned validator, as the bank's CI does, with no environment", async () => {
  const cases: readonly (readonly [FixtureBank, Readonly<Record<string, string>>])[] = [
    [PERSONAL_BANK, {}],
    [TEAM_BANK, {}],
    ...Object.values(RULE_FIXTURES).map(({ bank, unreadable = {} }) => [bank, unreadable] as const),
  ];
  for (const [bank, unreadable] of cases) {
    const expected = validateBank({ files: bank, unreadable });
    const { code, out, urls } = await cli(["validate", bankFolder(bank, unreadable), "--json"]);
    expect(JSON.parse(out)).toEqual(expected);
    expect(code).toBe(expected.valid ? 0 : 1);
    expect(urls).toEqual([]);
  }
  expect(await cli(["validate", bankFolder(RULE_FIXTURES.orientation_missing.bank)])).toMatchObject({
    code: 1,
    out: "refused orientation_missing: BANK.md's orientation names where-work-is-tracked, which no memory in the bank has: write it in the bank's home folder or take the name out.\nbank-validator 1: 1 refused\n",
  });
  expect(await cli(["validate"], { cwd: bankFolder(TEAM_BANK) })).toMatchObject({ code: 0, out: "bank-validator 1: valid\n", err: "" });

  // Read as bank CI reads it: a link back to a folder it is in refused, a linked folder read as the folder.
  const looped = bankFolder(PERSONAL_BANK);
  symlinkSync("..", join(looped, "projects/personal/homelab/memories/loop"));
  expect((await cli(["validate", looped])).out).toBe("refused unreadable: projects/personal/homelab/memories/loop/ could not be read (ELOOP), so the verdict is on the bank without it: make it readable, or remove it.\nbank-validator 1: 1 refused\n");
  const nas = "projects/personal/homelab/nas";
  const linked = bankFolder(Object.fromEntries(Object.entries(PERSONAL_BANK).map(([path, text]) => [path.replace(`${nas}/`, "elsewhere/nas/"), text])));
  symlinkSync("../../../elsewhere/nas", join(linked, nas));
  expect(await cli(["validate", linked])).toMatchObject({ code: 0, out: "bank-validator 1: valid\n" });
});

it("refuses in validate what the memory tool's draft refuses, by the same rule ids", async () => {
  const h = await start();
  await register(h, PERSONAL_BANK);
  const [refused] = await toolAnswers(h, [tool("draft", { scope: { org: "personal", project: "homelab" }, name: "short-fact", description: "Too short.", body: "Roll out once.", type: "project" })]);
  const { data } = JSON.parse(refused?.text ?? "null") as { data: { rules: string[] } };
  expect(data.rules).toEqual(["description_length"]);
  const folder = bankFolder({ ...PERSONAL_BANK, "projects/personal/homelab/memories/short-fact.md": memory("short-fact", { description: "Too short." }) });
  const validated = await cli(["validate", folder, "--json"]);
  const verdict = JSON.parse(validated.out) as { findings: { rule: string; severity: string }[] };
  expect(validated.code).toBe(1);
  expect([...new Set(verdict.findings.filter((finding) => finding.severity === "refusal").map((finding) => finding.rule))]).toEqual(data.rules);
});

it("offers exactly the five bank verbs of this build, naming them when none or another is asked for", async () => {
  expect(await cli([])).toMatchObject({ code: 2, out: "", err: expect.stringMatching(/^bank takes a verb: validate, search, read, draft, promote\.\n/) });
  expect(await cli(["retire", "rollout-steps"])).toMatchObject({ code: 2, out: "", err: expect.stringMatching(/^Unknown bank verb retire\.\n/) });
  const usage = (await cli(["retire"])).err;
  expect(usage.match(/^ +agent-harness bank \w+/gm)?.map((line) => line.trim().split(" ")[2])).toEqual(["validate", "search", "read", "draft", "promote"]);
});
