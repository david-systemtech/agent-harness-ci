import { act, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, onTestFinished, vi } from "vitest";
import { App } from "../app.js";
import { startWebWorld } from "../../gallery/world.js";
import { renderApp, type EnvironmentHandle } from "../../test/harness.js";
import { phoneLayout } from "../../test/phone-layout.js";

const shot = (env: EnvironmentHandle, hash = "a".repeat(64)) => {
  const session = env.sessionId();
  const { runId } = env.startRun(session, "Screenshot");
  env.emit(session, "tool.started", { runId, toolCallId: "shot", name: "mcp__desktop__screenshot", input: {}, title: null, agentId: null, parentToolCallId: null });
  env.emit(session, "tool.ended", { runId, toolCallId: "shot", status: "ok", output: [{ type: "image", hash, mediaType: "image/png", size: 7, sensitive: true }], durationMs: 1 });
};

it("waits for viewport intersection before fetching and states the gap after eviction", async () => {
  let enter: (() => void) | undefined;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      enter = () => this.callback([{ target, isIntersecting: true, intersectionRatio: 1, time: 0, rootBounds: null, boundingClientRect: target.getBoundingClientRect(), intersectionRect: target.getBoundingClientRect() }], this as unknown as IntersectionObserver);
    }
    disconnect() {}
  });
  onTestFinished(() => vi.unstubAllGlobals());
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Pictures" }] }] });
  app.open("desk");
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  const env = app.environment("desk");
  env.wire.answer("transcript.image", () => ({ result: { image: null } }));
  act(() => shot(env));
  await within(transcript).findByText("Image loading…");
  expect(env.requests("transcript.image")).toHaveLength(0);
  expect(enter).toBeDefined();
  act(() => enter!());
  await within(transcript).findByText("Image no longer retained");
  expect(env.requests("transcript.image")).toHaveLength(1);
  expect(within(transcript).queryByRole("img")).toBeNull();
});

it("blurs a sensitive screenshot on the phone until it is explicitly revealed", async () => {
  phoneLayout();
  const world = await startWebWorld({ environments: [{ name: "desk", reach: "paired", sessions: [{ title: "Pictures" }] }] }, {});
  const env = world.world.environment("desk");
  env.wire.answer("transcript.image", () => ({ result: { image: { mediaType: "image/png", data: "cGljdHVyZQ==" } } }));
  const app = render(<App {...world} web={{ platform: world.platform, route: { session: { environmentId: env.environmentId, sessionId: env.sessionId() } } }} />);
  onTestFinished(async () => { app.unmount(); await world.runtime.close(); await world.presentation.close(); });
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  act(() => shot(env));
  const image = await within(transcript).findByRole("img", { name: "Returned by mcp__desktop__screenshot" });
  expect(image.classList.contains("blur-md")).toBe(true);
  await userEvent.setup().click(within(transcript).getByRole("button", { name: "Show sensitive image" }));
  expect(image.classList.contains("blur-md")).toBe(false);
  expect(within(transcript).queryByRole("button", { name: "Show sensitive image" })).toBeNull();
});
