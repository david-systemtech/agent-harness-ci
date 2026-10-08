import "../test/markdown-editor-dom.js";
import { act, screen, waitFor, within } from "@testing-library/react";
import type { ResultOf } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type EnvironmentHandle } from "../test/harness.js";
import { ownedInstruction, scriptInstructions } from "../test/instructions.js";

const openCard = async (app: RenderedApp) => {
  const rail = await screen.findByRole("navigation", { name: "Set up steps" });
  await app.user.click(within(rail).getByRole("button", { name: "Instructions" }));
  return screen.findByRole("region", { name: "Instructions" });
};

const scriptPreview = (desk: EnvironmentHandle) => {
  desk.wire.answer("workspaces.browse", () => ({ result: { path: "/home/test", parent: "/home", directories: [], truncated: false } }));
  const result: ResultOf<"instructions.preview"> = {
    parts: [{ layer: "user", id: "orientation", title: "Orientation", text: "# Orientation\nPreview: verified on this environment." }],
    text: "# Orientation\nPreview: verified on this environment.",
    manifest: { channel: "system-prompt-append", layers: [], alwaysOn: [], skillSetFingerprint: null, unreadRegistries: [], leftOut: [] },
  };
  desk.wire.answer("instructions.preview", () => ({ result }));
};

describe("the Instructions card in Set up", () => {
  it("seeds About my setup once across two runtimes on the same environment", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk);
    const card = await openCard(app);
    const seed = await within(card).findByRole("region", { name: "About my setup" });
    expect(within(seed).getByText(/The orientation block at the start/)).toBeDefined();
    expect(desk.requests("instructions.create").map((request) => request.params["catalogueId"])).toEqual(["setup.about-my-setup"]);
    const next = await app.remount();
    await next.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    await within(await openCard(next)).findByRole("region", { name: "About my setup" });
    expect(desk.requests("instructions.create")).toHaveLength(0);
  });

  it("shows the rendered Orientation preview read-only, switches it off, and reads done from the environment's check", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", setup: { instructions: { state: "needs-attention", reason: "The block could not render.", failing: ["instructions.orientation-renders"], actions: ["check-again"] } } }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk);
    scriptPreview(desk);
    const card = await openCard(app);
    const orientation = await within(card).findByRole("region", { name: "Orientation" });
    expect(await within(orientation).findByText(/Preview: verified/)).toBeDefined();
    expect(within(orientation).queryByRole("textbox")).toBeNull();
    expect(within(orientation).getByText("Turning Orientation off means the model will not know where its forges, keys and banks are.")).toBeDefined();
    expect(desk.requests("instructions.preview")[0]?.params).toEqual({ accountId: "account-1", workspace: { kind: "directory", path: "/home/test" } });
    await app.user.click(within(orientation).getByRole("switch", { name: "Orientation enabled" }));
    await waitFor(() => expect(within(orientation).getByRole("switch", { name: "Orientation enabled" }).getAttribute("aria-checked")).toBe("false"));
    expect(desk.requests("settings.update").at(-1)?.params["values"]).toEqual({ "instructions.orientation": false });
    act(() => {
      desk.setSetup({ instructions: { state: "done", reason: "Agents get your notes and a summary of this computer." } });
    });
    await app.user.click(within(card).getByRole("button", { name: "Check again" }));
    expect(await within(card).findByText("Agents get your notes and a summary of this computer.")).toBeDefined();
    expect(within(card).getByRole("img", { name: "Instructions: Done" })).toBeDefined();
  });

  it("creates Custom text without an origin, with all account chips on", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk);
    const card = await openCard(app);
    const custom = await within(card).findByRole("region", { name: "Custom" });
    await app.user.click(within(custom).getByRole("button", { name: "Write a custom instruction" }));
    const editor = await screen.findByRole("dialog", { name: "New instruction" });
    await app.user.type(within(editor).getByRole("textbox", { name: "Title" }), "My review habits");
    await app.user.click(within(editor).getByRole("textbox", { name: "Markdown body" }));
    await app.user.paste("**Read** the comments.");
    await app.user.click(within(editor).getByRole("button", { name: "Save instruction" }));
    const row = await within(card).findByRole("region", { name: "My review habits" });
    expect(within(row).getByText("Read", { selector: "strong" })).toBeDefined();
    expect(row.textContent).toContain("Read the comments.");
    expect((within(row).getByRole("checkbox", { name: "All accounts, including future accounts" }) as HTMLInputElement).checked).toBe(true);
    expect((within(row).getByRole("checkbox", { name: "Main account" }) as HTMLInputElement).checked).toBe(true);
    expect((within(row).getByRole("checkbox", { name: /Other account/ }) as HTMLInputElement).checked).toBe(true);
    const created = desk.requests("instructions.create").find((request) => request.params["title"] === "My review habits");
    expect(created?.params).toMatchObject({ title: "My review habits", body: "**Read** the comments." });
    expect(created?.params).not.toHaveProperty("catalogueId");
    expect(created?.params).not.toHaveProperty("origin");
  });


  it("does not recreate a removed and dismissed seed when another runtime opens the step", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk);
    const seed = await within(await openCard(app)).findByRole("region", { name: "About my setup" });
    await app.user.click(within(seed).getByRole("button", { name: "Remove" }));
    await app.user.click(within(await screen.findByRole("dialog", { name: "Remove About my setup?" })).getByRole("button", { name: "Remove instruction" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "About my setup" })).toBeNull());
    const next = await app.remount();
    await next.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const card = await openCard(next);
    await within(card).findByRole("region", { name: "Suggested instructions" });
    await next.user.click(within(card).getByRole("button", { name: "Dismissed" }));
    expect(await within(card).findByRole("button", { name: "Restore About my setup" })).toBeDefined();
    expect(within(card).queryByRole("region", { name: "About my setup" })).toBeNull();
    expect(desk.requests("instructions.create")).toHaveLength(0);
  });

  it("ticks a catalogue entry into a copy with all accounts reached", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk);
    const card = await openCard(app);
    const suggestions = await within(card).findByRole("region", { name: "Suggested instructions" });
    await app.user.click(within(suggestions).getByRole("checkbox", { name: "Read code from a fresh checkout" }));
    const row = await within(card).findByRole("region", { name: "Read code from a fresh checkout" });
    expect(within(row).getByText("coding.fresh-checkout")).toBeDefined();
    expect((within(row).getByRole("checkbox", { name: "All accounts, including future accounts" }) as HTMLInputElement).checked).toBe(true);
    expect((within(row).getByRole("checkbox", { name: "Main account" }) as HTMLInputElement).checked).toBe(true);
    expect(desk.requests("instructions.create").filter((request) => request.params["catalogueId"] === "coding.fresh-checkout")).toHaveLength(1);
  });

  it.each(["keep", "replace"] as const)("opens the reused version comparison and resolves it by %s", async (choice) => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    scriptInstructions(app.environment("desk"), [ownedInstruction({ origin: { catalogueId: "coding.fresh-checkout", version: 1 }, newerVersion: 2 })], { to: "Updated source.", toVersion: 2 });
    const card = await openCard(app);
    const row = await within(card).findByRole("region", { name: "Review habits" });
    expect(within(row).getByText("Newer version 2")).toBeDefined();
    await app.user.click(within(row).getByRole("button", { name: "See what changed" }));
    const dialog = await screen.findByRole("dialog", { name: "Changes to Review habits" });
    expect(await within(dialog).findByRole("table", { name: "Catalogue changes" })).toBeDefined();
    expect(within(dialog).getByText("Replace loses your edits. Keep mine keeps your text and clears this version badge.")).toBeDefined();
    await app.user.click(within(dialog).getByRole("button", { name: choice === "keep" ? "Keep mine" : "Replace with new text" }));
    await waitFor(() => expect(within(row).queryByText("Newer version 2")).toBeNull());
    expect(within(row).getByText(choice === "keep" ? "Read every comment." : "Updated source.")).toBeDefined();
  });

  it("leaves Instructions in Settings unseeded", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    const desk = app.environment("desk");
    scriptInstructions(desk);
    await app.user.keyboard("{Control>},{/Control}");
    await app.user.click(within(await screen.findByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Instructions" }));
    const pane = await screen.findByRole("region", { name: "Instructions" });
    await within(pane).findByText("No owned instruction on this environment.");
    expect(desk.requests("instructions.create")).toHaveLength(0);
  });


  it("recognizes a renamed, switched-off seed by its origin", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk, [ownedInstruction({ title: "My setup notes", enabled: false, origin: { catalogueId: "setup.about-my-setup", version: 1 } })]);
    const row = await within(await openCard(app)).findByRole("region", { name: "My setup notes" });
    expect(within(row).getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe("false");
    expect(desk.requests("instructions.create")).toHaveLength(0);
  });

  it("reads the winning copy when another client's create wins the seed id", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk);
    let won = false;
    desk.wire.answer("instructions.list", () => ({ result: {
      orientation: { enabled: true, text: "# Orientation", unreadRegistries: [], accounts: [] },
      instructions: won ? [ownedInstruction({ title: "About my setup", origin: { catalogueId: "setup.about-my-setup", version: 1 } })] : [],
      dismissed: [],
    } }));
    desk.wire.answer("instructions.create", () => {
      won = true;
      return { result: { receipt: { status: "rejected", sequence: 1, changed: false, reason: "conflict", error: { code: "conflict", message: "This id is already held.", data: { reason: "exists" } } } } };
    });
    const card = await openCard(app);
    await within(card).findByRole("region", { name: "About my setup" });
    expect(within(card).queryByText(/About my setup was not created/)).toBeNull();
    expect(desk.requests("instructions.create")).toHaveLength(1);
  });

});
