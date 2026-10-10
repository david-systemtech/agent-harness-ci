import { randomUUID } from "node:crypto";
import { scriptedCdpPeer } from "@agent-harness/browser/testing";
import type { JsonObject, PromptOpenedPayload } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { callHostTool, end, fakeAdapter, type FakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { isInProcess, type HostToolResult } from "../adapter/contract.js";

const { onCleanup } = useCleanups();
const PAYPAL = "https://www.paypal.com/checkout";
const events = (t: TestEnvironment, id: string) => t.env.log.readStream({ kind: "session", id });

const start = async (options: TestEnvironmentOptions = {}) => {
  const t = await startTestEnvironment({ adapter: fakeAdapter(), ...options });
  onCleanup(() => t.close());
  const client = await t.client();
  onCleanup(() => client.close());
  return { t, client };
};

const headless = async () => {
  const peer = scriptedCdpPeer();
  onCleanup(() => peer.close());
  const endpoint = await peer.listen();
  const setup = await start({ browser: { resolve: async () => [{ address: "93.184.215.14", family: 4 }] } });
  await setup.client.request("settings.update", { commandId: randomUUID(), values: { "browser.headless.endpoint": endpoint } });
  const { id } = await create(setup.client, { browser: { value: { kind: "headless" }, chosenBy: "person" } });
  return { ...setup, peer, id };
};

const script = (t: TestEnvironment, answers: HostToolResult[], calls: readonly (readonly [string, JsonObject])[]) => {
  (t.adapter as FakeAdapter).nextScripts.push(async function* (controls) {
    for (const [name, input] of calls) answers.push(yield* callHostTool(controls, { server: "browser", name, input }));
    yield end();
  });
};

const run = async (client: WireClient, id: string) => client.apply("runs.start", { commandId: randomUUID(), sessionId: id, text: "Use the browser" });
const ended = async (t: TestEnvironment, id: string) => vi.waitFor(() => expect(events(t, id).some((e) => e.type === "run.ended")).toBe(true), { timeout: WAIT_MS });
const prompt = async (t: TestEnvironment, id: string, count = 1): Promise<PromptOpenedPayload> => {
  await vi.waitFor(() => expect(events(t, id).filter((e) => e.type === "prompt.opened")).toHaveLength(count), { timeout: WAIT_MS });
  return events(t, id).filter((e) => e.type === "prompt.opened").at(-1)!.payload as PromptOpenedPayload;
};
const answer = (client: WireClient, id: string, p: PromptOpenedPayload, decision: "allow" | "deny") =>
  client.request("permissions.prompts.answer", { commandId: randomUUID(), sessionId: id, promptId: p.promptId, decision });
const navigations = (peer: ReturnType<typeof scriptedCdpPeer>) => peer.sentOf("Page.navigate").map((c) => c.params["url"]);

describe("the denylist on a browser call", () => {
  it.each(["permission", "denylist"] as const)("records an earlier allowance when the browser run stops under a later %s prompt", async (kind) => {
    const { t, client, id } = await headless();
    const toolCallId = "stopped-browser-for-tests";
    const name = "mcp__browser__browser_open";
    (t.adapter as FakeAdapter).nextScripts.push(async function* (controls) {
      const input = { address: PAYPAL, snapshot: false };
      yield { type: "tool.started", payload: { toolCallId, name, input, title: null, agentId: null, parentToolCallId: null } };
      const gated = await controls.context.gate.check({ toolCallId, tool: name, summary: "Open the page", access: { kind: "browse", urls: [PAYPAL] }, input });
      if (gated.decision !== "allow") throw new Error("Gate denied");
      if (kind === "permission") {
        await controls.context.broker.request({ sessionId: id, runId: controls.input.runId, kind, detail: { toolName: name, toolCallId, input } });
      } else {
        const redirect = "https://checkout.stripe.com/pay";
        await controls.context.gate.check({ toolCallId, tool: name, summary: "Follow the redirect", access: { kind: "browse", urls: [redirect] }, input: { address: redirect } });
      }
      yield end();
    });
    await run(client, id);
    const first = await prompt(t, id);
    await answer(client, id, first, "allow");
    const later = await prompt(t, id, 2);
    expect(later.kind).toBe(kind);
    expect(events(t, id).filter((e) => e.type === "tool.decision")).toEqual([]);
    await client.apply("providers.processes.stop", { commandId: randomUUID(), sessionId: id });
    await ended(t, id);
    expect((await client.apply("permissions.prompts.list", { sessionId: id })).prompts.map((p) => p.promptId)).toEqual([later.promptId]);
    expect(events(t, id).filter((e) => e.type === "tool.decision").map((e) => e.payload)).toEqual([
      expect.objectContaining({ toolCallId, promptId: first.promptId, decision: "allowed", decidedBy: "person" }),
    ]);
    await answer(client, id, later, "deny");
    expect(events(t, id).filter((e) => e.type === "tool.decision")).toHaveLength(1);
  });

  it("records an allowance answered after the browser run was stopped, beside the next-run answer", async () => {
    const { t, client, id } = await headless();
    const answers: HostToolResult[] = [];
    script(t, answers, [["browser_open", { address: PAYPAL, snapshot: false }]]);
    await run(client, id);
    const parked = await prompt(t, id);
    await client.apply("providers.processes.stop", { commandId: randomUUID(), sessionId: id });
    await ended(t, id);
    expect(events(t, id).filter((e) => e.type === "tool.decision")).toEqual([]);
    await answer(client, id, parked, "allow");
    expect(events(t, id).filter((e) => e.type === "prompt.answered").map((e) => e.payload)).toEqual([
      expect.objectContaining({ promptId: parked.promptId, decision: "allow", delivery: "next-run" }),
    ]);
    expect(events(t, id).filter((e) => e.type === "tool.decision").map((e) => e.payload)).toEqual([
      expect.objectContaining({ toolCallId: parked.toolCallId, promptId: parked.promptId, decision: "allowed", decidedBy: "person" }),
    ]);
  });

  it("carries the person's allow for browser_open to the headless driver once and judges the next navigation afresh", async () => {
    const { t, client, peer, id } = await headless();
    const answers: HostToolResult[] = [];
    script(t, answers, [["browser_open", { address: PAYPAL, snapshot: false }], ["browser_navigate", { address: PAYPAL, snapshot: false }]]);
    await run(client, id);
    const first = await prompt(t, id);
    expect(navigations(peer)).toEqual([]);
    await answer(client, id, first, "allow");
    const second = await prompt(t, id, 2);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ isError: false, text: expect.stringContaining(PAYPAL) });
    expect(navigations(peer)).toEqual([PAYPAL]);
    expect(second.toolCallId).not.toBe(first.toolCallId);
    await answer(client, id, second, "deny");
    await ended(t, id);
    expect(answers[1]?.isError).toBe(true);
    expect(navigations(peer)).toEqual([PAYPAL]);
  });
  it("parks a headless redirect's call at about:blank until the person allows the browser's match", async () => {
    const { t, client, peer, id } = await headless();
    peer.document("https://shop.example/pay", { redirect: PAYPAL });
    const answers: HostToolResult[] = [];
    script(t, answers, [["browser_open", { address: "https://shop.example/pay", snapshot: false }]]);
    await run(client, id);
    const p = await prompt(t, id);
    expect(p).toMatchObject({ kind: "denylist", toolName: "mcp__browser__browser_open", denylist: [expect.objectContaining({ matched: PAYPAL })] });
    expect(answers).toEqual([]);
    expect(navigations(peer).at(-1)).toBe("about:blank");
    await answer(client, id, p, "allow");
    await ended(t, id);
    expect(answers[0]).toMatchObject({ isError: false, text: expect.stringContaining(PAYPAL) });
    expect(navigations(peer).at(-1)).toBe(PAYPAL);
  });

  it.each([false, true])("delivers an allowed redirect Note in the browser result, including when navigation is refused (%s)", async (fails) => {
    const { t, client, peer, id } = await headless();
    peer.document("https://shop.example/pay", { redirect: PAYPAL });
    if (fails) peer.document(PAYPAL, { frames: [{ url: "https://checkout.stripe.com/pay", crossSite: true }] });
    const answers: HostToolResult[] = [];
    script(t, answers, [["browser_open", { address: "https://shop.example/pay", snapshot: false }], ["browser_snapshot", {}]]);
    await run(client, id);
    const p = await prompt(t, id);
    await client.request("permissions.prompts.answer", {
      commandId: randomUUID(), sessionId: id, promptId: p.promptId, decision: "allow",
      message: "REDIRECT_NOTE_2091: summarize only; do not buy anything.",
    });
    await ended(t, id);
    expect(answers).toHaveLength(2);
    expect(answers[0]?.isError).toBe(fails);
    expect(answers[0]?.text).toContain("Note from the person: REDIRECT_NOTE_2091: summarize only; do not buy anything.");
    expect(answers[1]?.text).not.toContain("REDIRECT_NOTE_2091");
    expect(navigations(peer)).toContain(PAYPAL);
  });

  it("refuses a listed sub-frame's whole page immediately, records the call's denylist decision and counts it in Unattended review", async () => {
    const { t, client, peer, id } = await headless();
    peer.document("https://shop.example/pay", { frames: [{ url: PAYPAL, crossSite: true }] });
    const answers: HostToolResult[] = [];
    script(t, answers, [["browser_open", { address: "https://shop.example/pay", snapshot: false }]]);
    await run(client, id);
    await vi.waitFor(() => expect(answers).toHaveLength(1), { timeout: WAIT_MS });
    await ended(t, id);
    expect(answers[0]).toMatchObject({ isError: true, text: expect.stringContaining(`A frame of the page loaded ${PAYPAL}`) });
    expect(answers[0]?.text).toContain("*.paypal.com");
    expect(navigations(peer).at(-1)).toBe("about:blank");
    expect(events(t, id).filter((e) => e.type === "prompt.opened")).toEqual([]);
    expect(events(t, id).filter((e) => e.type === "tool.decision").map((e) => e.payload)).toEqual([
      expect.objectContaining({ decision: "denied", decidedBy: "denylist", tool: "mcp__browser__browser_open", reason: expect.stringContaining(PAYPAL) }),
    ]);
    const review = await client.apply("permissions.review.list", {});
    expect(review.runs).toEqual([expect.objectContaining({ sessionId: id, counts: expect.objectContaining({ denied: 1 }) })]);
  });

  it.each(["person", "ttl", "unattended"] as const)("denies a headless redirect by %s and records the call", async (by) => {
    const { t, client, peer, id } = await headless();
    peer.document("https://shop.example/pay", { redirect: PAYPAL });
    if (by === "ttl") await client.request("permissions.settings.set", { commandId: randomUUID(), values: { "permissions.parkedPrompt.ttl": { amount: 1, unit: "minutes" } } });
    const answers: HostToolResult[] = [];
    script(t, answers, [["browser_open", { address: "https://shop.example/pay", snapshot: false }]]);
    if (by === "unattended") t.env.startRun({ sessionId: id, text: "Use the browser", actor: { kind: "completions", attended: false, ceiling: "bypassPermissions", clientSessionId: null } });
    else await run(client, id);
    const p = await prompt(t, id);
    if (by !== "unattended") {
      expect(answers).toEqual([]);
      if (by === "person") await answer(client, id, p, "deny");
      else t.clock.advance(120_000);
    }
    await ended(t, id);
    expect(answers[0]).toMatchObject({ isError: true, text: expect.stringContaining(`The page went to ${PAYPAL}`) });
    expect(answers[0]?.text).toContain(t.env.id);
    expect(navigations(peer).at(-1)).toBe("about:blank");
    expect(events(t, id).find((e) => e.type === "prompt.answered")?.payload).toMatchObject({ decision: "deny", ...(by === "person" ? {} : { decidedBy: { auto: by } }) });
    expect(events(t, id).filter((e) => e.type === "tool.decision").map((e) => e.payload)).toEqual([expect.objectContaining({ decision: "denied", decidedBy: by === "person" ? "person" : "denylist" })]);
  });

  it("records a later listed sub-frame as denied even when the person allowed the top-level host on the same call", async () => {
    const { t, client, peer, id } = await headless();
    peer.document(PAYPAL, { frames: [{ url: "https://checkout.stripe.com/pay", crossSite: true }] });
    const answers: HostToolResult[] = [];
    script(t, answers, [["browser_open", { address: PAYPAL, snapshot: false }]]);
    await run(client, id);
    await answer(client, id, await prompt(t, id), "allow");
    await ended(t, id);
    expect(answers[0]).toMatchObject({ isError: true, text: expect.stringContaining("A frame of the page loaded https://checkout.stripe.com/pay") });
    expect(events(t, id).filter((e) => e.type === "prompt.opened")).toHaveLength(1);
    expect(events(t, id).filter((e) => e.type === "tool.decision").map((e) => e.payload)).toEqual([expect.objectContaining({ decision: "denied", decidedBy: "denylist" })]);
    expect((await client.apply("permissions.review.list", {})).runs).toEqual([expect.objectContaining({ counts: expect.objectContaining({ denied: 1 }) })]);
  });

  it("keeps the gate's allowance when the provider also asks permission for the same call", async () => {
    const { t, client, peer, id } = await headless();
    const answers: HostToolResult[] = [];
    (t.adapter as FakeAdapter).nextScripts.push(async function* (controls) {
      const server = controls.input.toolServers.find((s) => s.name === "browser");
      if (server === undefined || !isInProcess(server)) throw new Error("No browser server");
      const tool = server.tools.find((candidate) => candidate.name === "browser_open");
      if (tool === undefined) throw new Error("No browser_open");
      const toolCallId = "gate-and-provider-for-tests";
      const name = "mcp__browser__browser_open";
      const input = { address: PAYPAL, snapshot: false };
      yield { type: "tool.started", payload: { toolCallId, name, input, title: null, agentId: null, parentToolCallId: null } };
      const gated = await controls.context.gate.check({ toolCallId, tool: name, summary: "Open the page", access: tool.access?.(input) ?? { kind: "other" }, input }, controls.signal);
      if (gated.decision !== "allow") throw new Error("Gate denied");
      const permitted = await controls.context.broker.request({ sessionId: id, runId: controls.input.runId, kind: "permission", detail: { toolName: name, toolCallId, input }, signal: controls.signal });
      if (permitted.decision !== "allow") throw new Error("Provider denied");
      const result = await tool.call(input, { toolCallId, signal: controls.signal });
      answers.push(result);
      yield { type: "tool.ended", payload: { toolCallId, status: result.isError ? "error" : "ok", output: result.text, durationMs: 1 } };
      yield end();
    });
    await run(client, id);
    await answer(client, id, await prompt(t, id), "allow");
    const provider = await prompt(t, id, 2);
    expect(provider.kind).toBe("permission");
    await answer(client, id, provider, "allow");
    await vi.waitFor(() => expect(navigations(peer)).toEqual([PAYPAL]), { timeout: WAIT_MS });
    await ended(t, id);
    expect(answers[0]?.isError).toBe(false);
    expect(events(t, id).filter((e) => e.type === "prompt.opened")).toHaveLength(2);
    expect(events(t, id).filter((e) => e.type === "tool.decision").map((e) => e.payload)).toEqual([expect.objectContaining({ decision: "allowed", decidedBy: "person" })]);
  });

});
