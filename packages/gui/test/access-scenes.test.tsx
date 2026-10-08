import { userEvent } from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each([
  ["settings-key-managers", "Key managers", "Project keys", "Add a key manager", 1400, 1352],
  ["settings-key-managers", "Key managers", "Project keys", "Add a key manager", 1024, 976],
  ["settings-forges", "Forges", "https://git.example.test", "Add a forge", 1400, 1352],
  ["settings-forges", "Forges", "https://git.example.test", "Add a forge", 1024, 976],
] as const)("renders %s over the runtime with measured cards and inline Add", async (scene, name, card, add, width, dialogWidth) => {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("innerHeight", width === 1400 ? 900 : 768);
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe(scene));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  const pane = within(settings).getByRole("region", { name });
  const connection = await within(pane).findByRole("region", { name: card });
  expect(within(connection).getByText("Verified")).toBeDefined();
  if (scene === "settings-key-managers") {
    expect(within(connection).queryByRole("group", { name: "Policies runs receive" })).toBeNull();
    expect(await within(pane).findByRole("region", { name: "Move stored tokens" })).toBeDefined();
  }
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toEqual(expect.arrayContaining([
    { selector: "[data-settings-dialog]", width: dialogWidth, height: width === 1400 ? 852 : 660 },
    { selector: "[data-access-card]", paddingLeft: 12, paddingTop: 12 },
    { selector: "[data-access-card] button", height: 28 },
    { selector: "[data-access-card] header > svg", width: 16, height: 16 },
  ]));
  await userEvent.setup().click(within(pane).getByRole("button", { name: add }));
  const form = await within(pane).findByRole("region", { name: `${add} on desk` });
  // A forge's kind is found from its address; it asks for one only where it cannot (setup-copy.md §5.6).
  if (scene === "settings-forges") expect(within(form).queryAllByRole("radio")).toHaveLength(0);
  else expect(within(form).getAllByRole("radio").length).toBeGreaterThan(2);
  expect(within(form).getByRole("textbox", { name: scene === "settings-forges" ? "Address of the site or of one of your repositories" : "Label" })).toBeDefined();
  await userEvent.setup().click(within(form).getByRole("button", { name: "Cancel" }));
  expect(within(pane).queryByRole("region", { name: `${add} on desk` })).toBeNull();
});
