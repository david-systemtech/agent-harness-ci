import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { KEY, renderApp } from "../test/harness.js";
import { parseCommand } from "./commands/parse.js";

const SESSION = "0199aa00-0000-4000-8000-000000000001";
const TERMINAL = "0199aa00-0000-4000-8000-000000000003";

describe("/check", () => {
  it("parses get/off/now and preserves all command text after the syntax separator", () => {
    expect(parseCommand("/check")).toEqual({ kind: "check", action: "get" });
    expect(parseCommand("/check off")).toEqual({ kind: "check", action: "off" });
    expect(parseCommand("/check now")).toEqual({ kind: "check", action: "now" });
    expect(parseCommand("/check   pnpm test  &&\nprintf done  ")).toEqual({ kind: "check", action: "set", command: "  pnpm test  &&\nprintf done  " });
  });

  it("shows configuration, saves exact text, clears it and refuses unset/busy without sending to the model", async () => {
    const app = await renderApp({ script: { environments: [{ name: "desk", reach: "local", capabilities: ["workspaceChecks"], sessions: [{ title: "Checks", workspace: { kind: "directory", path: "/repo" } }] }] }, flags: { session: SESSION } });
    onTestFinished(() => app.unmount());
    await app.waitFor("Nothing said yet.");
    const env = app.environment("desk");
    let command: string | null = null;
    env.wire.answer("checks.get", () => ({ result: { workspace: "/repo", command } }));
    env.wire.answer("checks.set", (params) => {
      command = params["command"] as string | null;
      return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { workspace: "/repo", command } } };
    });
    let reason = "check_unset";
    env.wire.answer("checks.run", () => ({ result: { receipt: { status: "rejected", sequence: 2, changed: false, reason: "conflict", error: { code: "conflict", message: "The check cannot run.", data: { reason } } } } }));
    const enter = async (text: string) => { await app.type(text); await app.press(KEY.enter); };
    await enter("/check");
    await app.waitFor("After-edit check: off for /repo.");
    await enter("/check now");
    await app.waitFor("check_unset");
    await enter("/check pnpm test  ");
    await app.waitFor("After-edit check saved");
    expect(command).toBe("pnpm test  ");
    await enter("/check");
    await app.waitFor("After-edit check: $ pnpm test");
    reason = "check_running";
    await enter("/check now");
    await app.waitFor("check_running");
    await enter("/check off");
    await app.waitFor("After-edit check: off.");
    expect(command).toBeNull();
    expect(env.wire.server.received().filter((f) => f.type === "request" && f.method === "runs.start")).toHaveLength(0);
  });

  it("draws a truncated timeout, offers Send failure, and sends only on empty Enter after preserving typed text", async () => {
    const app = await renderApp({ script: { environments: [{ name: "desk", reach: "local", capabilities: ["workspaceChecks"], sessions: [{ title: "Checks", workspace: { kind: "directory", path: "/repo" } }] }] }, flags: { session: SESSION } });
    onTestFinished(() => app.unmount());
    await app.waitFor("Nothing said yet.");
    const env = app.environment("desk");
    env.wire.answer("checks.get", () => ({ result: { workspace: "/repo", command: "pnpm test" } }));
    await app.type("/check"); await app.press(KEY.enter);
    await app.waitFor("pnpm test");
    await app.type("untouched draft");
    env.emit(SESSION, "checks.started", { terminalId: TERMINAL, command: "pnpm test", sourceRunId: null });
    env.emit(SESSION, "checks.finished", { terminalId: TERMINAL, command: "pnpm test", sourceRunId: null, output: "failed assertion", truncated: true, exitCode: null, signal: null, timedOut: true, failure: null });
    await app.waitFor("Send failure");
    expect(app.frame()).toContain("untouched draft");
    expect(app.frame()).toContain("timeout");
    expect(app.frame()).toContain("truncated");
    expect(env.wire.server.received().filter((f) => f.type === "request" && f.method === "runs.start")).toHaveLength(0);
    await app.press(KEY.ctrlU);
    await app.press(KEY.enter);
    await app.waitFor("steer or queue a message");
    expect(env.wire.server.received()).toContainEqual(expect.objectContaining({ method: "runs.start", params: expect.objectContaining({ text: expect.stringContaining("failed assertion") }) }));
  });
});

it("streams a running check through the Environment terminal subscription and releases it on finish", async () => {
  const app = await renderApp({ script: { environments: [{ name: "desk", reach: "local", capabilities: ["workspaceChecks"], sessions: [{ title: "Checks" }], terminals: [{ id: TERMINAL, output: "live check output" }] }] }, flags: { session: SESSION } });
  onTestFinished(() => app.unmount());
  await app.waitFor("Nothing said yet.");
  const env = app.environment("desk");
  env.emit(SESSION, "checks.started", { terminalId: TERMINAL, command: "pnpm test", sourceRunId: null });
  await app.waitFor("live check output");
  expect(env.requests("terminals.subscribe")).toHaveLength(1);
  env.terminalOutput(TERMINAL, "\nmore check output");
  await app.waitFor("more check output");
  env.emit(SESSION, "checks.finished", { terminalId: TERMINAL, command: "pnpm test", sourceRunId: null, output: "durable check output", truncated: false, exitCode: 0, signal: null, timedOut: false, failure: null });
  await app.waitFor("durable check output");
  expect(app.frame()).toContain("pass");
  expect(env.requests("terminals.run")).toHaveLength(0);
  expect(env.server.received()).toContainEqual({ type: "unsubscribe", subscription: expect.any(String) });
});

it("shows imported text as inert and leaves now unset until an explicit save", async () => {
  const app = await renderApp({ script: { environments: [{ name: "desk", reach: "local", capabilities: ["workspaceChecks"], sessions: [{ title: "Checks", workspace: { kind: "directory", path: "/repo" } }] }] }, flags: { session: SESSION } });
  onTestFinished(() => app.unmount());
  await app.waitFor("Nothing said yet.");
  mkdirSync(join(app.stateDir, "documents"), { recursive: true });
  writeFileSync(join(app.stateDir, "documents", "terminal.afterEdit.json"), JSON.stringify({ "/repo": "imported command" }));
  const env = app.environment("desk");
  env.wire.answer("checks.get", () => ({ result: { workspace: "/repo", command: null } }));
  env.wire.answer("checks.run", () => ({ error: { code: "conflict", message: "check_unset", data: { reason: "check_unset" } } }));
  await app.type("/check"); await app.press(KEY.enter);
  await app.waitFor("inert");
  expect(app.frame()).toContain("imported command");
  await app.type("/check now"); await app.press(KEY.enter);
  await app.waitFor("check_unset");
  expect(env.requests("checks.set")).toHaveLength(0);
  expect(env.requests("runs.start")).toHaveLength(0);
});

it("Send failure on a check row preserves a nonempty composer", async () => {
  const app = await renderApp({ script: { environments: [{ name: "desk", reach: "local", capabilities: ["workspaceChecks"], sessions: [{ title: "Checks" }] }] }, flags: { session: SESSION } });
  onTestFinished(() => app.unmount());
  await app.waitFor("Nothing said yet.");
  const env = app.environment("desk");
  env.wire.answer("checks.get", () => ({ result: { workspace: "/repo", command: "pnpm test" } }));
  await app.type("/check"); await app.press(KEY.enter);
  await app.waitFor("pnpm test");
  await app.type("keep this draft");
  env.emit(SESSION, "checks.finished", { terminalId: TERMINAL, command: "pnpm test", sourceRunId: null, output: "assertion failed", truncated: false, exitCode: 2, signal: null, timedOut: false, failure: null });
  await app.waitFor("Send failure");
  await app.press(KEY.tab, KEY.tab, KEY.up);
  await app.waitFor("The transcript has the keys");
  await app.press(KEY.enter);
  expect(env.requests("runs.start")).toHaveLength(0);
  await app.press("s");
  await app.waitFor("Check failure; exit 2");
  expect(app.frame()).toContain("keep this draft");
  expect(env.requests("runs.start")).toContainEqual(expect.objectContaining({ params: expect.objectContaining({ text: expect.stringContaining("assertion failed") }) }));
});

it("names the after-edit check in the line above the composer when the Environment cannot run it (#1826)", async () => {
  const app = await renderApp({ script: { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Checks", workspace: { kind: "directory", path: "/repo" } }] }] }, flags: { session: SESSION } });
  onTestFinished(() => app.unmount());
  await app.waitFor("After-edit check: ");
  expect(app.frame()).not.toMatch(/(^|\s)Check: /m);
});
