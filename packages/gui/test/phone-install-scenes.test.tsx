import { render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { discoverScenes, type SceneModule } from "../gallery/scene-registry.js";

it.each(["install", "update", "denial"])("draws the phone-install-%s scene with the actual web leaf", async mode => {
  const registry = discoverScenes(import.meta.glob<SceneModule>("../gallery/scenes/phone-install-*.tsx", { eager: true }));
  const scene = registry[`phone-install-${mode === "install" ? "guidance" : mode}`]!;
  const Scene = scene.default!;
  render(<Scene ladder="dark" />);
  expect(scene.platform).toBe("web");
  expect(screen.getByRole("region", { name: "Home Screen installation" })).toBeDefined();
  if (mode === "update") expect(screen.getByRole("button", { name: "Reload client" })).toBeDefined();
  if (mode === "denial") await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/unavailable or denied/));
});
