import { randomUUID } from "node:crypto";
import { SCOPES, registry, type Mode, type ParamsOf, type ResponseOf, type Scope } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { end, fakeAdapter, say, toldText, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { create, deleteSession, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import type { AdapterEvent, PromptDetail } from "../adapter/contract.js";
import { openEventLog } from "../event-log/event-log.js";
import { runsProjector } from "../runs/runs-projector.js";
import { sessionListProjector } from "../sessions/session-list.js";
import type { Reader } from "../sessions/session-reads.js";
import { permissionsProjector } from "./permissions-store.js";
import { readRunPolicy } from "./review-store.js";
import { recordToolDecision, runToolCalls } from "./tool-decisions.js";
import type { ActorRunRequest } from "../serve/start.js";

/**
 * The Unattended review (#131; permissions spec, "The Unattended review
 * view"): `permissions.review.list` and `permissions.review.seen` through the
 * primary seam, with runs started by a client session and by routines, bots
 * and the completions surface, each making tool calls the fake provider
 * scripts.
 */

const { onCleanup } = useCleanups();

const MINUTE = 60_000;
const at = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();
const UNATTENDED_DENIAL = "Denied: nobody is present to approve this. Continue without it and say what you could not do.";

const start = async (): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ adapter: fakeAdapter() });
  onCleanup(() => t.close());
  return t;
};

type Command = "runs.start" | "permissions.prompts.answer" | "permissions.settings.set" | "permissions.review.seen";

const send = async <N extends Command>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId"> & { commandId?: string }): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

const list = async (client: WireClient) => registry["permissions.review.list"].result.parse(await client.request("permissions.review.list", {}));

/** Who starts a run that no client session starts: a routine or a bot by its id, or the completions surface. */
type Who = Omit<ActorRunRequest, "sessionId" | "text" | "mode">;

const routine = (name = "nightly-receipts", ceiling: Mode = "acceptEdits"): Who => ({ actor: { kind: "routine", name, ceiling, clientSessionId: null }, actorId: `routine-${name}` });

/** A run `who` starts on the session, through the environment's own start. */
const startAs = (t: TestEnvironment, sessionId: string, who: Who, text = "Go") => t.env.startRun({ sessionId, text, ...who } as ActorRunRequest);

const untilEnded = (t: TestEnvironment, sessionId: string, runId: string) =>
  vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true));

const untilOpened = (t: TestEnvironment, sessionId: string) =>
  vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "prompt.opened")).toBe(true));

const started = (toolCallId: string, name = "Bash", input: Record<string, string> = { command: "ls" }): AdapterEvent => ({
  type: "tool.started",
  payload: { toolCallId, name, input, title: null, agentId: null, parentToolCallId: null },
});
const ended = (toolCallId: string, status: "ok" | "error" = "ok"): AdapterEvent => ({ type: "tool.ended", payload: { toolCallId, status, output: null, durationMs: 1 } });

const permission: PromptDetail = { toolName: "Bash", toolCallId: "toolu_1", input: { command: "sudo apt install jq" }, summary: "Claude wants to run sudo apt install jq" };

/** A run that lists a directory without asking, then asks to install a package, and ends. */
const listThenInstall: Script = async function* ({ context, input }) {
  yield started("t-ls");
  yield ended("t-ls");
  yield started("toolu_1", "Bash", { command: "sudo apt install jq" });
  const decision = await context.broker.request({ sessionId: input.sessionId, runId: input.runId, kind: "permission", detail: permission, promptId: "toolu_1" });
  yield say(toldText(decision));
  yield ended("toolu_1", decision.decision === "allow" ? "ok" : "error");
  yield end();
};

/** A run that only lists a directory, without asking. */
const listOnly: Script = () => [started("t-ls"), ended("t-ls"), end()];

/** A run that makes no tool call. */
const talkOnly: Script = () => [say("Nothing to do."), end()];

describe("permissions.review.list", () => {
  it("returns an unattended run that made a tool call: its ids, when, actor, mode and clamp, containment, counts and each denial", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    t.adapter.nextScripts.push(listThenInstall);
    t.clock.advance(MINUTE);
    const { runId } = startAs(t, id, routine(), "Tidy the receipts");
    await untilEnded(t, id, runId);

    const review = await list(client);
    expect(review.watermark).toBe(0);
    expect(review.head).toBe(t.env.log.head());
    expect(review.runs).toEqual([
      {
        sessionId: id,
        runId,
        ranAt: at(MINUTE),
        actor: { kind: "routine", name: "nightly-receipts" },
        attended: false,
        mode: { requested: null, effective: "acceptEdits", ceiling: "acceptEdits", clamped: false, clampReason: null },
        containment: { requested: null, effective: "off", mechanism: null, reason: null },
        counts: { toolCalls: 2, autoApproved: 1, denied: 1, answeredByPerson: 0, expired: 0 },
        denials: [{ toolCallId: "toolu_1", tool: "Bash", summary: "Claude wants to run sudo apt install jq", decidedBy: "unattended", reason: UNATTENDED_DENIAL }],
      },
    ]);
  });

  it("qualifies unattended runs with a tool call and attended runs with a decision by the TTL; newest first", async () => {
    const t = await start();
    const client = await t.client();
    await send(client, "permissions.settings.set", { values: { "permissions.parkedPrompt.ttl": { amount: 1, unit: "minutes" } } });
    const { id } = await create(client);
    const run = async (script: Script, how: Who | "client") => {
      t.adapter.nextScripts.push(script);
      t.clock.advance(MINUTE);
      const { runId } =
        how === "client"
          ? ((await send(client, "runs.start", { sessionId: id, text: "Go" })).result as { runId: string })
          : startAs(t, id, how);
      return runId;
    };

    const quiet = await run(talkOnly, routine());
    await untilEnded(t, id, quiet);
    const botRun = await run(listOnly, { actor: { kind: "bot", name: "triage", ceiling: "acceptEdits", clientSessionId: null }, actorId: "bot-triage" });
    await untilEnded(t, id, botRun);
    const program = await run(listOnly, { actor: { kind: "completions", attended: false, ceiling: "acceptEdits", clientSessionId: null } });
    await untilEnded(t, id, program);
    // An attended run whose calls a person or the mode decided does not qualify.
    const mine = await run(listThenInstall, "client");
    await untilOpened(t, id);
    await send(client, "permissions.prompts.answer", { promptId: "toolu_1", decision: "allow" });
    await untilEnded(t, id, mine);
    // One whose prompt waited past its TTL does.
    const expired = await run(listThenInstall, "client");
    await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id }).filter((event) => event.type === "prompt.opened")).toHaveLength(2));
    t.clock.advance(MINUTE);
    await untilEnded(t, id, expired);

    const review = await list(client);
    expect(review.runs.map((row) => row.runId)).toEqual([expired, program, botRun]);
    // At most `limit`, the newest.
    const limited = registry["permissions.review.list"].result.parse(await client.request("permissions.review.list", { limit: 2 }));
    expect(limited.runs.map((row) => row.runId)).toEqual([expired, program]);
    expect(review.runs.map((row) => row.actor)).toEqual([
      { kind: "client", name: null },
      { kind: "completions", name: null },
      { kind: "bot", name: "triage" },
    ]);
    expect(review.runs[0]).toMatchObject({
      attended: true,
      counts: { toolCalls: 2, autoApproved: 1, denied: 1, answeredByPerson: 0, expired: 1 },
      denials: [{ toolCallId: "toolu_1", decidedBy: "ttl", reason: expect.stringMatching(/^Denied: /) }],
    });
  });

  it("counts a person's answers and leaves out a deleted session's runs", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    t.adapter.nextScripts.push(listThenInstall);
    // A completions request that says a person is present: its prompt parks and a person answers it.
    const { runId } = startAs(t, id, { actor: { kind: "completions", attended: true, ceiling: "acceptEdits", clientSessionId: null } });
    await untilOpened(t, id);
    await send(client, "permissions.prompts.answer", { promptId: "toolu_1", decision: "deny", message: "Not here" });
    await untilEnded(t, id, runId);
    // Attended and decided by a person only: it does not qualify.
    expect((await list(client)).runs).toEqual([]);

    const other = await create(client);
    t.adapter.nextScripts.push(listOnly);
    const unattended = startAs(t, other.id, routine());
    await untilEnded(t, other.id, unattended.runId);
    expect((await list(client)).runs.map((row) => row.runId)).toEqual([unattended.runId]);
    await deleteSession(client, other.id);
    expect((await list(client)).runs).toEqual([]);
  });
});

describe("permissions.review.seen", () => {
  it("moves the environment-wide watermark: a later list leaves out the runs before it, and a run decided after it comes back", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    t.adapter.nextScripts.push(listOnly);
    const first = startAs(t, id, routine());
    await untilEnded(t, id, first.runId);
    const before = await list(client);
    expect(before.runs.map((row) => row.runId)).toEqual([first.runId]);

    const seen = await send(client, "permissions.review.seen", { through: before.head });
    expect(seen.result).toEqual({ watermark: before.head });
    const settings = t.env.log.readStream({ kind: "settings", id: t.env.id });
    expect(settings.filter((event) => event.type === "review.seen").map((event) => event.payload)).toEqual([{ through: before.head }]);
    // Another client, another socket: the watermark is the environment's.
    const other = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
    expect(await list(other)).toMatchObject({ watermark: before.head, runs: [] });

    t.adapter.nextScripts.push(listOnly);
    const second = startAs(t, id, routine(), "Again");
    await untilEnded(t, id, second.runId);
    expect((await list(client)).runs.map((row) => row.runId)).toEqual([second.runId]);

    // Named nothing, it marks everything to the head seen; it never moves back.
    const all = await send(client, "permissions.review.seen", {});
    expect(all.result?.watermark).toBe(t.env.log.head() - 1);
    expect((await list(client)).runs).toEqual([]);
    const back = await send(client, "permissions.review.seen", { through: before.head });
    expect(back.result?.watermark).toBe(all.result?.watermark);
    expect(back.receipt.changed).toBe(false);
  });

  it("refuses a position past the log's head, invalid_params, and needs sessions:write", async () => {
    const t = await start();
    const client = await t.client();
    const refused = await refusal(client.request("permissions.review.seen", { commandId: randomUUID(), through: t.env.log.head() + 100 }));
    expect(refused.code).toBe("invalid_params");
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] satisfies Scope[] })).token });
    expect((await refusal(reader.request("permissions.review.seen", { commandId: randomUUID() }))).code).toBe("forbidden");
    const writer = await t.client({ token: (await t.pair({ scopes: SCOPES.filter((scope) => scope !== "admin") })).token });
    expect((await send(writer, "permissions.review.seen", {})).result).toBeDefined();
  });
});

describe("the review projection", () => {
  const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
  const openLog = () => {
    const log = openEventLog({ path: ":memory:", projectors: [sessionListProjector, runsProjector, permissionsProjector] });
    onCleanup(() => log.close());
    const created = { title: null, tags: [], groupId: null, workspace: { kind: "directory", path: "/work" }, repositoryIdentity: null, account: null, model: null, mode: null };
    log.append({ kind: "session", id: sessionId }, [{ type: "session.created", payload: created }], { actor: "system:test" });
    return log;
  };
  const policy = {
    runId,
    actorKind: "client",
    attended: true,
    mode: { requested: null, effective: "acceptEdits", ceiling: "acceptEdits", clamped: false, clampReason: null },
    containment: { requested: null, effective: "off", mechanism: null, reason: null },
    unattendedDefaultApplied: false,
  };

  it("reads a run.policy.resolved from before #131, with no actorName, as naming no one, and rebuilds over it", () => {
    const log = openLog();
    log.append({ kind: "session", id: sessionId }, [{ type: "run.policy.resolved", payload: policy }], { actor: "system:test", correlationId: runId });
    const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
    expect(readRunPolicy(reader, runId)).toMatchObject({ actorKind: "client", actorName: null });
    expect(log.rebuildProjections()).toContain("permissions");
    expect(readRunPolicy(reader, runId)).toMatchObject({ actorName: null });
  });

  it("keeps a call whose decision's transaction rolled back, so the run's end still decides it, once (runToolCalls)", () => {
    const log = openLog();
    const stream = { kind: "session", id: sessionId } as const;
    const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
    const calls = runToolCalls(reader, runId);
    calls.started({ type: "tool.started", payload: { toolCallId: "toolu_5", name: "Bash", input: { command: "ls" }, title: null, agentId: null, parentToolCallId: null } });
    calls.started({ type: "tool.started", payload: { toolCallId: "toolu_6", name: "Read", input: { file_path: "/etc/shadow" }, title: null, agentId: null, parentToolCallId: null } });
    const decide = (work: (tx: Parameters<Parameters<typeof log.atomically>[0]>[0]) => ReturnType<typeof calls.settle>, fail: boolean) =>
      log.atomically((tx) => {
        log.append(stream, work(tx), { tx, actor: "system:test", correlationId: runId });
        if (fail) throw new Error("rolled back");
      });
    // The mode's decision at an ok end, and the provider's denial, each rolled back with the transaction that carried it.
    expect(() => decide((tx) => calls.after({ type: "tool.ended", payload: { toolCallId: "toolu_5", status: "ok", output: "done", durationMs: 1 } }, tx), true)).toThrow("rolled back");
    expect(() => decide((tx) => calls.denied({ type: "denial", toolCallId: "toolu_6", toolName: "Read", by: "rule", reason: "Denied by a rule" }, tx), true)).toThrow("rolled back");
    expect(log.readStream(stream).filter((event) => event.type === "tool.decision")).toEqual([]);
    // The run's end still has both calls, and decides each once.
    decide(() => calls.settle(), false);
    decide(() => calls.settle(), false);
    const decided = log.readStream(stream).filter((event) => event.type === "tool.decision").map((event) => [event.payload["toolCallId"], event.payload["decidedBy"]]);
    expect(decided).toEqual([
      ["toolu_5", "mode"],
      ["toolu_6", "mode"],
    ]);
  });

  it("records a decision through recordToolDecision once per call: a call decided already is left as it was", () => {
    const log = openLog();
    const decision = { runId, toolCallId: "toolu_9", tool: "Bash", summary: "Bash: ls", decidedBy: "containment", promptId: null } as const;
    const denied = { ...decision, decision: "denied", reason: "Outside the workspace." } as const;
    expect(log.atomically((tx) => recordToolDecision(log, tx, sessionId, denied, { actor: "system:gate" }))).toBe(true);
    expect(log.atomically((tx) => recordToolDecision(log, tx, sessionId, { ...decision, decidedBy: "rule", decision: "denied", reason: "Again." }, { actor: "system:gate" }))).toBe(false);
    const types = log.readStream({ kind: "session", id: sessionId }).map((event) => event.type);
    expect(types.filter((type) => type === "tool.decision")).toHaveLength(1);
  });
});
