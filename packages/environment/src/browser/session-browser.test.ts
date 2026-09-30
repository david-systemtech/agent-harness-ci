import { randomUUID } from "node:crypto";
import {
  ChatCompletion,
  CompletionsErrorBody,
  registry,
  type Mode,
  type ParamsOf,
  type ResponseOf,
  type RunBrowserResolvedPayload,
  type SessionBrowser,
  type SessionBrowserSetPayload,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, gate, say, type FakeAdapterOptions, type Gate, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { created, ranNow, untilStarted, written } from "../../test/routines.js";
import { command, create, get, listStream, patchOf, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import type { ActorRunRequest } from "../serve/start.js";
import type { HeadlessAvailability } from "./run-browser.js";

/**
 * The browser as a session field (browser spec, "The browser as a session
 * field"; ADR 0014, ADR 0003; #550) through the primary seam: an in-process
 * environment with the scripted fake adapter, the typed client over the
 * wire. What is asserted is what a client sees: the summary, the list's
 * patch, the session's stream.
 */

const { onCleanup } = useCleanups();

const start = async (adapter: FakeAdapterOptions = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

const OTHER_ENVIRONMENT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const WORK_CHROME: SessionBrowser = { kind: "chrome", environmentId: OTHER_ENVIRONMENT, chromeId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427" };
const MY_CHROME: SessionBrowser = { kind: "chrome", environmentId: OTHER_ENVIRONMENT, chromeId: null };

const eventsOf = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId });
const payloadsOf = <P>(t: TestEnvironment, sessionId: string, type: string): P[] =>
  eventsOf(t, sessionId)
    .filter((event) => event.type === type)
    .map((event) => event.payload as P);

describe("sessions.setBrowser", () => {
  it("sets the field and records session.browser.set chosen by a person; a second client's list shows it through the patch", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const other = await t.client();
    const list = await listStream(other, t.env.log.head());

    const answer = await command(client, "sessions.setBrowser", { sessionId: id, browser: WORK_CHROME });
    expect(answer.result?.summary.browser).toEqual(WORK_CHROME);
    expect(payloadsOf<SessionBrowserSetPayload>(t, id, "session.browser.set")).toEqual([{ browser: WORK_CHROME, chosenBy: "person" }]);

    const event = await list.next();
    expect(event.type).toBe("session.browser.set");
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { browser: WORK_CHROME } });
    expect(await get(other, id)).toMatchObject({ browser: WORK_CHROME });
  });

  it("takes every shape, and null for none chosen; the browser the session has appends nothing, and updatedAt stays", async () => {
    const t = await start();
    const client = await t.client();
    const { id, result } = await create(client);
    const createdAt = result?.summary.updatedAt;
    t.clock.advance(60_000);
    for (const browser of [MY_CHROME, { kind: "headless" }, { kind: "dock" }, { kind: "none" }, null] as const) {
      const answer = await command(client, "sessions.setBrowser", { sessionId: id, browser });
      expect(answer.result?.summary).toMatchObject({ browser, updatedAt: createdAt });
    }
    const again = await command(client, "sessions.setBrowser", { sessionId: id, browser: null });
    expect(again.receipt).toMatchObject({ status: "accepted", changed: false });
    expect(payloadsOf<SessionBrowserSetPayload>(t, id, "session.browser.set").map((payload) => payload.browser)).toEqual([
      MY_CHROME,
      { kind: "headless" },
      { kind: "dock" },
      { kind: "none" },
      null,
    ]);
  });

  it("is refused for a client session without runs:drive, and for a session not here", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const { token } = await t.pair({ scopes: ["read", "sessions:write"] });
    const organiser = await t.client({ token });
    expect(await refusal(organiser.request("sessions.setBrowser", { commandId: randomUUID(), sessionId: id, browser: { kind: "headless" } }))).toMatchObject({
      code: "forbidden",
      data: { scope: "runs:drive" },
    });
    expect(await get(client, id)).toMatchObject({ browser: null });

    const missing = randomUUID();
    const answer = await command(client, "sessions.setBrowser", { sessionId: missing, browser: { kind: "headless" } });
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "session", sessionId: missing } } });
  });
});

describe("sessions.create's browser", () => {
  it("records the first session.browser.set after session.created, with who chose it: the reach default or a person", async () => {
    const t = await start();
    const client = await t.client();
    const byReach = await create(client, { browser: { value: MY_CHROME, chosenBy: "reach" } });
    expect(byReach.result?.summary.browser).toEqual(MY_CHROME);
    expect(eventsOf(t, byReach.id).map((event) => event.type)).toEqual(["session.created", "session.browser.set"]);
    expect(payloadsOf<SessionBrowserSetPayload>(t, byReach.id, "session.browser.set")).toEqual([{ browser: MY_CHROME, chosenBy: "reach" }]);

    const byPerson = await create(client, { browser: { value: { kind: "dock" }, chosenBy: "person" } });
    expect(await get(client, byPerson.id)).toMatchObject({ browser: { kind: "dock" } });
    expect(payloadsOf<SessionBrowserSetPayload>(t, byPerson.id, "session.browser.set")).toEqual([{ browser: { kind: "dock" }, chosenBy: "person" }]);
  });

  it("chooses none when absent: the field is null and nothing is recorded", async () => {
    const t = await start();
    const client = await t.client();
    const { id, result } = await create(client);
    expect(result?.summary.browser).toBeNull();
    expect(eventsOf(t, id).map((event) => event.type)).toEqual(["session.created"]);
  });
});

/** A run that makes one tool call of the provider's own, then says it is done. */
const oneToolCall: Script = function* () {
  yield { type: "tool.started", payload: { toolCallId: "toolu_1", name: "Bash", input: { command: "ls" }, title: null, agentId: null, parentToolCallId: null } };
  yield { type: "tool.ended", payload: { toolCallId: "toolu_1", status: "ok", output: "README.md", durationMs: 1 } };
  yield say("Done.");
  yield end();
};

/** The headless browser a test's environment has, through the availability seam #555's manager will fill. */
const HEADLESS_HERE: HeadlessAvailability = { available: true };
const withHeadless = (headless: HeadlessAvailability = HEADLESS_HERE): Omit<TestEnvironmentOptions, "adapter"> => ({ browser: { headless: () => headless } });

type Command = "runs.start" | "settings.update";

const send = async <N extends Command>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

/** A run a client session starts over the wire: attended. */
const startRun = async (client: WireClient, sessionId: string, text = "Read the page"): Promise<string> => {
  const answer = await send(client, "runs.start", { sessionId, text });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.runId;
};

/** Who starts a run that no client session starts: a routine, a bot, or a program on the completions surface. */
type Who = Omit<ActorRunRequest, "sessionId" | "text" | "mode">;
const routine = (ceiling: Mode = "acceptEdits"): Who => ({ actor: { kind: "routine", name: "nightly-read", ceiling, clientSessionId: null }, actorId: "routine-nightly-read" });
const bot = (ceiling: Mode = "acceptEdits"): Who => ({ actor: { kind: "bot", name: "triage", ceiling, clientSessionId: null }, actorId: "bot-triage" });
const program = (attended: boolean, ceiling: Mode = "acceptEdits"): Who => ({ actor: { kind: "completions", attended, ceiling, clientSessionId: null } });

const untilEnded = (t: TestEnvironment, sessionId: string, runId: string) =>
  vi.waitFor(() => expect(eventsOf(t, sessionId).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true));

/** The run's `run.browser.resolved`, less its run id. */
const resolvedOf = (t: TestEnvironment, sessionId: string, runId: string): Omit<RunBrowserResolvedPayload, "runId"> | undefined => {
  const found = payloadsOf<RunBrowserResolvedPayload>(t, sessionId, "run.browser.resolved").find((payload) => payload.runId === runId);
  if (found === undefined) return undefined;
  const { runId: _, ...resolution } = found;
  return resolution;
};

/** A session in the test workspace whose browser is `browser` (none chosen for null). */
const sessionWith = async (client: WireClient, browser: SessionBrowser | null): Promise<string> => {
  const { id } = await create(client, browser === null ? {} : { browser: { value: browser, chosenBy: "person" } });
  return id;
};

describe("run.browser.resolved", () => {
  it("is recorded for every run after run.policy.resolved and before its first tool call", async () => {
    const t = await start({ script: oneToolCall });
    const client = await t.client();
    const id = await sessionWith(client, WORK_CHROME);
    const runId = await startRun(client, id);
    await untilEnded(t, id, runId);
    const types = eventsOf(t, id).map((event) => event.type);
    expect(types.indexOf("run.policy.resolved")).toBeGreaterThan(types.indexOf("run.started"));
    expect(types.indexOf("run.browser.resolved")).toBe(types.indexOf("run.policy.resolved") + 1);
    expect(types.indexOf("run.browser.resolved")).toBeLessThan(types.indexOf("tool.started"));
    expect(resolvedOf(t, id, runId)).toEqual({ requested: WORK_CHROME, browser: WORK_CHROME, reason: "chosen", message: "The session chose a paired Chrome." });
  });

  it("resolves a Chrome, the plain My Chrome, headless, the dock or none on an attended run as the field names it", async () => {
    const t = await start({}, withHeadless({ available: false, reason: "no Chromium was found" }));
    const client = await t.client();
    for (const browser of [MY_CHROME, { kind: "headless" }, { kind: "dock" }, { kind: "none" }] as const) {
      const id = await sessionWith(client, browser);
      const runId = await startRun(client, id);
      expect(resolvedOf(t, id, runId), browser.kind).toMatchObject({ requested: browser, browser, reason: "chosen" });
    }
  });

  it("resolves no browser chosen to none on an attended run while the environment has no headless browser, the seam's preset, with the reason", async () => {
    const t = await start();
    const client = await t.client();
    const id = await sessionWith(client, null);
    const runId = await startRun(client, id);
    expect(resolvedOf(t, id, runId)).toEqual({
      requested: null,
      browser: { kind: "none" },
      reason: "headless-unavailable",
      message: "The session chose no browser, and this environment has no headless browser: it runs none yet.",
    });
  });

  it("resolves no browser chosen to the headless browser when the seam has one and browser.headless.allowRuns is on", async () => {
    const t = await start({}, withHeadless());
    const client = await t.client();
    const id = await sessionWith(client, null);
    const runId = await startRun(client, id);
    expect(resolvedOf(t, id, runId)).toEqual({
      requested: null,
      browser: { kind: "headless" },
      reason: "default",
      message: "The session chose no browser, so the run takes this environment's headless browser.",
    });
  });

  it("gives no run the headless browser while browser.headless.allowRuns is off, the field's none chosen or headless alike", async () => {
    const t = await start({}, withHeadless());
    const client = await t.client();
    await send(client, "settings.update", { values: { "browser.headless.allowRuns": false } });
    for (const browser of [null, { kind: "headless" }] as const) {
      const id = await sessionWith(client, browser);
      const runId = await startRun(client, id);
      expect(resolvedOf(t, id, runId), JSON.stringify(browser)).toMatchObject({ requested: browser, browser: { kind: "none" }, reason: "headless-not-allowed" });
    }
  });

  it("applies a change during a live run from the next run; the live run keeps what it resolved", async () => {
    const held: Gate = gate();
    const t = await start(
      {
        script: async function* () {
          await held.opened;
          yield end();
        },
      },
      withHeadless(),
    );
    const client = await t.client();
    const id = await sessionWith(client, { kind: "dock" });
    const first = await startRun(client, id);
    await command(client, "sessions.setBrowser", { sessionId: id, browser: { kind: "headless" } });
    held.open();
    await untilEnded(t, id, first);
    const second = await startRun(client, id);
    await untilEnded(t, id, second);
    const resolutions = payloadsOf<RunBrowserResolvedPayload>(t, id, "run.browser.resolved");
    expect(resolutions.map((payload) => [payload.runId, payload.browser])).toEqual([
      [first, { kind: "dock" }],
      [second, { kind: "headless" }],
    ]);
  });
});

describe("an unattended run's browser", () => {
  it("resolves a Chrome or the dock to none for a routine's, a bot's and an unattended program's run, with the reason", async () => {
    const t = await start({}, withHeadless());
    const client = await t.client();
    for (const who of [routine(), bot(), program(false)]) {
      for (const browser of [WORK_CHROME, MY_CHROME, { kind: "dock" }] as const) {
        const id = await sessionWith(client, browser);
        const { runId } = t.env.startRun({ sessionId: id, text: "Read the page", ...who } as ActorRunRequest);
        expect(resolvedOf(t, id, runId), `${who.actor.kind} ${browser.kind}`).toMatchObject({ requested: browser, browser: { kind: "none" }, reason: "unattended" });
      }
    }
  });

  it("resolves no browser chosen as an attended run does, and headless or none as the field names them", async () => {
    const t = await start({}, withHeadless());
    const client = await t.client();
    for (const [browser, expected] of [
      [null, { browser: { kind: "headless" }, reason: "default" }],
      [{ kind: "headless" }, { browser: { kind: "headless" }, reason: "chosen" }],
      [{ kind: "none" }, { browser: { kind: "none" }, reason: "chosen" }],
    ] as const) {
      const id = await sessionWith(client, browser);
      const { runId } = t.env.startRun({ sessionId: id, text: "Read the page", ...routine() } as ActorRunRequest);
      expect(resolvedOf(t, id, runId), JSON.stringify(browser)).toMatchObject({ requested: browser, ...expected });
    }
  });

  it("gives a routine's firing, whose session chooses no browser, the headless browser where one is here", async () => {
    const t = await start({}, withHeadless());
    const client = await t.client();
    const { state } = await created(client, written());
    const firingId = await ranNow(client, state.id);
    const { sessionId, runId } = (await untilStarted(t, state.id, firingId)).payload as { sessionId: string; runId: string };
    expect(resolvedOf(t, sessionId, runId)).toMatchObject({ requested: null, browser: { kind: "headless" }, reason: "default" });
  });

  it("lets an attended program's run have the Chrome its session names", async () => {
    const t = await start();
    const client = await t.client();
    const id = await sessionWith(client, WORK_CHROME);
    const { runId } = t.env.startRun({ sessionId: id, text: "Read the page", ...program(true) } as ActorRunRequest);
    expect(resolvedOf(t, id, runId)).toMatchObject({ browser: WORK_CHROME, reason: "chosen" });
  });
});

describe("the completions surface's sessions", () => {
  /** A program's bearer token: a pairing exchanged as kind `program` with the scopes a turn needs. */
  const program = async (t: TestEnvironment) => (await t.pair({ kind: "program", scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits", label: "hermes" })).token;

  const post = (t: TestEnvironment, token: string, extension: Record<string, unknown>): Promise<Response> =>
    fetch(`http://${t.address.host}:${t.address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "claude-max/opus", messages: [{ role: "user", content: "Read the page" }], "agent-harness": extension }),
    });

  const complete = async (t: TestEnvironment, token: string, extension: Record<string, unknown> = {}) => {
    const response = await post(t, token, extension);
    const text = await response.text();
    if (response.status !== 200) throw new Error(`The completion answered ${response.status}: ${text}`);
    return ChatCompletion.parse(JSON.parse(text))["agent-harness"];
  };

  it("creates a session with none, chosen by the completions surface, which its run resolves to none", async () => {
    const t = await start({}, withHeadless());
    const token = await program(t);
    const { sessionId, runId } = await complete(t, token);
    expect(payloadsOf<SessionBrowserSetPayload>(t, sessionId, "session.browser.set")).toEqual([{ browser: { kind: "none" }, chosenBy: "completions" }]);
    expect(await get(await t.client(), sessionId)).toMatchObject({ browser: { kind: "none" } });
    expect(resolvedOf(t, sessionId, runId)).toMatchObject({ requested: { kind: "none" }, browser: { kind: "none" }, reason: "chosen" });
  });

  it("creates one with the headless browser when the request says agent-harness.browser: headless", async () => {
    const t = await start({}, withHeadless());
    const token = await program(t);
    const answer = await complete(t, token, { browser: "headless" });
    expect(answer.ignored).toEqual([]);
    expect(payloadsOf<SessionBrowserSetPayload>(t, answer.sessionId, "session.browser.set")).toEqual([{ browser: { kind: "headless" }, chosenBy: "completions" }]);
    expect(resolvedOf(t, answer.sessionId, answer.runId)).toMatchObject({ browser: { kind: "headless" }, reason: "chosen" });
  });

  it("refuses any other value as the namespace refuses a malformed field, recording nothing", async () => {
    const t = await start();
    const token = await program(t);
    const before = t.env.log.head();
    for (const browser of ["chrome", "none", "on", { kind: "headless" }, true]) {
      const response = await post(t, token, { browser });
      expect({ status: response.status, body: CompletionsErrorBody.parse(await response.json()) }, JSON.stringify(browser)).toMatchObject({
        status: 400,
        body: { error: { code: "invalid_params", param: "agent-harness.browser" } },
      });
    }
    expect(t.env.log.head()).toBe(before);
  });

  it("gives a fork it makes the browser it asks for, and leaves a named session's own, reporting the field ignored", async () => {
    const t = await start({}, withHeadless());
    const token = await program(t);
    const client = await t.client();
    const named = await sessionWith(client, { kind: "dock" });
    await command(client, "sessions.setBrowser", { sessionId: named, browser: { kind: "dock" } });
    const continued = await complete(t, token, { sessionId: named, browser: "headless" });
    expect(continued.ignored).toEqual(["agent-harness.browser"]);
    expect(await get(client, named)).toMatchObject({ browser: { kind: "dock" } });

    const forked = await complete(t, token, { sessionId: named, forkSession: true, browser: "headless" });
    expect(forked.sessionId).not.toBe(named);
    expect(forked.ignored).toEqual([]);
    expect(payloadsOf<SessionBrowserSetPayload>(t, forked.sessionId, "session.browser.set")).toEqual([{ browser: { kind: "headless" }, chosenBy: "completions" }]);
    const plain = await complete(t, token, { sessionId: named, forkSession: true });
    expect(await get(client, plain.sessionId)).toMatchObject({ browser: { kind: "none" } });
  });
});
