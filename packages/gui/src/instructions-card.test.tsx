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

const scriptPreview = (desk: EnvironmentHandle, unreadRegistries: string[] = []) => {
  desk.wire.answer("workspaces.browse", () => ({ result: { path: "/home/test", parent: "/home", directories: [], truncated: false } }));
  const result: ResultOf<"instructions.preview"> = {
    parts: [{ layer: "user", id: "orientation", title: "Orientation", text: "# Orientation\nPreview: verified on this environment." }],
    text: "# Orientation\nPreview: verified on this environment.",
    manifest: { channel: "system-prompt-append", layers: [], alwaysOn: [], skillSetFingerprint: null, unreadRegistries, leftOut: [] },
  };
  desk.wire.answer("instructions.preview", () => ({ result }));
};

describe("the Instructions card in Set up", () => {
  it("seeds About my setup once across two runtimes on the same environment and offers it as Your note with Edit", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk);
    const card = await openCard(app);
    const note = await within(await within(card).findByRole("region", { name: "Your note" })).findByRole("region", { name: "About my setup" });
    expect(desk.requests("instructions.create").map((request) => request.params["catalogueId"])).toEqual(["setup.about-my-setup"]);
    await app.user.click(within(note).getByRole("button", { name: "Edit" }));
    const editor = await within(note).findByRole("region", { name: "Edit About my setup" });
    await app.user.clear(within(editor).getByRole("textbox", { name: "Title" }));
    await app.user.type(within(editor).getByRole("textbox", { name: "Title" }), "How my computer is set up");
    await app.user.click(within(editor).getByRole("button", { name: "Save instruction" }));
    expect(await within(card).findByRole("region", { name: "How my computer is set up" })).toBeDefined();
    expect(desk.requests("instructions.edit").at(-1)?.params).toMatchObject({ title: "How my computer is set up" });
    const next = await app.remount();
    await next.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    await within(await openCard(next)).findByRole("region", { name: "Your note" });
    expect(desk.requests("instructions.create")).toHaveLength(0);
  });

  it("folds what agents are told about this computer: the preview, its switch and warning, and reads done from the environment's check", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", setup: { instructions: { state: "needs-attention", reason: "agent-harness could not finish checking this step. Choose Check again.", failing: ["instructions.orientation-renders"], actions: ["check-again"] } } }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk);
    scriptPreview(desk);
    const card = await openCard(app);
    await within(card).findByRole("region", { name: "Your note" });
    expect(within(card).queryByText(/Preview: verified/)).toBeNull();
    await app.user.click(within(card).getByRole("button", { name: "What agents are told about this computer" }));
    expect(await within(card).findByText(/Preview: verified/)).toBeDefined();
    expect(within(card).getByText("If you turn this off, agents will not know where your forges, keys and notebooks are.")).toBeDefined();
    expect(desk.requests("instructions.preview")[0]?.params).toEqual({ accountId: "account-1", workspace: { kind: "directory", path: "/home/test" } });
    await app.user.click(within(card).getByRole("switch", { name: "Tell agents about this computer" }));
    await waitFor(() => expect(within(card).getByRole("switch", { name: "Tell agents about this computer" }).getAttribute("aria-checked")).toBe("false"));
    expect(desk.requests("settings.update").at(-1)?.params["values"]).toEqual({ "instructions.orientation": false });
    act(() => {
      desk.setSetup({ instructions: { state: "done", reason: "Agents get your notes and a summary of this computer." } });
    });
    await app.user.click(within(card).getByRole("button", { name: "Check again" }));
    expect(await within(card).findByText("Agents get your notes and a summary of this computer.")).toBeDefined();
    expect(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Instructions", description: / Done / })).toBeDefined();
  });

  it("names each part it could not read by its step, with Go to that step inside Set up, and no raw section names", async () => {
    const reason = "agent-harness could not read part of this computer's setup: Your machines, Forges, Memory bank.";
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", setup: { instructions: { state: "needs-attention", reason, failing: ["instructions.orientation-renders"], actions: [], details: ["Unread sections of the orientation block: banks, forges, other-environments"] } } }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk);
    scriptPreview(desk, ["banks", "forges", "other-environments"]);
    const card = await openCard(app);
    expect(await within(card).findByText(reason)).toBeDefined();
    expect((await within(card).findAllByRole("button", { name: /^Go to / })).map((button) => button.textContent)).toEqual(["Go to Your machines", "Go to Forges", "Go to Memory bank"]);
    await app.user.click(within(card).getByRole("button", { name: "What agents are told about this computer" }));
    expect(within(card).queryByText(/other-environments|banks, forges/)).toBeNull();
    await app.user.click(within(card).getByRole("button", { name: "Go to Forges" }));
    const rail = screen.getByRole("navigation", { name: "Set up steps" });
    await waitFor(() => expect(within(rail).getByRole("button", { name: "Forges" }).getAttribute("aria-current")).toBe("step"));
    expect(screen.getByRole("region", { name: "Forges" })).toBeDefined();
  });

  it("offers no Go to while the step's check passes, though the preview still names an unread part", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", setup: { instructions: { state: "done", reason: "Agents get your notes and a summary of this computer." } } }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk);
    scriptPreview(desk, ["forges"]);
    const card = await openCard(app);
    await app.user.click(await within(card).findByRole("button", { name: "What agents are told about this computer" }));
    await within(card).findByText(/Preview: verified/);
    expect(within(card).queryByRole("button", { name: /^Go to / })).toBeNull();
  });

  it("writes your own note without an origin and shows it beside About my setup", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk);
    const card = await openCard(app);
    await within(card).findByRole("region", { name: "Your note" });
    await app.user.click(within(card).getByRole("button", { name: "Write your own" }));
    const editor = await screen.findByRole("dialog", { name: "New instruction" });
    await app.user.type(within(editor).getByRole("textbox", { name: "Title" }), "My review habits");
    await app.user.click(within(editor).getByRole("textbox", { name: "Markdown body" }));
    await app.user.paste("**Read** the comments.");
    await app.user.click(within(editor).getByRole("button", { name: "Save instruction" }));
    const note = within(card).getByRole("region", { name: "Your note" });
    expect(await within(note).findByRole("region", { name: "My review habits" })).toBeDefined();
    const created = desk.requests("instructions.create").find((request) => request.params["title"] === "My review habits");
    expect(created?.params).toMatchObject({ title: "My review habits", body: "**Read** the comments." });
    expect(created?.params).not.toHaveProperty("catalogueId");
    expect(created?.params).not.toHaveProperty("origin");
  });

  it("does not recreate a removed and dismissed seed when the step opens, and shows no note for it", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk);
    desk.wire.answer("instructions.list", () => ({ result: { orientation: { enabled: true, text: "# Orientation", unreadRegistries: [], accounts: [] }, instructions: [], dismissed: ["setup.about-my-setup"] } }));
    const card = await openCard(app);
    await within(card).findByRole("region", { name: "Suggestions" });
    expect(within(card).queryByRole("region", { name: "Your note" })).toBeNull();
    expect(within(card).queryByRole("checkbox", { name: "About my setup" })).toBeNull();
    expect(desk.requests("instructions.create")).toHaveLength(0);
  });

  it("ticks a suggestion with its one line into a copy, and leaves owned lists, order and account reach to Settings", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk);
    const card = await openCard(app);
    const suggestions = await within(card).findByRole("region", { name: "Suggestions" });
    expect(within(suggestions).getByText("Pull or clone before you reference code, and say which commit you read.")).toBeDefined();
    await app.user.click(within(suggestions).getByRole("checkbox", { name: "Read code from a fresh checkout" }));
    await waitFor(() => expect((within(suggestions).getByRole("checkbox", { name: "Read code from a fresh checkout" }) as HTMLInputElement).checked).toBe(true));
    expect((within(suggestions).getByRole("checkbox", { name: "Read code from a fresh checkout" }) as HTMLInputElement).disabled).toBe(true);
    expect(within(suggestions).getByText("Added. Change or remove it in Settings › Instructions.")).toBeDefined();
    expect(desk.requests("instructions.create").filter((request) => request.params["catalogueId"] === "coding.fresh-checkout")).toHaveLength(1);
    expect(within(card).queryByRole("region", { name: "Read code from a fresh checkout" })).toBeNull();
    expect(within(card).queryByRole("region", { name: "Owned instructions" })).toBeNull();
    expect(within(card).queryByRole("button", { name: /Move (up|down)|Dismiss/ })).toBeNull();
    expect(within(card).queryByRole("checkbox", { name: "All accounts, including future accounts" })).toBeNull();
  });

  it("leaves a copy's newer version to Settings, where its comparison opens", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    scriptInstructions(app.environment("desk"), [ownedInstruction({ origin: { catalogueId: "coding.fresh-checkout", version: 1 }, newerVersion: 2 })], { to: "Updated source.", toVersion: 2 });
    const card = await openCard(app);
    await within(card).findByRole("region", { name: "Suggestions" });
    expect(within(card).queryByText("Newer version 2")).toBeNull();
    await app.user.click(within(card).getByRole("button", { name: "Open Instructions" }));
    const pane = await screen.findByRole("region", { name: "Instructions" });
    const row = await within(pane).findByRole("region", { name: "Review habits" });
    expect(within(row).getByText("Newer version 2")).toBeDefined();
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

  it("recognizes a renamed, switched-off seed by its origin as Your note", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const desk = app.environment("desk");
    scriptInstructions(desk, [ownedInstruction({ title: "My setup notes", enabled: false, origin: { catalogueId: "setup.about-my-setup", version: 1 } })]);
    const note = await within(await openCard(app)).findByRole("region", { name: "Your note" });
    expect(within(note).getByRole("region", { name: "My setup notes" })).toBeDefined();
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
    await within(await within(card).findByRole("region", { name: "Your note" })).findByRole("region", { name: "About my setup" });
    expect(within(card).queryByText(/About my setup was not created/)).toBeNull();
    expect(desk.requests("instructions.create")).toHaveLength(1);
  });
});
