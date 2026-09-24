import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { createRuntime, writable } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../environment/test/cleanups.js";
import { startTestEnvironment } from "../../environment/test/helper.js";
import { FORBIDDEN_WORDS } from "../../../eslint-rules/no-client-organisation-state.js";
import { App } from "../src/app.js";
import { DEFAULT_KEYMAP } from "../src/keys.js";
import { nodePlatform } from "../src/platform/node-platform.js";
import type { LocalService } from "../src/platform/services.js";
import { createRuntimeHost } from "../src/runtime-host.js";
import { SIZE } from "./harness.js";

/**
 * The smoke test through the real spine (docs/specs/tui.md, "Testing
 * Decisions"), serial: the #108 in-process environment on a temporary data
 * directory and loopback port 0, and the terminal UI on its real platform on
 * a temporary state directory, reading the environment's real grant file.
 * The second smoke test, a send streaming into a transcript, is #146's.
 */

const { onCleanup, tempDir } = useCleanups();

const WAIT_MS = 5000;
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

/** One terminal UI on the real platform: its own label, a shared or own state directory. */
const terminal = (dataDir: string, stateDir: string, tty: string) => {
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
      flags: { workspace: "~/code" },
      faults: writable<readonly string[]>([]),
      size: SIZE,
      newCommandId: () => `0199ee00-0000-7000-8000-${String(++ids).padStart(12, "0")}`,
    }),
  );
  onCleanup(async () => {
    app.unmount();
    await host.close();
  });
  void host.start();
  return { app, host, frame: () => app.lastFrame() ?? "" };
};

describe.sequential("the terminal UI through the real spine", () => {
  it("exchanges the grant and renders the header and the rail", async () => {
    const t = await startTestEnvironment({ name: "smoke-desk" });
    onCleanup(() => t.close());
    const stateDir = join(tempDir("agent-harness-tui-smoke-"), "tui");
    const one = terminal(t.dataDir, stateDir, "pts/1");

    await until(() => one.frame().includes("● smoke-desk ready"), one.frame);
    const rows = one.frame().split("\n");
    expect(rows[0]).toContain("agent-harness · ● smoke-desk ready · ~/code");
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
});
