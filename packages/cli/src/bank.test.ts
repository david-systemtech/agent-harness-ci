import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonObject } from "@agent-harness/contracts";
import { expect, it, vi } from "vitest";
import { PERSONAL_BANK, TEAM_BANK, markdown, personalManifest, type FixtureBank } from "../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../environment/test/cleanups.js";
import { callHostTool, end, fakeAdapter, type HostToolCallScript } from "../../environment/test/fake-adapter.js";
import { startTestEnvironment } from "../../environment/test/helper.js";
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

/** `files` committed on `main` in a fresh repository. */
const bankRepository = (files: FixtureBank): string => {
  const root = tempDir("bank-cli-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "The bank.");
  return root;
};

const start = async () => {
  const adapter = fakeAdapter();
  const t = await startTestEnvironment({ adapter });
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

/** The CLI in-process, `bank` and `args` against the environment's data directory: its exit code, its output, and every URL its network was given. */
const bankCli = async (h: Harness, args: readonly string[], options: { readonly env?: Record<string, string>; readonly stdin?: string } = {}) => {
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
  const code = await runCli(["bank", ...args, "--data-dir", h.t.dataDir], {
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
