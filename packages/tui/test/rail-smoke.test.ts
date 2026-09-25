import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { createRuntime, writable } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../environment/test/cleanups.js";
import { startTestEnvironment } from "../../environment/test/helper.js";
import { App } from "../src/app.js";
import { DEFAULT_KEYMAP } from "../src/keys.js";
import { nodePlatform } from "../src/platform/node-platform.js";
import type { LocalService } from "../src/platform/services.js";
import { createRuntimeHost } from "../src/runtime-host.js";
import type { Fault } from "../src/view.js";
import { KEY, SIZE } from "./harness.js";

/**
 * The rail through the real spine (docs/specs/tui.md, "Testing Decisions"),
 * serial: the in-process environment on a temporary data directory and
 * loopback port 0, and the terminal UI on its real platform, driven by real
 * key bytes. It is the verify-first of #145: that `sessions.create` accepts
 * a `directory` workspace from the terminal UI, and that the rail's keys
 * reach the environment's own deciders (a pin, a group created with a
 * client-minted id and the move into it).
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

describe.sequential("the rail through the real spine", () => {
  it("starts a session in a directory workspace from Enter on the environment's heading, then pins it and moves it into a new group", async () => {
    const t = await startTestEnvironment({ name: "smoke-rail" });
    onCleanup(() => t.close());
    const stateDir = join(tempDir("agent-harness-tui-rail-"), "tui");
    const workspace = tempDir("agent-harness-rail-workspace-");
    const platform = nodePlatform({ stateDir, dataDir: t.dataDir, version: "0.0.0-smoke", identity: { user: "seth", host: "desk", tty: "pts/4" } });
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
        faults: writable<readonly Fault[]>([]),
        size: SIZE,
        newCommandId: () => `0199ee00-0000-7000-8000-${String(++ids).padStart(12, "0")}`,
      }),
    );
    onCleanup(async () => {
      app.unmount();
      await host.close();
    });
    void host.start();
    const frame = () => app.lastFrame() ?? "";
    const press = async (...keys: string[]) => {
      for (const bytes of keys) {
        app.stdin.write(bytes);
        await new Promise((resolve) => setTimeout(resolve, bytes === KEY.esc ? 40 : 15));
      }
    };
    const shows = (text: string) => until(() => frame().replace(/\s+/g, " ").includes(text), frame);

    await shows("● smoke-rail ready");
    await press(KEY.tab);
    await shows("Enter starts a session on smoke-rail");
    await press(KEY.enter);
    await shows("New session on smoke-rail: its account");
    await press(KEY.enter);
    await shows("New session on smoke-rail: its model");
    await press(KEY.enter);
    await shows("New session on smoke-rail: where it works");
    app.stdin.write(workspace);
    await shows(`${workspace} typed`);
    await press(KEY.enter);
    await shows("› ●SR · New session");

    const runtime = host.current.read();
    const [local] = runtime.connections.list.read();
    const environmentId = local?.environmentId ?? "";
    const listed = await runtime.requests.call(environmentId, "sessions.list", {});
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.result.sessions).toEqual([expect.objectContaining({ title: "New session", workspace: { kind: "directory", path: workspace } })]);

    // A path the machine does not have is taken as given: the workspace is not checked when the session is created.
    const missing = join(workspace, "not-there");
    await press(KEY.up);
    await shows("Enter starts a session on smoke-rail");
    await press(KEY.enter, KEY.enter, KEY.enter);
    await shows("where it works");
    app.stdin.write(missing);
    await shows(`${missing} typed`);
    await press(KEY.enter);
    await until(() => (runtime.projections.sessionList.read().rows.length === 2), frame);
    expect(runtime.projections.sessionList.read().rows.map((r) => r.summary.workspace.path).sort()).toEqual([missing, workspace].sort());

    await press("p");
    await shows("Pinned “New session”.");
    await press("g");
    app.stdin.write("Smoke");
    await shows("New group Smoke");
    await press(KEY.enter);
    await shows("Moved “New session” into a new group Smoke.");
    await until(() => runtime.projections.sessionList.read().groups.some((g) => g.name === "Smoke"), frame);
    const [sessions, groups] = await Promise.all([runtime.requests.call(environmentId, "sessions.list", {}), runtime.requests.call(environmentId, "groups.list", {})]);
    if (!sessions.ok || !groups.ok) throw new Error("the lists could not be read");
    const smoke = groups.result.groups.find((g) => g.name === "Smoke");
    expect(smoke?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    const moved = sessions.result.sessions.find((s) => s.groupId === smoke?.id);
    expect(moved?.pinnedAt).not.toBeNull();
  });
});
