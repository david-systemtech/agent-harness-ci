import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SCOPES } from "@agent-harness/contracts";
import type { HttpFetch, WebSocketFactory } from "@agent-harness/client-runtime";
import { App } from "../app.js";
import { startWebWorld } from "../../gallery/world.js";
import { openPresentation } from "../presentation.js";
import { focusedPane } from "../grid/layout.js";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const opened = async () => {
  vi.stubGlobal("innerWidth", 320);
  const media = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : media(query));
  const world = await startWebWorld({ environments: [{ name: "desk", reach: "paired", capabilities: ["workspaceChecks"], scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" }, sessions: [{ title: "Receipts" }] }] }, { settingsRow: "accounts.accounts" });
  const environment = world.world.environment("desk");
  // HTTPS terminates at the scripted transport boundary, as it does at a reverse proxy.
  const fetch: HttpFetch = (url, request) => world.world.fetch(url.replace(/^https:/, "http:"), request);
  const webSocket: WebSocketFactory = (url, handlers) => world.world.webSocket(url.replace(/^wss:/, "ws:"), handlers);
  Object.assign(world.platform, { fetch, webSocket });
  const session = { environmentId: environment.environmentId, sessionId: environment.sessionId() };
  const mount = () => render(<App {...world} web={{ platform: world.platform, route: { session } }} />);
  let view = mount();
  stops.push(async () => { view.unmount(); await world.runtime.close(); await world.presentation.close(); });
  await screen.findByRole("textbox", { name: "Message" });
  return { ...world, environment, session, user: userEvent.setup(), remount: async () => { view.unmount(); await world.presentation.close(); Object.assign(world, { presentation: await openPresentation(world.platform.documents) }); view = mount(); } };
};
it("dismisses the short disclosure for this pairing across a remount", async () => {
  const app = await opened();
  const note = screen.getByRole("note", { name: "Limited access" });
  expect(note.textContent).toBe("Limited access · Details");
  expect(screen.queryByText(/without the terminal scope/)).toBeNull();
  await app.user.click(within(note).getByRole("button", { name: "Dismiss limited access" }));
  expect(screen.queryByRole("note", { name: "Limited access" })).toBeNull();
  await app.remount();
  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.queryByRole("note", { name: "Limited access" })).toBeNull();
});
it("explains the actual grant in plain words and replaces it without changing the open session", async () => {
  const app = await opened();
  await app.user.click(screen.getByRole("button", { name: "Details" }));
  const sheet = await screen.findByRole("dialog", { name: "This phone's access" });
  expect(sheet.textContent).toContain("Read sessions, send messages and answer permission requests");
  expect(sheet.textContent).toContain("Files, changes and terminals are unavailable");
  expect(sheet.textContent).toContain("Settings changes and provider sign-in are unavailable");
  expect(sheet.textContent).not.toMatch(/sessions:write|runs:drive|scope|acceptEdits/);
  await app.user.click(within(sheet).getByRole("button", { name: "Give this phone full access" }));
  const pairing = await screen.findByRole("dialog", { name: "Give this phone full access" });
  expect(pairing.textContent).toContain("Settings → Your machines");
  expect(pairing.textContent).toContain("My own client");
  expect(pairing.textContent).toContain("agent-harness pair");
  await app.user.type(within(pairing).getByRole("textbox", { name: "Pairing link" }), app.environment.wire.link.replace(/^http:/, "https:"));
  app.environment.autoAccept(false);
  const before = app.environment.wire.opened();
  await app.user.click(within(pairing).getByRole("button", { name: "Pair" }));
  await waitFor(() => expect(app.environment.wire.opened()).toBeGreaterThan(before));
  await act(async () => { await app.environment.accept({ scopes: [...SCOPES], ceiling: "bypassPermissions" }); });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Give this phone full access" })).toBeNull());
  expect(screen.queryByRole("note", { name: "Limited access" })).toBeNull();
  expect(focusedPane(app.presentation.values.read().paneLayout).session).toEqual(app.session);
  expect(app.runtime.connections.list.read().filter(record => record.environmentId === app.session.environmentId)).toHaveLength(1);
});
it("offers the same full-access flow from read-only Settings", async () => {
  const app = await opened();
  await app.user.click(screen.getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(settings.textContent).not.toContain("admin scope");
  await app.user.click(within(settings).getByRole("button", { name: "Give this phone full access" }));
  expect(await screen.findByRole("dialog", { name: "Give this phone full access" })).toBeDefined();
});

it.each(["Terminal", "Files", "Diff"])("offers full access from the unavailable %s menu entry", async name => {
  const app = await opened();
  await app.user.click(screen.getByRole("button", { name: "More" }));
  const entry = await screen.findByRole("menuitem", { name });
  expect(entry.textContent).not.toContain("scope");
  expect(entry.textContent).toContain("Give this phone full access");
  await app.user.click(entry);
  expect(await screen.findByRole("dialog", { name: "Give this phone full access" })).toBeDefined();
  expect(app.environment.requests("terminals.open")).toHaveLength(0);
});
it("keeps the old pairing and open session after an expired replacement code", async () => {
  const app = await opened();
  const identity = app.runtime.connections.list.read()[0]?.clientSessionId;
  await app.user.click(screen.getByRole("button", { name: "Details" }));
  await app.user.click(screen.getByRole("button", { name: "Give this phone full access" }));
  Object.assign(app.platform, { fetch: ((url, request) => url.endsWith("/pair") ? Promise.resolve({ status: 410, json: async () => ({ code: "pairing_expired", message: "This code has expired." }) }) : app.world.fetch(url.replace(/^https:/, "http:"), request)) satisfies HttpFetch });
  const pairing = screen.getByRole("dialog", { name: "Give this phone full access" });
  await app.user.type(within(pairing).getByRole("textbox", { name: "Pairing link" }), app.environment.wire.link.replace(/^http:/, "https:"));
  await app.user.click(within(pairing).getByRole("button", { name: "Pair" }));
  expect(await within(pairing).findByText(/expired/i)).toBeDefined();
  expect(app.runtime.connections.list.read()[0]?.clientSessionId).toBe(identity);
  expect(focusedPane(app.presentation.values.read().paneLayout).session).toEqual(app.session);
});
it("discloses a new limited pairing after the previous pairing was dismissed", async () => {
  const app = await opened();
  await app.user.click(screen.getByRole("button", { name: "Dismiss limited access" }));
  await act(async () => { await app.runtime.connections.add({ link: app.environment.wire.link.replace(/^http:/, "https:") }, { rePair: app.environment.environmentId }); });
  expect(await screen.findByRole("note", { name: "Limited access" })).toBeDefined();
});
