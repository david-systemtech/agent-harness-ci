import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { InstallController, InstallGuidance } from "./install.js";

it("offers iOS manual guidance and explains independent Home Screen pairing storage", () => {
  const controller = new InstallController(new EventTarget(), { secure: true, standalone: false, ios: true, worker: true });
  render(<InstallGuidance controller={controller} />);
  expect(screen.getByText(/Share.*Add to Home Screen/)).toBeDefined();
  expect(screen.getByText(/separate.*pair again/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Install client" })).toBeNull();
  controller.dispose();
});

it("detects install eligibility, prompts only on a tap and leaves dismissal retry guidance", async () => {
  const events = new EventTarget();
  const controller = new InstallController(events, { secure: true, standalone: false, ios: false, worker: true });
  render(<InstallGuidance controller={controller} />);
  let prompted = false;
  const offer = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt: async () => { prompted = true; }, userChoice: Promise.resolve({ outcome: "dismissed" }) });
  await act(async () => { events.dispatchEvent(offer); });
  expect(offer.defaultPrevented).toBe(true);
  expect(prompted).toBe(false);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Install client" })); });
  expect(prompted).toBe(true);
  expect(screen.getByRole("status").textContent).toMatch(/dismissed/);
  controller.dispose();
});

it("plain HTTP only offers a shortcut with honest secure-origin limitations", () => {
  const controller = new InstallController(new EventTarget(), { secure: false, standalone: false, ios: false, worker: false });
  render(<InstallGuidance controller={controller} />);
  expect(screen.getByText(/HTTPS.*offline.*push/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Install client" })).toBeNull();
  controller.dispose();
});
