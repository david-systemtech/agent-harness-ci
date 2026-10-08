import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";
import { INTRODUCTION_STATES, type IntroductionState } from "../gallery/scenes/setup-introduction.js";

it.each<[string, IntroductionState]>([
  ["setup-introduction", "starting"],
  ["setup-introduction-failed", "failed"],
  ["setup-introduction-off", "off"],
  ["setup-introduction-stopped", "stopped"],
  ["setup-introduction-unavailable", "unavailable"],
])("captures %s using the real first-launch window", async (scene, state) => {
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  try {
    await screen.findByRole("heading", { name: "Welcome to agent-harness" });
    expect(await gallery.ready).toBe(true);
    await waitFor(() => expect(container.dataset["galleryReady"]).toBe(scene));
    const service = container.querySelector<HTMLElement>("[data-setup-service]")!;
    expect(within(service).getByRole(state === "failed" ? "alert" : "status").textContent).toBe(INTRODUCTION_STATES[state]);
    expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull();
    expect(screen.getByRole("button", { name: "Begin set up" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Available once agent-harness is ready.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Connect to another computer" })).toBeDefined();
    if (state === "failed") {
      expect(within(service).getByRole("button", { name: "Try again" })).toBeDefined();
      expect(within(service).getByRole("button", { name: "Copy details" })).toBeDefined();
      expect(within(service).getByText(/No user service manager is available\./)).toBeDefined();
    }
    if (state === "stopped") expect(within(service).getByRole("button", { name: "Start" })).toBeDefined();
    if (state === "off") expect(within(service).getByRole("switch", { name: "Run agent-harness on this computer" })).toBeDefined();
    expect(container.textContent).not.toContain("no-shell");
    expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: "[data-setup-frame]", height: 44 });
  } finally {
    await gallery.close();
    container.remove();
  }
});
