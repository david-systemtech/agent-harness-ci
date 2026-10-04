import { userEvent } from "@testing-library/user-event";
import { act, screen, within, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
import { webModule as cameraModule } from "../platform/web-camera.js";
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
it("a trusted admin can save separate client and connection origins", async () => {
  vi.stubGlobal("innerWidth", 390);
  const container = document.createElement("div"); document.body.append(container);
  await act(async () => { const gallery = await mountGallery(container, "phone-connections-custom"); close = gallery.close; });
  const clients = await screen.findByRole("textbox", { name: "Allowed client origins" });
  const user = userEvent.setup();
  await user.type(clients, "https://client.example.test:8443");
  await user.type(screen.getByRole("textbox", { name: "Allowed connection origins" }), "https://second.example.test");
  await user.click(screen.getByRole("button", { name: "Save origins" }));
  expect(await screen.findByText(/Origins saved/)).toBeDefined();
});

it("reopening origins preserves a saved client list when only connections are edited", async () => {
  vi.stubGlobal("innerWidth", 390);
  const container = document.createElement("div"); document.body.append(container);
  await act(async () => { const gallery = await mountGallery(container, "phone-connections-custom"); close = gallery.close; });
  const user = userEvent.setup();
  await user.type(await screen.findByRole("textbox", { name: "Allowed client origins" }), "https://client.example.test");
  await user.click(screen.getByRole("button", { name: "Save origins" }));
  await screen.findByText(/Origins saved/);
  await user.click(screen.getByRole("button", { name: "Close Settings" }));
  await user.click(screen.getByRole("button", { name: "Settings" }));
  const clients = await screen.findByRole("textbox", { name: "Allowed client origins" });
  await waitFor(() => expect((clients as HTMLTextAreaElement).value).toBe("https://client.example.test"));
  await user.type(screen.getByRole("textbox", { name: "Allowed connection origins" }), "https://second.example.test");
  await user.click(screen.getByRole("button", { name: "Save origins" }));
  await screen.findByText(/Origins saved/);
  expect((clients as HTMLTextAreaElement).value).toBe("https://client.example.test");
});

it("touch cancellation from the Settings pairing form restores manual entry and stops the camera", async () => {
  vi.stubGlobal("innerWidth", 390); vi.stubGlobal("isSecureContext", true);
  const stop = vi.fn();
  const previous = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const container = document.createElement("div"); document.body.append(container);
  await act(async () => {
    const gallery = await mountGallery(container, "phone-connections-machines");
    if (!("persistence" in gallery.world.platform)) throw new Error("Expected the browser platform.");
    const dispose = cameraModule.registration.start?.(gallery.world.runtime, gallery.world.platform);
    close = async () => {
      dispose?.(); await gallery.close(); vi.restoreAllMocks();
      if (previous) Object.defineProperty(navigator, "mediaDevices", previous);
      else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    };
  });
  const user = userEvent.setup();
  const pairing = await screen.findByRole("dialog", { name: "Settings" });
  await user.click(within(pairing).getByRole("button", { name: "Scan a QR" }));
  const camera = document.querySelector<HTMLDialogElement>(".web-camera")!;
  expect(pairing.contains(camera)).toBe(true);
  const cancel = camera.querySelector<HTMLButtonElement>("button")!;
  expect(getComputedStyle(cancel).pointerEvents).toBe("auto");
  await user.pointer([{ keys: "[TouchA>]", target: cancel }, { keys: "[/TouchA]", target: cancel }]);
  expect(stop).toHaveBeenCalledOnce();
  expect(document.querySelector(".web-camera")).toBeNull();
  expect(within(pairing).getByRole("textbox", { name: "Pairing code" })).toBeDefined();
});
