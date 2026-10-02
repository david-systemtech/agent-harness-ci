import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SCOPES, type SessionBrowser } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { callHostTool, end, fakeAdapter, type FakeAdapter } from "../../environment/test/fake-adapter.js";
import { answeringFrom, fakeChrome } from "../../environment/test/fake-extension.js";
import type { TestEnvironment } from "../../environment/test/helper.js";
import { scriptedPageDriver } from "../../environment/test/scripted-page-driver.js";
import { workspace } from "../../environment/test/sessions.js";
import { WAIT_MS } from "../../environment/test/wire-client.js";
import type { HostToolResult } from "../../environment/src/adapter/contract.js";
import { grantReader, holds, useHarness } from "../test/harness.js";
import type { ConnectionSeams } from "./connections/registry.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";

/**
 * The browser relay end to end (browser spec, "The browser relay" and
 * "Testing Decisions", the relay seam; ADR 0014; #554): two in-process
 * environments and one client runtime connected to both, local to the desk
 * through its grant and paired with the server, the fake extension paired
 * with the desk and the scripted fake adapter on the server calling
 * `browser_navigate` in a run the runtime started. The verb goes out as the
 * server's `client.call` to the runtime, which performs it with
 * `browser.chromes.perform` on the desk, whose extension answers; the
 * runtime answers with `client.answer` and the model reads the framed page.
 */

const harness = useHarness();

/** Sends `method` through the runtime's socket to `environmentId`, throwing unless it answers a result. */
const send = async (seams: ConnectionSeams, environmentId: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const response = await seams.request(environmentId, method, params);
  if (response.error || response.result === undefined) throw new Error(`${method} was refused: ${JSON.stringify(response)}`);
  return response.result;
};

/** The desk with the fake Chrome "Work" paired to it, answering every verb from a scripted page driver. */
const deskWithChrome = async () => {
  const desk = await harness.environment({ name: "desk" });
  const driver = scriptedPageDriver("chrome");
  const chrome = fakeChrome(join(desk.dataDir, "extension", "current"), { script: answeringFrom(driver) });
  const asking = await desk.client();
  const { code } = await asking.apply("browser.pairing.code", {});
  await asking.close();
  const { extension, answer } = await chrome.pair(code, "Work");
  harness.onCleanup(() => extension.close());
  if (answer.type !== "paired") throw new Error(`The pairing was refused: ${JSON.stringify(answer)}`);
  return { desk, chromeId: answer.chromeId, extension };
};

/** Starts a run on `server` from the runtime that calls `browser_navigate`, in a session whose browser is `browser`; answers what the model read. */
const navigateFrom = async (seams: ConnectionSeams, server: TestEnvironment, browser: SessionBrowser): Promise<{ sessionId: string; answer: HostToolResult }> => {
  const sessionId = randomUUID();
  await send(seams, server.env.id, "sessions.create", { commandId: randomUUID(), id: sessionId, workspace, browser: { value: browser, chosenBy: "person" } });
  const answers: HostToolResult[] = [];
  (server.adapter as FakeAdapter).nextScripts.push(async function* (controls) {
    answers.push(yield* callHostTool(controls, { server: "browser", name: "browser_navigate", input: { address: "https://example.com/next" } }));
    yield end();
  });
  await send(seams, server.env.id, "runs.start", { commandId: randomUUID(), sessionId, text: "Look at the next page" });
  await vi.waitFor(() => expect(answers).toHaveLength(1), { timeout: WAIT_MS });
  return { sessionId, answer: answers[0] as HostToolResult };
};

/** Whether a result carries page content in a frame. */
const isFramed = (text: string): boolean => /^\[page content [0-9a-f]+\] /m.test(text) && /^\[end of page content [0-9a-f]+\]$/m.test(text);

describe.each(["desktop", "tui"] as const)("the browser relay through a %s runtime", (kind) => {
  it("takes browser_navigate on the server to the Chrome paired with the desk, and the model reads the framed answer", async () => {
    const { desk, chromeId, extension } = await deskWithChrome();
    const server = await harness.environment({ name: "server", adapter: fakeAdapter() });
    const { runtime, seams } = harness.withSeams(inMemoryPlatform({ kind, grant: grantReader(desk) }));
    await runtime.start();
    await runtime.connections.add({ link: (await server.createPairing()).link });
    await holds(runtime.connections.list, (records) => records.length === 2 && records.every((record) => record.phase === "ready"));

    const { sessionId, answer } = await navigateFrom(seams, server, { kind: "chrome", environmentId: desk.env.id, chromeId });

    expect(extension.calls.map((call) => ({ pageKey: call.pageKey, command: call.command }))).toEqual([
      { pageKey: `${server.env.id}/${sessionId}`, command: { verb: "navigate", args: { url: "https://example.com/next", snapshot: { filter: "interactive", maxChars: 12_000 } } } },
    ]);
    expect(answer.isError).toBe(false);
    expect(answer.text.split("\n")[0]).toBe("Went to https://example.com/next. The page is at https://example.com/next.");
    expect(isFramed(answer.text)).toBe(true);
    expect(server.env.log.readStream({ kind: "environment", id: server.env.id }).filter((event) => event.type === "client.call")).toHaveLength(1);
  });
});

describe("a runtime with no local connection to the Chrome's environment", () => {
  it("answers the call with why, which the model reads as a sentence naming the client, and the Chrome is asked nothing", async () => {
    const { desk, chromeId, extension } = await deskWithChrome();
    const server = await harness.environment({ name: "server", adapter: fakeAdapter() });
    const { runtime, seams } = harness.withSeams(inMemoryPlatform({ kind: "desktop", label: "The laptop" }));
    await runtime.start();
    await runtime.connections.add({ link: (await desk.createPairing({ scopes: SCOPES })).link });
    await runtime.connections.add({ link: (await server.createPairing()).link });
    await holds(runtime.connections.list, (records) => records.length === 2 && records.every((record) => record.phase === "ready"));

    const { answer } = await navigateFrom(seams, server, { kind: "chrome", environmentId: desk.env.id, chromeId });

    expect(answer).toEqual({
      text: `The client "The laptop" could not drive the Chrome: This client is not on the machine of the environment the Chrome is paired with (${desk.env.id}): it holds no local connection to it, so it cannot drive that Chrome.`,
      isError: true,
    });
    expect(extension.calls).toEqual([]);
  });
});


/** Two fake extensions at the desk, and a plain My Chrome session on the server. */
const relayedPlainChrome = async (secondName = "Personal") => {
  const { desk, extension: work } = await deskWithChrome();
  const personalChrome = fakeChrome(join(desk.dataDir, "extension", "current"), { script: answeringFrom(scriptedPageDriver("chrome")) });
  const asking = await desk.client();
  const { code } = await asking.apply("browser.pairing.code", {});
  await asking.close();
  const { extension: personal, answer: paired } = await personalChrome.pair(code, secondName);
  harness.onCleanup(() => personal.close());
  if (paired.type !== "paired") throw new Error("Personal was not paired");
  const server = await harness.environment({ name: "server", adapter: fakeAdapter() });
  const { runtime, seams } = harness.withSeams(inMemoryPlatform({ kind: "tui", grant: grantReader(desk) }));
  await runtime.start();
  await runtime.connections.add({ link: (await server.createPairing()).link });
  await holds(runtime.connections.list, (records) => records.length === 2 && records.every((record) => record.phase === "ready"));
  const sessionId = randomUUID();
  await send(seams, server.env.id, "sessions.create", { commandId: randomUUID(), id: sessionId, workspace, browser: { value: { kind: "chrome", environmentId: desk.env.id, chromeId: null }, chosenBy: "person" } });
  return { desk, work, personal, paired, server, seams, sessionId };
};

describe("the several-Chromes answer for a relayed plain My Chrome", () => {
  it("records the named desk Chrome chosen by the agent and drives it in this run and the next", async () => {
    const { desk, work, personal, paired, server, seams, sessionId } = await relayedPlainChrome();
    const answers: HostToolResult[] = [];
    (server.adapter as FakeAdapter).nextScripts.push(async function* (controls) {
      answers.push(yield* callHostTool(controls, { server: "browser", name: "browser_snapshot", input: {} }));
      answers.push(yield* callHostTool(controls, { server: "browser", name: "browser_open", input: { browser: " personal ", address: "https://example.com", snapshot: false } }));
      answers.push(yield* callHostTool(controls, { server: "browser", name: "browser_open", input: { browser: "Work", snapshot: false } }));
      answers.push(yield* callHostTool(controls, { server: "browser", name: "browser_snapshot", input: {} }));
      yield end();
    });
    await send(seams, server.env.id, "runs.start", { commandId: randomUUID(), sessionId, text: "Use Personal" });
    await vi.waitFor(() => expect(answers).toHaveLength(4), { timeout: WAIT_MS });
    expect(answers[0]).toMatchObject({ isError: true, text: expect.stringContaining("Work, Personal") });
    expect(answers[1]).toMatchObject({ isError: false, text: expect.stringContaining("This session uses the Chrome Personal from now on.") });
    expect(answers[2]).toMatchObject({ isError: true, text: expect.stringContaining("This session uses the Chrome Personal, which only the person can change") });
    expect(answers[3]?.isError).toBe(false);
    expect(work.calls).toEqual([]);
    expect(personal.calls.map((call) => call.command.verb)).toEqual(["open", "snapshot"]);
    const events = server.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "session.browser.set");
    expect(events.map((event) => event.payload)).toEqual([
      { browser: { kind: "chrome", environmentId: desk.env.id, chromeId: null }, chosenBy: "person" },
      { browser: { kind: "chrome", environmentId: desk.env.id, chromeId: paired.chromeId }, chosenBy: "agent" },
    ]);
    await vi.waitFor(() => expect(server.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "run.ended")).toBe(true), { timeout: WAIT_MS });
    (server.adapter as FakeAdapter).nextScripts.push(async function* (controls) {
      answers.push(yield* callHostTool(controls, { server: "browser", name: "browser_navigate", input: { address: "https://example.com/next", snapshot: false } }));
      yield end();
    });
    await send(seams, server.env.id, "runs.start", { commandId: randomUUID(), sessionId, text: "Next page" });
    await vi.waitFor(() => expect(answers).toHaveLength(5), { timeout: WAIT_MS });
    expect(answers[4]?.isError).toBe(false);
    expect(personal.calls.map((call) => call.command.verb)).toEqual(["open", "snapshot", "navigate"]);
    expect(work.calls).toEqual([]);
  });

  it.each([
    { name: "Home", secondName: "Personal", reason: "No Chrome paired with desk is named Home: the paired Chromes are Work, Personal." },
    { name: "work", secondName: "WORK", reason: "Several Chromes paired with desk are named Work." },
  ])("refuses $name when the desk's names cannot identify one Chrome", async ({ name, secondName, reason }) => {
    const { work, personal, server, seams, sessionId } = await relayedPlainChrome(secondName);
    const answers: HostToolResult[] = [];
    (server.adapter as FakeAdapter).nextScripts.push(async function* (controls) {
      answers.push(yield* callHostTool(controls, { server: "browser", name: "browser_open", input: { browser: name } }));
      yield end();
    });
    await send(seams, server.env.id, "runs.start", { commandId: randomUUID(), sessionId, text: "Choose a Chrome" });
    await vi.waitFor(() => expect(answers).toHaveLength(1), { timeout: WAIT_MS });
    expect(answers[0]).toMatchObject({ isError: true, text: expect.stringContaining(reason) });
    expect(work.calls).toEqual([]);
    expect(personal.calls).toEqual([]);
    expect(server.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "session.browser.set")).toHaveLength(1);
  });

});
