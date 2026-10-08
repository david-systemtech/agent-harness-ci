import "../test/markdown-editor-dom.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp } from "../test/harness.js";
import { INSTRUCTION_ACCOUNT, NO_CHANNEL_ACCOUNT, ownedInstruction, scriptInstructions } from "../test/instructions.js";

const openInstructions = async (app: RenderedApp) => {
  await app.user.keyboard("{Control>},{/Control}");
  await app.user.click(within(await screen.findByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Instructions" }));
  return screen.findByRole("region", { name: "Instructions" });
};

describe("Instructions", () => {
  it("opens on its registered settings row with what agents are told about this computer first, read-only, owned text and channel-less accounts visible", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    scriptInstructions(app.environment("desk"), [ownedInstruction()]);
    const pane = await openInstructions(app);
    const orientation = await within(pane).findByRole("region", { name: "What agents are told about this computer" });
    expect(within(orientation).getByText(/Forge: verified/)).toBeDefined();
    expect(within(orientation).queryByRole("button", { name: /Edit|Remove/ })).toBeNull();
    expect(await within(pane).findByRole("region", { name: "Review habits" })).toBeDefined();
    expect(within(pane).getAllByText("This adapter has no instruction channel.").length).toBeGreaterThan(0);
    expect(
      within(pane)
        .getAllByRole("heading", { level: 3 })
        .slice(0, 2)
        .map((heading) => heading.textContent),
    ).toEqual(["What agents are told about this computer", "Owned instructions"]);
  });
  it("creates a custom instruction and edits its title and Markdown through the environment", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    scriptInstructions(app.environment("desk"));
    const pane = await openInstructions(app);
    await app.user.click(await within(pane).findByRole("button", { name: "New instruction" }));
    const editor = await screen.findByRole("dialog", { name: "New instruction" });
    await app.user.type(within(editor).getByRole("textbox", { name: "Title" }), "My habits");
    await app.user.click(within(editor).getByRole("textbox", { name: "Markdown body" }));
    await app.user.paste("Read the tests.");
    await app.user.click(within(editor).getByRole("button", { name: "Save instruction" }));
    const row = await within(pane).findByRole("region", { name: "My habits" });
    expect(within(row).getByText("Read the tests.")).toBeDefined();
    await app.user.click(within(row).getByRole("button", { name: "Edit" }));
    const edit = await screen.findByRole("region", { name: "Edit My habits" });
    await app.user.clear(within(edit).getByRole("textbox", { name: "Title" }));
    await app.user.type(within(edit).getByRole("textbox", { name: "Title" }), "Better habits");
    await app.user.click(within(edit).getByRole("textbox", { name: "Markdown body" }));
    fireEvent.keyDown(within(edit).getByRole("textbox", { name: "Markdown body" }), { key: "a", ctrlKey: true });
    await app.user.paste("Read the tests. Then read the code.");
    await app.user.click(within(edit).getByRole("button", { name: "Save instruction" }));
    expect(await within(await within(pane).findByRole("region", { name: "Better habits" })).findByText("Read the tests. Then read the code.")).toBeDefined();
  });
  it("cancels inline editing with Escape while keeping Settings open", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    scriptInstructions(app.environment("desk"), [ownedInstruction()]);
    const pane = await openInstructions(app);
    const row = await within(pane).findByRole("region", { name: "Review habits" });
    await app.user.click(within(row).getByRole("button", { name: "Edit" }));
    const editor = await within(row).findByRole("region", { name: "Edit Review habits" });
    await app.user.click(within(editor).getByRole("textbox", { name: "Title" }));
    await app.user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeDefined();
    expect(within(row).queryByRole("region", { name: "Edit Review habits" })).toBeNull();
    expect(within(row).getByText("Read every comment.")).toBeDefined();
  });
  it("closes link editing with Escape before closing its instruction dialog", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    scriptInstructions(app.environment("desk"));
    const pane = await openInstructions(app);
    await app.user.click(await within(pane).findByRole("button", { name: "New instruction" }));
    const editor = await screen.findByRole("dialog", { name: "New instruction" });
    await app.user.click(within(editor).getByRole("button", { name: "Link" }));
    expect(within(editor).getByRole("textbox", { name: "Link URL" })).toBeDefined();
    await app.user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "New instruction" })).toBeDefined();
    expect(within(editor).queryByRole("textbox", { name: "Link URL" })).toBeNull();
    await app.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "New instruction" })).toBeNull();
  });
  it("switches off without removing, selects account scope, moves a row and removes it", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    scriptInstructions(app.environment("desk"), [ownedInstruction(), ownedInstruction({ id: "22222222-2222-4222-8222-222222222222", title: "Second habit", position: "t" })]);
    const pane = await openInstructions(app);
    const row = await within(pane).findByRole("region", { name: "Review habits" });
    await app.user.click(within(row).getByRole("switch", { name: "Enabled" }));
    await waitFor(() => expect(within(row).getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe("false"));
    await app.user.click(within(row).getByRole("checkbox", { name: "All accounts, including future accounts" }));
    await waitFor(() => expect((within(row).getByRole("checkbox", { name: "All accounts, including future accounts" }) as HTMLInputElement).checked).toBe(false));
    expect((within(row).getByRole("checkbox", { name: "Main account" }) as HTMLInputElement).checked).toBe(true);
    expect((within(row).getByRole("checkbox", { name: /Other account/ }) as HTMLInputElement).disabled).toBe(true);
    await app.user.click(within(row).getByRole("button", { name: "Move down" }));
    await waitFor(() =>
      expect(
        within(within(pane).getByRole("region", { name: "Owned instructions" }))
          .getAllByRole("heading")
          .slice(1)
          .map((heading) => heading.textContent),
      ).toEqual(["Second habit", "Review habits"]),
    );
    await app.user.click(within(row).getByRole("button", { name: "Remove" }));
    const remove = await screen.findByRole("dialog", { name: "Remove Review habits?" });
    await app.user.click(within(remove).getByRole("button", { name: "Remove instruction" }));
    await waitFor(() => expect(within(pane).queryByRole("region", { name: "Review habits" })).toBeNull());
  });
  it("leaves all accounts through an account checkbox without selecting channel-less accounts", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    scriptInstructions(app.environment("desk"), [ownedInstruction({ accounts: [INSTRUCTION_ACCOUNT, NO_CHANNEL_ACCOUNT, { ...INSTRUCTION_ACCOUNT, accountId: "account-3", label: "Second supported account" }] })]);
    const pane = await openInstructions(app);
    const row = await within(pane).findByRole("region", { name: "Review habits" });
    await app.user.click(within(row).getByRole("checkbox", { name: "Main account" }));
    await waitFor(() => expect((within(row).getByRole("checkbox", { name: "All accounts, including future accounts" }) as HTMLInputElement).checked).toBe(false));
    expect((within(row).getByRole("checkbox", { name: "Main account" }) as HTMLInputElement).checked).toBe(false);
    expect((within(row).getByRole("checkbox", { name: /Other account/ }) as HTMLInputElement).checked).toBe(false);
    expect((within(row).getByRole("checkbox", { name: "Second supported account" }) as HTMLInputElement).checked).toBe(true);
  });
  it("keeps the last supported account selected when all accounts are reached", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    scriptInstructions(app.environment("desk"), [ownedInstruction()]);
    const pane = await openInstructions(app);
    const row = await within(pane).findByRole("region", { name: "Review habits" });
    const account = within(row).getByRole("checkbox", { name: "Main account" }) as HTMLInputElement;
    expect(account.disabled).toBe(true);
    await app.user.click(account);
    expect(account.checked).toBe(true);
    expect((within(row).getByRole("checkbox", { name: "All accounts, including future accounts" }) as HTMLInputElement).checked).toBe(true);
    expect(within(row).getByText("Choose at least one account, or all accounts. Switch the instruction off to reach none.")).toBeDefined();
  });
  it("ticks a suggestion into an owned copy and remembers dismissal until restored", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    scriptInstructions(app.environment("desk"));
    const pane = await openInstructions(app);
    const suggested = await within(pane).findByRole("region", { name: "Suggested instructions" });
    await app.user.click(within(suggested).getByRole("checkbox", { name: "Read code from a fresh checkout" }));
    const row = await within(pane).findByRole("region", { name: "Read code from a fresh checkout" });
    expect(within(row).getByText(/Before you reference, quote or change code/)).toBeDefined();
    await app.user.click(within(row).getByRole("button", { name: "Remove" }));
    await app.user.click(within(await screen.findByRole("dialog", { name: "Remove Read code from a fresh checkout?" })).getByRole("button", { name: "Remove instruction" }));
    await waitFor(() => expect(within(suggested).queryByRole("checkbox", { name: "Read code from a fresh checkout" })).toBeNull());
    await app.user.click(within(pane).getByRole("button", { name: "Dismissed" }));
    const dismissed = within(pane).getByRole("region", { name: "Dismissed suggestions" });
    await app.user.click(within(dismissed).getByRole("button", { name: "Restore Read code from a fresh checkout" }));
    expect(await within(suggested).findByRole("checkbox", { name: "Read code from a fresh checkout" })).toBeDefined();
    await app.user.click(within(suggested).getByRole("button", { name: "Dismiss Read code from a fresh checkout" }));
    expect(await within(dismissed).findByRole("button", { name: "Restore Read code from a fresh checkout" })).toBeDefined();
  });
  it.each(["keep", "replace"] as const)("shows both version comparisons and resolves a newer source by %s", async (choice) => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    scriptInstructions(app.environment("desk"), [ownedInstruction({ origin: { catalogueId: "coding.fresh-checkout", version: 1 }, newerVersion: 2 })], {
      from: "Earlier source.",
      to: "Updated source.",
      toVersion: 2,
    });
    const pane = await openInstructions(app);
    const row = await within(pane).findByRole("region", { name: "Review habits" });
    expect(within(row).getByText("Newer version 2")).toBeDefined();
    await app.user.click(within(row).getByRole("button", { name: "See what changed" }));
    const diff = await screen.findByRole("dialog", { name: "Changes to Review habits" });
    expect(await within(diff).findByText("Earlier source.")).toBeDefined();
    expect(within(diff).getByRole("table", { name: "Catalogue changes" }).textContent).toContain("Updated source.");
    expect(within(diff).getByRole("table", { name: "Changes to your copy" }).textContent).toContain("Read every comment.");
    expect(within(diff).getByText("Replace loses your edits. Keep mine keeps your text and clears this version badge.")).toBeDefined();
    await app.user.click(within(diff).getByRole("button", { name: choice === "keep" ? "Keep mine" : "Replace with new text" }));
    await waitFor(() => expect(within(row).queryByText("Newer version 2")).toBeNull());
    expect(within(row).getByText(choice === "keep" ? "Read every comment." : "Updated source.")).toBeDefined();
  });
  it("switches telling agents about this computer through settings with its warning, updates from other clients and marks cached instructions stale on disconnect", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    const peer = scriptInstructions(app.environment("desk"), [ownedInstruction()]);
    const pane = await openInstructions(app);
    const orientation = await within(pane).findByRole("region", { name: "What agents are told about this computer" });
    expect(within(orientation).getByText("If you turn this off, agents will not know where your forges, keys and notebooks are.")).toBeDefined();
    await app.user.click(within(orientation).getByRole("switch", { name: "Tell agents about this computer" }));
    await waitFor(() => expect(within(orientation).getByRole("switch", { name: "Tell agents about this computer" }).getAttribute("aria-checked")).toBe("false"));
    await act(async () => peer.change([ownedInstruction({ title: "Changed elsewhere", body: "A live update." })]));
    expect(await within(pane).findByRole("region", { name: "Changed elsewhere" })).toBeDefined();
    await act(async () => {
      app.environment("desk").discovery("nothing");
      app.environment("desk").server.drop();
    });
    expect(await within(pane).findByText(/Cached instructions, stale/)).toBeDefined();
    expect(within(pane).getByRole("region", { name: "Changed elsewhere" })).toBeDefined();
    expect(within(pane).getByRole("button", { name: "New instruction" }).hasAttribute("disabled")).toBe(true);
  });
  it("names the steps of the parts it could not read, without their raw names, and Go to opens that step in Set up on this computer", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    const desk = app.environment("desk");
    scriptInstructions(desk);
    desk.wire.answer("instructions.list", () => ({ result: {
      orientation: { enabled: true, text: "# Orientation", unreadRegistries: ["key-managers", "environment", "accounts"], accounts: [INSTRUCTION_ACCOUNT] },
      instructions: [],
      dismissed: [],
    } }));
    const pane = await openInstructions(app);
    const orientation = await within(pane).findByRole("region", { name: "What agents are told about this computer" });
    expect(within(orientation).getByText("agent-harness could not read part of this computer's setup: Account, Your machines, Key manager.")).toBeDefined();
    expect(within(orientation).queryByText(/key-managers/)).toBeNull();
    expect(within(orientation).getAllByRole("button", { name: /^Go to / }).map((button) => button.textContent)).toEqual(["Go to Account", "Go to Your machines", "Go to Key manager"]);
    await app.user.click(within(orientation).getByRole("button", { name: "Go to Key manager" }));
    const rail = await screen.findByRole("navigation", { name: "Set up steps" });
    await waitFor(() => expect(within(rail).getByRole("button", { name: "Key manager" }).getAttribute("aria-current")).toBe("step"));
  });

  it("says to sign in on the Account step first while the environment holds no account", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    const desk = app.environment("desk");
    scriptInstructions(desk);
    desk.wire.answer("instructions.list", () => ({ result: { orientation: { enabled: true, text: null, unreadRegistries: [], accounts: [] }, instructions: [], dismissed: [] } }));
    const orientation = await within(await openInstructions(app)).findByRole("region", { name: "What agents are told about this computer" });
    expect(within(orientation).getByText("Sign in on the Account step first. Agents are told about your accounts.")).toBeDefined();
  });

  it("keeps absent controls dim with their scope reason and displays a runtime refusal in one line", async () => {
    const app = await renderApp({
      environments: [
        { name: "desk", reach: "local" },
        { name: "read-only", reach: "paired", scopes: ["read"] },
      ],
    });
    scriptInstructions(app.environment("desk"), [ownedInstruction()]);
    scriptInstructions(app.environment("read-only"), [ownedInstruction()]);
    const pane = await openInstructions(app);
    app.environment("desk").wire.answer("instructions.setEnabled", () => ({ error: { code: "conflict", message: "The instruction was removed elsewhere.", data: {} } }));
    await app.user.click(within(await within(pane).findByRole("region", { name: "Review habits" })).getByRole("switch", { name: "Enabled" }));
    expect(await within(pane).findByText("Not saved: The instruction was removed elsewhere.")).toBeDefined();
    await app.user.selectOptions(within(pane).getByRole("combobox", { name: "Environment" }), app.environment("read-only").environmentId);
    expect(await within(pane).findByRole("button", { name: "New instruction" })).toBeDefined();
    await within(pane).findByRole("region", { name: "Review habits" });
    expect(within(pane).getByRole("button", { name: "New instruction" }).hasAttribute("disabled")).toBe(true);
    expect(within(pane).getAllByText("This app has limited access to read-only, so it cannot change settings or sign in accounts. Pair again with full access to change this.").length).toBeGreaterThan(0);
  });
  it("edits and clears session instructions from the session menu by keyboard", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }] });
    const environment = app.environment("desk");
    const sessionId = environment.sessionId();
    environment.wire.answer("sessions.setInstructions", (params) => {
      const text = String(params["text"]);
      environment.emit(sessionId, "session.instructions-set", { text });
      return {
        result: { receipt: { status: "accepted", sequence: environment.events(sessionId).at(-1)?.sequence ?? 1, changed: true }, result: { sessionId, text, changed: true } },
      };
    });
    app.open("desk");
    await screen.findByRole("region", { name: "Transcript" });
    const openEditor = async () => {
      const sessionRow = within(screen.getByRole("navigation", { name: "Sessions" })).getByRole("button", { name: /Receipts/ });
      act(() => sessionRow.focus());
      await app.user.keyboard("{Shift>}{F10}{/Shift}");
      // jsdom does not dispatch the browser's default contextmenu event for the menu key.
      fireEvent.contextMenu(sessionRow, { button: 0 });
      const menu = await screen.findByRole("menu", { name: "Organise “Receipts”" });
      act(() => within(menu).getByRole("menuitem", { name: "Session instructions…" }).focus());
      await app.user.keyboard("{Enter}");
      return screen.findByRole("dialog", { name: "Instructions for Receipts" });
    };
    const editor = await openEditor();
    const body = await within(editor).findByRole("textbox", { name: "Markdown body" });
    act(() => body.focus());
    await app.user.paste("For this session only.");
    act(() => within(editor).getByRole("button", { name: "Save session instructions" }).focus());
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Instructions for Receipts" })).toBeNull());
    const reopened = await openEditor();
    expect((await within(reopened).findByRole("textbox", { name: "Markdown body" })).textContent).toBe("For this session only.");
    await app.user.click(within(reopened).getByRole("button", { name: "Clear session instructions" }));
    const cleared = await openEditor();
    expect((await within(cleared).findByRole("textbox", { name: "Markdown body" })).textContent).toBe("");
  });
  it("lists the pane's native keyboard actions in the searchable shortcuts pane", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    await app.user.keyboard("{Control>},{/Control}");
    await app.user.click(within(await screen.findByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Keyboard shortcuts" }));
    const pane = screen.getByRole("region", { name: "Keyboard shortcuts" });
    const table = within(pane).getByRole("table", { name: "Instructions controls" });
    expect(within(table).getByRole("row", { name: /Create, edit and save an owned instruction/ }).textContent).toContain("Tab to control; Enter");
    expect(within(table).getByRole("row", { name: /Edit or clear session instructions/ }).textContent).toContain("Shift+F10");
    await app.user.type(within(pane).getByRole("searchbox", { name: "Search the shortcuts" }), "Replace");
    expect(within(pane).getByRole("table", { name: "Instructions controls" }).textContent).toContain("Replace with new text or Keep mine");
  });
  it("shows a rejected save receipt without closing or losing the typed draft", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    scriptInstructions(app.environment("desk"));
    app
      .environment("desk")
      .wire.answer("instructions.create", () => ({
        result: {
          receipt: { status: "rejected", sequence: 1, changed: false, reason: "conflict", error: { code: "conflict", message: "This instruction id is already used.", data: {} } },
        },
      }));
    const pane = await openInstructions(app);
    await app.user.click(await within(pane).findByRole("button", { name: "New instruction" }));
    const editor = await screen.findByRole("dialog", { name: "New instruction" });
    await app.user.type(within(editor).getByRole("textbox", { name: "Title" }), "Keep this draft");
    await app.user.click(within(editor).getByRole("textbox", { name: "Markdown body" }));
    await app.user.paste("The typed text.");
    await app.user.click(within(editor).getByRole("button", { name: "Save instruction" }));
    expect(await within(editor).findByRole("alert")).toHaveProperty("textContent", "Error: Not saved: This instruction id is already used.");
    expect(within(editor).getByRole("textbox", { name: "Markdown body" }).textContent).toBe("The typed text.");
  });
  it("preserves typed session instructions while reconnecting and catching up", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }] });
    const environment = app.environment("desk");
    app.open("desk");
    await screen.findByRole("region", { name: "Transcript" });
    const sessionRow = within(screen.getByRole("navigation", { name: "Sessions" })).getByRole("button", { name: /Receipts/ });
    await app.user.pointer({ keys: "[MouseRight]", target: sessionRow });
    await app.user.click(within(await screen.findByRole("menu", { name: "Organise “Receipts”" })).getByRole("menuitem", { name: "Session instructions…" }));
    const editor = await screen.findByRole("dialog", { name: "Instructions for Receipts" });
    await app.user.click(await within(editor).findByRole("textbox", { name: "Markdown body" }));
    await app.user.paste("Keep my unsaved draft.");
    const subscription = "resuming-instructions";
    environment.wire.answer("sessions.subscribeSession", (_params, request) => {
      environment.server.send({ type: "subscribed", id: request.id, subscription });
      return undefined;
    });
    await act(async () => {
      environment.discovery("nothing");
      environment.server.drop();
    });
    await within(editor).findByText(/Cached session instructions, stale/);
    await act(async () => {
      environment.discovery("ready");
      app.clock.advance(5_000);
      await environment.server.request("sessions.subscribeSession");
    });
    const body = within(editor).getByRole("textbox", { name: "Markdown body" });
    expect(body.textContent).toBe("Keep my unsaved draft.");
    expect(body.getAttribute("contenteditable")).toBe("false");
    await act(async () => environment.server.send({ type: "synchronized", subscription, sequence: environment.events(environment.sessionId()).at(-1)?.sequence ?? 1 }));
    await waitFor(() => expect(body.getAttribute("contenteditable")).toBe("true"));
    expect(body.textContent).toBe("Keep my unsaved draft.");
  });
  it("reads an unopened session's instructions after its stream catches up", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Unopened" }] }] });
    const environment = app.environment("desk");
    environment.emit(environment.sessionId(), "session.instructions-set", { text: "Already set by another client." });
    const subscription = "instructions-session";
    environment.wire.answer("sessions.subscribeSession", (_params, request) => {
      environment.server.send({ type: "subscribed", id: request.id, subscription });
      environment.server.send({
        type: "snapshot",
        subscription,
        sequence: 100,
        payload: { sequence: 100, summary: environment.summary(environment.sessionId()), runs: [], items: [], parkedPrompts: [], rewinds: [], instructions: "" },
      });
      return undefined;
    });
    const sessionRow = within(await screen.findByRole("navigation", { name: "Sessions" })).getByRole("button", { name: /Unopened/ });
    await app.user.pointer({ keys: "[MouseRight]", target: sessionRow });
    await app.user.click(within(await screen.findByRole("menu", { name: "Organise “Unopened”" })).getByRole("menuitem", { name: "Session instructions…" }));
    const editor = await screen.findByRole("dialog", { name: "Instructions for Unopened" });
    await within(editor).findByText(/Reading|stale/);
    await act(async () => {
      for (const event of environment.events(environment.sessionId())) environment.server.send({ type: "event", subscription, sequence: event.sequence, event });
      environment.server.send({ type: "synchronized", subscription, sequence: 101 });
    });
    await waitFor(() => expect(within(editor).getByRole("textbox", { name: "Markdown body" }).textContent).toBe("Already set by another client."));
  });
});
