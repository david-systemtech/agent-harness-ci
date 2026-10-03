import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderApp } from "../test/harness.js";

it("hides and reopens the sidebar by its buttons and the window key", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [] }] });
  const sidebar = within(screen.getByRole("navigation", { name: "Sessions" }));
  expect(sidebar.getByText("Sessions")).toBeDefined();
  expect(sidebar.getByRole("button", { name: "New session" }).textContent).toContain("Ctrl+N");
  await app.user.click(sidebar.getByRole("button", { name: "Hide sidebar" }));
  expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull();
  expect(screen.queryByRole("separator", { name: "Resize the sidebar" })).toBeNull();
  await app.user.click(screen.getByRole("button", { name: "Show sidebar" }));
  expect(screen.getByRole("navigation", { name: "Sessions" })).toBeDefined();
  await app.user.keyboard("{Control>}b{/Control}");
  expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull();
  await app.user.keyboard("{Control>}b{/Control}");
  expect(screen.getByRole("navigation", { name: "Sessions" })).toBeDefined();
});

it("opens a new session from the sidebar's accent action", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [] }] });
  await app.user.click(within(screen.getByRole("navigation", { name: "Sessions" })).getByRole("button", { name: "New session" }));
  expect(await screen.findByRole("region", { name: "New session" })).toBeDefined();
});

it("creates an empty group on the primary environment without moving a session", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [] }] });
  await screen.findByRole("heading", { name: "desk" });
  await app.user.click(screen.getByRole("button", { name: "New group" }));
  const dialog = within(screen.getByRole("dialog", { name: "New group" }));
  await app.user.type(dialog.getByRole("textbox", { name: "The group's name" }), "Notes");
  await app.user.click(dialog.getByRole("button", { name: "Create group" }));
  await waitFor(() => expect(app.environment("desk").requests("groups.create")).toHaveLength(1));
  expect(app.environment("desk").requests("groups.create")[0]?.params).toMatchObject({ name: "Notes" });
  expect(app.environment("desk").requests("sessions.setGroup")).toEqual([]);
  expect(screen.queryByRole("dialog", { name: "New group" })).toBeNull();
});

it("reveals and focuses the filter for an explicit search with just one session", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Find the notes" }] }] });
  app.open("desk");
  const message = await screen.findByRole("textbox", { name: "Message" });
  await app.user.type(message, "/search{Enter}");
  const field = await screen.findByRole("searchbox", { name: "Filter the sessions" });
  await waitFor(() => expect(document.activeElement).toBe(field));
  await app.user.type(field, "notes");
  expect(screen.getByRole("list", { name: "Sessions matching “notes”" })).toBeDefined();
});

it("shows the effective New session keys after a remap", async () => {
  await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [] }] }, { presentation: { keyRemaps: { "app.session.new": ["Mod+Alt+N"] } } });
  const sidebar = within(screen.getByRole("navigation", { name: "Sessions" }));
  expect(sidebar.getByRole("button", { name: "New session" }).textContent).toContain("Ctrl+Alt+N");
});

it("names the New session keys in its tooltip", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [] }] });
  const action = within(screen.getByRole("navigation", { name: "Sessions" })).getByRole("button", { name: "New session" });
  await app.user.hover(action);
  expect((await screen.findByRole("tooltip")).textContent).toBe("New session · Ctrl+N");
});

it.each([8, 9])("shows the filter past eight total sessions (%i sessions)", async (count) => {
  await renderApp({ environments: [
    { name: "desk", reach: "local", sessions: Array.from({ length: 4 }, (_, i) => ({ title: `Desk task ${i}` })) },
    { name: "laptop", reach: "paired", sessions: Array.from({ length: count - 4 }, (_, i) => ({ title: `Laptop task ${i}` })) },
  ] });
  await screen.findByRole("button", { name: `laptop Laptop task ${count - 5}` });
  const sidebar = within(screen.getByRole("navigation", { name: "Sessions" }));
  expect(sidebar.queryByRole("searchbox", { name: "Filter the sessions" }) !== null).toBe(count === 9);
  expect(sidebar.getByRole("button", { name: "New group" })).toBeDefined();
  expect(sidebar.getByRole("switch", { name: "By repository" })).toBeDefined();
});
