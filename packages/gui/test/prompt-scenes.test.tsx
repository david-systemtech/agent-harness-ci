import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

it("the permission error scene keeps its refusal and decisions outside the scrolling request", async () => {
  for (const ladder of ["light", "dark"] as const) {
    const container = document.createElement("div");
    document.body.append(container);
    const gallery = await mountGallery(container, "prompt-permission-error", ladder);
    close = gallery.close;
    expect(await gallery.ready).toBe(true);
    const card = screen.getByRole("region", { name: "Parked prompt" });
    const decisions = within(card).getByRole("group", { name: "Permission decision" });
    expect(within(decisions).getByRole("status").textContent).toBe("Not answered: The prompt was already answered.");
    expect(within(decisions).getByRole("textbox", { name: "Note" })).toBeTruthy();
    for (const name of ["Deny", "Allow once", "Allow for this session"]) expect(within(decisions).getByRole("button", { name })).toBeTruthy();
    expect(within(card).getByRole("region", { name: "Permission request" }).textContent).toContain("Check 20");
    const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]");
    expect(geometry).toContainEqual({ selector: '[aria-label="Permission decision"] [role="status"]', visibleWithin: '[aria-label="Parked prompt"]' });
    await gallery.close();
    close = undefined;
    container.remove();
  }
});

it.each(["permission", "question", "plan", "denylist"] as const)("draws the %s prompt scene and its measured controls in both ladders", async (kind) => {
  for (const ladder of ["light", "dark"] as const) {
    const container = document.createElement("div");
    document.body.append(container);
    const gallery = await mountGallery(container, `prompt-${kind}`, ladder);
    close = gallery.close;
    const card = await screen.findByRole("region", { name: "Parked prompt" });
    expect(within(card).getByRole("textbox", { name: "Note" })).toHaveProperty("rows", 2);
    expect(within(card).getByRole("button", { name: "Hide request" }).getAttribute("aria-expanded")).toBe("true");
    for (const button of within(card).getAllByRole("button")) expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    if (kind === "question") expect(within(card).getAllByRole("radio")).toHaveLength(2);
    if (kind === "denylist") {
      expect(within(card).getByRole("button", { name: "Allow once" })).toBeTruthy();
      expect(within(card).queryByRole("button", { name: "Allow for this session" })).toBeNull();
      expect(within(card).getByRole("list", { name: "On the denylist" }).textContent).toContain("private-key");
    }
    expect(await gallery.ready).toBe(true);
    await waitFor(() => expect(container.dataset["galleryReady"]).toBe(`prompt-${kind}`));
    const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]") as { selector: string; height?: number }[];
    expect(geometry).toContainEqual({ selector: '[aria-label="Parked prompt"] button', height: 28 });
    expect(geometry).toContainEqual({ selector: '[aria-label="Parked prompt"] header > svg', width: 14, height: 14 });
    if (kind === "plan") expect(geometry).toContainEqual({ selector: '[aria-label="Plan body"]', maxHeight: 416, visibleWithin: '[aria-label="Parked prompt"]' });
    if (kind === "permission") {
      expect(geometry).toContainEqual({ selector: '[aria-label="Arguments"]', height: 224, viewport: 1400 });
      expect(geometry).toContainEqual({ selector: '[aria-label="Permission decision"]', visibleWithin: '[aria-label="Parked prompt"]' });
    }
    for (const check of geometry) expect(container.querySelector(check.selector)).not.toBeNull();
    await gallery.close();
    close = undefined;
    container.remove();
  }
});
