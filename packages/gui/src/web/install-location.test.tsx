import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, onTestFinished, vi } from "vitest";
import { App } from "../app.js";
import { startWebWorld } from "../../gallery/world.js";
import { webModule } from "./install.js";

const conversation = async (standalone = false, ios = false) => {
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("isSecureContext", true);
  const matchMedia = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => Object.assign(matchMedia(query), { matches: query === "(display-mode: standalone)" ? standalone : query.includes("639") }));
  if (ios) Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
  const world = await startWebWorld({ environments: [{ name: "desk", reach: "paired", sessions: [{ title: "Check the receipts" }] }] }, { settingsRow: "about.about" });
  const environment = world.world.environment("desk");
  let stop: void | (() => void);
  act(() => { stop = webModule.registration.start(); });
  const view = render(<App {...world} web={{ platform: world.platform, route: { session: { environmentId: environment.environmentId, sessionId: environment.sessionId() } } }} />);
  onTestFinished(async () => {
    view.unmount(); stop?.(); world.stopFollowing();
    await world.runtime.close(); await world.presentation.close();
    if (ios) delete (navigator as Navigator & { standalone?: boolean }).standalone;
    vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, "", "/");
  });
  await screen.findByRole("textbox", { name: "Message" });
  return { ...world, view, user: userEvent.setup() };
};

it("keeps installation in one Settings row and leaves the conversation bottom at its composer and status", async () => {
  const app = await conversation();
  const frame = app.view.container.querySelector("[data-web-client]")!;
  expect(frame.querySelector("[data-install-disclosure], [data-phone-install]")).toBeNull();
  expect(frame.textContent).not.toMatch(/Home Screen|Install client/);
  expect(frame.lastElementChild?.tagName).toBe("MAIN");
  await app.user.click(screen.getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(within(settings).getAllByText("Add to Home Screen", { exact: true })).toHaveLength(1);
  await app.user.click(within(settings).getByText("Add to Home Screen", { exact: true }));
  expect(within(settings).getByRole("region", { name: "Home Screen installation" })).toBeDefined();
  await app.user.click(within(settings).getByRole("button", { name: "Close Settings" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
  expect(frame.textContent).not.toMatch(/Home Screen|Install client/);
});

it.each(["display-mode", "ios"])("hides the Settings installation row as well as conversation guidance in %s standalone mode", async mode => {
  const app = await conversation(mode === "display-mode", mode === "ios");
  expect(app.view.container.textContent).not.toMatch(/Home Screen|Install client/);
  expect(app.view.container.querySelector("[data-web-client]")?.lastElementChild?.tagName).toBe("MAIN");
  await app.user.click(screen.getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(within(settings).getByText(/This client:/)).toBeDefined();
  expect(within(settings).queryByText("Add to Home Screen", { exact: true })).toBeNull();
  expect(within(settings).queryByRole("region", { name: "Home Screen installation" })).toBeNull();
});

it("leaves dismissed installation in Settings without offering conversation guidance on reopening", async () => {
  const app = await conversation();
  const offer = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: "dismissed" }) });
  act(() => { window.dispatchEvent(offer); });
  expect(app.view.container.textContent).not.toMatch(/Home Screen|Install client/);
  await app.user.click(screen.getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await app.user.click(within(settings).getByText("Add to Home Screen", { exact: true }));
  await app.user.click(within(settings).getByRole("button", { name: "Install client" }));
  expect(await within(settings).findByText(/Installation dismissed/)).toBeDefined();
  await app.user.click(within(settings).getByRole("button", { name: "Close Settings" }));
  expect(app.view.container.textContent).not.toMatch(/Home Screen|Install client|Installation dismissed/);
  await app.user.click(screen.getByRole("button", { name: "Settings" }));
  const reopened = await screen.findByRole("dialog", { name: "Settings" });
  expect(reopened.querySelector("details")?.open).toBe(false);
  expect(within(reopened).queryByRole("button", { name: "Install client" })).toBeNull();
});
