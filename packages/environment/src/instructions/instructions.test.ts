import { randomUUID } from "node:crypto";
import {
  Ceiling,
  registry,
  type Mode,
  type ParamsOf,
  type ResponseOf,
  type RunInstructionsComposedPayload,
  type Scope,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter, gate, type FakeAdapterOptions, type Gate } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, refusal, workspace } from "../../test/sessions.js";
import { scriptedResolver } from "../../test/workspaces.js";
import type { WireClient } from "../../test/wire-client.js";
import type { InstructionScope } from "../adapter/seams.js";
import type { EventEnvelope } from "../event-log/event-log.js";
import { composeInstructions, instructionsDigest, type InstructionLayers } from "./composer.js";

/**
 * The composer through the primary seam (skills-instructions spec, "Testing
 * Decisions"; #493): the in-process environment with the scripted fake
 * adapter recording each run's input, a test orientation seam that can stall
 * and reports a registry it could not read, typed clients over a real
 * WebSocket, and the manual clock. What is asserted is what the adapter is
 * handed, what the session's stream carries and what `instructions.preview`
 * answers.
 */

const { onCleanup } = useCleanups();

/** An orientation seam a test drives: its text, the registries it could not read, a stall each composition waits on while set, and the scopes it was asked for. */
const testOrientation = (text = "You are on SAMPLE-SERVER, a Linux machine.") => {
  const state = {
    text,
    unread: ["forges"] as string[],
    stall: null as Gate | null,
    scopes: [] as InstructionScope[],
    /** How many compositions it has answered. */
    answered: 0,
  };
  const seam: NonNullable<InstructionLayers["orientation"]> = async (scope) => {
    state.scopes.push(scope);
    if (state.stall !== null) await state.stall.opened;
    state.answered += 1;
    return { text: state.text, unreadRegistries: [...state.unread] };
  };
  return { state, seam };
};

type Orientation = ReturnType<typeof testOrientation>;

const start = async (
  orientation: Orientation,
  adapter: FakeAdapterOptions = {},
  options: Omit<TestEnvironmentOptions, "adapter" | "adapterSeams"> & { readonly layers?: Omit<InstructionLayers, "orientation"> } = {},
): Promise<TestEnvironment> => {
  const { layers = {}, ...rest } = options;
  const t = await startTestEnvironment({ ...rest, adapter: fakeAdapter(adapter), adapterSeams: { instructions: composeInstructions({ ...layers, orientation: orientation.seam }) } });
  onCleanup(() => t.close());
  return t;
};

type RunCommand = "runs.start" | "runs.interrupt";

const command = async <N extends RunCommand>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params })) as ResponseOf<N>;

/** Starts a run; resolves with its ids. */
const startRun = async (client: WireClient, sessionId: string, text = "Fix the receipts") => {
  const answer = await command(client, "runs.start", { sessionId, text });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result;
};

const preview = async (client: WireClient, params: ParamsOf<"instructions.preview">) =>
  registry["instructions.preview"].result.parse(await client.request("instructions.preview", params));

/** The session's events, from the log. */
const eventsOf = (t: TestEnvironment, sessionId: string): EventEnvelope[] => t.env.log.readStream({ kind: "session", id: sessionId });

const endOf = (t: TestEnvironment, sessionId: string, runId: string): EventEnvelope | undefined =>
  eventsOf(t, sessionId).find((event) => event.type === "run.ended" && event.payload["runId"] === runId);

const untilEnded = (t: TestEnvironment, sessionId: string, runId: string) => vi.waitFor(() => expect(endOf(t, sessionId, runId)).toBeDefined());

/** The run's `run.instructions.composed`, whole. */
const composedOf = (t: TestEnvironment, sessionId: string, runId: string): EventEnvelope | undefined =>
  eventsOf(t, sessionId).find((event) => event.type === "run.instructions.composed" && event.payload["runId"] === runId);

/** The types of the run's events, in order. */
const typesOf = (t: TestEnvironment, sessionId: string, runId: string): string[] =>
  eventsOf(t, sessionId)
    .filter((event) => event.payload["runId"] === runId)
    .map((event) => event.type);

/** A client session issued straight from the environment, holding only `scopes`. */
const narrowClient = (t: TestEnvironment, scopes: Scope[], ceiling: Mode = "acceptEdits") =>
  t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a narrow program", scopes, ceiling: Ceiling.parse(ceiling) }).token });

describe("a run's launch", () => {
  it("awaits the composition before its adapter is asked for anything, then records run.instructions.composed after run.policy.resolved and before the provider's events", async () => {
    const orientation = testOrientation();
    const t = await start(orientation);
    const client = await t.client();
    const { id } = await create(client);
    const stall = gate();
    orientation.state.stall = stall;

    const { runId } = await startRun(client, id);
    await vi.waitFor(() => expect(orientation.state.scopes).toHaveLength(1));
    // Composing: live, with no run asked of the adapter, no provider process, and nothing composed on the log.
    expect(t.adapter.runs).toHaveLength(0);
    expect((await client.request("providers.processes.list", {})).processes).toEqual([]);
    // It is the session's live run: a second start is refused.
    const second = await command(client, "runs.start", { sessionId: id, text: "Another" });
    expect(second.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "run_active", runId } } });
    expect(typesOf(t, id, runId)).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.sent"]);

    stall.open();
    await untilEnded(t, id, runId);
    expect(typesOf(t, id, runId)).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.sent", "run.instructions.composed", "assistant.text", "run.ended"]);
    expect(composedOf(t, id, runId)).toMatchObject({ actor: "system:adapter-host", correlationId: runId });
    expect(t.adapter.lastRun().input.instructions).toBe("You are on SAMPLE-SERVER, a Linux machine.");
  });

  it("ends a run interrupted while it composes as an interrupt ends one, starting no provider process, and its message is the next run's", async () => {
    const orientation = testOrientation();
    const t = await start(orientation);
    const client = await t.client();
    const { id } = await create(client);
    const stall = gate();
    orientation.state.stall = stall;
    const { runId, messageId } = await startRun(client, id, "First");
    await vi.waitFor(() => expect(orientation.state.scopes).toHaveLength(1));

    const answer = await command(client, "runs.interrupt", { runId });
    expect(answer.result).toEqual({ runId, ended: false });
    await untilEnded(t, id, runId);
    expect(endOf(t, id, runId)?.payload).toMatchObject({ reason: "interrupted", cause: "user", error: null });
    // What it was launched with is the environment's again, heard just before its end.
    expect(typesOf(t, id, runId)).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.sent", "message.requeued", "run.ended"]);

    // The composition it no longer waits for answers: nothing is recorded, and no provider is asked for the run.
    orientation.state.stall = null;
    stall.open();
    await vi.waitFor(() => expect(orientation.state.answered).toBe(1));
    expect(composedOf(t, id, runId)).toBeUndefined();
    expect(t.adapter.runs).toHaveLength(0);
    expect((await client.request("providers.processes.list", {})).processes).toEqual([]);

    const next = await startRun(client, id, "Second");
    await untilEnded(t, id, next.runId);
    expect(t.adapter.runs).toHaveLength(1);
    expect(t.adapter.lastRun().input.prompt.map((message) => [message.messageId, message.text])).toEqual([
      [messageId, "First"],
      [next.messageId, "Second"],
    ]);
  });

  it("ends a run whose composition fails error, starting no provider process", async () => {
    const orientation = testOrientation();
    const t = await start(orientation, {}, { layers: { persona: () => Promise.reject(new Error("The persona could not be read.")) } });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(endOf(t, id, runId)?.payload).toMatchObject({ reason: "error", error: { message: "The run's standing instructions could not be composed: The persona could not be read." } });
    expect(composedOf(t, id, runId)).toBeUndefined();
    expect(t.adapter.runs).toHaveLength(0);
  });
});

describe("the instruction scope", () => {
  it("carries the session, account, workspace and repository identity, the trust key undecided, the skill set the run is handed, the origin, the containment level, the injection answer and its level, no bot, no extra always-on names, and the account's channel and whether its adapter loads project instructions itself", async () => {
    const orientation = testOrientation();
    const identity = "https://git.example/david/receipts";
    const t = await start(orientation, {}, { workspaceResolver: scriptedResolver(() => ({ workspace, repositoryIdentity: identity })) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);
    const routine = t.env.startRun({ sessionId: id, text: "Nightly", actor: { kind: "routine", name: "nightly", ceiling: "acceptEdits", clientSessionId: null }, actorId: "routine-nightly" });
    await untilEnded(t, id, routine.runId);
    const completions = t.env.startRun({ sessionId: id, text: "From a bot", actor: { kind: "completions", attended: false, ceiling: "acceptEdits", clientSessionId: null } });
    await untilEnded(t, id, completions.runId);

    expect(orientation.state.scopes).toEqual([
      {
        sessionId: id,
        accountId: "claude-max",
        workspace,
        repositoryIdentity: identity,
        trust: { key: { kind: "identity", value: identity }, decision: "undecided" },
        // The own directory holds nothing: the set resolved is empty, with nothing to link, and has its fingerprint.
        skillSet: { generation: null, fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/), members: [], hiddenNativeNames: [] },
        origin: "client",
        containment: "off",
        injection: { answer: "allow", level: { kind: "environment" } },
        bot: null,
        alwaysOn: [],
        channel: { kind: "system-prompt-append", maxCharacters: null },
        nativeProjectInstructions: true,
      },
      expect.objectContaining({ sessionId: id, origin: "routine", bot: null }),
      expect.objectContaining({ sessionId: id, origin: "completions", bot: null }),
    ]);
  });

  it("keys trust by the workspace path when the session has no repository identity, and gives a scratch workspace no key", async () => {
    const orientation = testOrientation();
    const t = await start(orientation);
    const client = await t.client();
    const { id } = await create(client);
    await preview(client, { sessionId: id });
    await preview(client, { accountId: "claude-max", workspace: { kind: "scratch", path: `${workspace.path}/scratch-for-tests` } });
    expect(orientation.state.scopes.map((scope) => scope.trust)).toEqual([
      { key: { kind: "directory", value: workspace.path }, decision: "undecided" },
      { key: null, decision: "undecided" },
    ]);
  });
});

describe("the composition", () => {
  it("is the text and a manifest: the event carries the manifest and the text's digest, never the text, and the unread registries", async () => {
    const orientation = testOrientation();
    const t = await start(orientation, {}, { layers: { session: () => [{ id: "session-note", version: "2", title: "Instructions for this session", text: "Answer in French." }] } });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);

    const text = "You are on SAMPLE-SERVER, a Linux machine.\n\nAnswer in French.";
    expect(t.adapter.lastRun().input.instructions).toBe(text);
    const payload = composedOf(t, id, runId)?.payload as RunInstructionsComposedPayload;
    expect(payload).toEqual({
      runId,
      manifest: {
        channel: "system-prompt-append",
        layers: [
          { layer: "user", characters: 42, parts: [{ id: "orientation", version: null, characters: 42 }] },
          { layer: "session", characters: 17, parts: [{ id: "session-note", version: "2", characters: 17 }] },
        ],
        alwaysOn: [],
        skillSetFingerprint: t.adapter.lastRun().input.skillSet.fingerprint,
        unreadRegistries: ["forges"],
        leftOut: [],
      },
      digest: instructionsDigest(text),
    });
    expect(JSON.stringify(composedOf(t, id, runId))).not.toContain("French");
  });

  it("puts the layers in their fixed order, leaves the empty ones out, and puts the run's own text after it all", async () => {
    const orientation = testOrientation();
    const part = (id: string, text: string) => ({ id, version: null, title: id, text });
    const t = await start(
      orientation,
      {},
      {
        layers: {
          persona: () => [part("reviewer", "You review.")],
          session: () => [part("blank", "  "), part("note", "Be brief.")],
          teamBank: () => [part("meadowstudios", "Brands live in the meadowstudios bank.")],
        },
      },
    );
    const client = await t.client();
    const { id } = await create(client);
    const completions = t.env.startRun({ sessionId: id, text: "From a bot", actor: { kind: "completions", attended: false, ceiling: "acceptEdits", clientSessionId: null } });
    await untilEnded(t, id, completions.runId);
    expect(t.adapter.lastRun().input.instructions).toBe(
      ["You are on SAMPLE-SERVER, a Linux machine.", "Brands live in the meadowstudios bank.", "Be brief.", "You review."].join("\n\n"),
    );
    expect((composedOf(t, id, completions.runId)?.payload as RunInstructionsComposedPayload).manifest.layers.map((layer) => layer.layer)).toEqual([
      "user",
      "team-bank",
      "session",
      "persona",
    ]);
  });

  it("is byte-identical for unchanged state across a clock advance, and a changed layer changes the text", async () => {
    const orientation = testOrientation();
    const t = await start(orientation);
    const client = await t.client();
    const { id } = await create(client);
    const first = await startRun(client, id, "One");
    await untilEnded(t, id, first.runId);
    t.clock.advance(60 * 60 * 1000);
    const second = await startRun(client, id, "Two");
    await untilEnded(t, id, second.runId);
    orientation.state.text = "You are on SAMPLE-SERVER, a Linux machine. OpenBao is sealed since 2026-09-24 01:02 UTC.";
    const third = await startRun(client, id, "Three");
    await untilEnded(t, id, third.runId);

    const [one, two, three] = t.adapter.runs.map((run) => run.input.instructions);
    expect(two).toBe(one);
    expect(three).not.toBe(one);
    const digests = [first, second, third].map(({ runId }) => (composedOf(t, id, runId)?.payload as RunInstructionsComposedPayload).digest);
    expect(digests[1]).toBe(digests[0]);
    expect(digests[2]).not.toBe(digests[0]);
  });

  it("hands an account whose adapter's channel is none no text, the run's own included, and its manifest says why", async () => {
    const orientation = testOrientation();
    const t = await start(orientation, { capabilities: { instructionChannel: { kind: "none", maxCharacters: null } } });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);
    const completions = t.env.startRun({ sessionId: id, text: "From a bot", actor: { kind: "completions", attended: false, ceiling: "acceptEdits", clientSessionId: null } });
    await untilEnded(t, id, completions.runId);

    expect(t.adapter.runs.map((run) => run.input.instructions)).toEqual(["", ""]);
    const manifest = {
      channel: "none",
      layers: [],
      alwaysOn: [],
      skillSetFingerprint: t.adapter.lastRun().input.skillSet.fingerprint,
      unreadRegistries: ["forges"],
      leftOut: [{ layer: "user", id: "orientation", reason: "channel-none" }],
    };
    expect(composedOf(t, id, runId)?.payload).toEqual({ runId, manifest, digest: instructionsDigest("") });
    expect(await preview(client, { sessionId: id })).toEqual({ parts: [], text: "", manifest });
  });
});

describe("instructions.preview", () => {
  it("answers, to a read client, what the session's next run is then handed: each part with its layer and title, the text and the manifest", async () => {
    const orientation = testOrientation();
    const t = await start(orientation, {}, { layers: { session: () => [{ id: "session-note", version: null, title: "Instructions for this session", text: "Answer in French." }] } });
    const client = await t.client();
    const reader = await narrowClient(t, ["read"]);
    const { id } = await create(client);

    const answer = await preview(reader, { sessionId: id });
    expect(answer.parts).toEqual([
      { layer: "user", id: "orientation", title: "Orientation", text: "You are on SAMPLE-SERVER, a Linux machine." },
      { layer: "session", id: "session-note", title: "Instructions for this session", text: "Answer in French." },
    ]);
    expect(answer.manifest.unreadRegistries).toEqual(["forges"]);
    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(t.adapter.lastRun().input.instructions).toBe(answer.text);
    expect((composedOf(t, id, runId)?.payload as RunInstructionsComposedPayload).manifest).toEqual(answer.manifest);
    // A preview composes for the session's next run, as a client starts it; it records nothing.
    expect(orientation.state.scopes.at(0)).toMatchObject({ sessionId: id, origin: "client" });
    expect(eventsOf(t, id).filter((event) => event.type === "run.instructions.composed")).toHaveLength(1);
  });

  it("answers, for an account and a workspace, what a new session there is handed on its first run", async () => {
    const orientation = testOrientation();
    const t = await start(orientation);
    const client = await t.client();
    const answer = await preview(client, { accountId: "claude-max", workspace });
    expect(orientation.state.scopes.at(0)).toMatchObject({ sessionId: null, accountId: "claude-max", workspace, origin: "client" });

    const { id } = await create(client, { account: "claude-max" });
    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(t.adapter.lastRun().input.instructions).toBe(answer.text);
    expect(answer.text).toBe("You are on SAMPLE-SERVER, a Linux machine.");
  });

  it("refuses a session or an account not on the environment not_found, and a request naming both invalid_params", async () => {
    const orientation = testOrientation();
    const t = await start(orientation);
    const client = await t.client();
    const missing = randomUUID();
    expect(await refusal(client.request("instructions.preview", { sessionId: missing }))).toEqual({ code: "not_found", data: { kind: "session", sessionId: missing } });
    expect(await refusal(client.request("instructions.preview", { accountId: "elsewhere", workspace }))).toEqual({
      code: "not_found",
      data: { kind: "account", accountId: "elsewhere" },
    });
    expect((await refusal(client.request("instructions.preview", { sessionId: missing, accountId: "claude-max", workspace } as ParamsOf<"instructions.preview">))).code).toBe("invalid_params");
    expect(orientation.state.scopes).toEqual([]);
  });
});
