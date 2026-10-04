// @vitest-environment jsdom-on-node
import { randomUUID } from "node:crypto";
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createRuntime, writable } from "@agent-harness/client-runtime";
import { inMemoryPlatform } from "@agent-harness/client-runtime/testing";
import { scriptedCdpPeer } from "@agent-harness/browser/testing";
import { expect, it } from "vitest";
import { useCleanups } from "../../../environment/test/cleanups.js";
import { callHostTool, end, fakeAdapter } from "../../../environment/test/fake-adapter.js";
import { startTestEnvironment } from "../../../environment/test/helper.js";
import { workspace } from "../../../environment/test/sessions.js";
import { WAIT_MS } from "../../../environment/test/wire-client.js";
import type { HostToolResult } from "../../../environment/src/adapter/contract.js";
import { App } from "../app.js";
import { openPresentation } from "../presentation.js";

const { onCleanup } = useCleanups();

it("a Phone grant chooses headless and sends a provider's browser verb to the environment's scripted CDP peer", async () => {
  const peer = scriptedCdpPeer();
  onCleanup(() => peer.close());
  const endpoint = await peer.listen();
  const adapter = fakeAdapter();
  const server = await startTestEnvironment({ adapter, browser: { resolve: async () => [{ address: "93.184.215.14", family: 4 }] } });
  onCleanup(() => server.close());
  const admin = await server.client();
  onCleanup(() => admin.close());
  await admin.apply("settings.update", { commandId: randomUUID(), values: { "browser.headless.endpoint": endpoint } });
  const platform = { ...inMemoryPlatform({ kind: "web" }), persistence: writable<"persistent" | "visit-only">("persistent") };
  const runtime = createRuntime(platform);
  onCleanup(() => runtime.close());
  await runtime.start();
  const pairing = await server.createPairing({ scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits" });
  expect(await runtime.connections.add({ link: pairing.link })).toMatchObject({ status: "paired" });
  const sessionId = randomUUID();
  expect(await runtime.commands.dispatch(server.env.id, "sessions.create", { id: sessionId, workspace })).toMatchObject({ ok: true });
  const presentation = await openPresentation(platform.documents);
  onCleanup(() => presentation.close());
  presentation.set("firstLaunchDone", true);
  const app = render(<App runtime={runtime} presentation={presentation} clock={platform.clock} version={platform.client.version} macOS={false} web={{ platform, route: { session: { environmentId: server.env.id, sessionId } } }} />);
  onCleanup(() => app.unmount());
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Environment browser" }));
  await waitFor(() => expect(screen.getByRole("option", { name: "Headless browser" }).hasAttribute("disabled")).toBe(false));
  await user.selectOptions(screen.getByRole("combobox", { name: "Browser for the next run" }), "1");
  await screen.findByText("Browser set to Headless browser for the next run.");
  await user.click(screen.getByRole("button", { name: "Close browser" }));
  const answers: HostToolResult[] = [];
  peer.document("https://news.example/", { title: "News" });
  adapter.nextScripts.push(async function* (controls) {
    answers.push(yield* callHostTool(controls, { server: "browser", name: "browser_open", input: { address: "https://news.example/", snapshot: false } }));
    yield end();
  });
  await act(async () => {
    expect(await runtime.commands.dispatch(server.env.id, "runs.start", { sessionId, text: "Open the news page" })).toMatchObject({ ok: true });
  });
  await waitFor(() => expect(answers).toHaveLength(1), { timeout: WAIT_MS });
  expect(answers[0]).toMatchObject({ isError: false });
  expect(peer.targets().find(target => target.type === "page")?.url).toBe("https://news.example/");
  expect(server.env.log.readStream({ kind: "session", id: sessionId }).find(event => event.type === "run.browser.resolved")?.payload).toMatchObject({ browser: { kind: "headless" }, reason: "chosen" });
  expect(runtime.capability(server.env.id, "shell.webView").status).toBe("absent");
});
