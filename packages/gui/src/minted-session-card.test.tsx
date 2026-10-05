import { uuidv4 } from "@agent-harness/client-runtime";
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";
import { MintedSessionCard } from "./setup/minted-session-card.js";
import type { ComponentType } from "react";
import type { StepCardProps } from "./setup/cards.js";

const BankCard = (props: StepCardProps) => <MintedSessionCard {...props} subject="bank-1" artefact={{ kind: "folder", path: "/banks/receipts" }} />;

const openCard = async (more: Partial<ScriptedEnvironment> = {}, draft = false, Card: ComponentType<StepCardProps> = BankCard) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["setup"], setup: { "memory-bank": { state: "needs-attention", reason: "BANK.md is missing.", actions: ["write-it-myself", "start-over"] } }, ...more }] }, { firstLaunch: true, stepCards: { "memory-bank": Card } });
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  const env = app.environment("desk");
  // The setup.mint boundary creates an ordinary session, just as the environment's mint service does.
  env.wire.answer("setup.mint", async () => {
    const id = uuidv4();
    const created = await app.runtime.commands.dispatch(env.environmentId, "sessions.create", { id, title: "Set up: Memory bank", tags: ["setup", "memory-bank"], workspace: { kind: "scratch" } });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (draft) {
      await app.runtime.commands.dispatch(env.environmentId, "sessions.setDraft", { sessionId: id, draft: "Describe this bank." });
    } else env.startRun(id, "Describe this bank.");
    return { result: { receipt: { status: "accepted", sequence: env.events(id).at(-1)?.sequence ?? 0, changed: true }, result: { sessionId: id } } };
  });
  await screen.findByRole("region", { name: "Set up" });
  await app.user.click(screen.getByRole("button", { name: "Memory bank" }));
  return app;
};

const closeAuthoring = async (app: RenderedApp) => {
  const dialog = screen.queryByRole("dialog", { name: "Authoring conversation" });
  if (dialog !== null) await app.user.click(within(dialog).getByRole("button", { name: "Close dialog" }));
};

const mint = async (app: RenderedApp) => {
  await closeAuthoring(app);
  await app.user.click(screen.getByRole("button", { name: "Start over" }));
  await screen.findByRole("textbox", { name: "Message" });
  return app.environment("desk").requests("setup.mint").at(-1);
};

describe("the minted session on its card", () => {
  it("opens bank authoring in a conversation dialog and resumes the same session after closing it", async () => {
    const app = await openCard();
    await mint(app);
    const dialog = await screen.findByRole("dialog", { name: "Authoring conversation" });
    const env = app.environment("desk");
    const id = env.sessionId();
    const questions = Array.from({ length: 8 }, (_, at) => ({ header: `Topic ${at + 1}`, question: `What should topic ${at + 1} retain?`, options: [], multiSelect: false }));
    act(() => env.openPrompt(id, { kind: "question", input: null, questions }));
    const request = await within(dialog).findByRole("region", { name: "Questions" });
    const decision = within(dialog).getByRole("group", { name: "Question decision" });
    expect(within(request).queryByRole("button", { name: "Send answers" })).toBeNull();
    await app.user.type(within(request).getAllByRole("textbox", { name: "Your own answer" })[0]!, "Working agreements");
    await app.user.click(within(dialog).getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog", { name: "Authoring conversation" })).toBeNull();
    await app.user.click(screen.getByRole("button", { name: "Continue authoring" }));
    const resumed = await screen.findByRole("dialog", { name: "Authoring conversation" });
    expect(within(resumed).getAllByRole("textbox", { name: "Your own answer" })[0]).toHaveProperty("value", "Working agreements");
    await app.user.click(within(resumed).getByRole("button", { name: "Send answers" }));
    await waitFor(() => expect(env.requests("permissions.prompts.answer").at(-1)?.params["answers"]).toEqual({ "What should topic 1 retain?": "Working agreements" }));
    expect(decision.contains(request)).toBe(false);
    expect(env.requests("setup.mint")).toHaveLength(1);
    expect(env.liveRun(id)).toBeDefined();
  });

  it.each(["question", "permission"] as const)("Escape answers an authoring %s without closing the conversation", async kind => {
    const app = await openCard(); await mint(app);
    const env = app.environment("desk"); const id = env.sessionId();
    act(() => env.openPrompt(id, kind === "question" ? { kind, input: null, questions: [{ header: "Topic", question: "What should the bank retain?", options: [], multiSelect: false }] } : undefined));
    const card = await screen.findByRole("region", { name: "Parked prompt" });
    act(() => card.focus());
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(env.requests("permissions.prompts.answer").at(-1)?.params["decision"]).toBe("deny"));
    expect(screen.getByRole("dialog", { name: "Authoring conversation" })).toBeDefined();
  });

  it.each(["/", "@"])("Escape dismisses the authoring composer's %s menu before denying its question", async text => {
    const app = await openCard({ files: ["BANK.md"] }); await mint(app);
    const env = app.environment("desk"); const id = env.sessionId();
    act(() => env.openPrompt(id, { kind: "question", input: null, questions: [{ header: "Topic", question: "What should the bank retain?", options: [], multiSelect: false }] }));
    await screen.findByRole("region", { name: "Parked prompt" });
    const composer = screen.getByRole("textbox", { name: "Message" });
    await app.user.type(composer, text);
    expect(await screen.findByRole("listbox")).toBeDefined();
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Authoring conversation" })).toBeDefined();
    expect(composer).toHaveProperty("value", text);
    expect(env.requests("permissions.prompts.answer")).toHaveLength(0);
  });

  it("Escape dismisses an idle authoring conversation when no local handler needs it", async () => {
    const app = await openCard(); await mint(app);
    await app.user.click(screen.getByRole("textbox", { name: "Message" }));
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Authoring conversation" })).toBeNull());
  });

  it("streams the ordinary session's transcript under its running status and opens it in the main pane", async () => {
    const app = await openCard();
    await mint(app);
    const env = app.environment("desk");
    const id = env.sessionId();
    const runId = env.liveRun(id) as string;
    act(() => env.emit(id, "assistant.delta", { runId, itemId: "bank-text", fragments: [{ kind: "text", text: "Working on BANK.md. " }] }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Transcript" })).getByRole("article", { name: "Reply" }).textContent).toContain("Working on BANK.md."));
    expect(screen.getByRole("status", { name: "Authoring status" }).textContent).toBe("running");
    expect(screen.getByRole("region", { name: "Authoring conversation" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Set up: Memory bank" })).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Open in the main window" }));
    await waitFor(() => expect(app.shown()?.sessionId).toBe(id));
    expect(screen.queryByRole("region", { name: "Set up" })).toBeNull();
    expect(app.presentation.values.read().firstLaunchDone).toBe(true);
    await app.user.keyboard("{Control>},{/Control}");
    await app.user.click(await screen.findByRole("button", { name: "Open the full checklist" }));
    await app.user.click(await screen.findByRole("button", { name: "Continue authoring" }));
    expect(await screen.findByRole("status", { name: "Authoring status" })).toBeDefined();
    expect(screen.getByRole("status", { name: "Authoring status" }).textContent).toBe("running");
    expect(within(screen.getByRole("region", { name: "Transcript" })).getByRole("article", { name: "Reply" }).textContent).toContain("Working on BANK.md.");
    expect(env.requests("setup.mint")).toHaveLength(1);
    expect(env.liveRun(id)).toBe(runId);
  });

  it("resizes the authoring surface with the phone's visual viewport", async () => {
    const viewport = Object.assign(new EventTarget(), { height: 844 });
    vi.stubGlobal("visualViewport", viewport);
    try {
      const app = await openCard();
      await mint(app);
      const dialog = screen.getByRole("dialog", { name: "Authoring conversation" });
      await waitFor(() => expect(dialog.style.getPropertyValue("--authoring-viewport-height")).toBe("844px"));
      act(() => { viewport.height = 480; viewport.dispatchEvent(new Event("resize")); });
      expect(dialog.style.getPropertyValue("--authoring-viewport-height")).toBe("480px");
    } finally { vi.unstubAllGlobals(); }
  });

  it("answers a parked permission on the card and resumes its running status", async () => {
    const app = await openCard();
    await mint(app);
    const env = app.environment("desk");
    const id = env.sessionId();
    act(() => env.openPrompt(id));
    const parked = await screen.findByRole("region", { name: "Parked prompt" });
    expect(screen.getByRole("status", { name: "Authoring status" }).textContent).toBe("waiting for you");
    await app.user.click(within(parked).getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Parked prompt" })).toBeNull());
    expect(env.requests("permissions.prompts.answer").at(-1)?.params["decision"]).toBe("allow");
    expect(screen.getByRole("status", { name: "Authoring status" }).textContent).toBe("running");
  });

  it("skips without stopping the run, keeps it on return, and takes done from the check at a run end", async () => {
    const app = await openCard();
    await mint(app);
    const env = app.environment("desk");
    const id = env.sessionId();
    const runId = env.liveRun(id) as string;
    await closeAuthoring(app);
    await app.user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(env.liveRun(id)).toBe(runId);
    expect(env.requests("runs.interrupt")).toHaveLength(0);
    act(() => {
      env.endRun(id, runId);
      env.setSetup({ "memory-bank": { state: "done", reason: "BANK.md landed.", actions: ["revise"] } });
      env.passSetup(["memory-bank"]);
    });
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("img", { name: "Memory bank: done" })).toBeDefined());
    await app.user.click(screen.getByRole("button", { name: "Memory bank" }));
    await app.user.click(await screen.findByRole("button", { name: "Continue authoring" }));
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeDefined();
    await waitFor(() => expect(screen.getByRole("status", { name: "Authoring status" }).textContent).toBe("landed"));
  });

  it("tries again on the target session and starts over without removing the old session", async () => {
    const app = await openCard();
    await mint(app);
    const env = app.environment("desk");
    const id = env.sessionId();
    act(() => {
      env.endRun(id, env.liveRun(id) as string, { reason: "error" });
      env.setSetup({ "memory-bank": { actions: ["try-again", "write-it-myself", "start-over"], targets: [{ action: "try-again", kind: "session", id, label: "the describe session" }] } });
      env.passSetup(["memory-bank"]);
    });
    await closeAuthoring(app);
    await app.user.click(await screen.findByRole("button", { name: "Try again: the describe session" }));
    await waitFor(() => expect(env.requests("runs.send").at(-1)?.params).toMatchObject({ sessionId: id, text: "Continue where you stopped." }));
    await mint(app);
    await waitFor(() => expect(app.runtime.projections.sessionList.read().rows).toHaveLength(2));
    expect(app.runtime.projections.sessionList.read().rows.some((row) => row.summary.id === id)).toBe(true);
    expect(env.requests("setup.mint").at(-1)?.params).toMatchObject({ step: "memory-bank", subject: "bank-1", variant: "first" });
  });

  it("revises by minting the revise variant for the action's bank", async () => {
    const app = await openCard();
    await mint(app);
    const env = app.environment("desk");
    act(() => {
      env.endRun(env.sessionId(), env.liveRun(env.sessionId()) as string);
      env.setSetup({ "memory-bank": { state: "done", reason: "BANK.md landed.", actions: ["revise"], targets: [{ action: "revise", kind: "bank", id: "bank-2", label: "Invoices" }] } });
      env.passSetup(["memory-bank"]);
    });
    await closeAuthoring(app);
    await app.user.click(await screen.findByRole("button", { name: "Revise: Invoices" }));
    await waitFor(() => expect(env.requests("setup.mint").at(-1)?.params).toMatchObject({ subject: "bank-2", variant: "revise" }));
  });

  it("opens the bank checkout in Files for Write it myself without starting an authoring run", async () => {
    const app = await openCard();
    const env = app.environment("desk");
    await app.user.click(screen.getByRole("button", { name: "Write it myself" }));
    const files = await screen.findByRole("complementary", { name: "Side column" });
    expect(within(files).getByRole("tab", { name: "Files" })).toBeDefined();
    expect(env.requests("sessions.create").at(-1)?.params["workspace"]).toEqual({ kind: "directory", path: "/banks/receipts" });
    expect(env.requests("setup.mint")).toHaveLength(0);
    expect(env.requests("runs.start")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Set up" })).toBeNull();
  });

  it("presets account, model family and effort and remembers changes across cards in this checklist run", async () => {
    const app = await openCard({
      accounts: [{ id: "account-1", label: "Work" }, { id: "account-2", label: "Home" }],
      models: [
        { accountId: "account-1", models: [{ id: "large-model", family: "large", tier: 3, efforts: ["low", "high"], label: "Large" }, { id: "small-model", family: "small", tier: 1, efforts: ["low", "high"], label: "Small" }] },
        { accountId: "account-2", models: [{ id: "home-model", family: "home", tier: 2, efforts: ["low", "high"], label: "Home model" }] },
      ],
      settings: { "accounts.defaultAccount": "account-1", "accounts.defaultModelFamily": "small", "accounts.defaultEffort": "high" },
    });
    const select = (name: string) => screen.getByRole("combobox", { name }) as HTMLSelectElement;
    await waitFor(() => expect(select("Authoring model").value).toBe("small-model"));
    expect(select("Authoring account").value).toBe("account-1");
    expect(select("Authoring effort").value).toBe("high");
    await app.user.selectOptions(select("Authoring account"), "account-2");
    await waitFor(() => expect(select("Authoring model").value).toBe("home-model"));
    await app.user.selectOptions(select("Authoring effort"), "low");
    await app.user.click(screen.getByRole("button", { name: "Skills" }));
    await app.user.click(screen.getByRole("button", { name: "Memory bank" }));
    expect(select("Authoring account").value).toBe("account-2");
    expect(select("Authoring effort").value).toBe("low");
    await mint(app);
    expect(app.environment("desk").requests("setup.mint").at(-1)?.params).toMatchObject({ account: "account-2", model: "home-model", effort: "low" });
    expect(app.environment("desk").requests("settings.update")).toHaveLength(0);
    await closeAuthoring(app);
    await app.user.selectOptions(select("Authoring account"), "account-1");
    await waitFor(() => expect(select("Authoring model").value).toBe("small-model"));
    await app.user.selectOptions(select("Authoring model"), "large-model");
    expect(select("Authoring effort").value).toBe("low");
  });

  it("keeps its picker choices and attached session across a detour to a Settings row", async () => {
    const app = await openCard({
      accounts: [{ id: "account-1", label: "Work" }],
      models: [{ accountId: "account-1", models: [{ id: "large-model", family: "large", tier: 3, efforts: ["low", "high"], label: "Large" }] }],
      settings: { "accounts.defaultAccount": "account-1", "accounts.defaultEffort": "high" },
    });
    const effort = () => screen.getByRole("combobox", { name: "Authoring effort" }) as HTMLSelectElement;
    await waitFor(() => expect(effort().value).toBe("high"));
    await app.user.selectOptions(effort(), "low");
    await mint(app);
    const env = app.environment("desk");
    const id = env.sessionId();
    const runId = env.liveRun(id);
    await closeAuthoring(app);
    await app.user.click(screen.getByRole("button", { name: "Permissions" }));
    await app.user.click(screen.getByRole("button", { name: "Open Permissions" }));
    expect(app.presentation.values.read().firstLaunchDone).toBe(false);
    const settings = await screen.findByRole("region", { name: "Settings" });
    await app.user.click(within(within(settings).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Set up" }));
    await app.user.click(screen.getByRole("button", { name: "Open the full checklist" }));
    await app.user.click(screen.getByRole("button", { name: "Memory bank" }));
    expect(screen.queryByRole("dialog", { name: "Authoring conversation" })).toBeNull();
    expect(effort().value).toBe("low");
    await app.user.click(screen.getByRole("button", { name: "Continue authoring" }));
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeDefined();
    expect(screen.getByRole("status", { name: "Authoring status" }).textContent).toBe("running");
    expect(env.requests("setup.mint")).toHaveLength(1);
    expect(env.liveRun(id)).toBe(runId);

    await closeAuthoring(app);
    // An explicit Close ends the checklist run; the next opening uses fresh defaults.
    await app.user.click(screen.getByRole("button", { name: "Close Set up" }));
    const reopenedSettings = await screen.findByRole("region", { name: "Settings" });
    await app.user.click(within(within(reopenedSettings).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Set up" }));
    await app.user.click(screen.getByRole("button", { name: "Open the full checklist" }));
    expect(effort().value).toBe("high");
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(env.liveRun(id)).toBe(runId);
  });

  it("shows the minted prompt as the composer's draft when no account resolves", async () => {
    const app = await openCard({}, true);
    await mint(app);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Describe this bank."));
    expect(screen.getByRole("status", { name: "Authoring status" }).textContent).toBe("waiting for you");
    expect(app.environment("desk").liveRun(app.environment("desk").sessionId())).toBeUndefined();
  });

  it("shows the subject's landed and awaiting review outcome after its run ends", async () => {
    const ReviewCard = (props: StepCardProps) => <MintedSessionCard {...props} subject="bank-1" artefact={{ kind: "folder", path: "/banks/receipts" }} outcome="landed and awaiting review" />;
    const app = await openCard({}, false, ReviewCard);
    await mint(app);
    const env = app.environment("desk");
    expect(screen.getByRole("status", { name: "Authoring status" }).textContent).toBe("running");
    act(() => env.endRun(env.sessionId(), env.liveRun(env.sessionId()) as string));
    await waitFor(() => expect(screen.getByRole("status", { name: "Authoring status" }).textContent).toBe("landed and awaiting review"));
  });

  it("offers a first authoring action when the step has not minted a session yet", async () => {
    const FirstCard = (props: StepCardProps) => <MintedSessionCard {...props} subject="bank-1" artefact={{ kind: "folder", path: "/banks/receipts" }} startLabel="Describe this bank" />;
    const app = await openCard({ setup: { "memory-bank": { state: "needs-attention", reason: "BANK.md is missing.", actions: [] } } }, false, FirstCard);
    await app.user.click(screen.getByRole("button", { name: "Describe this bank" }));
    await screen.findByRole("textbox", { name: "Message" });
    expect(app.environment("desk").requests("setup.mint").at(-1)?.params).toMatchObject({ variant: "first", subject: "bank-1" });
  });

  it("opens the Instructions editor for an instruction artefact", async () => {
    const InstructionsCard = (props: StepCardProps) => <MintedSessionCard {...props} artefact={{ kind: "instructions" }} />;
    const app = await openCard({}, false, InstructionsCard);
    await app.user.click(screen.getByRole("button", { name: "Write it myself" }));
    expect(await screen.findByRole("region", { name: "Instructions" })).toBeDefined();
    expect(app.environment("desk").requests("setup.mint")).toHaveLength(0);
  });

  it("leaves a long run running and explains a clean end whose check still fails", async () => {
    const app = await openCard();
    await mint(app);
    const env = app.environment("desk");
    const id = env.sessionId();
    act(() => app.clock.advance(2 * 60 * 60 * 1000));
    expect(screen.getByRole("status", { name: "Authoring status" }).textContent).toBe("running");
    act(() => {
      env.endRun(id, env.liveRun(id) as string);
      env.passSetup(["memory-bank"]);
    });
    await waitFor(() => expect(screen.getByRole("status", { name: "Authoring status" }).textContent).toBe("needs attention"));
    expect(screen.getByText(/BANK.md is missing/)).toBeDefined();
    expect(env.requests("runs.interrupt")).toHaveLength(0);
  });

  it("explains a refused mint without discarding the attached session", async () => {
    const app = await openCard();
    await mint(app);
    const env = app.environment("desk");
    const id = env.sessionId();
    env.wire.answer("setup.mint", () => ({ error: { code: "conflict", message: "The bank checkout is missing.", data: { reason: "bank_missing" } } }));
    await closeAuthoring(app);
    await app.user.click(screen.getByRole("button", { name: "Start over" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The bank checkout is missing.");
    expect(env.liveRun(id)).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Continue authoring" }));
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDefined();
    expect(app.runtime.projections.sessionList.read().rows).toHaveLength(1);
    env.wire.answer("setup.mint", async () => {
      const next = uuidv4();
      const created = await app.runtime.commands.dispatch(env.environmentId, "sessions.create", { id: next, title: "Set up: Memory bank", tags: ["setup", "memory-bank"], workspace: { kind: "scratch" } });
      expect(created.ok).toBe(true);
      env.startRun(next, "Describe this bank.");
      return { result: { receipt: { status: "accepted", sequence: env.events(next).at(-1)?.sequence ?? 0, changed: true }, result: { sessionId: next } } };
    });
    await mint(app);
    await waitFor(() => expect(app.runtime.projections.sessionList.read().rows).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status", { name: "Authoring status" }).textContent).toBe("running");
  });
});
