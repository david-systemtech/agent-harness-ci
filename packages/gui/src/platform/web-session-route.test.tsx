import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createRuntime } from "@agent-harness/client-runtime";
import { manualClock } from "@agent-harness/client-runtime/testing";
import { scriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, onTestFinished, vi } from "vitest";
import { App } from "../app.js";
import { openPresentation } from "../presentation.js";
import { browserPlatform, type BrowserPlatform } from "./browser-platform.js";
import { sessionLink, type BrowserRoute } from "./browser-boot.js";

const pairedClient = async (cold = false, narrow = false) => {
  if (narrow) {
    const original = window.matchMedia;
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("matchMedia", (query: string) => query === "(width < 640px)"
      ? Object.assign(new EventTarget(), { media: query, matches: true, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
    onTestFinished(() => { vi.unstubAllGlobals(); });
  }
  history.replaceState(null, "", "/");
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired", sessions: [{ title: "First conversation" }, { title: "Second conversation" }] }] });
  const env = world.environment("desk");
  const first = { environmentId: env.environmentId, sessionId: env.sessionId(0) };
  const second = { environmentId: env.environmentId, sessionId: env.sessionId(1) };
  const view = Object.assign(Object.create(window) as Window & typeof globalThis, { indexedDB: new IDBFactory() });
  const platform: BrowserPlatform = { ...browserPlatform(view, "0.0.0"), clock,
    fetch: (url, request) => world.fetch(url.replace(/^https:/, "http:"), request),
    webSocket: (url, handlers) => world.webSocket(url.replace(/^wss:/, "ws:"), handlers),
  };
  const runtime = createRuntime(platform);
  await runtime.start();
  const presentation = await openPresentation(platform.documents);
  presentation.set("runLocalEnvironment", false); presentation.set("firstLaunchDone", true);
  const route: BrowserRoute = { pairing: { link: env.wire.link.replace(/^http:/, "https:") }, ...(cold ? { session: first } : {}) };
  if (cold) history.replaceState(null, "", sessionLink(first));
  const app = render(<App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route }} />);
  onTestFinished(async () => { app.unmount(); await runtime.close(); await presentation.close(); history.replaceState(null, "", "/"); });
  await waitFor(() => expect(runtime.projections.sessionList.read().rows).toHaveLength(2));
  const navigate = async (link: string) => { await act(async () => { location.hash = new URL(link, location.origin).hash; }); };
  const selected = (session: typeof first) => waitFor(() => narrow
    ? expect(document.querySelector("[data-header-session-title]")?.textContent).toBe(env.summary(session.sessionId).title)
    : expect(screen.getByRole("combobox", { name: "Sessions" })).toHaveProperty("value", `${session.environmentId}/${session.sessionId}`));
  return { env, first, second, navigate, selected, app, presentation, runtime, clock };
};

it("opens session hashes in a freshly paired document and switches back with drafts and live replies intact", async () => {
  const { env, first, second, navigate, selected } = await pairedClient();
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  await navigate(sessionLink(first));
  await selected(first);
  await within(await screen.findByRole("region", { name: "Transcript" })).findByText("Nothing said yet.");
  const user = userEvent.setup();
  await user.type(await screen.findByRole("textbox", { name: "Message" }), "First draft");
  const runId = await act(async () => {
    const { runId } = env.startRun(first.sessionId, "First request");
    env.emit(first.sessionId, "assistant.delta", { runId, itemId: "first-reply", fragments: [{ kind: "text", text: "First live reply " }] });
    return runId;
  });
  await waitFor(() => expect(screen.getAllByRole("article", { name: "Reply" }).at(-1)?.textContent).toBe("First live reply"));
  await navigate(sessionLink(second));
  await selected(second);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", ""));
  expect(within(screen.getByRole("region", { name: "Transcript" })).queryByText("First live reply")).toBeNull();
  await user.type(screen.getByRole("textbox", { name: "Message" }), "Second draft");
  await act(async () => { env.emit(first.sessionId, "assistant.delta", { runId, itemId: "first-reply", fragments: [{ kind: "text", text: "continues " }] }); });
  await navigate(sessionLink(first));
  await selected(first);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "First draft"));
  await waitFor(() => expect(screen.getAllByRole("article", { name: "Reply" }).at(-1)?.textContent).toBe("First live reply continues"));
  expect(env.liveRun(first.sessionId)).toBe(runId);
  await navigate(sessionLink(second));
  await selected(second);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "Second draft"));
  expect(location.hash).toBe(new URL(sessionLink(second), location.origin).hash);
});

it.each([
  { hash: "#/session/%/missing", message: "This session link is malformed. Open a session from Sessions." },
  { hash: "#/unrecognized", message: "This session link is malformed. Open a session from Sessions." },
  { hash: "#/session/unknown-environment/unknown-session", message: "This environment is not paired. Pair with it or open a session from Sessions." },
  { hash: "unknown-session", message: "This session is unavailable. Open a session from Sessions." },
])("explains $hash without silently replacing it with the previous conversation's URL", async ({ hash, message }) => {
  const { first, second, navigate, selected } = await pairedClient(true);
  await selected(first);
  const destination = hash === "unknown-session" ? `#/session/${first.environmentId}/unknown-session` : hash;
  await navigate(`/${destination}`);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", message);
  expect(location.hash).toBe(destination);
  await selected(first);
  await navigate(sessionLink(second));
  await selected(second);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("keeps the session shell when following another session hash and returning", async () => {
  const { env, first, second, navigate, selected } = await pairedClient(true);
  await selected(first);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("textbox", { name: "Message" }));
  await user.keyboard("/terminal{Enter}");
  await screen.findByRole("region", { name: "Terminal" });
  await waitFor(() => expect(env.terminals()).toHaveLength(1));
  const terminalId = env.terminals()[0]!.id;
  await act(async () => env.terminalOutput(terminalId, "retained shell\r\n"));
  await waitFor(() => expect(screen.getByLabelText("Terminal screen").textContent).toContain("retained shell"));
  await navigate(sessionLink(second));
  await selected(second);
  expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
  await navigate(sessionLink(first));
  await selected(first);
  await screen.findByRole("region", { name: "Terminal" });
  await waitFor(() => expect(screen.getByLabelText("Terminal screen").textContent).toContain("retained shell"));
  expect(env.terminals().map(terminal => terminal.id)).toEqual([terminalId]);
});

it("lets choosing another session dismiss a bad link and restore its canonical URL", async () => {
  const { first, second, navigate, selected } = await pairedClient(true);
  await selected(first);
  await navigate(`/#/session/${first.environmentId}/unknown-session`);
  await screen.findByRole("alert");
  await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Sessions" }), `${second.environmentId}/${second.sessionId}`);
  await selected(second);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(location.hash).toBe(new URL(sessionLink(second), location.origin).hash);
});


it("lets the phone drawer replace a refused session link", async () => {
  const { first, second, navigate, selected } = await pairedClient(true, true);
  await selected(first);
  await navigate(`/#/session/${first.environmentId}/unknown-session`);
  await screen.findByRole("alert");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Show sessions" }));
  const drawer = await screen.findByRole("dialog", { name: "Sessions" });
  await user.click(within(drawer).getByText("Second conversation"));
  await selected(second);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(location.hash).toBe(new URL(sessionLink(second), location.origin).hash);
});
