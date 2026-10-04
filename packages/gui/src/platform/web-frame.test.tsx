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
  const runId = await act(async () => {
    const { runId } = env.startRun(env.sessionId(), "Check the receipts");
    env.emit(env.sessionId(), "assistant.delta", { runId, itemId: "reply", fragments: [{ kind: "text", text: "The receipt totals agree. " }] });
    return runId;
  });
  await waitFor(() => expect(screen.getAllByRole("article", { name: "Reply" }).at(-1)?.textContent).toBe("The receipt totals agree. "));
  await act(async () => {
    env.emit(env.sessionId(), "assistant.text", { runId, itemId: "reply", text: "The receipt totals agree.", aborted: false });
    env.endRun(env.sessionId(), runId);
    const next = env.startRun(env.sessionId(), "Check the next receipt");
    env.emit(env.sessionId(), "assistant.delta", { runId: next.runId, itemId: "next-reply", fragments: [{ kind: "text", text: "The next receipt agrees. " }] });
  });
  await waitFor(() => expect(screen.getAllByRole("article", { name: "Reply" }).at(-1)?.textContent).toBe("The next receipt agrees. "));
  await waitFor(() => expect(platform.shell).toBeUndefined());
  const incoming = new URL(env.wire.link);
  app.rerender(<App key="new-pairing-visit" runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: { pairing: { address: incoming.origin, code: incoming.hash.slice(1) } } }} />);
  await screen.findByDisplayValue(env.wire.link);
  expect(screen.getByText(/Scopes: read, sessions:write, runs:drive · Ceiling: acceptEdits/)).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Pair" }));
  await user.click(await screen.findByRole("button", { name: "Pair again" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Pair with this environment" })).toBeNull());


  history.replaceState(null, "", "/");
});
