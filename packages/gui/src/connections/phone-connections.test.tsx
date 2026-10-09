import { SCOPES } from "@agent-harness/contracts";
import type { SceneRegistry } from "../../gallery/scene-registry.js";
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
  expect(await screen.findByText("Use the other computer's HTTPS pairing link or HTTPS address. This page cannot connect over HTTP.")).toBeDefined();
  expect((within(form).getByRole("textbox", { name: "Pairing link" }) as HTMLInputElement).value).toBe("http://environment.example.test/pair#K7Q2MXH4RT");
});

it("Custom cannot grant a missing scope or a ceiling above the minter", async () => {
  vi.stubGlobal("innerWidth", 390);
  const container = document.createElement("div"); document.body.append(container);
  await act(async () => { const gallery = await mountGallery(container, "phone-connections-custom"); close = gallery.close; });
  const scopes = await screen.findByRole("group", { name: "What it can do" });
  expect((within(scopes).getByRole("checkbox", { name: "Use terminals, files and changes" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(scopes).getByRole("checkbox", { name: "Change settings and sign in accounts" }) as HTMLButtonElement).disabled).toBe(false);
  const part = screen.getByRole("region", { name: "Pair another client" });
  const ceiling = within(part).getByRole("radiogroup", { name: "How much may its agents do without asking?" });
  expect((within(ceiling).getByRole("radio", { name: "Never ask" }) as HTMLButtonElement).disabled).toBe(true);
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
  await user.click(within(pairing).getByRole("button", { name: "Scan a QR code" }));
  const camera = document.querySelector<HTMLDialogElement>(".web-camera")!;
  expect(pairing.contains(camera)).toBe(true);
  const cancel = camera.querySelector<HTMLButtonElement>("button")!;
  expect(getComputedStyle(cancel).pointerEvents).toBe("auto");
  await user.pointer([{ keys: "[TouchA>]", target: cancel }, { keys: "[/TouchA]", target: cancel }]);
  expect(stop).toHaveBeenCalledOnce();
  expect(document.querySelector(".web-camera")).toBeNull();
  expect(within(pairing).getByRole("textbox", { name: "Pairing link" })).toBeDefined();
});


it.each(["desktop", "web"] as const)("asks who each code is for on %s, in words, and defaults to Me", async platform => {
  vi.stubGlobal("innerWidth", platform === "web" ? 390 : 1280);
  const container = document.createElement("div"); document.body.append(container);
  const registry = {
    "pairing-grants": {
      ...(platform === "web" ? { platform: "web" as const } : {}),
      script: { environments: [{ name: "desk", reach: "paired", scopes: [...SCOPES], hello: { ceiling: "bypassPermissions" } }] },
      presentation: { settingsRow: "environments.machines" },
    },
  } satisfies SceneRegistry;
  await act(async () => { const gallery = await mountGallery(container, "pairing-grants", "light", registry); close = gallery.close; });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Settings" }));
  const card = await screen.findByRole("region", { name: "desk" });
  const part = within(card).getByRole("region", { name: "Pair another client" });
  const radios = within(within(part).getByRole("radiogroup", { name: "Who is it for?" })).getAllByRole("radio");
  expect(radios.map(radio => radio.getAttribute("aria-label"))).toEqual(["Me", "A phone with limited access", "A program or bot"]);
  expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
  const description = (radio: HTMLElement) => document.getElementById(radio.getAttribute("aria-describedby")!)!.textContent;
  expect(description(radios[0]!)).toBe("Your own phone or computer. It can do everything you can do here.");
  expect(description(radios[1]!)).toContain("It cannot open terminals or change settings.");
  expect(description(radios[2]!)).toBe("A tool such as a bot. It can start and follow sessions but not change settings.");
  await user.click(within(part).getByRole("button", { name: "Make a pairing code" }));
  const code = await within(part).findByRole("group", { name: "Pairing code" });
  expect(code.textContent).toContain("On the new device, open agent-harness and choose Connect to another computer.");
  await user.click(radios[1]!);
  await user.click(within(part).getByRole("button", { name: "Make a pairing code" }));
  await waitFor(() => expect(within(part).getByRole("timer").textContent).toBe("This code works once, for 10 minutes. 10 min left."));
});
