import { afterEach, expect, it } from "vitest";
import type { SkillReadiness } from "@agent-harness/contracts";
import { KEY, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

const SESSION = "0199aa00-0000-4000-8000-000000000001";
let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const setup: SkillReadiness = {
  name: "tdd", state: "setup-needed", declaredBy: "sidecar",
  failing: [
    { check: { kind: "file", paths: ["CONTEXT.md"] }, outcome: "failed", message: "CONTEXT.md is missing." },
    { check: { kind: "tool", command: "pnpm" }, outcome: "failed", message: "pnpm is missing." },
  ],
  why: "The project needs its domain model.", fix: "/setup-project",
};

const launch = async (extra: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({
    script: { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }], commands: [
      { kind: "skill", name: "tdd", description: "Build with tests", invocation: "model+slash", origin: null, alwaysOn: false, argumentHint: null },
    ], ...extra }] },
    flags: { session: SESSION },
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  return { app, env: app.environment("desk") };
};

it("marks setup needed, explains the highlighted skill, and sends it despite the warning", async () => {
  const { app, env } = await launch();
  env.wire.answer("skills.readiness", () => ({ result: { skills: [setup] } }));
  env.notice("skills.updated", {});
  await app.type("/tdd");
  await app.waitFor("setup needed");
  expect(app.frame()).toContain("The project needs its domain model.");
  expect(app.frame()).toContain("Fix: /setup-project");
  expect(app.frame()).not.toContain("pnpm is missing.");
  await app.press(KEY.enter);
  await app.waitFor("▌ /tdd");
  expect(env.requests("runs.start")[0]?.params).toMatchObject({ sessionId: SESSION, text: "/tdd" });
  expect(env.requests("skills.readiness").at(-1)?.params).toEqual({ sessionId: SESSION });
});

it("keeps readiness on /skill: aliases and hides setup details when another row is highlighted", async () => {
  const { app, env } = await launch({ commands: [
    { kind: "skill", name: "tdd", description: "Build with tests", invocation: "model+slash", origin: null, alwaysOn: false, argumentHint: null },
    { kind: "skill", name: "trust", description: "Review repository trust", invocation: "slash-only", origin: null, alwaysOn: false, argumentHint: null },
  ] });
  env.wire.answer("skills.readiness", () => ({ result: { skills: [setup, { ...setup, name: "trust" }] } }));
  env.notice("skills.updated", {});
  await app.type("/tdd");
  await app.waitFor("The project needs its domain model.");
  await app.press(KEY.ctrlU);
  await app.type("/tr");
  await app.waitFor("Review repository trust");
  expect(app.frame()).not.toContain("The project needs its domain model.");
  await app.press(KEY.ctrlU);
  await app.type("/skill:trust");
  await app.waitFor("Fix: /setup-project");
  expect(app.frame()).toContain("slash-only");
  await app.press(KEY.enter);
  await app.waitFor("▌ /skill:trust");
  expect(env.requests("runs.start")[0]?.params).toMatchObject({ text: "/skill:trust" });
  expect(env.requests("trust.decide")).toEqual([]);
});

it("refreshes an unsupported skill's reason, and keeps its invocation advisory", async () => {
  const { app, env } = await launch();
  let readiness: SkillReadiness = setup;
  env.wire.answer("skills.readiness", () => ({ result: { skills: [readiness] } }));
  env.notice("skills.updated", {});
  await app.type("/tdd");
  await app.waitFor("setup needed");
  readiness = {
    name: "tdd", state: "unsupported", declaredBy: "overlay",
    failing: [{ check: { kind: "provider", providers: ["claude"] }, outcome: "failed", message: "This account is unsupported." }],
    why: "Needs the Claude provider.", fix: null,
  };
  env.notice("skills.updated", {});
  await app.waitFor("Needs the Claude provider.");
  expect(app.frame()).not.toContain("setup needed");
  await app.press(KEY.enter);
  await app.waitFor("▌ /tdd");
  expect(env.requests("runs.start")[0]?.params).toMatchObject({ text: "/tdd" });
});

it("refreshes the menu's readiness when repository trust changes the session's set", async () => {
  const { app, env } = await launch();
  let readiness: SkillReadiness = setup;
  env.wire.answer("skills.readiness", () => ({ result: { skills: [readiness] } }));
  env.notice("skills.updated", {});
  await app.type("/tdd");
  await app.waitFor("setup needed");
  const before = env.requests("skills.readiness").length;
  readiness = { name: "tdd", state: "ready", declaredBy: null };
  env.notice("trust.updated", {});
  await app.waitUntil(() => env.requests("skills.readiness").length > before && !app.frame().includes("setup needed"), "the changed trust to refresh readiness");
  expect(app.frame()).toContain("Build with tests");
  expect(app.frame()).not.toContain("The project needs its domain model.");
});
