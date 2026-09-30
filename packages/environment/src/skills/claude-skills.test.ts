import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { registry } from "@agent-harness/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { FakeSdk, sdk, type FakeQuery } from "../../test/fake-claude-sdk.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";

/**
 * The run's skill set end to end with the Claude adapter (skills spec,
 * "Testing Decisions", the adapter seam): the in-process environment with
 * the Claude adapter registered and its SDK transport scripted, so what is
 * asserted is what the CLI would be spawned with. A skill created through
 * the wire reaches the next run's process as the generation, its one local
 * plugin; a changed set spawns a fresh process, and an unchanged one is
 * served on the kept process.
 */

const hooks = vi.hoisted(() => ({ sdk: undefined as undefined | { query: (params: never) => unknown; getSessionMessages: (id: string, options: unknown) => unknown } }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: never) => {
    if (hooks.sdk === undefined) throw new Error("The test installed no fake SDK.");
    return hooks.sdk.query(params);
  },
  getSessionMessages: (id: string, options: unknown) => hooks.sdk?.getSessionMessages(id, options),
}));

const { createClaudeAdapter } = await import("../adapters/claude/index.js");
const { startTestEnvironment } = await import("../../test/helper.js");
const { create } = await import("../../test/sessions.js");

const PROVIDER_SESSION = "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a";

const { onCleanup, tempDir } = useCleanups();

let fake: FakeSdk;

beforeEach(() => {
  fake = new FakeSdk();
  hooks.sdk = fake;
});

afterEach(() => {
  hooks.sdk = undefined;
});

/** An environment whose one account is a Claude account, signed in, on the scripted SDK. */
const start = async () => {
  const claude = createClaudeAdapter({
    executablePath: "/sdk/claude",
    hostEnv: { PATH: "/usr/bin" },
    diagnostic: () => undefined,
    runCommand: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "david@example.com" }), stderr: "" }),
  });
  const t = await startTestEnvironment({ adapters: [claude], accounts: [{ id: "work", provider: "claude", directory: tempDir("agent-harness-claude-") }] });
  onCleanup(() => t.close());
  const client = await t.client();
  const { id } = await create(client, { account: "work", workspace: { kind: "directory", path: tempDir("agent-harness-workspace-") } });
  return { t, client, sessionId: id };
};

const createSkill = async (client: WireClient, name: string, description: string) =>
  registry["skills.own.create"].response.parse(await client.request("skills.own.create", { commandId: randomUUID(), name, description }));

/** The queries that are runs', not the unsampled ones the environment asks for models or usage: a run's is the one that asks the host about tools. */
const runQueries = (): FakeQuery[] => fake.queries.filter((query) => query.options.canUseTool !== undefined);

/** Resolves once `count` run queries have been made; answers the last. */
const runQuery = async (count: number): Promise<FakeQuery> => {
  await vi.waitFor(() => expect(runQueries()).toHaveLength(count), { timeout: WAIT_MS });
  return runQueries()[count - 1] as FakeQuery;
};

/** Starts a run and answers it on `query` once its prompt, the `prompt`th on that process, is pushed: linked, replied to, completed. */
const runOn = async (client: WireClient, sessionId: string, text: string, query: () => Promise<FakeQuery>, prompt: number): Promise<FakeQuery> => {
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  const served = await query();
  await served.promptsPushed(prompt);
  served.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart(`msg_${randomUUID()}`, [answer.result.messageId]), sdk.result(PROVIDER_SESSION));
  return served;
};

/** Resolves once the session has `count` runs ended. */
const ended = async (t: Awaited<ReturnType<typeof start>>["t"], sessionId: string, count: number) =>
  vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended")).toHaveLength(count), { timeout: WAIT_MS });

/** The one local plugin a query was spawned with. */
const pluginOf = (query: FakeQuery): string => {
  const plugins = query.options.plugins ?? [];
  expect(plugins).toHaveLength(1);
  return (plugins[0] as { readonly path: string }).path;
};

describe("the run's skill set with the Claude adapter", () => {
  it("hands the process spawned after skills.own.create the generation holding the skill, serves an unchanged set on the kept process, and spawns a fresh one after another create", async () => {
    const { t, client, sessionId } = await start();
    const own = join(t.dataDir, "skills", "own");
    await createSkill(client, "tdd", "Test-driven development.");

    const first = await runOn(client, sessionId, "One", () => runQuery(1), 1);
    await ended(t, sessionId, 1);
    const generation = pluginOf(first);
    expect(generation.startsWith(join(t.dataDir, "skills", "generations"))).toBe(true);
    expect(readdirSync(join(generation, "skills"))).toEqual(["tdd"]);
    expect(lstatSync(join(generation, "skills", "tdd")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(generation, "skills", "tdd"))).toBe(join(own, "skills", "tdd"));

    // No change: the kept process reads the next prompt, and no process is spawned for it.
    await runOn(client, sessionId, "Two", async () => first, 2);
    await ended(t, sessionId, 2);
    expect(runQueries()).toHaveLength(1);

    // Another create: the session's next run is a fresh process, spawned with the new generation and resuming the conversation.
    await createSkill(client, "handoff", "Hand the conversation off.");
    const fresh = await runOn(client, sessionId, "Three", () => runQuery(2), 1);
    await ended(t, sessionId, 3);
    expect(first.closed).toBe(true);
    expect(fresh.options.resume).toBe(PROVIDER_SESSION);
    expect(pluginOf(fresh)).not.toBe(generation);
    expect(readdirSync(join(pluginOf(fresh), "skills")).sort()).toEqual(["handoff", "tdd"]);
  });
});
