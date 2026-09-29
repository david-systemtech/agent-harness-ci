// @vitest-environment jsdom
import { describe, expect, it, onTestFinished } from "vitest";
import { createRuntime } from "../runtime.js";
import { flush } from "./fake-wire.js";
import { inMemoryPlatform, manualClock } from "./in-memory-platform.js";
import { scriptedWorld, type Script } from "./scripted-environment.js";

/**
 * The scripted environment as a renderer's tests drive it
 * (docs/specs/gui.md, "Testing Decisions"): the runtime on the in-memory
 * platform over the script, in jsdom as the GUI's tests run, asserted
 * through the runtime's public surface. The terminal UI's suites drive the
 * same script through Ink.
 */

/** A runtime over `script`: started, the local environment through its grant, each `paired` one paired by its link. */
const launch = async (script: Script) => {
  const clock = manualClock();
  const world = scriptedWorld(clock, script);
  const platform = inMemoryPlatform({ clock, kind: "desktop", fetch: world.fetch, webSocket: world.webSocket, ...(world.grant && { grant: world.grant }) });
  const runtime = createRuntime(platform);
  onTestFinished(() => runtime.close());
  await runtime.start();
  for (const spec of script.environments.filter((e) => e.reach === "paired")) {
    expect(await runtime.connections.add({ link: world.environment(spec.name).wire.link })).toMatchObject({ status: "paired" });
  }
  /** Lets the fake wire and the runtime answer each other until `condition` holds, with no time passing. */
  const until = async (condition: () => boolean, what: string) => {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await flush();
    }
    throw new Error(`Never ${what}.`);
  };
  return { clock, world, runtime, until };
};

const GROUP_ID = "0199bb00-0000-4000-8000-000000000001";

describe("the scripted environment in a DOM", () => {
  it("runs where a renderer's tests run: in jsdom", () => {
    expect(navigator.userAgent).toContain("jsdom");
    expect("document" in globalThis).toBe(true);
  });

  it("lists the sessions and groups of two environments, the local one through its grant and the other paired by its link", async () => {
    const { runtime, until } = await launch({
      environments: [
        { name: "desk", reach: "local", sessions: [{ title: "Fix the rail", groupId: GROUP_ID }, { title: "Pairing" }], groups: [{ name: "Brandsolidate" }] },
        { name: "laptop", reach: "paired", sessions: [{ title: "Train tidy-up" }] },
      ],
    });
    onTestFinished(runtime.projections.sessionList.subscribe(() => undefined));
    await until(() => runtime.projections.sessionList.read().rows.length === 3, "listing three sessions");

    const list = runtime.projections.sessionList.read();
    expect(runtime.projections.environments.read().map((e) => [e.name, e.phase])).toEqual([
      ["desk", "ready"],
      ["laptop", "ready"],
    ]);
    expect(list.rows.map((row) => row.summary.title).sort()).toEqual(["Fix the rail", "Pairing", "Train tidy-up"]);
    expect(list.groups).toMatchObject([{ name: "Brandsolidate", groups: [{ groupId: GROUP_ID }] }]);
  });

  it("streams a run with a tool call into the session's transcript", async () => {
    const { world, runtime, until } = await launch({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Fix the rail" }] }] });
    const desk = world.environment("desk");
    const sessionId = desk.sessionId();
    const session = runtime.projections.session(desk.environmentId, sessionId);
    onTestFinished(session.subscribe(() => undefined));
    await until(() => session.read().freshness === "live", "following the session live");

    const { runId } = desk.startRun(sessionId, "Why does the rail flicker?");
    desk.emit(sessionId, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Looking at " }] });
    await until(() => session.read().items.some((item) => item.kind === "assistant-text"), "streaming the reply");
    expect(session.read().items.find((item) => item.kind === "assistant-text")).toMatchObject({ text: "Looking at ", streaming: true });

    desk.emit(sessionId, "tool.started", { runId, toolCallId: "t1", name: "Bash", input: { command: "pnpm test" }, title: null, agentId: null, parentToolCallId: null });
    desk.emit(sessionId, "tool.ended", { runId, toolCallId: "t1", status: "ok", output: "passed", durationMs: 20 });
    desk.emit(sessionId, "assistant.text", { runId, itemId: "i-1", text: "Looking at the rail. Fixed.", aborted: false });
    desk.endRun(sessionId, runId);
    await until(() => session.read().runs.length === 1 && session.read().runs[0]?.endedAt !== null, "ending the run");

    expect(session.read().items.map((item) => item.kind)).toEqual(["user-message", "assistant-text", "tool-call"]);
    expect(session.read().items).toMatchObject([
      { text: "Why does the rail flicker?" },
      { text: "Looking at the rail. Fixed.", streaming: false },
      { name: "Bash", status: "ok" },
    ]);
  });

  it("parks a prompt on a live run and hears the runtime's answer to it", async () => {
    const { world, runtime, until } = await launch({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Fix the rail" }] }] });
    const desk = world.environment("desk");
    const sessionId = desk.sessionId();
    onTestFinished(runtime.projections.runs.subscribe(() => undefined));
    desk.startRun(sessionId, "Clean the build");
    const promptId = desk.openPrompt(sessionId);
    await until(() => runtime.projections.runs.read().parkedAsks.length === 1, "parking the prompt");
    expect(runtime.projections.runs.read().parkedAsks).toMatchObject([{ environmentId: desk.environmentId, sessionId, promptId, kind: "permission", summary: "Bash: rm -rf build" }]);

    const answered = await runtime.commands.dispatch(desk.environmentId, "permissions.prompts.answer", { sessionId, promptId, decision: "allow" });
    expect(answered).toMatchObject({ ok: true });
    await until(() => runtime.projections.runs.read().parkedAsks.length === 0, "the prompt leaving the parked asks");
    expect(desk.answered()).toMatchObject([{ promptId, decision: "allow" }]);
  });

  it("answers a command with the receipt the script chose", async () => {
    const { world, runtime } = await launch({
      environments: [{ name: "desk", reach: "local", sessions: [{ title: "Gone" }, { title: "Kept" }], receipts: { "sessions.archive": { rejected: "not_found", message: "No such session." } } }],
    });
    const desk = world.environment("desk");

    expect(await runtime.commands.dispatch(desk.environmentId, "sessions.archive", { sessionId: desk.sessionId(0) })).toMatchObject({
      ok: false,
      error: { code: "not_found", message: "No such session." },
    });
    expect(await runtime.commands.dispatch(desk.environmentId, "sessions.pin", { sessionId: desk.sessionId(1) })).toMatchObject({ ok: true });
    expect(desk.summary(desk.sessionId(1)).pinnedAt).not.toBeNull();
    expect(desk.summary(desk.sessionId(0)).archivedAt).toBeNull();
  });

  it("reads a subagent's stored transcript while its provider declares them, and refuses as the environment does while it does not", async () => {
    const messages = [{ type: "user", uuid: "u1", message: { role: "user", content: "Find the parser" } }];
    const { world, runtime } = await launch({
      environments: [
        { name: "desk", reach: "local", sessions: [{ title: "Explore" }], provider: { subagentTranscripts: true }, subagentTranscripts: { "call-agent": messages } },
        { name: "laptop", reach: "paired", sessions: [{ title: "Explore" }], subagentTranscripts: { "call-agent": messages } },
      ],
    });
    const desk = world.environment("desk");
    expect(await runtime.requests.call(desk.environmentId, "sessions.subagentTranscript", { sessionId: desk.sessionId(), agentId: "call-agent" })).toEqual({
      ok: true,
      result: { sessionId: desk.sessionId(), agentId: "call-agent", messages },
    });
    expect(await runtime.requests.call(desk.environmentId, "sessions.subagentTranscript", { sessionId: desk.sessionId(), agentId: "nobody" })).toMatchObject({
      ok: true,
      result: { messages: [] },
    });
    const laptop = world.environment("laptop");
    expect(await runtime.requests.call(laptop.environmentId, "sessions.subagentTranscript", { sessionId: laptop.sessionId(), agentId: "call-agent" })).toMatchObject({
      ok: false,
      error: { code: "invalid_params", message: "The Claude adapter cannot read a subagent's transcript: it does not declare subagentTranscripts.", data: { reason: "unsupported" } },
    });
  });

  it("has discovery answer starting or nothing, and says bye with a reason", async () => {
    const { clock, world, runtime, until } = await launch({
      environments: [
        { name: "desk", reach: "local", discovery: "starting" },
        { name: "laptop", reach: "paired" },
      ],
    });
    const phaseOf = (name: string) => runtime.projections.environments.read().find((e) => e.name === name)?.phase;
    expect(runtime.local.read()).toMatchObject({ state: "failed", reason: "starting" });
    expect(phaseOf("desk")).toBe("starting");

    const laptop = world.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    await until(() => phaseOf("laptop") === "backoff", "the laptop backing off");
    laptop.discovery("ready");
    clock.advance(2000);
    await until(() => phaseOf("laptop") === "ready", "the laptop back");
    laptop.bye("draining");
    await until(() => phaseOf("laptop") === "draining", "the laptop draining");
  });
});
