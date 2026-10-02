import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CompletionsModelList, registry, type Mode, type RunPolicyResolvedPayload, type RunStartedPayload, type Scope } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, say, type FakeAdapterOptions, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { BUTLER_INSTRUCTIONS, HERMES_SYSTEM_PROMPT, HERMES_TOOLS, hermesCaller, type HermesRoute } from "../../test/hermes-caller.js";
import { isInProcess, type AdapterEvent } from "../adapter/contract.js";
import type { EventEnvelope } from "../event-log/event-log.js";
import { composeInstructions } from "../instructions/composer.js";

/**
 * The butler's side of the Hermes cut-over (switch-over spec, "Hermes
 * cut-over and Bank migration"; #1193), through the built completions
 * contract: the scripted Hermes caller (`test/hermes-caller.ts`) sends the
 * request shapes of the pinned Hermes with the butler's deployment settings
 * over real HTTP and SSE, as a paired `program` with the butler's scopes and
 * `bypassPermissions` ceiling, to the in-process environment over the
 * scripted fake provider. What is asserted is what Hermes reads on the wire
 * and what the log and the provider hold afterwards.
 *
 * Not proved here, and owed by the live switch-over (#1197): the deployment
 * pin, the parked librarian, the `/keep` and `/save` plugin, the credential's
 * provisioning in OpenBao, and signed delivery to Matrix.
 */

const { onCleanup } = useCleanups();

/** The butler's pairing: the three scopes and the bypass ceiling (spec L115). */
const BUTLER_SCOPES: readonly Scope[] = ["read", "sessions:write", "runs:drive"];

/** Two signed-in accounts: the default one first, and the one whose Claude billing the butler keeps, second. */
const ACCOUNTS = [
  { id: "Shared Max", provider: "fake" },
  { id: "Owner Max", provider: "fake" },
] as const;
const OWNER_EMAIL = "owner@example.com";

const status: NonNullable<FakeAdapterOptions["status"]> = (account) => ({
  signedIn: true,
  authMethod: "fake",
  email: account.id === "Owner Max" ? OWNER_EMAIL : "shared@example.com",
  orgName: null,
  subscriptionType: "max",
  error: null,
});

/** A composer whose every run is handed `COMPOSED`, so the request's own instructions are seen after it. */
const composed = composeInstructions({ orientation: () => ({ text: "COMPOSED", unreadRegistries: [] }) });

const start = async (script?: Script): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ adapter: fakeAdapter({ status, ...(script !== undefined && { script }) }), accounts: ACCOUNTS, adapterSeams: { instructions: composed } });
  onCleanup(() => t.close());
  return t;
};

const origin = (t: TestEnvironment): string => `http://${t.address.host}:${t.address.port}`;

/** A program's credential, the butler's unless `ceiling` says otherwise. */
const program = (t: TestEnvironment, ceiling: Mode = "bypassPermissions", label = "butler") => t.pair({ kind: "program", scopes: BUTLER_SCOPES, ceiling, label });

/** The route to `family` on the owner's account, read from the live listing as the deployment's check does, never from saved settings. */
const liveRoute = async (t: TestEnvironment, token: string, family: string, thinking: string): Promise<HermesRoute> => {
  const response = await fetch(`${origin(t)}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
  const listed = CompletionsModelList.parse(await response.json());
  const model = listed.data.find((entry) => entry["agent-harness"].accountId === "Owner Max" && entry.family === family);
  if (model === undefined) throw new Error(`The live listing has no ${family} on the owner's account.`);
  return { model: model.id, thinking };
};

const eventsOf = (t: TestEnvironment, sessionId: string, type: string): EventEnvelope[] => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === type);
const payloadsOf = <P>(t: TestEnvironment, sessionId: string, type: string): P[] => eventsOf(t, sessionId, type).map((event) => event.payload as P);

const usage = (inputTokens: number, outputTokens: number): AdapterEvent => ({
  type: "usage.reported",
  payload: { models: [{ model: "sonnet", inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, contextWindow: null }] },
});

/** Replies `text`, reports usage and completes. */
const reply =
  (text: string): Script =>
  () => [say(text), usage(20, 4), end()];

describe("the butler's chat turn", () => {
  it("runs on the Account-qualified model it read live, billed to that Account and its identity, in the namespace's mode, effort and instructions, unattended", async () => {
    const t = await start(reply("Your calendar is clear."));
    const { token } = await program(t);
    const route = await liveRoute(t, token, "sonnet", "high");
    expect(route.model).toBe("owner-max/sonnet");
    const butler = hermesCaller({ origin: origin(t), token, route, sessionIds: "never" });

    const { final } = await butler.chat("What is on my calendar today?");

    expect(final.content).toBe("Your calendar is clear.");
    expect(final.finishReason).toBe("stop");
    expect(final.done).toBe(true);
    expect(final.atFinish?.ended).toEqual({ reason: "completed", cause: null });
    expect(final.chunks.every((chunk) => chunk.model === "owner-max/sonnet")).toBe(true);
    expect(final.head).toMatchObject({ mode: "bypassPermissions", clamped: null, ignored: [] });
    expect(final.chunks.at(-1)?.usage).toMatchObject({ prompt_tokens: 20, completion_tokens: 4 });

    const sessionId = final.head.sessionId as string;
    const [started] = payloadsOf<RunStartedPayload>(t, sessionId, "run.started");
    expect(started).toMatchObject({ accountId: "Owner Max", identity: { provider: "fake", email: OWNER_EMAIL }, model: "sonnet", effort: "high", origin: "completions" });
    const [policy] = payloadsOf<RunPolicyResolvedPayload>(t, sessionId, "run.policy.resolved");
    expect(policy).toMatchObject({
      actorKind: "completions",
      attended: false,
      mode: { requested: "bypassPermissions", effective: "bypassPermissions", clamped: false },
      unattendedDefaultApplied: false,
    });
    const run = t.adapter.lastRun().input;
    expect(run.instructions.endsWith(`COMPOSED\n\n${BUTLER_INSTRUCTIONS}\n\n${HERMES_SYSTEM_PROMPT}`)).toBe(true);
    const client = run.toolServers.find((server) => server.name === "client");
    if (client === undefined || !isInProcess(client)) throw new Error("Hermes's tools were not served as the client server.");
    expect(client.tools.map((tool) => tool.name)).toEqual(HERMES_TOOLS.map((tool) => tool.function.name));
  });

  it("holds the namespace's bypassPermissions to the butler's ceiling as it is now: a lowered ceiling clamps the next turn, and the first chunk says so", async () => {
    const t = await start(reply("Done."));
    const { token, clientSessionId } = await program(t);
    const butler = hermesCaller({ origin: origin(t), token, route: await liveRoute(t, token, "sonnet", "medium"), sessionIds: "never" });
    const admin = await t.client();
    const lowered = registry["access.sessions.setCeiling"].response.parse(
      await admin.request("access.sessions.setCeiling", { commandId: randomUUID(), clientSessionId, ceiling: "acceptEdits" }),
    );
    expect(lowered.result).toMatchObject({ from: "bypassPermissions", to: "acceptEdits" });

    const { final } = await butler.chat("Tidy the notes folder.");

    expect(final.head).toMatchObject({
      mode: "acceptEdits",
      clamped: { requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", reason: "ceiling" },
    });
    expect(final.atFinish?.ended).toEqual({ reason: "completed", cause: null });
    expect(t.adapter.lastRun().input).toMatchObject({ mode: "acceptEdits", ceiling: "acceptEdits" });
  });
});

describe("a two-turn chat", () => {
  it("runs a turn naming no session in a fresh scratch session, and the next turn naming the id it returned in that session, on the model and effort each turn's route picks", async () => {
    const t = await start();
    const { token } = await program(t);
    const butler = hermesCaller({ origin: origin(t), token, route: await liveRoute(t, token, "sonnet", "medium"), sessionIds: "sent" });

    const first = await butler.chat("The boiler is serviced in March.");
    const sessionId = first.final.head.sessionId as string;
    expect(t.adapter.lastRun().input.workspace).toEqual({ kind: "scratch", path: join(t.dataDir, "scratch", sessionId) });
    // The second turn is a chat command's: /opus-max, with the whole conversation re-sent, as Hermes does.
    const second = await butler.chat("When is the boiler serviced?", await liveRoute(t, token, "opus", "max"));

    expect(butler.sent.map((body) => (body["agent-harness"] as { sessionId?: string }).sessionId)).toEqual([undefined, sessionId]);
    expect(second.final.head.sessionId).toBe(sessionId);
    expect(second.final.content).toBe("Done: When is the boiler serviced?");
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["When is the boiler serviced?"]);
    expect(payloadsOf<RunStartedPayload>(t, sessionId, "run.started").map((run) => [run.accountId, run.model, run.effort])).toEqual([
      ["Owner Max", "sonnet", "medium"],
      ["Owner Max", "opus", "max"],
    ]);
    expect(first.final.chunks.every((chunk) => chunk.model === "owner-max/sonnet")).toBe(true);
    expect(second.final.chunks.every((chunk) => chunk.model === "owner-max/opus")).toBe(true);
    for (const turn of [first, second]) {
      expect(turn.final).toMatchObject({ finishReason: "stop", done: true, atFinish: { ended: { reason: "completed", cause: null } } });
    }
  });

  it("gives every turn of a caller that names no session, as the pinned Hermes, a fresh scratch session whose prompt carries the conversation so far", async () => {
    const t = await start();
    const { token } = await program(t);
    const butler = hermesCaller({ origin: origin(t), token, route: await liveRoute(t, token, "sonnet", "medium"), sessionIds: "never" });

    const first = await butler.chat("The boiler is serviced in March.");
    const second = await butler.chat("When is the boiler serviced?");

    const sessions = [first, second].map((turn) => turn.final.head.sessionId as string);
    expect(new Set(sessions).size).toBe(2);
    expect(t.adapter.lastRun().input.workspace).toEqual({ kind: "scratch", path: join(t.dataDir, "scratch", sessions[1] as string) });
    const [prompt] = t.adapter.lastRun().input.prompt.map((message) => message.text);
    expect(prompt).toMatch(/^Earlier in this conversation:/);
    expect(prompt).toContain("User: The boiler is serviced in March.");
    expect(prompt).toContain("Assistant: Done: The boiler is serviced in March.");
    expect(prompt?.endsWith("When is the boiler serviced?")).toBe(true);
    // Hermes's own system prompt is never part of the preamble: it is appended to the instructions on each turn.
    expect(prompt).not.toContain(HERMES_SYSTEM_PROMPT);
  });
});
