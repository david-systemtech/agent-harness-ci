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


it("opens permission Details for capture without scrolling across ancestors", async () => {
  const root = document.createElement("div"); root.id = "root";
  root.innerHTML = '<section class="phone-prompt-summary"><button>Details</button></section>';
  document.body.append(root);
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  root.querySelector("button")!.addEventListener("click", () => {
    const action = document.createElement("button"); action.setAttribute("aria-label", "Allow once"); root.append(action);
  });
  const stop = revealPermission();
  onTestFinished(() => { stop(); root.remove(); vi.restoreAllMocks(); });
  await waitFor(() => expect(root.querySelector('[data-permission-revealed]')).not.toBeNull());
  expect(scroll).not.toHaveBeenCalled();
});

it("does not open a permission request arriving after the scene was disposed", async () => {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const stop = revealPermission(); stop();
  onTestFinished(() => root.remove());
  const click = vi.fn();
  root.innerHTML = '<section class="phone-prompt-summary"><button>Details</button></section>';
  root.querySelector("button")!.addEventListener("click", click);
  await Promise.resolve();
  expect(click).not.toHaveBeenCalled();
});

it("reveals the desktop-hosted permission fixture in its dock when the request wrapper cannot scroll", async () => {
  const root = document.createElement("div"); root.id = "root";
  root.innerHTML = '<div data-composer-column><div data-composer-above><button aria-label="Allow once">Allow once</button></div></div>'; document.body.append(root);
  const dock = root.querySelector<HTMLElement>("[data-composer-column]")!, well = root.querySelector<HTMLElement>("[data-composer-above]")!, action = well.querySelector<HTMLElement>("button")!;
  dock.getBoundingClientRect = () => new DOMRect(0, 0, 300, 180);
  well.getBoundingClientRect = () => new DOMRect(0, 0, 300, 600);
  action.getBoundingClientRect = () => new DOMRect(10, 300 - dock.scrollTop, 150, 44);
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  const stop = revealPermission();
  onTestFinished(() => { stop(); root.remove(); vi.restoreAllMocks(); });
  await waitFor(() => expect(action.matches("[data-permission-revealed]")).toBe(true));
  expect(action.getBoundingClientRect().bottom).toBeLessThanOrEqual(180);
  expect(well.scrollTop).toBe(0);
  expect(scroll).not.toHaveBeenCalled();
});
