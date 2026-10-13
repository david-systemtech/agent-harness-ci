import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";
import * as backgroundWait from "../gallery/scenes/session-background-wait.js";

it("captures background waiting both during and between turns, in every session indicator", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const gallery = await mountGallery(root, "session-background-wait", "dark", { "session-background-wait": backgroundWait });
  try {
    await gallery.ready;
    expect(await screen.findAllByRole("status", { name: "Run activity" })).toHaveLength(2);
    for (const activity of screen.getAllByRole("status", { name: "Run activity" })) {
      expect(activity.textContent).toBe("Waiting on 3 background agents");
      expect(activity.parentElement!.textContent).toContain("12m 00s");
    }
    expect(within(screen.getByRole("banner")).getByRole("img", { name: "Running · waiting on background work" })).toBeTruthy();
    for (const caption of root.querySelectorAll<HTMLElement>("[data-pane-caption]")) {
      expect(within(caption).getByRole("img", { name: "Running · waiting on background work" })).toBeTruthy();
    }
    for (const line of screen.getAllByRole("region", { name: "Status line" })) {
      expect(within(line).getByText("Waiting on 3 background agents")).toBeTruthy();
    }
  } finally {
    await gallery.close();
    root.remove();
  }
});
