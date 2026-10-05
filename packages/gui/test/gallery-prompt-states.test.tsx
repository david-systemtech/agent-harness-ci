import type { PromptKind } from "@agent-harness/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, onTestFinished, vi } from "vitest";
import { activate as revealPermission } from "../gallery/scenes/phone-gallery-permission.js";
import { PromptScene } from "../gallery/prompt-scene.js";

it.each<PromptKind>(["permission", "question", "plan", "denylist"])("captures %s while sending, after a refusal and once settled", async (kind) => {
  for (const state of ["busy", "error", "settled"] as const) {
    const view = render(<PromptScene kind={kind} state={state} ladder="dark" />);
    try {
      await waitFor(() => expect(view.container.querySelector(`[data-prompt-state="${state}"]`)).not.toBeNull());
      if (state === "error") expect(screen.getByRole("region", { name: "Parked prompt" }).textContent).toContain("Not answered: The prompt was already answered.");
      else expect(screen.queryByRole("region", { name: "Parked prompt" })).toBeNull();
      if (state === "settled") expect(screen.getByRole("article", { name: kind === "plan" ? "Plan" : kind === "question" ? "Question" : "Permission" })).toBeTruthy();
    } finally { view.unmount(); }
  }
});


it("keeps the permission action inside its scroll area after fonts change the card height", async () => {
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  let finishFonts!: () => void;
  const ready = new Promise<void>(resolve => { finishFonts = resolve; });
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready } });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const root = document.createElement("div"); root.id = "root";
  root.innerHTML = '<div data-composer-above><button aria-label="Allow once">Allow once</button></div>';
  document.body.append(root);
  const well = root.querySelector<HTMLElement>("[data-composer-above]")!, action = well.querySelector<HTMLElement>("button")!;
  let cardBottom = 164;
  well.getBoundingClientRect = () => new DOMRect(0, 0, 300, 120);
  action.getBoundingClientRect = () => new DOMRect(10, cardBottom - well.scrollTop - 44, 150, 44);
  action.scrollIntoView = () => { well.scrollTop = Math.round(cardBottom - 120); };
  const stop = revealPermission();
  onTestFinished(() => {
    stop(); root.remove(); vi.unstubAllGlobals();
    if (originalFonts === undefined) Reflect.deleteProperty(document, "fonts");
    else Object.defineProperty(document, "fonts", originalFonts);
  });
  // The last layout grows by one pixel after the initial nearest-edge scroll.
  cardBottom = 165; finishFonts(); await Promise.resolve();
  for (let frame = 0; frame < 12; frame++) { frames.shift()?.(frame); await Promise.resolve(); }
  expect(action.getBoundingClientRect().bottom).toBeLessThanOrEqual(well.getBoundingClientRect().bottom + 0.5);
  expect(action.matches('[data-permission-revealed]')).toBe(true);
});


it("does not reveal a disposed permission scene when its fonts finish loading", async () => {
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  let finishFonts!: () => void;
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: new Promise<void>(resolve => { finishFonts = resolve; }) } });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const root = document.createElement("div"); root.id = "root";
  root.innerHTML = '<button aria-label="Allow once">Allow once</button>'; document.body.append(root);
  const action = root.querySelector<HTMLButtonElement>("button")!;
  const scroll = vi.spyOn(action, "scrollIntoView");
  const stop = revealPermission();
  onTestFinished(() => {
    stop(); root.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    if (originalFonts === undefined) Reflect.deleteProperty(document, "fonts");
    else Object.defineProperty(document, "fonts", originalFonts);
  });
  frames.shift()?.(0); await Promise.resolve();
  stop(); root.remove(); finishFonts(); await Promise.resolve();
  for (let frame = 0; frame < 12; frame++) { frames.shift()?.(frame); await Promise.resolve(); }
  expect(scroll).not.toHaveBeenCalled();
  expect(action.matches('[data-permission-revealed]')).toBe(false);
});
