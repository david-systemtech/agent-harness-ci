import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ceiling, keyBetween, registry, type MethodName, type ParamsOf, type ResponseOf, type RunInstructionsComposedPayload, type Scope } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import type { InstructionScope } from "../adapter/seams.js";
import type { EventEnvelope } from "../event-log/event-log.js";
import type { OrientationSeam } from "./composer.js";

/**
 * Owned instructions through the primary seam (skills-instructions spec,
 * "Owned instructions" and "Testing Decisions"; #505): the in-process
 * environment with three accounts on fake adapters (`claude-max` on the
 * Claude-shaped one, `local` on one whose channel is `none`, `small` on one
 * declaring a small cap), a test orientation seam in place of the
 * OrientationRenderer's, and typed clients at `admin` and `read`. What is
 * asserted is what the commands answer and append, what `instructions.list`
 * answers, and the text each adapter is handed.
 */

const { onCleanup } = useCleanups();

const ORIENTATION = "# Orientation\n\nYou are on SAMPLE-SERVER.";

/** An orientation seam a test drives: its text, the registries it could not read, and the scopes it was asked for. */
const testOrientation = () => {
  const state = { text: ORIENTATION, unread: [] as string[], scopes: [] as InstructionScope[] };
  const seam: OrientationSeam = (scope) => {
    state.scopes.push(scope);
    return { text: state.text, unreadRegistries: [...state.unread] };
  };
  return { state, seam };
};

/** The cap the `small` account's adapter declares. */
const SMALL_CAP = 200;

const noChannel = () => fakeAdapter({ provider: "fake-none", capabilities: { instructionChannel: { kind: "none", maxCharacters: null } } });
const capped = () => fakeAdapter({ provider: "fake-capped", capabilities: { instructionChannel: { kind: "prompt", maxCharacters: SMALL_CAP } } });

const start = async (options: Omit<TestEnvironmentOptions, "orientation"> = {}) => {
  const orientation = testOrientation();
  const adapter = fakeAdapter();
  const others = [noChannel(), capped()];
  const t = await startTestEnvironment({
    adapter,
    otherAdapters: others,
    accounts: [
      { id: "claude-max", provider: "fake" },
      { id: "local", provider: "fake-none" },
      { id: "small", provider: "fake-capped" },
    ],
    orientation: orientation.seam,
    ...options,
  });
  onCleanup(() => t.close());
  const [none, small] = others as [ReturnType<typeof fakeAdapter>, ReturnType<typeof fakeAdapter>];
  return { t, orientation, adapters: { claude: adapter, none, small } };
};

type InstructionCommand = Extract<MethodName, `instructions.${string}`> & ("instructions.create" | "instructions.edit" | "instructions.setScope" | "instructions.setEnabled" | "instructions.move" | "instructions.remove");

const command = async <N extends InstructionCommand>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

/** Creates an owned instruction and resolves with it; throws unless it was applied. */
const make = async (client: WireClient, params: Omit<ParamsOf<"instructions.create">, "commandId" | "id"> & { readonly id?: string }) => {
  const answer = await command(client, "instructions.create", { id: randomUUID(), ...params });
  if (answer.result === undefined) throw new Error(`instructions.create was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.instruction;
};

const list = async (client: WireClient) => registry["instructions.list"].result.parse(await client.request("instructions.list", {}));

/** A client session issued straight from the environment, holding only `scopes`. */
const narrowClient = (t: TestEnvironment, scopes: Scope[]) =>
  t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a narrow program", scopes, ceiling: Ceiling.parse("acceptEdits") }).token });

const eventsOf = (t: TestEnvironment, sessionId: string): EventEnvelope[] => t.env.log.readStream({ kind: "session", id: sessionId });

const untilEnded = (t: TestEnvironment, sessionId: string, runId: string) =>
  vi.waitFor(() => expect(eventsOf(t, sessionId).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true));

const composedOf = (t: TestEnvironment, sessionId: string, runId: string) =>
  eventsOf(t, sessionId).find((event) => event.type === "run.instructions.composed" && event.payload["runId"] === runId)?.payload as RunInstructionsComposedPayload | undefined;

/** Starts a run from a client in a new session of `account`, awaits its end, and answers its ids. */
const runOn = async (t: TestEnvironment, client: WireClient, account: string) => {
  const { id } = await create(client, { account });
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Go" }));
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  await untilEnded(t, id, answer.result.runId);
  return { sessionId: id, runId: answer.result.runId };
};

const standing = (...instructions: readonly (readonly [string, string])[]) =>
  ["# Standing instructions", ...instructions.map(([title, body]) => `## ${title}\n\n${body}`)].join("\n\n");

describe("the record", () => {
  it("is made by instructions.create at admin under the client's id, preset for every account, enabled and after the last, appending instructions.created", async () => {
    const { t } = await start();
    const client = await t.client();
    const id = randomUUID().toUpperCase();
    const answer = await command(client, "instructions.create", { id, title: "  Coding   style ", body: "Prefer small modules." });
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    const first = answer.result?.instruction;
    expect(first).toEqual({ id: id.toLowerCase(), title: "Coding style", body: "Prefer small modules.", origin: null, scope: "all", enabled: true, position: "n" });
    const second = await make(client, { title: "Tests", body: "Test first." });
    expect(second.position > "n").toBe(true);

    const events = t.env.log.readStream({ kind: "instructions", id: t.env.id });
    expect(events.map((event) => [event.type, event.payload["id"]])).toEqual([
      ["instructions.created", id.toLowerCase()],
      ["instructions.created", second.id],
    ]);
    expect(events[0]?.payload).toEqual(first);
  });

  it("holds its bounds: a broken one is invalid_params, an unknown id not_found of kind instruction, an id used before conflict, an account not held not_found", async () => {
    const { t } = await start();
    const client = await t.client();
    const made = await make(client, { title: "Coding style", body: "" });
    for (const params of [
      { id: randomUUID(), title: "", body: "" },
      { id: randomUUID(), title: "t".repeat(121), body: "" },
      { id: randomUUID(), title: "Long", body: "b".repeat(20001) },
      { id: randomUUID(), title: "Nobody", body: "", scope: [] },
      { id: "orientation", title: "Orientation", body: "" },
    ]) {
      expect((await refusal(client.request("instructions.create", { commandId: randomUUID(), ...params } as ParamsOf<"instructions.create">))).code, JSON.stringify(params).slice(0, 60)).toBe(
        "invalid_params",
      );
    }
    expect(await make(client, { title: "t".repeat(120), body: "b".repeat(20000) })).toMatchObject({ title: "t".repeat(120) });

    const missing = randomUUID();
    for (const [method, params] of [
      ["instructions.edit", { instructionId: missing, title: "Other", body: "" }],
      ["instructions.setScope", { instructionId: missing, scope: "all" }],
      ["instructions.setEnabled", { instructionId: missing, enabled: false }],
      ["instructions.move", { instructionId: missing, position: "b" }],
      ["instructions.remove", { instructionId: missing }],
    ] as const) {
      const answer = await command(client, method, params as never);
      expect(answer.receipt, method).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "instruction", instructionId: missing } } });
    }
    const again = await command(client, "instructions.create", { id: made.id, title: "Again", body: "" });
    expect(again.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "exists", instructionId: made.id } } });
    await command(client, "instructions.remove", { instructionId: made.id });
    const reused = await command(client, "instructions.create", { id: made.id, title: "Again", body: "" });
    expect(reused.receipt).toMatchObject({ status: "rejected", reason: "conflict" });
    for (const answer of [
      await command(client, "instructions.create", { id: randomUUID(), title: "Elsewhere", body: "", scope: ["claude-max", "elsewhere"] }),
      await command(client, "instructions.setScope", { instructionId: (await make(client, { title: "Here", body: "" })).id, scope: ["elsewhere"] }),
    ]) {
      expect(answer.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "account", accountId: "elsewhere" } } });
    }
  });

  it("changes one field per command at admin, each appending its event, and a command that changes nothing appends nothing", async () => {
    const { t } = await start();
    const client = await t.client();
    const reader = await narrowClient(t, ["read"]);
    const made = await make(client, { title: "Coding style", body: "Prefer small modules." });
    const instructionId = made.id;

    expect((await command(client, "instructions.edit", { instructionId, title: "Style", body: "Small modules." })).result?.instruction).toMatchObject({ title: "Style", body: "Small modules." });
    expect((await command(client, "instructions.setScope", { instructionId, scope: ["small", "claude-max"] })).result?.instruction.scope).toEqual(["small", "claude-max"]);
    expect((await command(client, "instructions.setEnabled", { instructionId, enabled: false })).result?.instruction.enabled).toBe(false);
    expect((await command(client, "instructions.move", { instructionId, position: "c" })).result?.instruction.position).toBe("c");
    const unchanged = await command(client, "instructions.setEnabled", { instructionId, enabled: false });
    expect(unchanged.receipt).toMatchObject({ status: "accepted", changed: false });
    expect(await command(client, "instructions.remove", { instructionId })).toMatchObject({ result: { instructionId } });

    expect(t.env.log.readStream({ kind: "instructions", id: t.env.id }).map((event) => event.type)).toEqual([
      "instructions.created",
      "instructions.edited",
      "instructions.scope-set",
      "instructions.enabled-set",
      "instructions.moved",
      "instructions.removed",
    ]);
    expect((await list(client)).instructions).toEqual([]);
    // Every command is admin's.
    for (const method of ["instructions.create", "instructions.edit", "instructions.setScope", "instructions.setEnabled", "instructions.move", "instructions.remove"] as const) {
      expect((await refusal(reader.request(method, { commandId: randomUUID(), id: randomUUID(), instructionId, title: "T", body: "", scope: "all", enabled: true, position: "b" } as never))).code, method).toBe(
        "forbidden",
      );
    }
  });

  it("raises instructions.updated on the environment's stream after each commit, and none for a command that changes nothing", async () => {
    const { t } = await start();
    const client = await t.client();
    const notices = () => t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "instructions.updated");
    const made = await make(client, { title: "Coding style", body: "" });
    await command(client, "instructions.setEnabled", { instructionId: made.id, enabled: true });
    await command(client, "instructions.setEnabled", { instructionId: made.id, enabled: false });
    expect(notices()).toHaveLength(2);
  });
});

describe("the order", () => {
  it("is the positions' fractional keys: instructions.move reorders, and the order holds across a restart, where scope all reaches an account added since", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agent-harness-owned-"));
    onCleanup(() => rmSync(dataDir, { recursive: true, force: true }));
    const first = await start({ dataDir });
    const client = await first.t.client();
    const a = await make(client, { title: "A", body: "First." });
    const b = await make(client, { title: "B", body: "Second." });
    const c = await make(client, { title: "C", body: "Third." });
    await command(client, "instructions.move", { instructionId: c.id, position: keyBetween(null, a.position) });
    await command(client, "instructions.move", { instructionId: a.id, position: keyBetween(b.position, null) });
    expect((await list(client)).instructions.map((row) => row.title)).toEqual(["C", "B", "A"]);
    await first.t.close();

    const ambient = mkdtempSync(join(tmpdir(), "agent-harness-ambient-"));
    onCleanup(() => rmSync(ambient, { recursive: true, force: true }));
    const again = await startTestEnvironment({ dataDir, adapter: fakeAdapter({ ambientDirectory: ambient }), accounts: [], orientation: testOrientation().seam });
    onCleanup(() => again.close());
    const next = await again.client();
    expect((await list(next)).instructions.map((row) => row.title)).toEqual(["C", "B", "A"]);
    // An account added after the instructions were made: scope all reaches it.
    await next.request("accounts.probe", {});
    const adopted = registry["accounts.adopt"].response.parse(await next.request("accounts.adopt", { commandId: randomUUID() })).result?.account;
    if (adopted === undefined) throw new Error("accounts.adopt was not applied.");
    await runOn(again, next, adopted.id);
    expect(again.adapter.lastRun().input.instructions).toBe([ORIENTATION, standing(["C", "Third."], ["B", "Second."], ["A", "First."])].join("\n\n"));
  });
});

describe("the user layer", () => {
  it("hands a run the orientation block, then its account's enabled owned instructions in order under # Standing instructions, each as ## <title>", async () => {
    const { t, adapters } = await start();
    const client = await t.client();
    const style = await make(client, { title: "Coding style", body: "Prefer small modules." });
    await make(client, { title: "Off", body: "Never handed.", enabled: false });
    await make(client, { title: "Elsewhere", body: "Only on small.", scope: ["small"] });
    await make(client, { title: "Tests", body: "Test first." });
    const { sessionId, runId } = await runOn(t, client, "claude-max");

    expect(adapters.claude.lastRun().input.instructions).toBe(`${ORIENTATION}\n\n# Standing instructions\n\n## Coding style\n\nPrefer small modules.\n\n## Tests\n\nTest first.`);
    const manifest = composedOf(t, sessionId, runId)?.manifest;
    expect(manifest?.layers).toEqual([
      {
        layer: "user",
        characters: adapters.claude.lastRun().input.instructions.length,
        parts: [
          { id: "orientation", version: null, characters: ORIENTATION.length },
          { id: style.id, version: null, characters: "# Standing instructions\n\n## Coding style\n\nPrefer small modules.".length },
          { id: expect.any(String), version: null, characters: "## Tests\n\nTest first.".length },
        ],
      },
    ]);
    const preview = registry["instructions.preview"].result.parse(await client.request("instructions.preview", { sessionId }));
    expect(preview.parts.map((part) => [part.layer, part.title])).toEqual([
      ["user", "Orientation"],
      ["user", "Coding style"],
      ["user", "Tests"],
    ]);
  });

  it("hands a routine's run and a completions run on the account the same owned instructions as a client run", async () => {
    const { t, adapters } = await start();
    const client = await t.client();
    await make(client, { title: "Coding style", body: "Prefer small modules." });
    const { sessionId } = await runOn(t, client, "claude-max");
    const routine = t.env.startRun({ sessionId, text: "Nightly", actor: { kind: "routine", name: "nightly", ceiling: "acceptEdits", clientSessionId: null }, actorId: "routine-nightly" });
    await untilEnded(t, sessionId, routine.runId);
    const completions = t.env.startRun({ sessionId, text: "From a bot", actor: { kind: "completions", attended: false, ceiling: "acceptEdits", clientSessionId: null } });
    await untilEnded(t, sessionId, completions.runId);
    const texts = adapters.claude.runs.map((run) => run.input.instructions);
    expect(texts).toHaveLength(3);
    expect(new Set(texts)).toEqual(new Set([`${ORIENTATION}\n\n${standing(["Coding style", "Prefer small modules."])}`]));
  });

  it("hands an account whose adapter has no instruction channel nothing, and its manifest names each owned instruction left out", async () => {
    const { t, adapters } = await start();
    const client = await t.client();
    const style = await make(client, { title: "Coding style", body: "Prefer small modules." });
    const { sessionId, runId } = await runOn(t, client, "local");
    expect(adapters.none.lastRun().input.instructions).toBe("");
    expect(composedOf(t, sessionId, runId)?.manifest.leftOut).toEqual([
      { layer: "user", id: "orientation", reason: "channel-none" },
      { layer: "user", id: style.id, reason: "channel-none" },
    ]);
  });

  it("leaves the block out of the next run's text while instructions.orientation is off, the key preset on", async () => {
    const { t, adapters, orientation } = await start();
    const client = await t.client();
    await make(client, { title: "Coding style", body: "Prefer small modules." });
    expect((await client.request("settings.get", { keys: ["instructions.orientation"] })).values).toEqual({ "instructions.orientation": true });
    await client.request("settings.update", { commandId: randomUUID(), values: { "instructions.orientation": false } });
    const asked = orientation.state.scopes.length;
    await runOn(t, client, "claude-max");
    expect(adapters.claude.lastRun().input.instructions).toBe(standing(["Coding style", "Prefer small modules."]));
    expect(orientation.state.scopes).toHaveLength(asked);
  });

  it("under a channel's cap leaves owned instructions out last first, and the manifest names each one and why", async () => {
    const { t, adapters } = await start();
    const client = await t.client();
    const first = await make(client, { title: "First", body: "One." });
    const second = await make(client, { title: "Second", body: "b".repeat(120) });
    const third = await make(client, { title: "Third", body: "c".repeat(20) });
    const { sessionId, runId } = await runOn(t, client, "small");

    const text = `${ORIENTATION}\n\n${standing(["First", "One."])}`;
    expect(adapters.small.lastRun().input.instructions).toBe(text);
    expect(text.length).toBeLessThanOrEqual(SMALL_CAP);
    expect(composedOf(t, sessionId, runId)?.manifest.leftOut).toEqual([
      { layer: "user", id: second.id, reason: "over-cap" },
      { layer: "user", id: third.id, reason: "over-cap" },
    ]);
    expect(first.id).not.toBe(second.id);
  });
});

describe("instructions.list", () => {
  it("answers, to a read client, the Orientation row first with the key and the block as a run receives it, then the owned instructions in order, every row with the accounts and their channels", async () => {
    const { t, orientation } = await start();
    const client = await t.client();
    const reader = await narrowClient(t, ["read"]);
    orientation.state.text = `${ORIENTATION}\n\nOpenBao: verified at 2026-09-28 09:14 UTC.`;
    orientation.state.unread = ["banks"];
    const second = await make(client, { title: "Second", body: "Two.", position: "t" });
    const first = await make(client, { title: "First", body: "One.", position: "c", scope: ["local"], enabled: false });

    const answer = await list(reader);
    const accounts = [
      { accountId: "claude-max", label: expect.any(String), channel: { kind: "system-prompt-append", maxCharacters: null }, reason: null },
      { accountId: "local", label: expect.any(String), channel: { kind: "none", maxCharacters: null }, reason: expect.stringMatching(/no instruction channel/) },
      { accountId: "small", label: expect.any(String), channel: { kind: "prompt", maxCharacters: SMALL_CAP }, reason: null },
    ];
    expect(answer.orientation).toEqual({ enabled: true, text: orientation.state.text, unreadRegistries: ["banks"], accounts });
    expect(answer.instructions).toEqual([
      { ...first, newerVersion: null, accounts },
      { ...second, newerVersion: null, accounts },
    ]);
    // The block is rendered as a preview of a new session of the default account renders it.
    expect(orientation.state.scopes.at(-1)).toMatchObject({ sessionId: null, accountId: "claude-max", origin: "client" });
    const preview = registry["instructions.preview"].result.parse(await client.request("instructions.preview", { accountId: "claude-max", workspace: { kind: "directory", path: t.dataDir } }));
    expect(preview.parts[0]?.text).toBe(answer.orientation.text);

    await client.request("settings.update", { commandId: randomUUID(), values: { "instructions.orientation": false } });
    expect((await list(reader)).orientation).toMatchObject({ enabled: false, text: orientation.state.text });
  });
});
