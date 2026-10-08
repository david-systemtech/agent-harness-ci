import { afterEach, expect, it } from "vitest";
import { TrustDecision, type TrustOffer, type TrustState } from "@agent-harness/contracts";
import { KEY, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

const SESSION = "0199aa00-0000-4000-8000-000000000001";
const SECOND = "0199aa00-0000-4000-8000-000000000002";
const REPOSITORY = "https://forge.test/milo/receipts";
const OFFER: TrustOffer = {
  instructionFiles: ["AGENTS.md", "CLAUDE.md"],
  skillRoots: [{ root: ".agents/skills", directory: ".", members: 3 }, { root: ".claude/skills", directory: ".", members: 2 }],
  commands: 4, hooks: [{ event: "PreToolUse", hooks: 2 }, { event: "SessionStart", hooks: 1 }],
  permissionRules: { allow: 2, ask: 1, deny: 3 }, subagents: 1,
  mcpServers: [{ name: "repo-tools", loaded: false }],
};
let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const launch = async (extra: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({
    script: { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }, { title: "Parser" }], ...extra }] },
    flags: { session: SESSION },
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  const env = app.environment("desk");
  let decision: TrustState = "undecided";
  let offer = OFFER;
  env.wire.answer("trust.get", () => ({ result: { key: REPOSITORY, keyKind: "identity", decision, offer } }));
  env.wire.answer("trust.decide", (params) => {
    decision = TrustDecision.parse(params["decision"]);
    env.notice("trust.updated", {});
    return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, record: {
      key: REPOSITORY, keyKind: "identity", decision, decidedAt: app.clock.now().toISOString(),
      clientSessionId: "fake-client-session", clientLabel: "Milo's terminal", sessionId: params["sessionId"],
    } } };
  });
  env.notice("trust.updated", {});
  return { app, env, decide: (next: TrustState) => { decision = next; env.notice("trust.updated", {}); }, offer: (next: TrustOffer) => { offer = next; env.notice("trust.updated", {}); } };
};

it("counts the repository's offer above the composer and lets a message go ahead undecided", async () => {
  const { app, env } = await launch();
  await app.waitFor("Trust https://forge.test/milo/receipts?");
  const frame = app.frame().replace(/\s+/g, " ");
  for (const count of ["2 instructions", "5 skills", "4 commands", "3 hooks", "6 permission rules", "1 subagent", "1 MCP server not loaded", "/trust", "/trust decline"]) expect(frame).toContain(count);
  expect(frame.indexOf("Trust https://forge.test/milo/receipts?")).toBeLessThan(frame.indexOf("›"));
  await app.type("Fix the parser");
  await app.press(KEY.enter);
  await app.waitFor("▌ Fix the parser");
  expect(env.requests("runs.start")[0]?.params).toMatchObject({ text: "Fix the parser" });
  expect(app.frame()).toContain("Trust https://forge.test/milo/receipts?");
});

it.each(["trusted", "declined"] as const)("records %s and removes the question in both sessions sharing its key", async (decision) => {
  const { app, env } = await launch();
  await app.waitFor("Trust https://forge.test/milo/receipts?");
  await app.type(decision === "trusted" ? "/trust" : "/trust decline");
  await app.press(KEY.enter);
  await app.waitUntil(() => !app.frame().includes("Trust https://forge.test/milo/receipts?"), "the trust question to disappear");
  await app.waitFor(`Repository trust set to ${decision}.`);
  expect(env.requests("trust.decide")[0]?.params).toMatchObject({ sessionId: SESSION, decision, commandId: expect.any(String) });
  expect(env.requests("runs.start")).toEqual([]);
  await app.type("/resume");
  await app.press(KEY.enter);
  await app.waitFor("Sessions");
  await app.type("Parser");
  await app.press(KEY.enter);
  await app.waitUntil(() => env.requests("trust.get").some((request) => request.params["sessionId"] === SECOND), "the second session's trust to be read");
  await app.tick(2);
  expect(app.frame()).not.toContain("Trust https://forge.test/milo/receipts?");
});

it.each(["/trust", "/trust decline"])("explains why %s needs admin without sending a decision or a run", async (command) => {
  const { app, env } = await launch({ scopes: ["read", "sessions:write", "runs:drive"] });
  await app.waitFor("Trust https://forge.test/milo/receipts?");
  await app.type(command);
  await app.press(KEY.enter);
  await app.waitFor("Cannot decide repository trust:");
  expect(app.frame()).toContain("so it cannot change settings");
  expect(app.frame()).toContain("Trust https://forge.test/milo/receipts?");
  expect(env.requests("trust.decide")).toEqual([]);
  expect(env.requests("runs.start")).toEqual([]);
});

it("removes a cached question in every session when another client declines the shared key", async () => {
  const { app, env, decide } = await launch();
  await app.waitFor("Trust https://forge.test/milo/receipts?");
  await app.type("/resume");
  await app.press(KEY.enter);
  await app.waitFor("Sessions");
  await app.type("Parser");
  await app.press(KEY.enter);
  await app.waitUntil(() => env.requests("trust.get").some((request) => request.params["sessionId"] === SECOND), "the second session to read trust");
  await app.waitFor("Trust https://forge.test/milo/receipts?");
  decide("declined");
  await app.waitUntil(() => !app.frame().includes("Trust https://forge.test/milo/receipts?"), "the other client's decision to remove the question");
  await app.type("/resume");
  await app.press(KEY.enter);
  await app.waitFor("Sessions");
  await app.type("Receipts");
  await app.press(KEY.enter);
  await app.tick(3);
  expect(app.frame()).not.toContain("Trust https://forge.test/milo/receipts?");
});

it("asks nothing for an empty offer, including one with only MCP servers", async () => {
  const { app, env, offer } = await launch();
  await app.waitFor("Trust https://forge.test/milo/receipts?");
  offer({ instructionFiles: [], skillRoots: [], commands: 0, hooks: [], permissionRules: { allow: 0, ask: 0, deny: 0 }, subagents: 0, mcpServers: OFFER.mcpServers });
  await app.waitUntil(() => !app.frame().includes("Trust https://forge.test/milo/receipts?"), "the empty offer to remove the question");
  env.wire.answer("trust.get", () => ({ result: { key: null, keyKind: null, decision: "undecided", offer: null } }));
  env.notice("trust.updated", {});
  await app.tick(3);
  expect(app.frame()).not.toContain("/trust or /trust decline");
});
