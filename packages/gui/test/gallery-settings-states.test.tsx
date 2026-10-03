import { render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { settingsScene } from "../gallery/settings-scene.js";

it("captures read-only Settings with a named, disabled add action", async () => {
  const Scene = await settingsScene(false, "access.forges", { environments: [{ name: "desk", reach: "local", capabilities: ["forge"], scopes: ["read"] }] });
  const view = render(<Scene ladder="dark" />);
  try {
    expect((await screen.findByRole("button", { name: "Add a forge" })).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  } finally { view.unmount(); }
});

it("captures remembered Settings after the environment becomes unreachable", async () => {
  const { default: Scene } = await import("../gallery/scenes/settings-unreachable.js");
  const view = render(<Scene ladder="dark" />);
  try {
    await waitFor(() => expect(view.container.querySelector("[data-unreachable-scene-ready]")).not.toBeNull());
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getAllByText(/Unreachable since/).length).toBeGreaterThan(0);
  } finally { view.unmount(); }
});
