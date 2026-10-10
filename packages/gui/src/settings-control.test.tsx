import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/harness.js";

describe("the header's Settings control", () => {
  it.each([false, true])("reaches Accounts and sign-in by clicks alone with a session open: %s", async (sessionOpen) => {
    const app = await renderApp({
      environments: [{
        name: "desk",
        reach: "local",
        sessions: [{ title: "Receipts" }],
        accounts: [{ label: "personal", status: { state: "signed-out", checkedAt: null, detail: null } }],
      }],
    });
    await screen.findByText("No session is open. Choose one from the sidebar.");
    if (sessionOpen) await app.user.click(screen.getByRole("button", { name: /^\S+ Receipts\b/ }));

    await app.user.click(within(screen.getByRole("banner")).getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("region", { name: "Settings" });
    await app.user.click(within(within(settings).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Accounts" }));
    const accounts = within(settings).getByRole("region", { name: "Accounts" });
    const personal = await within(accounts).findByRole("region", { name: "personal" });
    await app.user.click(within(personal).getByRole("button", { name: "Sign in again" }));
    expect(await screen.findByRole("region", { name: "Sign in to Claude" })).toBeDefined();
  });

  it.each([{ macOS: false, keys: "Ctrl+," }, { macOS: true, keys: "⌘," }])("names the platform's shortcut in its tooltip: $keys", async ({ macOS, keys }) => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { macOS });
    await screen.findByText("No session is open. Choose one from the sidebar.");
    const control = within(screen.getByRole("banner")).getByRole("button", { name: "Settings" });
    act(() => control.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe(`Settings · ${keys}`);

    act(() => app.presentation.set("keyRemaps", { "app.settings.toggle": ["Mod+Shift+S"] }));
    expect(screen.getByRole("tooltip").textContent).toBe(macOS ? "Settings · ⇧⌘S" : "Settings · Ctrl+Shift+S");
  });
});
