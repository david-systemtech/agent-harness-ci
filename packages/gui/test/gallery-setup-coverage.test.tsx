import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { StepId } from "@agent-harness/contracts";
import { expect, it } from "vitest";
import { setupRegionScene } from "../gallery/setup-regions-scene.js";

it("captures the real Account gate with disabled Skip and Continue", async () => {
  const Scene = setupRegionScene("account");
  const view = render(<Scene ladder="dark" />);
  try {
    await screen.findByRole("heading", { name: "Account", level: 2 });
    const footer = screen.getByRole("navigation", { name: "Step navigation" });
    expect(within(footer).getByRole("button", { name: "Skip for now" }).hasAttribute("disabled")).toBe(true);
    expect(within(footer).getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("Optional")).toHaveLength(10);
  } finally { view.unmount(); }
});


it.each<[StepId, string]>([["your-machines", "Your machines"], ["forges", "Forges"], ["key-manager", "Key manager"], ["instructions", "Instructions"], ["permissions", "Permissions"], ["appearance", "Appearance"]])("captures the real %s card and its persistent footer", async (step, label) => {
  const Scene = setupRegionScene(step);
  const view = render(<Scene ladder="light" />);
  try {
    await screen.findByRole("heading", { name: label, level: 2 });
    const footer = screen.getByRole("navigation", { name: "Step navigation" });
    expect(within(footer).getByRole("button", { name: "Back" })).toBeTruthy();
    expect(within(footer).getByRole("button", { name: "Skip for now" }).hasAttribute("disabled")).toBe(false);
    expect(within(footer).getByRole("button", { name: step === "appearance" ? "Finish" : "Continue" })).toBeTruthy();
  } finally { view.unmount(); }
});

it("captures the one-time close confirmation without completing set up", async () => {
  const Scene = setupRegionScene("close-confirmation");
  const view = render(<Scene ladder="dark" />);
  try {
    const dialog = await screen.findByRole("dialog", { name: "Leave set up without an account?" });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep setting up" })));
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Keep setting up" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "Account", level: 2 })).toBeTruthy();
  } finally { view.unmount(); }
});

it("captures the ready introduction before the owner enters Account", async () => {
  const { default: Scene } = await import("../gallery/scenes/setup-introduction-ready.js");
  const view = render(<Scene ladder="light" />);
  try {
    expect((await screen.findByRole("button", { name: "Begin set up" })).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("The environment on this machine is ready")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Step navigation" })).toBeNull();
  } finally { view.unmount(); }
});
