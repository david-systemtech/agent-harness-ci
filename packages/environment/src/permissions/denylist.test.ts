import { randomUUID } from "node:crypto";
import { mkdirSync, symlinkSync } from "node:fs";
import { relative } from "node:path";
import { homedir, userInfo } from "node:os";
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
import type { GatedToolCall, ToolGate } from "../adapter/contract.js";
import { CANCELLED_MESSAGE, RUN_ENDED_MESSAGE, UNRECORDED_MESSAGE } from "./broker.js";
import { denylistCall, denylistReadsCall, denylistRule } from "./denylist-gate.js";
import { GATE_FAILED_MESSAGE, resolvePath } from "./gate.js";
import type { RuledRun, ToolGateRule } from "../adapter/seams.js";
import type { EventEnvelope as LogEvent } from "../event-log/event-log.js";
import type { ActorRunRequest } from "../serve/start.js";

/**
 * The denylist and the tool gate (#132; permissions spec, "The denylist",
 * "Prompts, parked prompts and the TTL", "Events"; ADR 0006) through the
 * primary seam: an in-process environment whose fake provider plays tool
 * calls under the run context's gate, as Claude's PreToolUse hook does
 * (#140). What is asserted is what a client sees (the methods, the
 * session's and the environment's streams, the access log) and what the
 * provider was told.
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

type Command = "runs.interrupt" | "runs.start" | "permissions.prompts.answer" | "permissions.denylist.set" | "permissions.denylist.restorePresets" | "permissions.settings.set";

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

/** A run a routine starts, through the environment's own start: unattended. */
const startAsRoutine = (t: TestEnvironment, sessionId: string, mode?: Mode) => {
  const request: ActorRunRequest = {
    sessionId,
    text: "Rotate the keys",
    actor: { kind: "routine", name: "nightly-keys", ceiling: "bypassPermissions", clientSessionId: null },
    actorId: "routine-nightly-keys",
    ...(mode !== undefined && { mode }),
  };
  return t.env.startRun(request);
};

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

  it("gives a section the entries in the order given, each read by its id in that section: one held is edited to the fields given, a preset's is the preset put back, any other is new under it", async () => {
    const t = await start();
    const client = await t.client();
    const held = await getDenylist(client);
    const [sudoPreset, ...otherCommands] = held.commandPatterns;
    const set = async (sections: ParamsOf<"permissions.denylist.set">["sections"]): Promise<Denylist> =>
      (await send(client, "permissions.denylist.set", { sections })).result?.denylist as Denylist;
    const lastChange = async () => (await accessEvents(client, "denylist.changed")).at(-1)?.payload as DenylistChangedPayload;

    // The section holds a and b; the call sends c under a's id, d under b's and e with none: c, d, e, in that order.
    const [a, b] = (await set({ hosts: [{ id: "a", pattern: "a.example", note: "A" }, { id: "b", pattern: "b.example", enabled: false }] })).hosts;
    const hosts = (await set({ hosts: [{ id: "a", pattern: "c.example" }, { id: "b", pattern: "d.example", enabled: false }, { pattern: "e.example" }] })).hosts;
    expect(hosts.map((entry) => [entry.id, entry.pattern])).toEqual([
      ["a", "c.example"],
      ["b", "d.example"],
      [expect.stringMatching(/\S/), "e.example"],
    ]);
    // A field left out takes its default, as for a new entry: a's note is gone.
    expect(hosts[0]).toEqual({ id: "a", pattern: "c.example", note: "", preset: false, enabled: true });
    expect(await lastChange()).toEqual({ section: "hosts", added: [hosts[2]], removed: [], edited: [{ before: a, after: hosts[0] }, { before: b, after: hosts[1] }], entries: hosts });

    // The same entries in another order: that order, recorded with nothing added, removed or edited.
    const reordered = (await set({ hosts: [hosts[2]!, hosts[0]!, hosts[1]!] })).hosts;
    expect(reordered).toEqual([hosts[2], hosts[0], hosts[1]]);
    expect(await lastChange()).toEqual({ section: "hosts", added: [], removed: [], edited: [], entries: reordered });

    // A preset removed, then sent back under its id with preset false: the preset again, flag and all.
    await set({ commandPatterns: otherCommands });
    const unflagged = { ...sudoPreset!, preset: false };
    expect((await set({ commandPatterns: [unflagged, ...otherCommands] })).commandPatterns).toEqual(held.commandPatterns);
    expect(await lastChange()).toEqual({ section: "commandPatterns", added: [sudoPreset], removed: [], edited: [], entries: held.commandPatterns });

    // Ids are the section's own: another section's preset id, or another section's entry's, is a new entry here.
    const paths = (await set({ paths: [...held.paths, { id: sudoPreset!.id, pattern: "/etc/sudoers" }, { id: "a", pattern: "/etc/shadow" }] })).paths;
    expect(paths.slice(-2)).toEqual([
      { id: sudoPreset!.id, pattern: "/etc/sudoers", note: "", preset: false, enabled: true },
      { id: "a", pattern: "/etc/shadow", note: "", preset: false, enabled: true },
    ]);
    expect(await getDenylist(client)).toMatchObject({ hosts: reordered, commandPatterns: held.commandPatterns });
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

  it.each(MODES)("asks again for the next identical call in %s: an allow is for that call only", async (mode) => {
    const t = await start({ script: calls(readKey, readKey) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id, mode);
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
  it.each(MODES)("denies a match at once in %s, recorded as an opened and answered pair decided by the denylist, and the run continues", async (mode) => {
    const t = await start({ script: calls(readKey, harmless) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = startAsRoutine(t, id, mode);
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
      const { runId } = startAsRoutine(t, id, "bypassPermissions");
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
    const { runId } = startAsRoutine(t, id);
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
    const { runId } = startAsRoutine(t, id);
    await untilEnded(t, id, runId);
    expect(decisions(t, id).map((decision) => [decision.summary.includes("build.log"), decision.decision, decision.decidedBy])).toEqual([
      [true, "allowed", "mode"],
      [false, "denied", "denylist"],
    ]);
    expect(opened(t, id)[0]?.denylist?.[0]?.entry.id).toBe(DATA_DIRECTORY_PRESET_ID);
  });
});

describe("the denylist a provider projects onto its own rules (#140)", () => {
  it("is handed to an unattended run: the enabled paths with ~ expanded, the directories the denylist leaves out, and the enabled command patterns", async () => {
    const t = await start();
    const client = await t.client();
    const held = await getDenylist(client);
    await send(client, "permissions.denylist.set", {
      sections: {
        paths: held.paths.map((entry) => (entry.pattern === "~/.aws" ? { ...entry, enabled: false } : entry)),
        commandPatterns: [...held.commandPatterns.map((entry) => (entry.pattern === "reboot *" ? { ...entry, enabled: false } : entry)), { pattern: "terraform destroy *" }],
      },
    });
    const { id } = await create(client);
    const { runId } = startAsRoutine(t, id);
    await untilEnded(t, id, runId);
    const projected = t.adapter.runs.at(-1)?.input.denylist;
    const home = homedir();
    expect(projected?.paths).toContain(join(home, ".ssh"));
    expect(projected?.paths).toContain(join(home, ".docker", "config.json"));
    expect(projected?.paths).toContain(t.env.dataDir);
    expect(projected?.paths).not.toContain(join(home, ".aws"));
    expect(projected?.paths.every((path) => path.startsWith("/"))).toBe(true);
    expect(projected?.exempt).toEqual([join(t.env.dataDir, "containment"), join(t.env.dataDir, "scratch"), join(t.env.dataDir, "worktrees"), join(t.env.dataDir, "key-manager-cli")]);
    expect(projected?.commandPatterns).toContain("sudo *");
    expect(projected?.commandPatterns).toContain("terraform destroy *");
    expect(projected?.commandPatterns).not.toContain("reboot *");
  });

  it("is not handed to an attended run, whose person's explicit allow no provider rule may block", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id, "bypassPermissions");
    await untilEnded(t, id, runId);
    expect(t.adapter.runs.at(-1)?.input.denylist).toBeNull();
  });
});

describe("a client tool's call (mcp__client__*, #139)", () => {
  const clientRead: Omit<GatedToolCall, "toolCallId"> = {
    tool: "mcp__client__read_file",
    summary: "read_file ~/.ssh/id_rsa",
    access: { kind: "other" },
    input: { path: "~/.ssh/id_rsa" },
  };

  it("is read by the denylist like any other call, by default: its arguments are matched, though the tool runs on the caller's machine", async () => {
    const t = await start({ script: calls(clientRead) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = startAsRoutine(t, id);
    await untilEnded(t, id, runId);
    expect(opened(t, id).map((prompt) => [prompt.toolName, prompt.denylist?.[0]?.entry.pattern])).toEqual([["mcp__client__read_file", "~/.ssh"]]);
    expect(decisions(t, id)).toEqual([expect.objectContaining({ tool: "mcp__client__read_file", decision: "denied", decidedBy: "denylist" })]);
  });

  it("is passed over by the rule when the one seam that says which calls the denylist reads leaves it out", async () => {
    const rule = denylistRule({
      denylist: () => denylistPresets("/data/agent-harness"),
      home: "/home/test",
      exempt: [],
      resolve: (path) => path,
      readsCall: (call) => !call.tool.startsWith("mcp__client__"),
    });
    const run: RuledRun = {
      runId: "run",
      sessionId: "session",
      workspace: "/work/repo",
      containment: { level: "off", mechanism: null, scratchDirectory: "/s", temporaryDirectory: "/t", writable: ["/work/repo"], network: true },
      ask: () => {
        throw new Error("Nobody is asked about a call the denylist does not read.");
      },
    };
    expect(await rule.check({ ...clientRead, toolCallId: "call_1" }, run)).toBeNull();
    await expect(rule.check({ ...readKey, toolCallId: "call_2" }, run)).rejects.toThrow(/Nobody is asked/);
    expect(denylistReadsCall({ ...clientRead, toolCallId: "call_3" })).toBe(true);
  });
});

describe("the workspace roots", () => {
  it("are left out of the data directory's preset, as the containment directories are: scratch, worktrees and a root a later workstream declares", async () => {
    const dataDir = join(tempDir("agent-harness-env-"), "data");
    const banks = join(dataDir, "banks");
    const t = await start({}, { dataDir, workspaces: { roots: [banks] } });
    const client = await t.client();
    for (const root of [join(dataDir, "scratch"), join(dataDir, "worktrees"), banks]) expect(await test(client, "path", join(root, randomUUID(), "notes.md")), root).toEqual([]);
    expect(await test(client, "path", join(dataDir, "elsewhere", "notes.md"))).toEqual([expect.objectContaining({ entry: expect.objectContaining({ pattern: dataDir }) })]);
  });

  it("let a run work in its own scratch workspace, as a completions run does", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client, { workspace: { kind: "scratch" } });
    const inside = join(t.env.dataDir, "scratch", id, "notes.md");
    t.adapter.nextScripts.push(calls({ tool: "Write", summary: "Write notes.md", access: { kind: "write", paths: [inside] } }));
    const { runId } = startAsRoutine(t, id);
    await untilEnded(t, id, runId);
    expect(decisions(t, id).map((decision) => [decision.decision, decision.decidedBy])).toEqual([["allowed", "mode"]]);
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

describe("disguised addresses and long lines", () => {
  it("match an address the platform's URL parser reads as a denylisted host: a tab, full-width letters and dots, a soft hyphen", async () => {
    const t = await start();
    const client = await t.client();
    await send(client, "permissions.denylist.set", { sections: { hosts: [{ id: "metadata", pattern: "169.254.169.254" }] } });
    for (const value of ["http://169.254.169\t.254/", "http://169\uff0e254\uff0e169\uff0e254/", "169\u3002254\u3002169\u3002254"]) {
      expect((await test(client, "host", value)).map((match) => match.entry.id), JSON.stringify(value)).toEqual(["metadata"]);
    }
    for (const value of ["https://www.\uff30\uff41\uff59\uff50\uff41\uff4c.com/", "https://www.pay\u00adpal.com/"]) {
      expect((await test(client, "browserDomain", value)).map((match) => match.entry.pattern), JSON.stringify(value)).toEqual(["*.paypal.com"]);
    }
  });

  it("name the section and the entry in one short line, never the whole command", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const heredoc = `sudo tee /etc/motd <<'EOF'\n${"line of the message ".repeat(2_000)}\nEOF`;
    t.adapter.nextScripts.push(calls({ tool: "Bash", summary: "tee", access: { kind: "shell", command: heredoc } }));
    const { runId } = startAsRoutine(t, id);
    await untilEnded(t, id, runId);
    const [prompt] = opened(t, id);
    expect(prompt?.reason).toMatch(/is on the denylist \(command patterns: sudo \*\)$/);
    expect(prompt?.reason?.length).toBeLessThan(120);
    expect(prompt?.summary.length).toBeLessThan(140);
    expect(prompt?.denylist?.[0]?.matched).toBe(heredoc);
  });
});

describe("the data directory", () => {
  it("is absolute however it was given: a relative one seeds the preset and the exemption as absolute paths", async () => {
    const absolute = tempDir();
    const t = await start({}, { dataDir: relative(process.cwd(), absolute) });
    const client = await t.client();
    expect(t.env.dataDir).toBe(absolute);
    const held = await getDenylist(client);
    expect(held.paths.find((entry) => entry.id === DATA_DIRECTORY_PRESET_ID)?.pattern).toBe(absolute);
    // The stored preset is in the grammar: sent back, it is taken.
    expect((await send(client, "permissions.denylist.set", { sections: { paths: held.paths } })).receipt).toMatchObject({ status: "accepted" });
    expect(await test(client, "path", join(absolute, "containment", randomUUID(), "tmp", "x"))).toEqual([]);
  });

  it("keeps a section's grammar in the log: a denylist.changed with an entry outside it fails its append", async () => {
    const t = await start();
    const bad = { id: "x", pattern: ".ssh", note: "", preset: false, enabled: true };
    expect(() =>
      t.env.log.append({ kind: "access", id: t.env.id }, [{ type: "denylist.changed", payload: { section: "paths", added: [bad], removed: [], edited: [], entries: [bad] } }], {
        actor: "system:test",
      }),
    ).toThrow();
  });
});

describe("links the gate cannot follow", () => {
  it("resolve to nothing: a loop, and a link that goes away between being seen and being read", () => {
    const links = tempDir();
    symlinkSync(join(links, "b"), join(links, "a"));
    symlinkSync(join(links, "a"), join(links, "b"));
    expect(resolvePath(join(links, "a", "x"), "/")).toBeNull();
    const vanishing = { isLink: () => true, readlink: () => { throw new Error("ENOENT"); } };
    expect(resolvePath("/tmp/gone/x", "/", vanishing)).toBeNull();
    expect(resolvePath("/tmp/not-a-link/x", "/", { isLink: () => false, readlink: () => "" })).toBe("/tmp/not-a-link/x");
  });

  it("deny the call outright, asking nobody, recorded as the denylist's", async () => {
    const t = await start();
    const client = await t.client();
    const links = tempDir();
    symlinkSync(join(links, "b"), join(links, "a"));
    symlinkSync(join(links, "a"), join(links, "b"));
    const { id } = await create(client);
    t.adapter.nextScripts.push(calls({ tool: "Read", summary: "Read a", access: { kind: "read", paths: [join(links, "a", "x")] } }));
    const { runId } = await startRun(client, id, "bypassPermissions");
    await untilEnded(t, id, runId);
    expect(opened(t, id)).toEqual([]);
    expect(toolEnds(t, id)).toEqual([expect.objectContaining({ status: "error", output: expect.stringContaining("loops or changed") })]);
    expect(decisions(t, id)).toEqual([expect.objectContaining({ decision: "denied", decidedBy: "denylist", promptId: null, reason: expect.stringContaining("loops or changed") })]);
  });
});

describe("the gate's rules", () => {
  it("deny a call a rule could not rule on, recorded by that rule's decider", async () => {
    const failing: ToolGateRule = {
      decider: "denylist",
      check: () => {
        throw new Error("The denylist could not be read.");
      },
    };
    const t = await start({}, { adapterSeams: { gateRules: [failing] } });
    const client = await t.client();
    const { id } = await create(client);
    t.adapter.nextScripts.push(calls(harmless));
    const { runId } = await startRun(client, id, "bypassPermissions");
    await untilEnded(t, id, runId);
    expect(toolEnds(t, id)).toEqual([expect.objectContaining({ status: "error", output: GATE_FAILED_MESSAGE })]);
    expect(decisions(t, id)).toEqual([expect.objectContaining({ decision: "denied", decidedBy: "denylist", reason: GATE_FAILED_MESSAGE })]);
  });

  it("stop at a deny: the rules after it are not asked, and the denial is recorded by its rule's decider", async () => {
    const asked: string[] = [];
    const walls: ToolGateRule = { decider: "containment", check: () => (asked.push("containment"), { decision: "deny", message: "Denied by containment." }) };
    const after: ToolGateRule = { decider: "denylist", check: () => (asked.push("denylist"), null) };
    const passes: ToolGateRule = { decider: "denylist", check: () => (asked.push("passes"), { decision: "allow" }) };
    const t = await start({}, { adapterSeams: { gateRules: [passes, walls, after] } });
    const client = await t.client();
    const { id } = await create(client);
    t.adapter.nextScripts.push(calls(harmless));
    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(asked).toEqual(["passes", "containment"]);
    expect(decisions(t, id)).toEqual([expect.objectContaining({ decision: "denied", decidedBy: "containment", reason: "Denied by containment." })]);
  });

  it("close a parked denylist prompt when the provider gives up on the call, the call the provider's to decide", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const gaveUp = new AbortController();
    t.adapter.nextScripts.push(async function* (controls: ScriptControls) {
      yield* toolCall(controls, readKey, gaveUp.signal);
      yield say("Carried on");
      yield end();
    });
    const { runId } = await startRun(client, id);
    const [prompt] = await untilOpened(t, id);
    gaveUp.abort();
    await untilEnded(t, id, runId);
    expect(answered(t, id)).toEqual([expect.objectContaining({ promptId: prompt?.promptId, decision: "deny", decidedBy: { auto: "cancelled" } })]);
    expect(decisions(t, id)).toEqual([expect.objectContaining({ decision: "denied", decidedBy: "provider", promptId: prompt?.promptId })]);
    expect(toolEnds(t, id)).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(registry["permissions.prompts.list"].result.parse(await client.request("permissions.prompts.list", {})).prompts).toEqual([]);
  });

  it("record a call the provider gave up on before its prompt could open as the provider's, not as the mode's at the run's end", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const gaveUp = new AbortController();
    gaveUp.abort();
    t.adapter.nextScripts.push(async function* (controls: ScriptControls) {
      yield* toolCall(controls, readKey, gaveUp.signal);
      yield say("Carried on");
      yield end();
    });
    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);
    // The broker denied the ask at once: no prompt opened, so no answer records the call's decision.
    expect(opened(t, id)).toEqual([]);
    expect(t.adapter.lastRun().gated.map((ruling) => ruling.decision)).toEqual([{ decision: "deny", message: CANCELLED_MESSAGE }]);
    expect(toolEnds(t, id)).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(decisions(t, id)).toEqual([expect.objectContaining({ decision: "denied", decidedBy: "provider", promptId: null, reason: CANCELLED_MESSAGE })]);
  });

  it("record a call whose prompt the log refused as the denylist's: nobody was asked, and the mode let nothing through", async () => {
    const t = await start({ script: calls(readKey) });
    const client = await t.client();
    const { id } = await create(client);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => error.mockRestore());
    const append = t.env.log.append.bind(t.env.log);
    vi.spyOn(t.env.log, "append").mockImplementation((stream, events, options) => {
      if (events.some((event) => event.type === "prompt.opened")) throw new Error("The log refused the prompt.");
      return append(stream, events, options);
    });
    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(opened(t, id)).toEqual([]);
    expect(toolEnds(t, id)).toEqual([expect.objectContaining({ status: "error", output: UNRECORDED_MESSAGE })]);
    expect(decisions(t, id)).toEqual([expect.objectContaining({ decision: "denied", decidedBy: "denylist", promptId: null, reason: UNRECORDED_MESSAGE })]);
  });

  it("record a call the provider asked the gate about after its run ended as the provider's", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    let late: ToolGate | undefined;
    t.adapter.nextScripts.push(async function* (controls: ScriptControls) {
      late = controls.context.gate;
      yield end();
    });
    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(await late?.check({ ...readKey, toolCallId: "toolu_late" })).toEqual({ decision: "deny", message: RUN_ENDED_MESSAGE });
    expect(opened(t, id)).toEqual([]);
    expect(decisions(t, id)).toEqual([
      expect.objectContaining({ runId, toolCallId: "toolu_late", decision: "denied", decidedBy: "provider", promptId: null, reason: RUN_ENDED_MESSAGE }),
    ]);
  });

  it("leave a denylist prompt a person's interrupt ended the run under to the provider, not the denylist", async () => {
    const t = await start({ script: calls(readKey) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilOpened(t, id);
    await send(client, "runs.interrupt", { runId });
    await untilEnded(t, id, runId);
    expect(answered(t, id)).toEqual([expect.objectContaining({ decidedBy: { auto: "run_ended" } })]);
    expect(decisions(t, id)).toEqual([expect.objectContaining({ decision: "denied", decidedBy: "provider" })]);
  });
});

describe("a tool server's input", () => {
  it("is read for a host with a port in a whole value, and the rest past its limits is logged, not read", async () => {
    const t = await start();
    const client = await t.client();
    await send(client, "permissions.denylist.set", { sections: { hosts: [{ id: "internal", pattern: "*.internal.example" }] } });
    const { id } = await create(client);
    let deep: Record<string, unknown> = { path: "~/.ssh/id_rsa" };
    for (let level = 0; level < 12; level++) deep = { next: deep };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    onCleanup(() => warn.mockRestore());
    t.adapter.nextScripts.push(
      calls(
        { tool: "mcp__db__query", summary: "Query", access: { kind: "other" }, input: { target: "db.internal.example:5432", sql: "select 1" } },
        { tool: "mcp__deep__read", summary: "Deep", access: { kind: "other" }, input: deep as never },
      ),
    );
    const { runId } = startAsRoutine(t, id);
    await untilEnded(t, id, runId);
    expect(decisions(t, id).map((decision) => [decision.tool, decision.decision, decision.decidedBy])).toEqual([
      ["mcp__db__query", "denied", "denylist"],
      ["mcp__deep__read", "allowed", "mode"],
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mcp__deep__read"));
  });

  it("reads a special scheme's address with fewer slashes than two as a URL, as the matcher does", () => {
    const call = denylistCall({ toolCallId: "t", tool: "mcp__web__get", summary: "Get", access: { kind: "other" }, input: { url: "http:/2852039166/latest" } });
    expect(call.hosts).toEqual(["http:/2852039166/latest"]);
  });

  it("logs a cut only when a string or a container was left unread, never for a number, a flag or null past a limit", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    onCleanup(() => warn.mockRestore());
    const read = (input: Record<string, unknown>) => denylistCall({ toolCallId: "toolu_1", tool: "mcp__notes__write", summary: "Write", access: { kind: "other" }, input });
    /** `inner` at the input's 8th level, the last one read. */
    const atLastLevel = (inner: unknown): Record<string, unknown> => {
      let input: Record<string, unknown> = { next: inner };
      for (let level = 1; level < 8; level++) input = { next: input };
      return input;
    };
    const notes = Array.from({ length: 500 }, (_, index) => `note ${index}`);

    expect(read({ notes, counts: [1, 2, 3], draft: true, parent: null })).toEqual({ paths: [], hosts: [] });
    expect(read(atLastLevel([1, 2, 3]))).toEqual({ paths: [], hosts: [] });
    expect(read(atLastLevel({}))).toEqual({ paths: [], hosts: [] });
    expect(warn).not.toHaveBeenCalled();

    expect(read({ notes, key: "~/.ssh/id_rsa" })).toEqual({ paths: [], hosts: [] });
    expect(read(atLastLevel(["~/.ssh/id_rsa"]))).toEqual({ paths: [], hosts: [] });
    expect(read(atLastLevel([[1]]))).toEqual({ paths: [], hosts: [] });
    // A cut deep in the input leaves the rest of it read.
    expect(read({ deep: atLastLevel(["x"]), key: "~/.ssh/id_rsa" })).toEqual({ paths: ["~/.ssh/id_rsa"], hosts: [] });
    expect(warn).toHaveBeenCalledTimes(4);
  });
});

describe("long values and a user's own home", () => {
  it("answer a value longer than an address is read to in permissions.denylist.test, its host read from its front", async () => {
    const t = await start();
    const client = await t.client();
    await send(client, "permissions.denylist.set", { sections: { hosts: [{ id: "metadata", pattern: "169.254.169.254" }] } });
    expect((await test(client, "host", `http://169.254.169.254/${"a".repeat(20_000)}`)).map((match) => match.entry.id)).toEqual(["metadata"]);
  });

  it("read a tool server's ~name/ value as the home of the environment's own user", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    t.adapter.nextScripts.push(calls({ tool: "mcp__files__read", summary: "Read", access: { kind: "other" }, input: { path: `~${userInfo().username}/.ssh/id_rsa` } }));
    const { runId } = startAsRoutine(t, id);
    await untilEnded(t, id, runId);
    expect(opened(t, id).map((prompt) => prompt.denylist?.[0]?.entry.pattern)).toEqual(["~/.ssh"]);
    expect(decisions(t, id)).toEqual([expect.objectContaining({ decision: "denied", decidedBy: "denylist" })]);
  });
});

describe("a file: URL in a call", () => {
  it.each([
    ["a tool server's input, three slashes", { tool: "mcp__files__open", summary: "Open", access: { kind: "other" as const }, input: { uri: `file://${homedir()}/.ssh/id_rsa` } }],
    ["a tool server's input, one slash", { tool: "mcp__files__open", summary: "Open", access: { kind: "other" as const }, input: { uri: `file:${homedir()}/.ssh/id_rsa` } }],
    ["a search query", { tool: "WebSearch", summary: "Search", access: { kind: "search" as const, query: `read file:${homedir()}/.ssh/id_rsa` } }],
    ["a shell line", { tool: "Bash", summary: "curl", access: { kind: "shell" as const, command: `curl -s file:${homedir()}/.ssh/id_rsa` } }],
  ])("is read as a path: %s", async (_, call) => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    t.adapter.nextScripts.push(calls(call));
    const { runId } = startAsRoutine(t, id);
    await untilEnded(t, id, runId);
    expect(opened(t, id).map((prompt) => prompt.denylist?.[0]?.entry.pattern)).toEqual(["~/.ssh"]);
  });
});

describe("permissions.denylist.test on a link that loops", () => {
  it("answers the path it cannot follow beside the matches, as the gate denies such a call", async () => {
    const t = await start();
    const client = await t.client();
    const links = tempDir();
    symlinkSync(join(links, "b"), join(links, "a"));
    symlinkSync(join(links, "a"), join(links, "b"));
    const answer = registry["permissions.denylist.test"].result.parse(await client.request("permissions.denylist.test", { kind: "path", value: join(links, "a", "x") }));
    expect(answer).toEqual({ matches: [], unresolvable: [join(links, "a", "x")] });
    expect(registry["permissions.denylist.test"].result.parse(await client.request("permissions.denylist.test", { kind: "path", value: "~/.ssh/id_rsa" })).unresolvable).toEqual([]);
  });
});
