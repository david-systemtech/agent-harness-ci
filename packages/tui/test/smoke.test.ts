import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { createRuntime, writable } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../environment/test/cleanups.js";
import { end, fakeAdapter, gate, say, type Script } from "../../environment/test/fake-adapter.js";
import { startTestEnvironment } from "../../environment/test/helper.js";
import { WAIT_MS } from "../../environment/test/wire-client.js";
import { FORBIDDEN_WORDS } from "../../../eslint-rules/no-client-organisation-state.js";
import { App } from "../src/app.js";
import { DEFAULT_KEYMAP } from "../src/keys.js";
import { nodePlatform } from "../src/platform/node-platform.js";
import type { LocalService } from "../src/platform/services.js";
import type { Fault } from "../src/view.js";
import { createRuntimeHost } from "../src/runtime-host.js";
import { SIZE, SMOKE_TEST_MS } from "./harness.js";

/**
 * The smoke tests through the real spine (docs/specs/tui.md, "Testing
 * Decisions"), serial: the #108 in-process environment on a temporary data
 * directory and loopback port 0, with the scripted fake provider, and the
 * terminal UI on its real platform on a temporary state directory, reading
 * the environment's real grant file: the grant exchanged into a rendered
 * rail (#143), and a send streaming through the fake provider into a
 * rendered transcript, its draft reaching a second runtime (#146); a
 * queued message withdrawn with ↑ on an empty composer, its text back in the
 * composer and, live through the draft, in the composer of a second terminal
 * already open on the session (#231).
 */

const { onCleanup, tempDir } = useCleanups();

const until = async (condition: () => boolean, what: () => string): Promise<void> => {
  const deadline = Date.now() + WAIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${what()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const noService: LocalService = {
  installed: async () => false,
  install: async () => ({ ok: false, message: "not in the smoke test" }),
  start: async () => ({ ok: false, message: "not in the smoke test" }),
  readiness: async () => "nothing",
};

/**
 * One terminal UI on the real platform: its own label, a shared or own state
 * directory, and `session` opened at launch when given. Its `--cwd` is the
 * directory the state directory is made in, which the machine has, as the
 * environment's check of a new session's directory wants (#325).
 */
const terminal = (dataDir: string, stateDir: string, tty: string, session?: string) => {
  const platform = nodePlatform({ stateDir, dataDir, version: "0.0.0-smoke", identity: { user: "seth", host: "desk", tty } });
  const host = createRuntimeHost(() => createRuntime(platform));
  let ids = 0;
  const app = render(
    createElement(App, {
      host,
      clock: platform.clock,
      services: noService,
      grant: platform.grant,
      keymap: DEFAULT_KEYMAP,
      flags: { workspace: dirname(stateDir), session },
      faults: writable<readonly Fault[]>([]),
      size: SIZE,
      newCommandId: () => `0199ee00-0000-7000-8000-${String(++ids).padStart(12, "0")}`,
      version: platform.client.version,
      stateDir,
      cwd: stateDir,
    }),
  );
  onCleanup(async () => {
    app.unmount();
    await host.close();
  });
  void host.start();
  return {
    app,
    host,
    frame: () => app.lastFrame() ?? "",
    type: (text: string) => void app.stdin.write(text),
  };
};

/** The bytes of Enter and ↑, as a terminal sends them. */
const ENTER = "\r";
const UP = "\u001B[A";

describe.sequential("the terminal UI through the real spine", { timeout: SMOKE_TEST_MS }, () => {
  it("exchanges the grant and renders the header and the rail", async () => {
    const t = await startTestEnvironment({ name: "smoke-desk" });
    onCleanup(() => t.close());
    const stateDir = join(tempDir("agent-harness-tui-smoke-"), "tui");
    const one = terminal(t.dataDir, stateDir, "pts/1");

    await until(() => one.frame().includes("● smoke-desk ready"), one.frame);
    const rows = one.frame().split("\n");
    expect(rows[0]).toContain(`agent-harness · ● smoke-desk ready · ${dirname(stateDir)}`);
    expect(rows[1]).toMatch(/^smoke-desk\s+│/);
    expect(rows[2]).toMatch(/^\s+no sessions\s+│/);
    expect(one.host.current.read().connections.list.read()).toMatchObject([{ kind: "local", phase: "ready", scopes: expect.arrayContaining(["admin"]) }]);

    // The state directory holds the runtime's documents and nothing named after session state.
    const files = readdirSync(stateDir, { recursive: true }) as string[];
    for (const file of files) for (const word of FORBIDDEN_WORDS) expect(file.toLowerCase()).not.toContain(word);
  });

  it("runs two terminal UIs at once, both connected, each with its own tui local client session", async () => {
    const t = await startTestEnvironment({ name: "smoke-two" });
    onCleanup(() => t.close());
    const stateDir = join(tempDir("agent-harness-tui-smoke-"), "tui");
    const one = terminal(t.dataDir, stateDir, "pts/1");
    const two = terminal(t.dataDir, stateDir, "pts/2");

    await until(() => one.frame().includes("● smoke-two ready") && two.frame().includes("● smoke-two ready"), () => `${one.frame()}\n---\n${two.frame()}`);
    const runtime = one.host.current.read();
    const [local] = runtime.connections.list.read();
    const listed = await runtime.requests.call(local?.environmentId ?? "", "access.sessions.list", { live: true });
    if (!listed.ok) throw new Error(listed.error.message);
    const terminals = listed.result.sessions.filter((s) => s.kind === "tui" && s.local && s.label.startsWith("seth@desk:"));
    expect(terminals.map((s) => s.label).sort()).toEqual(["seth@desk:pts/1", "seth@desk:pts/2"]);
    expect(one.host.current.read().connections.list.read()[0]?.phase).toBe("ready");
    expect(two.host.current.read().connections.list.read()[0]?.phase).toBe("ready");
  });

  it("streams a send through the fake provider into the rendered transcript, and its draft reaches a second runtime", async () => {
    const t = await startTestEnvironment({ name: "smoke-send" });
    onCleanup(() => t.close());
    const streamed = gate();
    const script: Script = async function* () {
      yield { type: "assistant.delta", payload: { itemId: "i-1", fragments: [{ kind: "text", text: "Look" }] } };
      await streamed.opened;
      yield { type: "assistant.delta", payload: { itemId: "i-1", fragments: [{ kind: "text", text: "ing" }] } };
      yield say("Looking at the receipts.", "i-1");
      yield end();
    };
    t.adapter.nextScripts.push(script);
    const stateDir = join(tempDir("agent-harness-tui-smoke-"), "tui");
    const one = terminal(t.dataDir, stateDir, "pts/1");
    await until(() => one.frame().includes("● smoke-send ready"), one.frame);

    // The new-session card, its cursor on the terminal's own directory, the workspace preset on this machine (#334).
    one.type("/new");
    one.type(ENTER);
    await until(() => one.frame().includes("where it works") && one.frame().includes("this directory"), one.frame);
    one.type(ENTER);
    await until(() => one.frame().includes("Nothing said yet."), one.frame);
    one.type("Fix the receipts");
    one.type(ENTER);
    await until(() => one.frame().includes("▌ Fix the receipts") && one.frame().includes("● Look"), one.frame);
    streamed.open();
    await until(() => one.frame().includes("● Looking at the receipts."), one.frame);
    await until(() => /\d+ms|\d+(\.\d)?s/.test(one.frame().split("● Looking at the receipts.")[1] ?? ""), () => `the cost line under the turn:\n${one.frame()}`);

    // The draft is the session's field: typed in this terminal, it is in another runtime of the same environment.
    one.type("half a thought");
    const runtime = one.host.current.read();
    const [local] = runtime.connections.list.read();
    const environmentId = local?.environmentId ?? "";
    const sessionId = runtime.projections.sessionList.read().rows.find((row) => row.environmentId === environmentId)?.summary.id ?? "";
    const two = terminal(t.dataDir, join(tempDir("agent-harness-tui-smoke-"), "tui"), "pts/2");
    await until(() => two.frame().includes("● smoke-send ready"), two.frame);
    const other = two.host.current.read().projections.session(environmentId, sessionId);
    onCleanup(other.subscribe(() => undefined));
    await until(() => other.read().draft === "half a thought", () => `the draft in the second runtime: ${String(other.read().draft)}`);
  });

  it("withdraws a queued message with ↑ on an empty composer: its text is back in this composer and, through the draft, in a second terminal's already open", async () => {
    // A provider queue that does not steer holds the message while the turn is held open, so the withdraw takes it back from the provider.
    const t = await startTestEnvironment({ name: "smoke-withdraw", adapter: fakeAdapter({ capabilities: { steering: false } }) });
    onCleanup(() => t.close());
    const held = gate();
    const script: Script = async function* () {
      yield { type: "assistant.delta", payload: { itemId: "i-1", fragments: [{ kind: "text", text: "Look" }] } };
      await held.opened;
      yield say("Looked.", "i-1");
      yield end();
    };
    t.adapter.nextScripts.push(script);
    onCleanup(() => held.open());
    const one = terminal(t.dataDir, join(tempDir("agent-harness-tui-smoke-"), "tui"), "pts/1");
    await until(() => one.frame().includes("● smoke-withdraw ready"), one.frame);
    // The new-session card, its cursor on the terminal's own directory, the workspace preset on this machine (#334).
    one.type("/new");
    one.type(ENTER);
    await until(() => one.frame().includes("where it works") && one.frame().includes("this directory"), one.frame);
    one.type(ENTER);
    await until(() => one.frame().includes("Nothing said yet."), one.frame);
    one.type("Fix the receipts");
    one.type(ENTER);
    await until(() => one.frame().includes("● Look"), one.frame);
    one.type("and the tests");
    one.type(ENTER);
    await until(() => one.frame().includes("⧗ queued and the tests"), one.frame);

    // A second terminal already on the session, with its own runtime: the text reaches its composer live, through the draft.
    const runtime = one.host.current.read();
    const [local] = runtime.connections.list.read();
    const environmentId = local?.environmentId ?? "";
    const sessionId = runtime.projections.sessionList.read().rows.find((row) => row.environmentId === environmentId)?.summary.id ?? "";
    const two = terminal(t.dataDir, join(tempDir("agent-harness-tui-smoke-"), "tui"), "pts/2", sessionId);
    await until(() => two.frame().includes("⧗ queued and the tests"), two.frame);
    expect(two.frame()).not.toContain("› and the tests");

    one.type(UP);
    await until(() => one.frame().includes("› and the tests") && !one.frame().includes("⧗ queued and the tests"), one.frame);
    expect(t.adapter.runs[0]?.withdrawals).toHaveLength(1);
    await until(() => two.frame().includes("› and the tests") && !two.frame().includes("⧗ queued and the tests"), two.frame);
    const other = two.host.current.read().projections.session(environmentId, sessionId);
    expect(other.read().draft).toBe("and the tests");
    expect(other.read().queued).toEqual([]);
  });
});
