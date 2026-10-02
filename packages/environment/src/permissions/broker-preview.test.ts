import { randomUUID } from "node:crypto";
import { type PromptOpenedPayload } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { storeAccounts } from "../../test/accounts.js";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { end, fakeAdapter, gate, type Script } from "../../test/fake-adapter.js";
import { accountsProjector } from "../accounts/account-store.js";
import type { PromptDecision } from "../adapter/contract.js";
import { createAdapterHost } from "../adapter/host.js";
import { openEventLog } from "../event-log/event-log.js";
import { decideStart } from "../runs/run-decider.js";
import { runsProjector } from "../runs/runs-projector.js";
import { sessionListProjector } from "../sessions/session-list.js";
import { CANCELLED_MESSAGE, DUPLICATE_PROMPT_MESSAGE, RUN_ENDED_MESSAGE } from "./broker.js";
import type { BlastRadiusDeps } from "./command-preview.js";
import { permissionsProjector } from "./permissions-store.js";
import { PREVIEW_TIMEOUT_MS } from "./preview.js";

const { onCleanup, tempDir } = useCleanups();
const detail = { toolName: "Bash", input: { command: "rm -rf *" } };

/** A real broker over the read-only I/O seam, held before its first directory read finishes. */
const setup = async (script: Script, previewDeps: Partial<BlastRadiusDeps> = {}) => {
  const workspace = tempDir();
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", projectors: [sessionListProjector, runsProjector, permissionsProjector, accountsProjector], clock: () => clock.now() });
  onCleanup(() => log.close());
  const adapter = fakeAdapter({ script });
  const accounts = await storeAccounts({ log, clock, adapters: [adapter], accounts: [{ id: "acct", provider: adapter.descriptor.provider }] });
  onCleanup(() => accounts.close());
  const reading = gate();
  const released = gate();
  const opened = gate();
  const ended = gate();
  log.subscribe((event) => {
    if (event.type === "prompt.opened") opened.open();
    if (event.type === "run.ended") ended.open();
  });
  const host = createAdapterHost({ log, clock, adapters: [adapter], accounts, ceilingOf: () => undefined, previewDeps: {
    readdir: async () => { reading.open(); await released.opened; return []; },
    ...previewDeps,
  } });
  onCleanup(() => host.close("disposed"));
  const sessionId = randomUUID();
  log.append({ kind: "session", id: sessionId }, [{ type: "session.created", payload: { title: null, tags: [], groupId: null, workspace: { kind: "directory", path: workspace }, repositoryIdentity: null, account: null, model: null, mode: null } }], { actor: "system:test" });
  const decision = decideStart(host.startFacts(sessionId, { kind: "client", ceiling: "bypassPermissions", clientSessionId: null }), { origin: "client", message: { messageId: randomUUID(), text: "Clean build", attachments: [] } });
  if (decision.rejected !== undefined) throw new Error(decision.rejected.message);
  log.append({ kind: "session", id: sessionId }, decision.events, { actor: "client_session:test", correlationId: decision.run.runId });
  host.launch(decision.run);
  return { host, clock, reading, released, opened, ended, runId: decision.run.runId,
    prompts: () => log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "prompt.opened").map((event) => event.payload as PromptOpenedPayload),
  };
};

describe("the broker's indirect execution preview", () => {
  it.skipIf(process.platform === "win32").each([
    "(rm -rf build)",
    "{ rm -rf build; }",
    "time { rm -rf build; }",
    "time -p { rm -rf build; }",
    "function f { rm -rf build; }; f",
    "exec sh -c 'rm -rf build'",
    "timeout 10 sh -c 'rm -rf build'",
    "busybox sh -c 'rm -rf build'",
    "echo $(rm -rf build)",
    "X=$(rm -rf build)",
    "eval rm -rf build",
    "sh -c 'rm -rf build'",
    'echo "$(rm -rf /outside)"',
    "echo `rm -rf build`",
    "sh -c 'git reset --hard; curl https://preview.example.test'",
  ])("records a warning for %s without querying its contents, and keeps the prompt answerable", async (command) => {
    const answers: PromptDecision[] = [];
    const calls: string[] = [];
    const t = await setup(async function* ({ context, input }) {
      answers.push(await context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "indirect", kind: "permission", detail: { toolName: "Bash", input: { command } } }));
      yield end();
    }, {
      execFile: async () => { calls.push("exec"); return ""; },
      readdir: async () => { calls.push("readdir"); return []; },
      stat: async () => { calls.push("stat"); return { size: 0, directory: false }; },
    });
    await t.opened.opened;
    expect(t.prompts()).toMatchObject([{ promptId: "indirect", previewLines: ["⚠ cannot tell: indirect shell execution may change files or contact the network"] }]);
    expect(calls).toEqual([]);
    t.host.deliverAnswer(t.runId, "indirect", { decision: "deny" });
    await t.ended.opened;
    expect(answers).toEqual([{ decision: "deny" }]);
  });

  it.skipIf(process.platform === "win32").each([
    "echo '(rm -rf build)'",
    'echo "{ rm -rf build; }"',
    "echo '$(rm -rf build)'",
    "echo 'eval rm -rf build'",
    "echo \"sh -c 'rm -rf build'\"",
  ])("records null for command-looking literal data: %s", async (command) => {
    const t = await setup(async function* ({ context, input }) {
      await context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "literal", kind: "permission", detail: { toolName: "Bash", input: { command } } });
      yield end();
    });
    await t.opened.opened;
    expect(t.prompts()).toMatchObject([{ promptId: "literal", previewLines: null }]);
    t.host.deliverAnswer(t.runId, "literal", { decision: "deny" });
    await t.ended.opened;
  });
});

describe("the broker while a preview is held", () => {
  it("opens an answerable prompt with null lines after the total budget expires", async () => {
    const answers: PromptDecision[] = [];
    const t = await setup(async function* ({ context, input }) {
      answers.push(await context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "held", kind: "permission", detail }));
      yield end();
    });
    await t.reading.opened;
    expect(t.prompts()).toEqual([]);
    t.clock.advance(PREVIEW_TIMEOUT_MS);
    await t.opened.opened;
    expect(t.prompts()).toMatchObject([{ promptId: "held", previewLines: null }]);
    t.host.deliverAnswer(t.runId, "held", { decision: "allow" });
    await t.ended.opened;
    expect(answers).toEqual([{ decision: "allow" }]);
    t.released.open();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(t.prompts()).toHaveLength(1);
  });

  it("reserves the first request's id during the preview and refuses a duplicate before any prompt opens", async () => {
    const duplicate = gate();
    const answers: PromptDecision[] = [];
    const t = await setup(async function* ({ context, input }) {
      const request = { sessionId: input.sessionId, runId: input.runId, promptId: "held", kind: "permission" as const, detail };
      const first = context.broker.request(request);
      answers.push(await context.broker.request(request));
      duplicate.open();
      answers.push(await first);
      yield end();
    });
    await t.reading.opened;
    await duplicate.opened;
    expect(answers).toEqual([{ decision: "deny", message: DUPLICATE_PROMPT_MESSAGE }]);
    expect(t.prompts()).toEqual([]);
    t.released.open();
    await t.opened.opened;
    t.host.deliverAnswer(t.runId, "held", { decision: "allow" });
    await t.ended.opened;
    expect(answers[1]).toEqual({ decision: "allow" });
    expect(t.prompts()).toHaveLength(1);
  });

  it("opens no late prompt when the provider cancels during preview", async () => {
    const cancel = new AbortController();
    const answers: PromptDecision[] = [];
    const t = await setup(async function* ({ context, input }) {
      answers.push(await context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "held", kind: "permission", detail, signal: cancel.signal }));
      yield end();
    });
    await t.reading.opened;
    cancel.abort();
    await t.ended.opened;
    expect(answers).toEqual([{ decision: "deny", message: CANCELLED_MESSAGE }]);
    t.released.open();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(t.prompts()).toEqual([]);
  });

  it("cancels preview work when the run is interrupted and opens no late prompt", async () => {
    const answered = gate();
    const answers: PromptDecision[] = [];
    const t = await setup(async function* ({ context, input }) {
      answers.push(await context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "held", kind: "permission", detail }));
      answered.open();
      yield end();
    });
    await t.reading.opened;
    t.host.interrupt(t.runId);
    await t.ended.opened;
    await answered.opened;
    expect(answers).toEqual([{ decision: "deny", message: RUN_ENDED_MESSAGE }]);
    t.released.open();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(t.prompts()).toEqual([]);
  });
});
