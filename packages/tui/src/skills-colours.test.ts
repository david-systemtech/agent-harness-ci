import { afterEach, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { renderApp, type RenderedApp } from "../test/harness.js";

let app: RenderedApp | undefined;
afterEach(async () => app?.unmount());

it("dims the unsupported skill's invocation as well as its reason", async () => {
  app = await renderApp({
    script: { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }], commands: [
      { kind: "skill", name: "tdd", description: "Build with tests", invocation: "model+slash", origin: null, alwaysOn: false, argumentHint: null },
    ] }] },
    flags: { session: "0199aa00-0000-4000-8000-000000000001" },
  });
  await app.waitFor("Nothing said yet.");
  const env = app.environment("desk");
  env.wire.answer("skills.readiness", () => ({ result: { skills: [{
    name: "tdd", state: "unsupported", declaredBy: "overlay", why: "Needs Claude.", fix: null,
    failing: [{ check: { kind: "provider", providers: ["claude"] }, outcome: "failed", message: "Needs Claude." }],
  }] } }));
  env.notice("skills.updated", {});
  await app.type("/tdd");
  await app.waitFor("Needs Claude.");
  const row = app.frame().split("\n").find((line) => line.includes("Build with tests"));
  expect(row?.split("/tdd")[0]).toContain("\u001B[2m");
});
