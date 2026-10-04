import { userEvent } from "@testing-library/user-event";
import { act, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });
it.each(["machines", "access"])("shows the actual Phone grant on %s without requiring admin", async kind => {
  vi.stubGlobal("innerWidth", 390);
  const container = document.createElement("div"); document.body.append(container);
  await act(async () => { const gallery = await mountGallery(container, `phone-connections-${kind}`); close = gallery.close; });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  const grant = await within(settings).findByRole("note", { name: "This client's grant" });
  expect(grant.textContent).toContain("read, sessions:write and runs:drive");
  expect(grant.textContent).toContain("acceptEdits");
  expect(grant.textContent).toContain("re-pair");
});

it("refuses a mixed HTTP link and retains the manual fields", async () => {
  vi.stubGlobal("innerWidth", 390);
  const container = document.createElement("div"); document.body.append(container);
  await act(async () => { const gallery = await mountGallery(container, "phone-connections-machines"); close = gallery.close; });
  const form = await screen.findByRole("form", { name: "Pair by link" });
  const user = userEvent.setup();
  await user.type(within(form).getByRole("textbox", { name: "Pairing link" }), "http://environment.example.test/pair#K7Q2MXH4RT");
  await user.click(within(form).getByRole("button", { name: "Pair" }));
  expect(await screen.findByText(/HTTP connections are unavailable in the browser/)).toBeDefined();
  expect(screen.getByRole("textbox", { name: "Pairing code" })).toBeDefined();
});

it("Custom cannot grant a missing scope or a ceiling above the minter", async () => {
  vi.stubGlobal("innerWidth", 390);
  const container = document.createElement("div"); document.body.append(container);
  await act(async () => { const gallery = await mountGallery(container, "phone-connections-custom"); close = gallery.close; });
  const scopes = await screen.findByRole("group", { name: "Scopes" });
  expect((within(scopes).getByRole("checkbox", { name: "terminal" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(scopes).getByRole("checkbox", { name: "admin" }) as HTMLButtonElement).disabled).toBe(false);
  const part = screen.getByRole("region", { name: "Pair another client" });
  const ceiling = within(part).getByRole("combobox", { name: "Ceiling" });
  expect((within(ceiling).getByRole("option", { name: "bypassPermissions" }) as HTMLOptionElement).disabled).toBe(true);
});
