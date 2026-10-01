// @vitest-environment jsdom-on-node
import { act, render, waitFor } from "@testing-library/react";
import { createRuntime, uuidv4 } from "@agent-harness/client-runtime";
import { inMemoryPlatform } from "@agent-harness/client-runtime/testing";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../environment/test/cleanups.js";
import { callHostTool, end, fakeAdapter } from "../../environment/test/fake-adapter.js";
import { startTestEnvironment } from "../../environment/test/helper.js";
import { workspace } from "../../environment/test/sessions.js";
import { WAIT_MS } from "../../environment/test/wire-client.js";
import type { HostToolResult } from "../../environment/src/adapter/contract.js";
import { App } from "../src/app.js";
import { showSession } from "../src/grid/layout.js";
import { openPresentation } from "../src/presentation.js";
import { dockPeer } from "./dock-peer.js";

const { onCleanup } = useCleanups();

describe("the dock over the relay seam", () => {
  it("takes a remote provider's snapshot and click to the dock peer, using the home policy", async () => {
    const { shell, peer } = dockPeer();
    const desk = await startTestEnvironment({ name: "desk" });
    const adapter = fakeAdapter();
    const server = await startTestEnvironment({ name: "server", adapter });
    onCleanup(async () => {
      await server.close();
      await desk.close();
    });
    const platform = inMemoryPlatform({
      kind: "desktop",
      shell,
      grant: { read: async () => desk.grant() },
    });
    const runtime = createRuntime(platform);
    onCleanup(() => runtime.close());
    await runtime.start();
    await runtime.connections.add({
      link: (await server.createPairing()).link,
    });
    const presentation = await openPresentation(platform.documents, platform.reportError);
    presentation.set("firstLaunchDone", true);
    onCleanup(() => presentation.close());
    const view = render(<App runtime={runtime} presentation={presentation} clock={platform.clock} version={platform.client.version} macOS={false} shell={shell} />);
    onCleanup(() => view.unmount());
    const sessionId = uuidv4();
    expect(
      await runtime.commands.dispatch(server.env.id, "sessions.create", {
        id: sessionId,
        workspace,
        browser: { value: { kind: "dock" }, chosenBy: "person" },
      }),
    ).toMatchObject({ ok: true });
    act(() => {
      const layout = presentation.values.read().paneLayout;
      presentation.set(
        "paneLayout",
        showSession(layout, layout.focused, {
          environmentId: server.env.id,
          sessionId,
        }),
      );
    });
    peer.inPage("snapshotFrame", () => ({
      nodes: [{ role: "button", name: "Continue", ref: "e1" }],
      lastRef: 1,
    }));
    peer.inPage("locateElement", () => ({
      kind: "found",
      x: 50,
      y: 80,
      editable: false,
    }));
    const answers: HostToolResult[] = [];
    adapter.nextScripts.push(async function* (controls) {
      answers.push(
        yield* callHostTool(controls, {
          server: "browser",
          name: "browser_open",
          input: { address: "https://example.org/", snapshot: false },
        }),
      );
      answers.push(
        yield* callHostTool(controls, {
          server: "browser",
          name: "browser_snapshot",
          input: {},
        }),
      );
      answers.push(
        yield* callHostTool(controls, {
          server: "browser",
          name: "browser_click",
          input: { ref: "e1", snapshot: false },
        }),
      );
      yield end();
    });
    expect(
      await runtime.commands.dispatch(server.env.id, "runs.start", {
        sessionId,
        text: "Look at the dock",
      }),
    ).toMatchObject({ ok: true });
    await waitFor(() => expect(answers).toHaveLength(3), { timeout: WAIT_MS });
    expect(answers.map((answer) => answer.isError)).toEqual([false, false, false]);
    expect(answers[1]!.text).toContain('button "Continue"');
    expect(peer.sentOf("Input.dispatchMouseEvent").map(({ params }) => params["type"])).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    const calls = server.env.log.readStream({ kind: "environment", id: server.env.id }).filter((event) => event.type === "client.call");
    expect(calls.map((event) => event.payload["kind"])).toEqual(["browser.dock", "browser.dock", "browser.dock"]);
    expect(shell.calls.some(([name]) => name === "webView.attach")).toBe(false);
    expect(runtime.requests.cached(desk.env.id, "permissions.denylist.get", {}).read().result).not.toBeNull();
    expect(runtime.requests.cached(server.env.id, "permissions.denylist.get", {}).read().result).toBeNull();
  });
});
