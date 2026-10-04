import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createRuntime } from "@agent-harness/client-runtime";
import { manualClock } from "@agent-harness/client-runtime/testing";
import { scriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, onTestFinished } from "vitest";
import { App } from "../app.js";
import { openPresentation } from "../presentation.js";
import { browserPlatform } from "./browser-platform.js";

it("pairs without a desktop shell, discloses the minted grant and opens a shared conversation", async () => {
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired", scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" }, sessions: [{ title: "Check the receipts" }] }] });
  const view = Object.assign(Object.create(window) as Window & typeof globalThis, { indexedDB: new IDBFactory() });
  const platform = { ...browserPlatform(view, "0.0.0"), clock, fetch: world.fetch, webSocket: world.webSocket };
  const runtime = createRuntime(platform);
  await runtime.start();
  const presentation = await openPresentation(platform.documents);
  presentation.set("runLocalEnvironment", false); presentation.set("firstLaunchDone", true);
  const env = world.environment("desk");
  const app = render(<App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: { pairing: { link: env.wire.link } } }} />);
  onTestFinished(async () => { app.unmount(); await runtime.close(); await presentation.close(); });
  await screen.findByText(/Scopes: read, sessions:write, runs:drive · Ceiling: acceptEdits/);
  expect(screen.queryByText(/Starting this machine/)).toBeNull();
  const user = userEvent.setup();
  await screen.findByRole("option", { name: "Check the receipts" });
  await user.selectOptions(screen.getByRole("combobox", { name: "Sessions" }), `${env.environmentId}/${env.sessionId()}`);
  await screen.findByRole("textbox", { name: "Message" });
  expect(location.hash).toContain(`/session/${env.environmentId}/${env.sessionId()}`);
  await act(async () => {
    const { runId } = env.startRun(env.sessionId(), "Check the receipts");
    env.emit(env.sessionId(), "assistant.text", { runId, itemId: "reply", text: "The receipt totals agree.", aborted: false });
  });
  await screen.findByText("The receipt totals agree.");
  await waitFor(() => expect(platform.shell).toBeUndefined());
  history.replaceState(null, "", "/");
});
