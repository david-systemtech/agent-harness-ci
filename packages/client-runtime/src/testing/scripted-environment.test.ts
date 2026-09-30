// @vitest-environment jsdom
import { DISCOVERY_PATH } from "@agent-harness/contracts";
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

  it("writes and edits a file in a run as Claude's Write and Edit do, which projections.documents lists and files.read answers", async () => {
    const { world, runtime, until } = await launch({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Site" }] }] });
    const desk = world.environment("desk");
    const sessionId = desk.sessionId();
    const documents = runtime.projections.documents(desk.environmentId, sessionId);
    onTestFinished(documents.subscribe(() => undefined));
    await until(() => runtime.projections.session(desk.environmentId, sessionId).read().freshness === "live", "following the session live");

    const { runId } = desk.startRun(sessionId, "Make a page");
    const written = desk.writeFile(sessionId, runId, "site/index.html", "<h1>Receipts</h1>");
    const edited = desk.editFile(sessionId, runId, "site/index.html", "Receipts", "Totals");
    await until(() => documents.read()[0]?.revisions === 2, "listing the page");
    expect(documents.read()).toMatchObject([{ path: "site/index.html", kind: "page", first: { toolCallId: written }, last: { toolCallId: edited }, size: 17 }]);
    expect(desk.events(sessionId).find((event) => event.type === "tool.started")?.payload).toMatchObject({
      name: "Write",
      input: { file_path: "/home/seth/code/site/index.html", content: "<h1>Receipts</h1>" },
    });

    const read = await runtime.requests.call(desk.environmentId, "files.read", { sessionId, path: "site/index.html" });
    expect(read).toMatchObject({ ok: true, result: { text: "<h1>Totals</h1>", size: 15 } });
    expect(await runtime.requests.call(desk.environmentId, "files.list", { sessionId })).toMatchObject({ ok: true, result: { files: ["site/index.html"] } });
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

  it("renames a group, refusing a name another group has, and deletes one, taking its sessions out of it, as the environment's deciders do", async () => {
    const OTHER = "0199bb00-0000-4000-8000-000000000002";
    const { world, runtime, until } = await launch({
      environments: [
        {
          name: "desk",
          reach: "local",
          sessions: [{ title: "Fix the rail", groupId: GROUP_ID }, { title: "Copy", groupId: GROUP_ID }],
          groups: [{ id: GROUP_ID, name: "Brandsolidate" }, { id: OTHER, name: "Ops" }],
        },
      ],
    });
    onTestFinished(runtime.projections.sessionList.subscribe(() => undefined));
    const desk = world.environment("desk");
    await until(() => runtime.projections.sessionList.read().rows.length === 2, "listing two sessions");

    expect(await runtime.commands.dispatch(desk.environmentId, "groups.rename", { groupId: GROUP_ID, name: " ops " })).toMatchObject({
      ok: false,
      error: { code: "conflict", data: { reason: "name_taken" } },
    });
    expect(await runtime.commands.dispatch(desk.environmentId, "groups.rename", { groupId: GROUP_ID, name: "  Brand   work " })).toMatchObject({ ok: true });
    expect(desk.list.groups().find((group) => group.id === GROUP_ID)?.name).toBe("Brand work");
    await until(() => runtime.projections.sessionList.read().groups.some((group) => group.name === "Brand work"), "renaming the heading");

    expect(await runtime.commands.dispatch(desk.environmentId, "groups.delete", { groupId: GROUP_ID })).toMatchObject({ ok: true });
    expect(desk.list.groups().map((group) => group.name)).toEqual(["Ops"]);
    expect(desk.list.summaries().map((summary) => summary.groupId)).toEqual([null, null]);
    await until(() => runtime.projections.sessionList.read().rows.every((row) => row.groupName === null), "ungrouping its sessions");
    expect(await runtime.commands.dispatch(desk.environmentId, "groups.delete", { groupId: GROUP_ID })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("says settings.changed with the keys each write changed, as the environment does, and when another client changes them, which a cached settings.get follows (#391)", async () => {
    const { world, runtime, until } = await launch({ environments: [{ name: "desk", reach: "local" }] });
    const desk = world.environment("desk");
    await until(() => runtime.projections.environments.read()[0]?.phase === "ready", "desk ready");
    const settings = runtime.requests.cached(desk.environmentId, "settings.get", { keys: ["sessions.autoSettleOnMerge", "permissions.defaultCeiling"] });
    onTestFinished(settings.subscribe(() => undefined));
    await until(() => settings.read().result !== null, "the settings read");
    const asked = () => desk.requests("settings.get").length;
    const before = asked();

    await runtime.requests.call(desk.environmentId, "settings.update", { commandId: "0199cc00-0000-4000-8000-000000000001", values: { "sessions.autoSettleOnMerge": true } });
    await until(() => settings.read().result?.values["sessions.autoSettleOnMerge"] === true, "the write read again");
    expect(asked()).toBe(before + 1);

    desk.setSettings({ "permissions.defaultCeiling": "auto" });
    await until(() => settings.read().result?.values["permissions.defaultCeiling"] === "auto", "another client's change read again");
    // A value it holds already changes nothing, and says nothing.
    desk.setSettings({ "permissions.defaultCeiling": "auto" });
    for (let i = 0; i < 10; i++) await flush();
    expect(asked()).toBe(before + 2);
  });

  it("answers the look commands with the look as it now is, noticing each field that changed, and says the new look in discovery, as the environment does (#323)", async () => {
    const { world, runtime, until } = await launch({ environments: [{ name: "desk", reach: "local", colour: "amber" }] });
    const desk = world.environment("desk");
    const view = () => runtime.projections.environments.read()[0];
    await until(() => view()?.phase === "ready", "desk ready");
    expect(view()).toMatchObject({ name: "desk", icon: null, colour: "amber" });

    const renamed = await runtime.requests.call(desk.environmentId, "environment.rename", { commandId: "0199cc00-0000-4000-8000-000000000002", name: "  Tower   box " });
    expect(renamed).toMatchObject({ ok: true, result: { receipt: { status: "accepted", changed: true }, result: { name: "Tower box", icon: "server", colour: "amber" } } });
    await until(() => view()?.name === "Tower box", "the rename noticed");
    const again = await runtime.requests.call(desk.environmentId, "environment.rename", { commandId: "0199cc00-0000-4000-8000-000000000003", name: "Tower box" });
    expect(again).toMatchObject({ ok: true, result: { receipt: { status: "accepted", changed: false } } });

    desk.setLook({ icon: "nas", colour: "teal" });
    await until(() => view()?.colour === "teal" && view()?.icon === "nas", "another client's look noticed");
    const discovery = await world.fetch(`${desk.wire.origin}${DISCOVERY_PATH}`);
    expect(await discovery.json()).toMatchObject({ environmentName: "Tower box", environmentIcon: "nas", environmentColour: "teal" });
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
