import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { mountGallery } from "../../gallery/mount.js";

it.each([
  ["settings-accounts", "Accounts"],
  ["settings-default-model", "Default account and model"],
  ["settings-usage", "Usage"],
])("draws %s with the real pane and measurement contract", async (scene, label) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  try {
    await waitFor(() => expect(container.dataset["galleryReady"]).toBe(scene));
    const pane = within(await screen.findByRole("region", { name: "Settings" })).getByRole("region", { name: label });
    if (scene === "settings-accounts") {
      const personal = await within(pane).findByRole("region", { name: "Personal" });
      expect(within(personal).getByText("Default")).toBeDefined();
      expect(within(personal).getAllByRole("img")).toHaveLength(2);
      expect(within(personal).getByRole("button", { name: "Relabel" }).querySelector("svg")).not.toBeNull();
    } else if (scene === "settings-default-model") {
      expect((await within(pane).findByRole("combobox", { name: "Model family" }) as HTMLSelectElement).value).toBe("sonnet");
      expect(within(pane).getByRole("region", { name: "New sessions" })).toBeDefined();
    } else {
      const pooled = await within(pane).findByRole("region", { name: "reader@example.test" });
      expect(within(pooled).getByRole("list", { name: "Accounts" }).textContent).toBe("Personal on deskTravel on laptop");
      expect(within(pooled).getAllByRole("img")).toHaveLength(2);
    }
    expect(JSON.parse(container.dataset["galleryGeometry"] ?? "null")).toEqual(expect.arrayContaining([
      { selector: 'nav[aria-label="Settings rows"]', width: 208 },
    ]));
  } finally {
    await gallery.close();
    container.remove();
  }
});
