import { act, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";
import { discoverScenes, type SceneModule } from "../gallery/scene-registry.js";

it.each(["tab", "standalone"])("shows the phone conversation without installation text in %s mode", async mode => {
  vi.stubGlobal("innerWidth", 390);
  onTestFinished(() => { vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });
  const registry = discoverScenes(import.meta.glob<SceneModule>("../gallery/scenes/phone-install-conversation-*.tsx", { eager: true }));
  const name = `phone-install-conversation-${mode}`;
  expect(registry[name]?.platform).toBe("web");
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await act(async () => mountGallery(container, name, "dark", registry));
  onTestFinished(async () => { await act(async () => gallery.close()); container.remove(); });
  await act(async () => { expect(await gallery.ready).toBe(true); });
  expect(screen.getByRole("textbox", { name: "Message" })).toBeDefined();
  const frame = container.querySelector("[data-web-client]")!;
  expect(frame.textContent).not.toMatch(/Home Screen|Install client/);
  expect(frame.querySelector("[data-install-disclosure], [data-phone-install]")).toBeNull();
  expect(frame.lastElementChild?.tagName).toBe("MAIN");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  const row = within(settings).queryByText("Add to Home Screen", { exact: true });
  if (mode === "tab") expect(row).not.toBeNull();
  else expect(row).toBeNull();
});
