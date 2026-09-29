import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { registry, type Mode, type ParamsOf, type PromptOpenedPayload, type ResponseOf, type ToolDecisionPayload } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { bubblewrapProbe } from "../../test/containment.js";
import { callHostTool, end, fakeAdapter, say, type FakeAdapter, type HostToolCallScript, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import type { EventEnvelope as LogEvent } from "../event-log/event-log.js";
import type { InProcessToolServer } from "./contract.js";

/**
 * The harness's own tools as the tool gate and the model see them (#540;
 * browser spec, "The tools"; permissions spec, "The gate") through the
 * primary seam: an in-process environment whose tool-server factory hands
 * every run a test server, and whose fake provider calls its tools as a
 * provider calls an in-process server's, under the gate. Each tool declares
 * what a call reaches, or nothing: `open` a browser verb's address
 * (`browse`), `read` a fetch reader's URL (`fetch`), `note` nothing, and
 * `shot` answers images. What is asserted is what a client sees in the log
 * (prompts, their answers, tool decisions, tool results) and what the
 * provider was told.
 */

const { onCleanup, tempDir } = useCleanups();

const UNATTENDED_DENIAL = "Denied: nobody is present to approve this. Continue without it and say what you could not do.";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);

const addressOf = (value: unknown): string[] => (typeof value === "string" ? [value] : []);

/** The test server, built afresh for each run as the factory builds one. */
const testServer = (): InProcessToolServer => ({
  name: "test",
  external: false,
  tools: [
    {
      name: "open",
      description: "Opens an address in a browser.",
      inputSchema: { type: "object", properties: { address: { type: "string" } } },
      access: (input) => ({ kind: "browse", urls: addressOf(input["address"]) }),
      call: async (input) => ({ text: `Opened ${String(input["address"])}`, isError: false }),
    },
    {
      name: "read",
      description: "Reads a URL without a browser.",
      inputSchema: { type: "object", properties: { url: { type: "string" } } },
      access: (input) => ({ kind: "fetch", urls: addressOf(input["url"]) }),
      call: async (input) => ({ text: `Read ${String(input["url"])}`, isError: false }),
    },
    {
      name: "note",
      description: "Keeps a note.",
      inputSchema: { type: "object", properties: { address: { type: "string" } } },
      call: async () => ({ text: "Noted", isError: false }),
    },
    {
      name: "shot",
      description: "A screenshot, and a second view.",
      inputSchema: { type: "object", properties: {} },
      call: async () => ({
        text: "Two views of https://example.com/",
        isError: false,
        images: [
          { mediaType: "image/jpeg", data: JPEG },
          { mediaType: "image/png", data: PNG },
        ],
      }),
    },
  ],
});

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ adapter: fakeAdapter(), adapterSeams: { toolServers: () => [testServer()] }, ...options });
  onCleanup(() => t.close());
  return t;
};

const open = (address: string): HostToolCallScript => ({ server: "test", name: "open", input: { address } });
const read = (url: string): HostToolCallScript => ({ server: "test", name: "read", input: { url } });
const note = (address: string): HostToolCallScript => ({ server: "test", name: "note", input: { address } });

/** A run that calls each tool in turn, says what each answered (and the images it carried), and completes. */
const calling =
  (...calls: HostToolCallScript[]): Script =>
  async function* (controls) {
    for (const call of calls) {
      const result = yield* callHostTool(controls, call);
      const images = (result.images ?? []).map((image) => `${image.mediaType} of ${image.data.byteLength} bytes`);
      yield say(`${call.name}: ${result.isError ? "error " : ""}${result.text}${images.length > 0 ? ` with ${images.join(", ")}` : ""}`);
    }
    yield end();
  };

type Command = "runs.start" | "permissions.prompts.answer" | "permissions.denylist.set" | "permissions.containment.set";

const send = async <N extends Command>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

/** Runs `script` in the session as a client starts a run: attended. */
const startAttended = async (t: TestEnvironment, client: WireClient, sessionId: string, script: Script, mode?: Mode): Promise<string> => {
  (t.adapter as FakeAdapter).nextScripts.push(script);
  const answer = await send(client, "runs.start", { sessionId, text: "Go", ...(mode !== undefined && { mode }) });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.runId;
};

/** Runs `script` in the session as a routine starts a run: unattended. */
const startUnattended = (t: TestEnvironment, sessionId: string, script: Script): string => {
  (t.adapter as FakeAdapter).nextScripts.push(script);
  return t.env.startRun({
    sessionId,
    text: "Go",
    actor: { kind: "routine", name: "nightly-read", ceiling: "bypassPermissions", clientSessionId: null },
    actorId: "routine-nightly-read",
  }).runId;
};

const eventsOf = (t: TestEnvironment, sessionId: string): LogEvent[] => t.env.log.readStream({ kind: "session", id: sessionId });
const payloadsOf = <P>(t: TestEnvironment, sessionId: string, type: string): P[] =>
  eventsOf(t, sessionId)
    .filter((event) => event.type === type)
    .map((event) => event.payload as P);
const opened = (t: TestEnvironment, sessionId: string) => payloadsOf<PromptOpenedPayload>(t, sessionId, "prompt.opened");
const decisions = (t: TestEnvironment, sessionId: string) => payloadsOf<ToolDecisionPayload>(t, sessionId, "tool.decision");
const toolEnds = (t: TestEnvironment, sessionId: string) => payloadsOf<{ toolCallId: string; status: string; output: unknown }>(t, sessionId, "tool.ended");
const said = (t: TestEnvironment, sessionId: string) => payloadsOf<{ text: string }>(t, sessionId, "assistant.text").map((payload) => payload.text);

/** Resolves once the run has ended, within the frame wait a loaded runner needs. */
const untilEnded = (t: TestEnvironment, sessionId: string, runId: string) =>
  vi.waitFor(() => expect(eventsOf(t, sessionId).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true), { timeout: WAIT_MS });

/** Adds the cloud metadata address to the denylist's hosts section, which has no presets. */
const denyMetadata = (client: WireClient) => send(client, "permissions.denylist.set", { sections: { hosts: [{ id: "metadata", pattern: "169.254.169.254" }] } });

describe("what an in-process tool's call reaches", () => {
  it("is what the tool declares from the call's input, with the summary naming the address, and other for a tool that declares nothing", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const runId = await startAttended(t, client, id, calling(open("https://example.com/"), read("https://example.org/a"), note("https://example.net/")));
    await untilEnded(t, id, runId);
    expect((t.adapter as FakeAdapter).lastRun().gated.map(({ call, decision }) => [call.tool, call.access, call.summary, decision.decision])).toEqual([
      ["mcp__test__open", { kind: "browse", urls: ["https://example.com/"] }, "mcp__test__open https://example.com/", "allow"],
      ["mcp__test__read", { kind: "fetch", urls: ["https://example.org/a"] }, "mcp__test__read https://example.org/a", "allow"],
      ["mcp__test__note", { kind: "other" }, "mcp__test__note", "allow"],
    ]);
    expect(said(t, id)).toEqual(["open: Opened https://example.com/", "read: Read https://example.org/a", "note: Noted"]);
  });
});

describe("a declared fetch", () => {
  it("to a host on the denylist's hosts section opens a denylist prompt on an attended run, whose person decides", async () => {
    const t = await start();
    const client = await t.client();
    await denyMetadata(client);
    const { id } = await create(client);
    const runId = await startAttended(t, client, id, calling(read("http://169.254.169.254/latest/meta-data/")));
    await vi.waitFor(() => expect(opened(t, id)).toHaveLength(1), { timeout: WAIT_MS });
    const [prompt] = opened(t, id);
    expect(prompt).toMatchObject({ runId, kind: "denylist", toolName: "mcp__test__read", denylist: [expect.objectContaining({ section: "hosts" })] });
    expect(prompt?.denylist?.[0]?.entry.pattern).toBe("169.254.169.254");
    await send(client, "permissions.prompts.answer", { promptId: prompt?.promptId as string, decision: "deny", message: "Not the metadata service." });
    await untilEnded(t, id, runId);
    expect(toolEnds(t, id).map((ended) => [ended.status, ended.output])).toEqual([["error", "Not the metadata service."]]);
    expect(decisions(t, id)).toEqual([expect.objectContaining({ tool: "mcp__test__read", decision: "denied", decidedBy: "person", promptId: prompt?.promptId })]);
  });

  it("to a host on the denylist's hosts section is denied at once on an unattended run, and the tool never runs", async () => {
    const t = await start();
    const client = await t.client();
    await denyMetadata(client);
    const { id } = await create(client);
    const runId = startUnattended(t, id, calling(read("http://169.254.169.254/latest/meta-data/")));
    await untilEnded(t, id, runId);
    expect(opened(t, id)).toEqual([expect.objectContaining({ kind: "denylist", denylist: [expect.objectContaining({ section: "hosts" })] })]);
    expect(toolEnds(t, id).map((ended) => [ended.status, ended.output])).toEqual([["error", UNATTENDED_DENIAL]]);
    expect(decisions(t, id)).toEqual([expect.objectContaining({ tool: "mcp__test__read", decision: "denied", decidedBy: "denylist" })]);
    expect(said(t, id)).toEqual([`read: error ${UNATTENDED_DENIAL}`]);
  });
});

describe("containment at workspace-no-network", () => {
  it("denies a declared fetch with no prompt, recorded by containment with the address in its summary, and leaves a declared browse and an undeclared call to the rest of the gate", async () => {
    const t = await start({ containment: bubblewrapProbe() });
    const client = await t.client();
    const { id } = await create(client, { workspace: { kind: "directory", path: realpathSync(tempDir("agent-harness-workspace-")) } });
    expect((await send(client, "permissions.containment.set", { sessionId: id, level: "workspace-no-network" })).receipt).toMatchObject({ status: "accepted" });
    const runId = await startAttended(t, client, id, calling(read("https://example.org/a"), open("https://example.org/a"), note("https://example.org/a")));
    await untilEnded(t, id, runId);
    const gated = (t.adapter as FakeAdapter).lastRun().gated;
    expect(gated.map(({ call, decision }) => [call.tool, decision.decision])).toEqual([
      ["mcp__test__read", "deny"],
      ["mcp__test__open", "allow"],
      ["mcp__test__note", "allow"],
    ]);
    const denial = gated[0]?.decision.decision === "deny" ? gated[0].decision.message : "";
    expect(denial).toMatch(/containment/);
    expect(denial).toContain("https://example.org/a");
    expect(opened(t, id)).toEqual([]);
    expect(decisions(t, id).filter((decision) => decision.tool === "mcp__test__read")).toEqual([
      {
        runId,
        toolCallId: gated[0]?.call.toolCallId,
        tool: "mcp__test__read",
        summary: "mcp__test__read https://example.org/a",
        decision: "denied",
        decidedBy: "containment",
        promptId: null,
        reason: denial,
      },
    ]);
    expect(said(t, id)).toEqual([`read: error ${denial}`, "open: Opened https://example.org/a", "note: Noted"]);
  });
});

describe("a declared browse", () => {
  it("is matched against the browser domains and the hosts, where the same address in a call that declares nothing meets only the hosts", async () => {
    const t = await start();
    const client = await t.client();
    await denyMetadata(client);
    const { id } = await create(client);
    const runId = startUnattended(t, id, calling(open("https://www.paypal.com/signin"), open("http://169.254.169.254/latest"), note("https://www.paypal.com/signin")));
    await untilEnded(t, id, runId);
    expect(opened(t, id).map((prompt) => [prompt.toolName, prompt.denylist?.map((match) => [match.section, match.entry.pattern])])).toEqual([
      ["mcp__test__open", [["browserDomains", "*.paypal.com"]]],
      ["mcp__test__open", [["hosts", "169.254.169.254"]]],
    ]);
    expect(toolEnds(t, id).map((ended) => ended.status)).toEqual(["error", "error", "ok"]);
  });
});

describe("an in-process tool's images", () => {
  it("reach the run beside the text, and the transcript records each as its media type and size, never its bytes; a text-only result is unchanged", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const runId = await startAttended(t, client, id, calling({ server: "test", name: "shot" }, note("https://example.com/")));
    await untilEnded(t, id, runId);
    expect(said(t, id)).toEqual(["shot: Two views of https://example.com/ with image/jpeg of 3 bytes, image/png of 5 bytes", "note: Noted"]);
    expect(toolEnds(t, id).map((ended) => ended.output)).toEqual([
      [
        { type: "text", text: "Two views of https://example.com/" },
        { type: "image", mediaType: "image/jpeg", size: 3 },
        { type: "image", mediaType: "image/png", size: 5 },
      ],
      "Noted",
    ]);
    // The bytes went to the run, never to the log.
    expect(JSON.stringify(eventsOf(t, id))).not.toContain(Buffer.from(JPEG).toString("base64"));
  });
});
