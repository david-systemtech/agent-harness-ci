import type { Scope } from "@agent-harness/contracts";
import { subscription } from "../test/scripted.js";
import { numbered, recordedSnapshot } from "../test/transcript.js";
import { noticeEvent } from "../test/events.js";
import { describe, expect, it, onTestFinished } from "vitest";
import { createRuntimeWithSeams } from "./internal.js";
import { fakeWire, flush } from "./testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "./testing/in-memory-platform.js";

const SESSION = "0199aa00-0000-4000-8000-000000000001";
const OTHER = "0199aa00-0000-4000-8000-000000000002";
const paired = async (capabilities = ["workspaceChecks"], scopes: Scope[] = ["read", "terminal", "sessions:write", "runs:drive"]) => {
  const clock = manualClock();
  const wire = fakeWire({ clock, name: "desk" });
  wire.answer("environment.subscribe", () => undefined);
  const { runtime } = createRuntimeWithSeams(inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket }));
  onTestFinished(() => runtime.close());
  await runtime.start();
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept({ capabilities, scopes });
  await adding;
  return { runtime, wire, id: wire.environmentId };
};

describe("Workspace checks", () => {
  it("gets, saves verbatim and clears the Environment's directory command shared by two Sessions", async () => {
    const { runtime, wire, id } = await paired();
    let command: string | null = null;
    wire.answer("checks.get", () => ({ result: { workspace: "/repo", command } }));
    wire.answer("checks.set", (params) => {
      command = params["command"] as string | null;
      return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { workspace: "/repo", command } } };
    });
    const view = runtime.projections.checks(id, SESSION);
    onTestFinished(view.subscribe(() => undefined));
    await flush();
    expect(view.read()).toMatchObject({ value: { workspace: "/repo", command: null }, availability: { status: "present" } });
    const text = "  pnpm test  &&\nprintf 'done'  ";
    expect(await runtime.checks.set(id, SESSION, text)).toMatchObject({ ok: true });
    expect(await runtime.checks.get(id, OTHER)).toMatchObject({ ok: true, result: { command: text } });
    expect(await runtime.checks.set(id, OTHER, null)).toMatchObject({ ok: true });
    expect(await runtime.checks.get(id, SESSION)).toMatchObject({ ok: true, result: { command: null } });
  });
});

const TERMINAL = "0199aa00-0000-4000-8000-000000000003";
const check = (terminalId = TERMINAL, extra = {}) => ({ terminalId, command: "pnpm test", sourceRunId: "0199aa00-0000-4000-8000-000000000004", output: "failed assertion", truncated: true, exitCode: 1, signal: null, timedOut: false, failure: null, ...extra });

it("offers failures from replay, sends only explicitly, and preserves the Session draft", async () => {
  const { runtime, wire, id } = await paired();
  wire.answer("checks.get", () => ({ result: { workspace: "/repo", command: "pnpm test" } }));
  wire.answer("sessions.subscribeSession", () => undefined);
  wire.answer("runs.start", () => ({ result: { receipt: { status: "accepted", sequence: 9, changed: true }, result: { runId: "0199aa00-0000-4000-8000-000000000005", messageId: "0199aa00-0000-4000-8000-000000000006", state: "starting" } } }));
  const view = runtime.projections.checks(id, SESSION);
  onTestFinished(view.subscribe(() => undefined));
  const stream = await subscription(wire, "sessions.subscribeSession");
  stream.snapshot(0, { ...recordedSnapshot(), sequence: 0, runs: [], items: [], parkedPrompts: [], rewinds: [], instructions: "" });
  stream.event(numbered(1, [["checks.finished", check()]])[0]!);
  stream.synchronized(1);
  await flush();
  expect(view.read().offer).toMatchObject({ terminalId: TERMINAL, output: "failed assertion" });
  expect(wire.server.received().filter((f) => f.type === "request" && f.method === "runs.start")).toHaveLength(0);
  runtime.drafts.set(id, SESSION, "untouched draft");
  expect(await runtime.checks.sendFailure(id, SESSION)).toMatchObject({ ok: true });
  expect(runtime.projections.session(id, SESSION).read().draft).toBe("untouched draft");
  expect(view.read().offer).toBeNull();
  expect(wire.server.received()).toContainEqual(expect.objectContaining({ method: "runs.start", params: expect.objectContaining({ text: expect.stringContaining("failed assertion") }) }));
  stream.event(numbered(2, [["checks.finished", check("0199aa00-0000-4000-8000-000000000007")]])[0]!);
  await flush();
  expect(view.read().offer).toBeNull();
  stream.event(numbered(3, [["checks.finished", check("0199aa00-0000-4000-8000-000000000008", { exitCode: 0 })]])[0]!);
  stream.event(numbered(4, [["checks.finished", check("0199aa00-0000-4000-8000-000000000009")]])[0]!);
  await flush();
  expect(view.read().offer).not.toBeNull();
  wire.answer("runs.start", () => ({ error: { code: "conflict", message: "cannot start", data: {} } }));
  expect(await runtime.checks.sendFailure(id, SESSION)).toMatchObject({ ok: false });
  expect(view.read().offer).not.toBeNull();
  wire.answer("checks.run", () => ({ result: { receipt: { status: "accepted", sequence: 5, changed: true }, result: { terminalId: "0199aa00-0000-4000-8000-000000000010" } } }));
  expect(await runtime.checks.run(id, SESSION)).toMatchObject({ ok: true });
  expect(view.read().offer).toBeNull();
  stream.event(numbered(5, [["checks.finished", check("0199aa00-0000-4000-8000-000000000010", { sourceRunId: null })]])[0]!);
  await flush();
  expect(view.read().offer).not.toBeNull();
  let command: string | null = "pnpm test";
  wire.answer("checks.get", () => ({ result: { workspace: "/repo", command } }));
  wire.answer("checks.set", (params) => {
    command = params["command"] as string | null;
    return { result: { receipt: { status: "accepted", sequence: 6, changed: true }, result: { workspace: "/repo", command } } };
  });
  await runtime.checks.set(id, SESSION, "pnpm lint");
  await flush();
  expect(view.read().offer).toBeNull();
  await runtime.checks.set(id, SESSION, "pnpm test");
  await flush();
  expect(view.read().offer).toBeNull();
  stream.event(numbered(6, [["checks.finished", check("0199aa00-0000-4000-8000-000000000011")]])[0]!);
  await flush();
  expect(view.read().offer).not.toBeNull();
  await runtime.checks.set(id, SESSION, null);
  await flush();
  expect(view.read().offer).toBeNull();
  await runtime.checks.set(id, SESSION, "pnpm test");
  await flush();
  stream.event(numbered(7, [["checks.finished", check("0199aa00-0000-4000-8000-000000000012")]])[0]!);
  await flush();
  wire.answer("runs.start", () => undefined);
  const sending = runtime.checks.sendFailure(id, SESSION);
  await flush();
  const request = wire.server.received().filter((frame) => frame.type === "request" && frame.method === "runs.start").at(-1);
  if (request?.type !== "request") throw new Error("No explicit failure send was requested.");
  await runtime.checks.set(id, SESSION, null);
  await runtime.checks.set(id, SESSION, "pnpm test");
  await flush();
  stream.event(numbered(8, [["checks.finished", check("0199aa00-0000-4000-8000-000000000013")]])[0]!);
  await flush();
  wire.server.send({ type: "response", id: request.id, result: { receipt: { status: "accepted", sequence: 9, changed: true }, result: { runId: "0199aa00-0000-4000-8000-000000000005", messageId: "0199aa00-0000-4000-8000-000000000006", state: "starting" } } });
  expect(await sending).toMatchObject({ ok: true });
  expect(view.read().offer).toMatchObject({ terminalId: "0199aa00-0000-4000-8000-000000000013" });
});

it("refreshes both Sessions on checks.changed and refuses absent flags, scopes and offline commands", async () => {
  for (const [flags, scopes, reason] of [[[], ["terminal"], "unsupported"], [["workspaceChecks"], ["read"], "scope"]] as const) {
    const { runtime, id } = await paired([...flags], [...scopes]);
    expect(runtime.projections.checks(id, SESSION).read().availability).toMatchObject({ status: "absent", reason });
    expect(await runtime.checks.run(id, SESSION)).toMatchObject({ ok: false, error: { code: reason } });
  }
  const { runtime, wire, id } = await paired();
  wire.answer("environment.subscribe", () => undefined);
  // The subscription may already have been requested at startup.
  const notices = await subscription(wire, "environment.subscribe");
  notices.synchronized(0);
  let command = "before";
  wire.answer("checks.get", () => ({ result: { workspace: "/repo", command } }));
  const views = [runtime.projections.checks(id, SESSION), runtime.projections.checks(id, OTHER)];
  views.forEach((view) => onTestFinished(view.subscribe(() => undefined)));
  await flush();
  command = "after";
  notices.event(noticeEvent(1, id, "checks.changed", { workspace: "/repo", command }));
  await flush();
  expect(views.map((view) => view.read().value?.command)).toEqual(["after", "after"]);
  await runtime.connections.setEnabled(id, false);
  expect(await runtime.checks.run(id, SESSION)).toMatchObject({ ok: false, error: { code: "unreachable" } });
  expect(await runtime.checks.set(id, SESSION, "never queued")).toMatchObject({ ok: false, error: { code: "unreachable" } });
});

it("keeps an in-flight check's later failure offer after a busy manual-now reset", async () => {
  const { runtime, wire, id } = await paired();
  wire.answer("checks.get", () => ({ result: { workspace: "/repo", command: "pnpm test" } }));
  wire.answer("sessions.subscribeSession", () => undefined);
  wire.answer("checks.run", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { terminalId: TERMINAL } } }));
  const view = runtime.projections.checks(id, SESSION);
  onTestFinished(view.subscribe(() => undefined));
  const stream = await subscription(wire, "sessions.subscribeSession");
  stream.snapshot(0, { ...recordedSnapshot(), sequence: 0, runs: [], items: [], parkedPrompts: [], rewinds: [], instructions: "" });
  stream.synchronized(0);
  await flush();
  expect(await runtime.checks.run(id, SESSION)).toMatchObject({ ok: true });
  const manual = check(TERMINAL, { sourceRunId: null });
  stream.event(numbered(1, [["checks.started", { terminalId: TERMINAL, command: manual.command, sourceRunId: null }]])[0]!);
  await flush();
  wire.answer("checks.run", () => ({ result: { receipt: { status: "rejected", sequence: 2, changed: false, reason: "conflict", error: { code: "conflict", message: "The check is busy.", data: { reason: "check_running" } } } } }));
  expect(await runtime.checks.run(id, SESSION)).toMatchObject({ ok: true, result: { receipt: { status: "rejected" } } });
  stream.event(numbered(2, [["checks.finished", manual]])[0]!);
  await flush();
  expect(view.read().offer).toMatchObject({ terminalId: TERMINAL, output: "failed assertion" });
});
