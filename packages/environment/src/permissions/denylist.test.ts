import { randomUUID } from "node:crypto";
import { mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DATA_DIRECTORY_PRESET_ID,
  DENYLIST_SECTIONS,
  denylistPresets,
  registry,
  type Denylist,
  type DenylistChangedPayload,
  type EventEnvelope,
  type Mode,
  type ParamsOf,
  type PromptAnsweredPayload,
  type PromptOpenedPayload,
  type ResponseOf,
  type Scope,
  type ToolDecisionPayload,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, say, toolCall, type FakeAdapter, type FakeAdapterOptions, type Script, type ScriptControls } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import type { GatedToolCall } from "../adapter/contract.js";
import type { EventEnvelope as LogEvent } from "../event-log/event-log.js";
import type { RunActor } from "./resolver.js";

/**
 * The denylist and the tool gate (#132; permissions spec, "The denylist",
 * "Prompts, parked prompts and the TTL", "Events"; ADR 0006) through the
 * primary seam: an in-process environment whose fake provider plays tool
 * calls under the run context's gate, as #140's Claude hook will. What is
 * asserted is what a client sees (the methods, the session's and the
 * environment's streams, the access log) and what the provider was told.
 */

const { onCleanup, tempDir } = useCleanups();

const MINUTE = 60_000;
const UNATTENDED_DENIAL = "Denied: nobody is present to approve this. Continue without it and say what you could not do.";
const MODES: readonly Mode[] = ["plan", "acceptEdits", "auto", "bypassPermissions"];

const start = async (adapter: FakeAdapterOptions | FakeAdapter = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: "descriptor" in adapter ? adapter : fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

type Command = "runs.start" | "permissions.prompts.answer" | "permissions.denylist.set" | "permissions.denylist.restorePresets" | "permissions.settings.set";

const send = async <N extends Command>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

const getDenylist = async (client: WireClient): Promise<Denylist> =>
  registry["permissions.denylist.get"].result.parse(await client.request("permissions.denylist.get", {})).denylist;

const test = async (client: WireClient, kind: ParamsOf<"permissions.denylist.test">["kind"], value: string) =>
  registry["permissions.denylist.test"].result.parse(await client.request("permissions.denylist.test", { kind, value })).matches;

const startRun = async (client: WireClient, sessionId: string, mode?: Mode) => {
  const answer = await send(client, "runs.start", { sessionId, text: "Tidy the keys", ...(mode !== undefined && { mode }) });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result;
};

const routine = (ceiling: Mode = "bypassPermissions"): RunActor => ({ kind: "routine", name: "nightly-keys", ceiling, clientSessionId: null });

const accessEvents = async (client: WireClient, type: string): Promise<EventEnvelope[]> =>
  (await client.request("access.log.list", { limit: 1000 }) as { events: EventEnvelope[] }).events.filter((event) => event.type === type);

const eventsOf = (t: TestEnvironment, sessionId: string): LogEvent[] => t.env.log.readStream({ kind: "session", id: sessionId });
const payloadsOf = <P>(t: TestEnvironment, sessionId: string, type: string): P[] =>
  eventsOf(t, sessionId)
    .filter((event) => event.type === type)
    .map((event) => event.payload as P);
const opened = (t: TestEnvironment, sessionId: string) => payloadsOf<PromptOpenedPayload>(t, sessionId, "prompt.opened");
const answered = (t: TestEnvironment, sessionId: string) => payloadsOf<PromptAnsweredPayload>(t, sessionId, "prompt.answered");
const decisions = (t: TestEnvironment, sessionId: string) => payloadsOf<ToolDecisionPayload>(t, sessionId, "tool.decision");
const said = (t: TestEnvironment, sessionId: string) => payloadsOf<{ text: string }>(t, sessionId, "assistant.text").map((payload) => payload.text);
const toolEnds = (t: TestEnvironment, sessionId: string) => payloadsOf<{ toolCallId: string; status: string; output: string }>(t, sessionId, "tool.ended");
const notices = (t: TestEnvironment) =>
  t.env.log
    .readStream({ kind: "environment", id: t.env.id })
    .map((event) => event.type)
    .filter((type) => type.startsWith("prompt."));

const untilOpened = async (t: TestEnvironment, sessionId: string, count = 1): Promise<PromptOpenedPayload[]> => {
  await vi.waitFor(() => expect(opened(t, sessionId)).toHaveLength(count));
  return opened(t, sessionId);
};

const untilEnded = async (t: TestEnvironment, sessionId: string, runId: string): Promise<LogEvent> => {
  const find = () => eventsOf(t, sessionId).find((event) => event.type === "run.ended" && event.payload["runId"] === runId);
  await vi.waitFor(() => expect(find()).toBeDefined());
  return find() as LogEvent;
};

const readKey: Omit<GatedToolCall, "toolCallId"> = {
  tool: "Read",
  summary: "Read ~/.ssh/id_rsa",
  access: { kind: "read", paths: ["~/.ssh/id_rsa"] },
  input: { file_path: "~/.ssh/id_rsa" },
};
const sudo: Omit<GatedToolCall, "toolCallId"> = { tool: "Bash", summary: "sudo apt install jq", access: { kind: "shell", command: "sudo apt install jq" }, input: { command: "sudo apt install jq" } };
const harmless: Omit<GatedToolCall, "toolCallId"> = { tool: "Read", summary: "Read README.md", access: { kind: "read", paths: ["README.md"] } };

/** A run that plays each call under the gate in turn, says it carried on, and completes. */
const calls =
  (...played: (Omit<GatedToolCall, "toolCallId"> & { readonly toolCallId?: string })[]): Script =>
  async function* (controls: ScriptControls) {
    for (const call of played) yield* toolCall(controls, call);
    yield say("Carried on");
    yield end();
  };

const answer = (client: WireClient, promptId: string, decision: "allow" | "deny", extra: Partial<ParamsOf<"permissions.prompts.answer">> = {}) =>
  send(client, "permissions.prompts.answer", { promptId, decision, ...extra });

describe("the presets", () => {
  it("are seeded on first start, recorded as denylist.changed on the access stream, and read back by permissions.denylist.get", async () => {
    const t = await start();
    const client = await t.client();
    const held = await getDenylist(client);
    expect(held).toEqual(denylistPresets(t.env.dataDir));
    expect(held.paths.find((entry) => entry.id === DATA_DIRECTORY_PRESET_ID)?.pattern).toBe(t.env.dataDir);
    expect(held.hosts).toEqual([]);
    const seeded = await accessEvents(client, "denylist.changed");
    expect(seeded.map((event) => (event.payload as DenylistChangedPayload).section)).toEqual(["browserDomains", "paths", "commandPatterns"]);
    for (const event of seeded) {
      const payload = event.payload as DenylistChangedPayload;
      expect(event.actor).toEqual({ kind: "system", id: "permissions" });
      expect(payload).toMatchObject({ removed: [], edited: [] });
      expect(payload.added).toEqual(payload.entries);
      expect(payload.entries).toEqual(held[payload.section]);
    }
  });

  it("are seeded once: a restart on the same data directory keeps what a person changed and seeds nothing again", async () => {
    const dataDir = tempDir();
    const first = await start({}, { dataDir });
    const client = await first.client();
    await send(client, "permissions.denylist.set", { sections: { commandPatterns: [] } });
    await first.close();
    const second = await start({}, { dataDir });
    const again = await second.client();
    expect((await getDenylist(again)).commandPatterns).toEqual([]);
    expect(await accessEvents(again, "denylist.changed")).toHaveLength(4);
  });

  it("count in permissions.settings.get, per section", async () => {
    const t = await start();
    const client = await t.client();
    const presets = denylistPresets(t.env.dataDir);
    const counts = registry["permissions.settings.get"].result.parse(await client.request("permissions.settings.get", {})).denylist;
    expect(counts).toEqual({ browserDomains: presets.browserDomains.length, paths: presets.paths.length, commandPatterns: presets.commandPatterns.length, hosts: 0 });
    await send(client, "permissions.denylist.set", { sections: { hosts: [{ pattern: "169.254.169.254" }] } });
    expect(registry["permissions.settings.get"].result.parse(await client.request("permissions.settings.get", {})).denylist.hosts).toBe(1);
  });

  it("survive a rebuild of the projections", async () => {
    const t = await start();
    const client = await t.client();
    await send(client, "permissions.denylist.set", { sections: { hosts: [{ id: "metadata", pattern: "169.254.169.254", note: "Cloud metadata" }] } });
    const before = await getDenylist(client);
    await client.request("environment.rebuildProjections", { commandId: randomUUID() });
    expect(await getDenylist(client)).toEqual(before);
  });
});

describe("permissions.denylist.set", () => {
  it("replaces the sections given, one denylist.changed each with what was added, removed and edited, by the client session", async () => {
    const t = await start();
    const client = await t.client();
    const [ssh, gnupg, ...rest] = (await getDenylist(client)).paths;
    const answerOf = await send(client, "permissions.denylist.set", {
      sections: {
        paths: [{ ...ssh!, enabled: false, note: "Handled by the key manager" }, ...rest, { pattern: "/etc/shadow", note: "" }],
        hosts: [{ id: "metadata", pattern: "169.254.169.254" }],
      },
    });
    const after = answerOf.result?.denylist as Denylist;
    expect(after.paths[0]).toEqual({ ...ssh, enabled: false, note: "Handled by the key manager" });
    expect(after.paths.map((entry) => entry.id)).not.toContain(gnupg?.id);
    const added = after.paths.at(-1);
    expect(added).toMatchObject({ pattern: "/etc/shadow", note: "", preset: false, enabled: true });
    expect(added?.id).toMatch(/\S/);
    expect(after.hosts).toEqual([{ id: "metadata", pattern: "169.254.169.254", note: "", preset: false, enabled: true }]);
    expect(await getDenylist(client)).toEqual(after);

    const changes = (await accessEvents(client, "denylist.changed")).slice(3);
    expect(changes.map((event) => event.actor)).toEqual([expect.objectContaining({ kind: "client_session" }), expect.objectContaining({ kind: "client_session" })]);
    expect(changes.map((event) => event.payload)).toEqual([
      { section: "paths", added: [added], removed: [gnupg], edited: [{ before: ssh, after: after.paths[0] }], entries: after.paths },
      { section: "hosts", added: after.hosts, removed: [], edited: [], entries: after.hosts },
    ]);
  });

  it("changes nothing for a section given as it is, and keeps a preset's id and flag when its entry is sent back", async () => {
    const t = await start();
    const client = await t.client();
    const held = await getDenylist(client);
    const same = await send(client, "permissions.denylist.set", { sections: { commandPatterns: held.commandPatterns } });
    expect(same.receipt).toMatchObject({ status: "accepted", changed: false });
    expect(await accessEvents(client, "denylist.changed")).toHaveLength(3);
    // Every section at once, the presets sent back as a client read them.
    const all = await send(client, "permissions.denylist.set", { sections: held });
    expect(all.receipt).toMatchObject({ changed: false });
    expect(all.result?.denylist).toEqual(held);
  });

  it("refuses a pattern outside its section's grammar, two entries under one id, and a call naming no section: invalid_params, nothing changed", async () => {
    const t = await start();
    const client = await t.client();
    const held = await getDenylist(client);
    for (const sections of [{ paths: [{ pattern: ".ssh" }] }, { hosts: [{ pattern: "https://evil.test" }] }, { browserDomains: [{ pattern: "pay*.com" }] }, { commandPatterns: [{ pattern: " " }] }]) {
      expect(await refusal(client.request("permissions.denylist.set", { commandId: randomUUID(), sections } as never)), JSON.stringify(sections)).toMatchObject({ code: "invalid_params" });
    }
    expect(
      await refusal(client.request("permissions.denylist.set", { commandId: randomUUID(), sections: { hosts: [{ id: "a", pattern: "x.test" }, { id: "a", pattern: "y.test" }] } })),
    ).toMatchObject({ code: "invalid_params" });
    expect(await refusal(client.request("permissions.denylist.set", { commandId: randomUUID(), sections: {} }))).toMatchObject({ code: "invalid_params" });
    expect(await getDenylist(client)).toEqual(held);
  });

  it("needs admin, as restorePresets does; get and test need read", async () => {
    const t = await start();
    const client = await t.client();
    const scopes: Scope[] = ["read", "sessions:write", "runs:drive"];
    const reader = await t.client({ token: (await t.pair({ scopes })).token });
    expect(await refusal(reader.request("permissions.denylist.set", { commandId: randomUUID(), sections: { hosts: [] } }))).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
    expect(await refusal(reader.request("permissions.denylist.restorePresets", { commandId: randomUUID() }))).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
    expect(await getDenylist(reader)).toEqual(await getDenylist(client));
    expect(await test(reader, "path", "~/.ssh/id_rsa")).toHaveLength(1);
  });
});

describe("permissions.denylist.restorePresets", () => {
  it("re-adds the presets that are gone, at the end of their sections, and leaves an edited or disabled preset as it is", async () => {
    const t = await start();
    const client = await t.client();
    const held = await getDenylist(client);
    const [ssh, gnupg, ...rest] = held.paths;
    await send(client, "permissions.denylist.set", { sections: { paths: [{ ...ssh!, enabled: false }, ...rest], commandPatterns: held.commandPatterns.slice(1) } });
    const restored = await send(client, "permissions.denylist.restorePresets", {});
    expect(restored.result?.restored).toEqual([
      { section: "paths", entry: gnupg },
      { section: "commandPatterns", entry: held.commandPatterns[0] },
    ]);
    const after = await getDenylist(client);
    expect(after.paths).toEqual([{ ...ssh, enabled: false }, ...rest, gnupg]);
    expect(after.commandPatterns).toEqual([...held.commandPatterns.slice(1), held.commandPatterns[0]]);
    // Three seeded, two for the set: then the restore's.
    const changes = (await accessEvents(client, "denylist.changed")).slice(5);
    expect(changes.map((event) => event.payload)).toEqual([
      { section: "paths", added: [gnupg], removed: [], edited: [], entries: after.paths },
      { section: "commandPatterns", added: [held.commandPatterns[0]], removed: [], edited: [], entries: after.commandPatterns },
    ]);
    const again = await send(client, "permissions.denylist.restorePresets", {});
    expect(again.receipt).toMatchObject({ changed: false });
    expect(again.result?.restored).toEqual([]);
  });
});

describe("permissions.denylist.test", () => {
  it("answers the entries a kind and a value match, on this environment's home directory and links", async () => {
    const t = await start();
    const client = await t.client();
    expect(await test(client, "path", "~/.ssh/id_rsa")).toEqual([{ section: "paths", entry: expect.objectContaining({ pattern: "~/.ssh" }), matched: "~/.ssh/id_rsa" }]);
    expect(await test(client, "path", join(homedir(), ".aws", "credentials"))).toEqual([expect.objectContaining({ entry: expect.objectContaining({ pattern: "~/.aws" }) })]);
    expect((await test(client, "command", "sudo apt install jq")).map((match) => match.entry.pattern)).toEqual(["sudo *"]);
    expect((await test(client, "browserDomain", "https://user@www.paypal.com/signin")).map((match) => match.entry.pattern)).toEqual(["*.paypal.com"]);
    expect(await test(client, "host", "http://169.254.169.254/")).toEqual([]);
    expect(await test(client, "path", "/work/agent-harness/README.md")).toEqual([]);
    // A link to a denylisted directory, followed on this machine's file system.
    const links = tempDir();
    symlinkSync(join(homedir(), ".ssh"), join(links, "keys"));
    expect((await test(client, "path", join(links, "keys", "id_ed25519"))).map((match) => match.entry.pattern)).toEqual(["~/.ssh"]);
  });

  it("leaves the containment directories inside the data directory out of its preset, but not the rest of it", async () => {
    const t = await start();
    const client = await t.client();
    expect(await test(client, "path", join(t.env.dataDir, "containment", randomUUID(), "tmp", "build.log"))).toEqual([]);
    expect((await test(client, "path", join(t.env.dataDir, "environment.db"))).map((match) => match.entry.id)).toEqual([DATA_DIRECTORY_PRESET_ID]);
  });
});

describe("the tool gate on an attended run", () => {
  it.each(MODES)("parks a denylist prompt naming the section and entry in %s, and an allow lets that one call through", async (mode) => {
    const t = await start({ script: calls(readKey) });
    const client = await t.client();
    const second = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id, mode);
    const [prompt] = await untilOpened(t, id);
    expect(prompt).toMatchObject({
      runId,
      kind: "denylist",
      toolName: "Read",
      input: { file_path: "~/.ssh/id_rsa" },
      mode,
      denylist: [{ section: "paths", entry: expect.objectContaining({ id: "preset:~/.ssh", pattern: "~/.ssh" }), matched: "~/.ssh/id_rsa" }],
    });
    expect(prompt?.summary).toContain("~/.ssh");
    expect(prompt?.reason).toContain("paths");
    expect(prompt?.ttlExpiresAt).not.toBeNull();
    expect(notices(t)).toEqual(["prompt.parked"]);
    // Nothing ran yet: the call waits on the person.
    expect(toolEnds(t, id)).toEqual([]);

    const given = await answer(second, prompt!.promptId, "allow");
    expect(given.result).toMatchObject({ decision: "allow", delivery: "live" });
    await untilEnded(t, id, runId);
    expect(toolEnds(t, id)).toEqual([expect.objectContaining({ status: "ok" })]);
    expect(t.adapter.lastRun().gated.map((ruling) => ruling.decision)).toEqual([{ decision: "allow" }]);
    expect(decisions(t, id)).toEqual([
      expect.objectContaining({ toolCallId: prompt?.toolCallId, decision: "allowed", decidedBy: "person", promptId: prompt?.promptId, reason: null }),
    ]);
    expect(said(t, id)).toContain("Carried on");
    expect(notices(t)).toEqual(["prompt.parked", "prompt.resolved"]);
    // The adapter never raised the prompt, so it is never handed the answer: the gate is.
    expect(t.adapter.lastRun().answers).toEqual([]);
  });

  it("asks again for the next identical call: an allow is for that call only", async () => {
    const t = await start({ script: calls(readKey, readKey) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id, "bypassPermissions");
    const [first] = await untilOpened(t, id);
    await answer(client, first!.promptId, "allow");
    const [, second] = await untilOpened(t, id, 2);
    expect(second).toMatchObject({ kind: "denylist", toolName: "Read" });
    expect(second?.promptId).not.toBe(first?.promptId);
    await answer(client, second!.promptId, "deny");
    await untilEnded(t, id, runId);
    expect(toolEnds(t, id).map((ended) => ended.status)).toEqual(["ok", "error"]);
  });

  it("hands a person's deny to the model with their message, or a sentence naming the entry, and the run continues", async () => {
    const t = await start({ script: calls(readKey, sudo) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id, "bypassPermissions");
    const [first] = await untilOpened(t, id);
    await answer(client, first!.promptId, "deny", { message: "Use the deploy key in the vault instead." });
    const [, second] = await untilOpened(t, id, 2);
    expect(second?.denylist).toEqual([expect.objectContaining({ section: "commandPatterns", entry: expect.objectContaining({ pattern: "sudo *" }), matched: "sudo apt install jq" })]);
    await answer(client, second!.promptId, "deny");
    const ended = await untilEnded(t, id, runId);
    expect(ended.payload).toMatchObject({ reason: "completed" });
    const [readEnd, sudoEnd] = toolEnds(t, id);
    expect(readEnd).toMatchObject({ status: "error", output: "Use the deploy key in the vault instead." });
    expect(sudoEnd?.output).toContain("sudo *");
    expect(decisions(t, id)).toEqual([
      expect.objectContaining({ tool: "Read", decision: "denied", decidedBy: "person", reason: "Use the deploy key in the vault instead." }),
      expect.objectContaining({ tool: "Bash", decision: "denied", decidedBy: "person" }),
    ]);
    expect(said(t, id)).toContain("Carried on");
  });

  it("refuses remember and an edited input on a denylist prompt: an allow is once, for the call as the model gave it", async () => {
    const t = await start({ script: calls(readKey) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    const [prompt] = await untilOpened(t, id);
    const promptId = prompt!.promptId;
    expect(await refusal(client.request("permissions.prompts.answer", { commandId: randomUUID(), promptId, decision: "allow", remember: "session" }))).toMatchObject({
      code: "invalid_params",
    });
    expect(
      await refusal(client.request("permissions.prompts.answer", { commandId: randomUUID(), promptId, decision: "allow", updatedInput: { file_path: "/tmp/other" } })),
    ).toMatchObject({ code: "invalid_params" });
    expect(answered(t, id)).toEqual([]);
    await answer(client, promptId, "allow");
    await untilEnded(t, id, runId);
  });

  it("lets a call that matches nothing on without asking: the mode's to decide", async () => {
    const t = await start({ script: calls(harmless) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id, "bypassPermissions");
    await untilEnded(t, id, runId);
    expect(opened(t, id)).toEqual([]);
    expect(decisions(t, id)).toEqual([expect.objectContaining({ tool: "Read", decision: "allowed", decidedBy: "mode" })]);
  });

  it("denies a parked denylist prompt past its TTL, decided by the denylist, and the run continues", async () => {
    const t = await start({ script: calls(readKey) });
    const client = await t.client();
    await send(client, "permissions.settings.set", { values: { "permissions.parkedPrompt.ttl": { amount: 1, unit: "minutes" } } });
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    const [prompt] = await untilOpened(t, id);
    t.clock.advance(2 * MINUTE);
    await vi.waitFor(() => expect(answered(t, id)).toEqual([expect.objectContaining({ promptId: prompt?.promptId, decision: "deny", decidedBy: { auto: "ttl" } })]));
    const ended = await untilEnded(t, id, runId);
    expect(ended.payload).toMatchObject({ reason: "completed" });
    expect(decisions(t, id)).toEqual([expect.objectContaining({ decision: "denied", decidedBy: "denylist", promptId: prompt?.promptId })]);
    expect(toolEnds(t, id)).toEqual([expect.objectContaining({ status: "error", output: expect.stringMatching(/^Denied: nobody answered/) })]);
  });
});

describe("the tool gate on an unattended run", () => {
  it.each(["acceptEdits", "bypassPermissions"] as const)("denies a match at once in %s, recorded as an opened and answered pair decided by the denylist, and the run continues", async (mode) => {
    const t = await start({ script: calls(readKey, harmless) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = t.env.startRun({ sessionId: id, actor: routine(), text: "Rotate the keys", mode });
    const ended = await untilEnded(t, id, runId);
    expect(ended.payload).toMatchObject({ reason: "completed" });
    const [prompt] = opened(t, id);
    expect(prompt).toMatchObject({ runId, kind: "denylist", ttlExpiresAt: null, denylist: [expect.objectContaining({ section: "paths" })] });
    expect(answered(t, id)).toEqual([expect.objectContaining({ promptId: prompt?.promptId, decision: "deny", decidedBy: { auto: "unattended" }, message: UNATTENDED_DENIAL })]);
    expect(toolEnds(t, id).map((ended) => [ended.status, ended.output])).toEqual([
      ["error", UNATTENDED_DENIAL],
      ["ok", "done"],
    ]);
    expect(decisions(t, id)).toEqual([
      expect.objectContaining({ tool: "Read", decision: "denied", decidedBy: "denylist", promptId: prompt?.promptId, reason: UNATTENDED_DENIAL }),
      expect.objectContaining({ tool: "Read", decision: "allowed", decidedBy: "mode" }),
    ]);
    expect(said(t, id)).toContain("Carried on");
    // Nobody was asked, so nobody was told.
    expect(notices(t)).toEqual([]);
  });

  it("matches every section: a shell line and its paths and hosts, a fetch, a search, a browser verb, and what a tool server receives", async () => {
    const t = await start();
    const client = await t.client();
    await send(client, "permissions.denylist.set", { sections: { hosts: [{ id: "metadata", pattern: "169.254.169.254" }, { id: "internal", pattern: "*.internal.example" }] } });
    const cases: [Omit<GatedToolCall, "toolCallId">, string, string][] = [
      [sudo, "commandPatterns", "sudo *"],
      [{ tool: "Bash", summary: "cat", access: { kind: "shell", command: "cat ~/.aws/credentials" } }, "paths", "~/.aws"],
      [{ tool: "Bash", summary: "curl", access: { kind: "shell", command: "curl -s http://169.254.169.254/latest/meta-data/" } }, "hosts", "169.254.169.254"],
      [{ tool: "Write", summary: "Write", access: { kind: "write", paths: ["~/.kube/config"] } }, "paths", "~/.kube"],
      [{ tool: "WebFetch", summary: "Fetch", access: { kind: "fetch", urls: ["http://0xA9FEA9FE/latest"] } }, "hosts", "169.254.169.254"],
      [{ tool: "WebSearch", summary: "Search", access: { kind: "search", query: "status", domains: ["api.internal.example"] } }, "hosts", "*.internal.example"],
      [{ tool: "browser_open", summary: "Open", access: { kind: "browse", urls: ["https://github.com@www.paypal.com/"] } }, "browserDomains", "*.paypal.com"],
      [{ tool: "mcp__memory__read", summary: "Memory", access: { kind: "other" }, input: { path: "~/.gnupg/pubring.kbx", depth: 2 } }, "paths", "~/.gnupg"],
    ];
    for (const [call, section, pattern] of cases) {
      const { id } = await create(client);
      t.adapter.nextScripts.push(calls(call));
      const { runId } = t.env.startRun({ sessionId: id, actor: routine(), text: "Go", mode: "bypassPermissions" });
      await untilEnded(t, id, runId);
      expect(opened(t, id).map((prompt) => prompt.denylist?.[0]).map((match) => [match?.section, match?.entry.pattern]), call.tool).toEqual([[section, pattern]]);
      expect(decisions(t, id), call.tool).toEqual([expect.objectContaining({ decision: "denied", decidedBy: "denylist" })]);
    }
  });

  it("follows an edit to the next call: a disabled entry never matches, and a new one does", async () => {
    const t = await start();
    const client = await t.client();
    const held = await getDenylist(client);
    await send(client, "permissions.denylist.set", {
      sections: { paths: held.paths.map((entry) => (entry.pattern === "~/.ssh" ? { ...entry, enabled: false } : entry)), hosts: [{ pattern: "api.internal.example" }] },
    });
    const { id } = await create(client);
    t.adapter.nextScripts.push(calls(readKey, { tool: "WebFetch", summary: "Fetch", access: { kind: "fetch", urls: ["https://api.internal.example/v1"] } }));
    const { runId } = t.env.startRun({ sessionId: id, actor: routine(), text: "Go" });
    await untilEnded(t, id, runId);
    expect(decisions(t, id).map((decision) => [decision.tool, decision.decision, decision.decidedBy])).toEqual([
      ["Read", "allowed", "mode"],
      ["WebFetch", "denied", "denylist"],
    ]);
  });

  it("leaves a write in the session's containment directories to the mode, and asks about the rest of the data directory", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const inside = join(t.env.dataDir, "containment", id, "tmp", "build.log");
    mkdirSync(join(t.env.dataDir, "containment", id, "tmp"), { recursive: true });
    t.adapter.nextScripts.push(
      calls(
        { tool: "Write", summary: "Write build.log", access: { kind: "write", paths: [inside] } },
        { tool: "Write", summary: "Write the log", access: { kind: "write", paths: [join(t.env.dataDir, "environment.db")] } },
      ),
    );
    const { runId } = t.env.startRun({ sessionId: id, actor: routine(), text: "Go" });
    await untilEnded(t, id, runId);
    expect(decisions(t, id).map((decision) => [decision.summary.includes("build.log"), decision.decision, decision.decidedBy])).toEqual([
      [true, "allowed", "mode"],
      [false, "denied", "denylist"],
    ]);
    expect(opened(t, id)[0]?.denylist?.[0]?.entry.id).toBe(DATA_DIRECTORY_PRESET_ID);
  });
});

describe("the denylist's sections", () => {
  it("are the four the spec names, each held by the environment", async () => {
    const t = await start();
    const client = await t.client();
    expect(Object.keys(await getDenylist(client))).toEqual([...DENYLIST_SECTIONS]);
  });
});

describe("a restart", () => {
  it("keeps a parked denylist prompt, and a person's later allow reaches the session's next run as its first message", async () => {
    const dataDir = tempDir();
    const first = await start({ script: calls(readKey) }, { dataDir });
    const client = await first.client();
    const { id } = await create(client);
    await startRun(client, id);
    const [prompt] = await untilOpened(first, id);
    await first.close();
    const second = await start({}, { dataDir });
    const again = await second.client();
    const listed = registry["permissions.prompts.list"].result.parse(await again.request("permissions.prompts.list", { sessionId: id })).prompts;
    expect(listed.map((parked) => [parked.promptId, parked.prompt.kind])).toEqual([[prompt?.promptId, "denylist"]]);
    const given = await answer(again, prompt!.promptId, "allow");
    expect(given.result).toMatchObject({ delivery: "next-run" });
    expect(decisions(second, id)).toEqual([expect.objectContaining({ decision: "allowed", decidedBy: "person" })]);
    const { runId } = await startRun(again, id);
    await untilEnded(second, id, runId);
    expect(second.adapter.lastRun().input.prompt[0]?.text).toContain("~/.ssh");
  });
});
