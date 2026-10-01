import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter, end, gate, say } from "../../test/fake-adapter.js";
import { startTestEnvironment } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { WAIT_MS } from "../../test/wire-client.js";

const { onCleanup } = useCleanups();

const writeOwn = (t: Awaited<ReturnType<typeof startTestEnvironment>>, path: string, text: string): void => {
  const file = join(t.dataDir, "skills", "own", path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};
const skill = (name: string, extra = "") => `---\nname: ${name}\ndescription: Test skill.\n${extra}---\nFollow this skill.\n`;


// Primary seam: the real environment and client, with the provider recording its input.
describe("slash resolution", () => {
  it("hands the provider its invocation and keeps the typed text and skill on message.sent", async () => {
    const t = await startTestEnvironment({ adapter: fakeAdapter({ commands: [] }) });
    onCleanup(() => t.close());
    const file = join(t.dataDir, "skills", "own", "skills", "tdd", "SKILL.md");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "---\nname: tdd\ndescription: Test-first development.\n---\nTest first.\n");
    const client = await t.client();
    const { id } = await create(client);
    const answer = await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "/tdd  the feature\nkeep spacing" });
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(1), { timeout: WAIT_MS });
    expect(t.adapter.lastRun().input.prompt[0]?.text).toBe("/agent-harness:tdd  the feature\nkeep spacing");
    expect(t.env.log.readStream({ kind: "session", id }).find((event) => event.type === "message.sent")?.payload).toMatchObject({
      runId: answer.result?.runId,
      text: "/tdd  the feature\nkeep spacing",
      skill: { name: "tdd", origin: null },
    });
  });
  it.each([
    ["/compact now", "/compact now", undefined],
    ["/skill:compact now", "/agent-harness:compact now", "compact"],
    ["/skill:tdd\tfeature", "/agent-harness:tdd\tfeature", "tdd"],
    ["/review branch", "/agent-harness:review branch", "review"],
    ["/disabled now", "/disabled now", undefined],
    ["/skill:disabled now", "/skill:disabled now", undefined],
    ["/background now", "/background now", undefined],
    ["/skill:background now", "/skill:background now", undefined],
    ["/missing now", "/missing now", undefined],
    ["/skill:missing now", "/skill:missing now", undefined],
    ["prefix /tdd", "prefix /tdd", undefined],
    [" /tdd", " /tdd", undefined],
    ["/tdd-more", "/tdd-more", undefined],
    ["/tdd", "/agent-harness:tdd", "tdd"],
  ])("resolves %s by precedence and member eligibility", async (typed, handed, name) => {
    const t = await startTestEnvironment({ adapter: fakeAdapter({ commands: [{ name: "compact", description: "Compact.", builtin: true }] }) });
    onCleanup(() => t.close());
    writeOwn(t, "skills/tdd/SKILL.md", skill("tdd", "disable-model-invocation: true\n"));
    writeOwn(t, "skills/compact/SKILL.md", skill("compact"));
    writeOwn(t, "skills/disabled/SKILL.md", skill("disabled"));
    writeOwn(t, "skills/background/SKILL.md", skill("background", "user-invocable: false\n"));
    writeOwn(t, "commands/review.md", "---\ndescription: Review.\n---\nReview the branch.\n");
    const client = await t.client();
    await client.request("skills.setEnabled", { commandId: randomUUID(), name: "disabled", accountId: null, enabled: false });
    const { id } = await create(client);
    await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: typed });
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(1), { timeout: WAIT_MS });
    expect(t.adapter.lastRun().input.prompt[0]?.text).toBe(handed);
    const payload = t.env.log.readStream({ kind: "session", id }).find((event) => event.type === "message.sent")?.payload;
    expect(payload?.["text"]).toBe(typed);
    if (name === undefined) expect(payload).not.toHaveProperty("skill");
    else expect(payload?.["skill"]).toEqual({ name, origin: null });
  });

  it.each([true, false])("resolves queued sends and read-now with providerQueue=%s", async (providerQueue) => {
    const held = gate();
    const t = await startTestEnvironment({ adapter: fakeAdapter({ commands: [], capabilities: { providerQueue, steering: false }, script: async function* () { await held.opened; yield end(); } }) });
    onCleanup(() => t.close());
    writeOwn(t, "skills/tdd/SKILL.md", skill("tdd"));
    const client = await t.client();
    const { id } = await create(client);
    await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Start" });
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(1), { timeout: WAIT_MS });
    const sent = await client.request("runs.send", { commandId: randomUUID(), sessionId: id, text: "/skill:tdd queued" });
    expect(sent.result?.delivery).toBe("queued");
    if (providerQueue) {
      await vi.waitFor(() => expect(t.adapter.runs[0]?.sent[0]?.text).toBe("/agent-harness:tdd queued"), { timeout: WAIT_MS });
    }
    expect(t.env.log.readStream({ kind: "session", id }).find((event) => event.type === "message.sent" && event.payload["messageId"] === sent.result?.messageId)?.payload).toMatchObject({
      text: "/skill:tdd queued", skill: { name: "tdd", origin: null },
    });
    await client.request("runs.readNow", { commandId: randomUUID(), sessionId: id });
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(2), { timeout: WAIT_MS });
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["/agent-harness:tdd queued"]);
    held.open();
  });

  it("resolves runs.send when it starts a run", async () => {
    const t = await startTestEnvironment({ adapter: fakeAdapter({ commands: [] }) });
    onCleanup(() => t.close());
    writeOwn(t, "commands/review.md", "---\ndescription: Review.\n---\nReview.\n");
    const client = await t.client();
    const { id } = await create(client);
    await client.request("runs.send", { commandId: randomUUID(), sessionId: id, text: "/review branch" });
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(1), { timeout: WAIT_MS });
    expect(t.adapter.lastRun().input.prompt[0]?.text).toBe("/agent-harness:review branch");
    expect(t.env.log.readStream({ kind: "session", id }).find((event) => event.type === "message.sent")?.payload).toMatchObject({ text: "/review branch", skill: { name: "review", origin: null } });
  });

  it("invokes a native member by its bare name and records its repository origin", async () => {
    const origin = { kind: "repository", repository: "https://example.com/team/repo", path: ".claude/skills/release" } as const;
    const t = await startTestEnvironment({ adapter: fakeAdapter({ commands: [] }), adapterSeams: { skillSet: async () => ({
      generation: null, fingerprint: "native-release", hiddenNativeNames: [], members: [{
        name: "release", description: "Release.", native: true, origin, invocation: "model+slash", alwaysOn: false, argumentHint: null, userInvocable: true,
      }],
    }) } });
    onCleanup(() => t.close());
    const client = await t.client();
    const { id } = await create(client);
    await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "/skill:release v1" });
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(1), { timeout: WAIT_MS });
    expect(t.adapter.lastRun().input.prompt[0]?.text).toBe("/release v1");
    expect(t.env.log.readStream({ kind: "session", id }).find((event) => event.type === "message.sent")?.payload["skill"]).toEqual({ name: "release", origin });
  });

  it("keeps a live run's set for sends, then resolves a fresh set when its queue is read", async () => {
    const held = gate();
    const t = await startTestEnvironment({ adapter: fakeAdapter({ commands: [], capabilities: { providerQueue: false, steering: false }, script: async function* () { yield say("Working"); await held.opened; yield end(); } }) });
    onCleanup(() => t.close());
    writeOwn(t, "skills/tdd/SKILL.md", skill("tdd"));
    const client = await t.client();
    const { id } = await create(client);
    await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Start" });
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(1), { timeout: WAIT_MS });
    await client.request("skills.setEnabled", { commandId: randomUUID(), name: "tdd", accountId: null, enabled: false });
    const sent = await client.request("runs.send", { commandId: randomUUID(), sessionId: id, text: "/tdd queued" });
    expect(t.env.log.readStream({ kind: "session", id }).find((event) => event.type === "message.sent" && event.payload["messageId"] === sent.result?.messageId)?.payload["skill"]).toEqual({ name: "tdd", origin: null });
    held.open();
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(2), { timeout: WAIT_MS });
    expect(t.adapter.lastRun().input.prompt[0]?.text).toBe("/tdd queued");
  });

  it("retains slash resolution on a provider-opened turn and its later sends", async () => {
    const first = gate();
    const later = gate();
    const t = await startTestEnvironment({ adapter: fakeAdapter({ commands: [], capabilities: { providerQueue: true, steering: false } }) });
    onCleanup(() => t.close());
    t.adapter.nextScripts.push(async function* () { yield say("First"); await first.opened; yield end(); });
    t.adapter.nextScripts.push(async function* () { yield say("Second"); await later.opened; yield end(); });
    writeOwn(t, "skills/tdd/SKILL.md", skill("tdd"));
    const client = await t.client();
    const { id } = await create(client);
    await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Start" });
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(1), { timeout: WAIT_MS });
    await client.request("runs.send", { commandId: randomUUID(), sessionId: id, text: "/tdd first" });
    await vi.waitFor(() => expect(t.adapter.runs[0]?.sent[0]?.text).toBe("/agent-harness:tdd first"), { timeout: WAIT_MS });
    first.open();
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(2), { timeout: WAIT_MS });
    expect(t.adapter.lastRun().adopted).toBe(true);
    expect(t.adapter.lastRun().input.prompt[0]?.text).toBe("/agent-harness:tdd first");
    await client.request("runs.send", { commandId: randomUUID(), sessionId: id, text: "/skill:tdd second" });
    await vi.waitFor(() => expect(t.adapter.lastRun().sent[0]?.text).toBe("/agent-harness:tdd second"), { timeout: WAIT_MS });
    later.open();
  });

});
