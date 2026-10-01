import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { EMPTY_RUN_SKILL_SET } from "@agent-harness/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../../test/cleanups.js";
import { manualClock } from "../../../test/clock.js";
import { FakeSdk } from "../../../test/fake-claude-sdk.js";
import type { RunContext, RunInput } from "../../adapter/contract.js";
import { EMPTY_PROCESS_ENVIRONMENT } from "../../adapter/process-environment.js";
import { openEventLog } from "../../event-log/event-log.js";
import { createProviderTranscriptStore, type ProviderTranscriptStore } from "../../provider-transcripts/store.js";

/**
 * An imported session's history read from the account's directory, and the
 * store's copy before its first run (ADR 0021; #579), on the pinned SDK's
 * own helpers over a fixture config directory laid out as the CLI writes
 * one: a transcript in a project folder, and a subagent's transcript with
 * its sidecar in the session's folder. Only `query()` is scripted, so
 * nothing spawns.
 */

const hooks = vi.hoisted(() => ({ sdk: undefined as undefined | { query: (params: never) => unknown } }));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: (params: never) => {
    if (hooks.sdk === undefined) throw new Error("The test installed no fake SDK.");
    return hooks.sdk.query(params);
  },
}));

const { createClaudeAdapter } = await import("./index.js");
const { createConfigDirQueue } = await import("./config-dir-queue.js");

const { onCleanup, tempDir } = useCleanups();

const HARNESS = "6f1d2a4e-8c3b-4f5a-9d7e-1a2b3c4d5e6f";
const PROVIDER = "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a";
const CWD = "/work/repo";
const FOLDER = "-work-repo";
const AGENT = "a1b2c3d4e5f6a7b8c";
const IMAGE = Buffer.from("not really a png").toString("base64");

/** The instant `seconds` into the session. */
const at = (seconds: number): string => new Date(Date.UTC(2026, 8, 1, 9, 0, seconds)).toISOString();

/** One transcript record as the CLI writes it, chained to the one before; an assistant record's message is its own unless named. */
const record = (type: "user" | "assistant", uuid: string, parentUuid: string | null, seconds: number, content: unknown, extra: Record<string, unknown> = {}, messageId = `msg-${uuid}`) => ({
  type,
  uuid,
  parentUuid,
  sessionId: PROVIDER,
  cwd: CWD,
  timestamp: at(seconds),
  isSidechain: false,
  userType: "external",
  version: "2.1.200",
  message: type === "user" ? { role: "user", content } : { id: messageId, type: "message", role: "assistant", model: "claude-x", content, stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
  ...extra,
});

const MAIN = [
  record("user", "u1", null, 0, "Find the flaky test"),
  record("assistant", "a1", "u1", 1, [{ type: "text", text: "I will ask a helper." }]),
  // The CLI writes a message's blocks as records of their own, under one message id.
  record("assistant", "a2", "a1", 2, [{ type: "tool_use", id: "toolu_agent", name: "Task", input: { description: "Search", prompt: "Find it" } }], {}, "msg-a1"),
  record("user", "u2", "a2", 9, [{ type: "tool_result", tool_use_id: "toolu_agent", content: "It is in runs.test.ts." }]),
  record("assistant", "a3", "u2", 10, [{ type: "text", text: "It is in runs.test.ts." }]),
  record("user", "u3", "a3", 11, [{ type: "text", text: "[Request interrupted by user]" }]),
  record("user", "u4", "u3", 12, [
    { type: "text", text: "And this one?" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE } },
  ]),
  record("assistant", "a4", "u4", 13, [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "pnpm test" } }]),
];

const SUBAGENT = [
  record("user", "s1", null, 3, "Find it", { isSidechain: true, agentId: AGENT }),
  record("assistant", "s2", "s1", 4, [{ type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "flaky" } }], { isSidechain: true, agentId: AGENT }),
  record("user", "s3", "s2", 6, [{ type: "tool_result", tool_use_id: "toolu_grep", content: "runs.test.ts:12" }], { isSidechain: true, agentId: AGENT }),
  record("assistant", "s4", "s3", 7, [{ type: "text", text: "It is in runs.test.ts." }], { isSidechain: true, agentId: AGENT }),
];

const jsonl = (lines: readonly unknown[]): string => lines.map((line) => JSON.stringify(line)).join("\n") + "\n";

/** An adopted directory holding the provider session and its subagent, as the CLI left it. */
const adoptedDirectory = (): string => {
  const directory = tempDir("adopted-");
  const project = join(directory, "projects", FOLDER);
  mkdirSync(join(project, PROVIDER, "subagents"), { recursive: true });
  writeFileSync(join(project, `${PROVIDER}.jsonl`), jsonl(MAIN));
  writeFileSync(join(project, PROVIDER, "subagents", `agent-${AGENT}.jsonl`), jsonl(SUBAGENT));
  writeFileSync(join(project, PROVIDER, "subagents", `agent-${AGENT}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: "toolu_agent" }));
  return directory;
};

/** Every file under `directory`, with its size and time, for "nothing was written". */
const tree = (directory: string): Record<string, string> => {
  const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]));
  return Object.fromEntries(walk(directory).map((path) => [relative(directory, path), `${statSync(path).mtimeMs} ${readFileSync(path, "utf8").length}`]));
};

let fake: FakeSdk;
let store: ProviderTranscriptStore;

beforeEach(() => {
  fake = new FakeSdk();
  hooks.sdk = fake;
  const log = openEventLog({ path: ":memory:" });
  onCleanup(() => log.close());
  store = createProviderTranscriptStore({ log, clock: manualClock() });
});

afterEach(() => {
  hooks.sdk = undefined;
});

const adapterWith = () =>
  createClaudeAdapter({
    clock: manualClock(),
    executablePath: "/sdk/claude-agent-sdk-linux-x64/claude",
    hostEnv: { PATH: "/usr/bin", HOME: "/home/david" },
    diagnostic: () => undefined,
    configDirQueue: createConfigDirQueue(process.env),
    sessionStore: store,
  });

describe("an imported session's history, read from the account's directory", () => {
  it("maps the transcript to the vocabulary: the person's messages, the assistant's words and calls, and the subagent's calls nested right after the call that started it", async () => {
    const directory = adoptedDirectory();
    const before = tree(directory);

    const history = await adapterWith().readHistory?.({ id: "claude-max", directory }, PROVIDER);

    const agentCall = (toolCallId: string) => ({ agentId: "toolu_agent", parentToolCallId: "toolu_agent", toolCallId });
    expect(history).toEqual([
      { type: "message.sent", payload: { text: "Find the flaky test", attachments: [] }, at: at(0) },
      { type: "assistant.text", payload: { itemId: "a1:0", text: "I will ask a helper.", aborted: false }, at: at(1) },
      { type: "tool.started", payload: { toolCallId: "toolu_agent", name: "Task", input: { description: "Search", prompt: "Find it" }, title: null, agentId: null, parentToolCallId: null }, at: at(2) },
      { type: "tool.started", payload: { ...agentCall("toolu_grep"), name: "Grep", input: { pattern: "flaky" }, title: null }, at: at(4) },
      { type: "tool.ended", payload: { toolCallId: "toolu_grep", status: "ok", output: "runs.test.ts:12", durationMs: 2000 }, at: at(6) },
      { type: "tool.ended", payload: { toolCallId: "toolu_agent", status: "ok", output: "It is in runs.test.ts.", durationMs: 7000 }, at: at(9) },
      { type: "assistant.text", payload: { itemId: "a3:0", text: "It is in runs.test.ts.", aborted: false }, at: at(10) },
      // The interrupt marker the CLI wrote in the person's place is no message of theirs.
      { type: "message.sent", payload: { text: "And this one?", attachments: [{ kind: "image", name: "image-1", mediaType: "image/png", size: Buffer.from(IMAGE, "base64").length }] }, at: at(12) },
      { type: "tool.started", payload: { toolCallId: "toolu_bash", name: "Bash", input: { command: "pnpm test" }, title: null, agentId: null, parentToolCallId: null }, at: at(13) },
      // A call the transcript never ended ends cancelled, as a run's end ends one.
      { type: "tool.ended", payload: { toolCallId: "toolu_bash", status: "cancelled", output: null, durationMs: 0 }, at: at(13) },
    ]);
    expect(tree(directory)).toEqual(before);
  });

  it("is null for a provider session the directory no longer holds", async () => {
    const directory = adoptedDirectory();

    expect(await adapterWith().readHistory?.({ id: "claude-max", directory }, randomUUID())).toBeNull();
  });
});

const runInput = (directory: string): RunInput => ({
  sessionId: HARNESS,
  runId: randomUUID(),
  account: { id: "claude-max", directory },
  // Another directory than the transcript's: the resume from the store does not depend on it.
  workspace: { kind: "directory", path: "/work/elsewhere" },
  repositoryIdentity: null,
  model: "opus",
  effort: null,
  mode: "acceptEdits",
  ceiling: "acceptEdits",
  instructions: "",
  target: { kind: "resume", providerSessionId: PROVIDER },
  toolServers: [],
  trusted: false,
  containment: {
    level: "off",
    mechanism: null,
    scratchDirectory: "/data/containment/session/scratch",
    temporaryDirectory: "/data/containment/session/tmp",
    writable: ["/work/elsewhere"],
    readOnly: [],
    network: true,
  },
  denylist: null,
  processEnvironment: EMPTY_PROCESS_ENVIRONMENT,
  skillSet: EMPTY_RUN_SKILL_SET,
  prompt: [{ messageId: randomUUID(), text: "Go on", attachments: [] }],
});

const context = (): RunContext => ({
  broker: { request: () => new Promise(() => undefined) },
  gate: { check: async () => ({ decision: "allow" }) },
  adopt: () => undefined,
  reportIdentity: () => undefined,
  recheckAccount: () => undefined,
  process: { hold: () => undefined, unhold: () => undefined, exited: () => undefined },
});

describe("an imported session's first run", () => {
  it("copies the provider session, subagents and all, from the account's directory into the store under the harness session, then resumes from the store; the directory is only read", async () => {
    const directory = adoptedDirectory();
    const before = tree(directory);

    adapterWith().createRun(runInput(directory), context());
    // The refresh query before a cold resume through the store comes first (#229).
    const resumed = await fake.made(2);

    expect(resumed.options).toMatchObject({ sessionStore: store, resume: PROVIDER });
    expect(resumed.env["CLAUDE_CONFIG_DIR"]).toBe(directory);
    expect(resumed.env["CLAUDE_CODE_PROJECT_DIR_NAME"]).toBe(HARNESS);
    expect((await store.load({ projectKey: HARNESS, sessionId: PROVIDER }))?.map((entry) => entry.uuid)).toEqual(MAIN.map((line) => line.uuid));
    expect(await store.listSubkeys({ projectKey: HARNESS, sessionId: PROVIDER })).toEqual([`subagents/agent-${AGENT}`]);
    expect(tree(directory)).toEqual(before);
  });

  it("copies nothing when the store holds the provider session already, as it does from the first run on", async () => {
    const directory = adoptedDirectory();
    const held = { type: "user", uuid: "held", parentUuid: null, sessionId: PROVIDER, message: { role: "user", content: "Held" } };
    await store.append({ projectKey: HARNESS, sessionId: PROVIDER }, [held]);

    adapterWith().createRun(runInput(directory), context());
    await fake.made(2);

    expect((await store.load({ projectKey: HARNESS, sessionId: PROVIDER }))?.map((entry) => entry.uuid)).toEqual(["held"]);
  });
});
