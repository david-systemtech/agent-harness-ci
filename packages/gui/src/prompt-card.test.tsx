import { act, screen, waitFor, within } from "@testing-library/react";
import { MANUAL_CLOCK_START } from "@agent-harness/client-runtime/testing";
import { describeDenylistMatch, type DenylistMatch } from "@agent-harness/contracts";
import type { ScriptedPrompt } from "@agent-harness/client-runtime/testing/scripted-environment";
import { describe, expect, it, vi } from "vitest";
import { renderApp, type EnvironmentHandle, type RenderedApp, type RenderOptions, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The parked prompt's card (docs/specs/gui.md, "A session pane"; permissions
 * spec, "Prompts, parked prompts and the TTL"; story 10): the open session's
 * parked prompts wait on a card between the transcript and the composer,
 * oldest first, until answered, then are drawn in the transcript where they
 * were asked. A bare Enter never approves: an approval is Mod+Enter
 * (`permission.allow`) or a click. Esc (`permission.deny`) denies, or skips
 * a question; a note rides the answer. Every answer is
 * `permissions.prompts.answer`. Driven through the harness over the scripted
 * environment's prompts, with a live run.
 */

/** The local environment with one session opened in the pane and a run going on it. */
const opened = async (more: Partial<ScriptedEnvironment> = {}, options: RenderOptions = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }], ...more }] }, options);
  app.open("desk");
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  const env = app.environment("desk");
  const session = env.sessionId();
  env.startRun(session, "Clean the build");
  await within(transcript).findByRole("article", { name: "Your message" });
  return { app, env, transcript, session };
};

/** The card; null while none is drawn. */
const card = () => screen.queryByRole("region", { name: "Parked prompt" });

/** Parks a prompt on the session's run and waits for the card to show it. */
const park = async (env: EnvironmentHandle, session: string, prompt: ScriptedPrompt = {}) => {
  const promptId = env.openPrompt(session, prompt);
  await waitFor(() => expect(card()).not.toBeNull());
  return promptId;
};

/** The params of every `permissions.prompts.answer` the window sent. */
const answersSent = (env: EnvironmentHandle) => env.requests("permissions.prompts.answer").map((request) => request.params);

/** Whether `a` comes before `b` in the document. */
const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("the card", () => {
  it("sits between the transcript and the composer until answered, then the prompt is drawn in the transcript where it was asked", async () => {
    const { env, transcript, session } = await opened();
    const promptId = await park(env, session);
    const shown = card() as HTMLElement;
    const composer = screen.getByRole("textbox", { name: "Message" });
    expect(before(transcript, shown)).toBe(true);
    expect(before(shown, composer)).toBe(true);
    expect(within(shown).getByRole("heading").textContent).toContain("Bash");
    expect(within(shown).getByText("$ rm -rf build")).toBeTruthy();
    // The card is where it waits: the transcript leaves it out until it is answered.
    expect(within(transcript).queryByRole("article", { name: "Permission" })).toBeNull();

    env.answerElsewhere(session, promptId, { decision: "allow" });
    await waitFor(() => expect(card()).toBeNull());
    expect(within(transcript).getByRole("article", { name: "Permission" }).textContent).toBe("Bash: rm -rf build — allowed");
  });

  it("hides and shows the same oldest request, keeping choices, note, TTL and focus", async () => {
    const { app, env, session } = await opened();
    const first = await park(env, session, {
      kind: "question", summary: "Which check?", input: null,
      questions: [{ header: "Check", question: "Which check?", options: [{ label: "Types", description: "Check types" }], multiSelect: false }],
      ttlExpiresAt: new Date(app.clock.now().getTime() + 120_000).toISOString(),
    });
    env.openPrompt(session, { summary: "A later request" });
    const shown = card() as HTMLElement;
    await app.user.click(within(shown).getByRole("radio", { name: "Types" }));
    await app.user.type(within(shown).getByRole("textbox", { name: "Note" }), "Use strict checks");
    await app.user.click(button("Hide request"));
    expect(within(shown).queryByRole("radio")).toBeNull();
    expect(shown.textContent).toContain("1 of 2 waiting");
    act(() => app.clock.advance(1_000));
    await waitFor(() => expect(shown.textContent).toContain("1m 59s left"));
    await app.user.click(button("Show request"));
    expect(document.activeElement).toBe(shown);
    expect(within(shown).getByRole("radio", { name: "Types" })).toHaveProperty("checked", true);
    expect(within(shown).getByRole("textbox", { name: "Note" })).toHaveProperty("value", "Use strict checks");
    await press(app, MOD_ENTER);
    expect((await sentAnswers(env, 1))[0]).toEqual(expect.objectContaining({ promptId: first, answers: { "Which check?": "Types" }, message: "Use strict checks" }));
  });

});

/** The card's button named `name`. */
const button = (name: string | RegExp) => within(card() as HTMLElement).getByRole("button", { name });

/** Keys pressed where the focus is. */
const press = async (app: RenderedApp, keys: string) => app.user.keyboard(keys);

/** Mod+Enter, off macOS. */
const MOD_ENTER = "{Control>}{Enter}{/Control}";

/** Waits for the window to have sent `count` answers, and gives their params. */
const sentAnswers = async (env: EnvironmentHandle, count: number) => {
  await waitFor(() => expect(answersSent(env)).toHaveLength(count));
  return answersSent(env);
};

describe("an approval", () => {
  it("bounds a pending request by the pane left after notices, composer and three transcript lines", async () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { observers.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    try {
      const { env, session, transcript } = await opened();
      await park(env, session, { input: { command: "git tag qa-check" } });
      const prompt = card()!;
      const pane = prompt.closest('[aria-label="Session pane"]')!;
      const column = prompt.closest("[data-composer-column]")!;
      const above = prompt.closest<HTMLElement>("[data-composer-above]")!;
      transcript.style.lineHeight = "28px";
      (transcript.firstElementChild as HTMLElement).style.paddingTop = "14px";
      (transcript.firstElementChild as HTMLElement).style.paddingBottom = "14px";
      let paneHeight = 580;
      vi.spyOn(pane, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 1000, paneHeight));
      vi.spyOn(column, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 600));
      vi.spyOn(prompt, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 420));
      const caption = pane.firstElementChild!;
      vi.spyOn(caption, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 32));
      const resize = () => act(() => { for (const callback of observers) callback([], {} as ResizeObserver); });
      resize();
      expect(above.style.getPropertyValue("--session-prompt-height")).toBe("256px");
      expect(above.dataset["promptSpace"]).toBe("compact");
      expect(prompt.style.maxHeight).toBe("min(60dvh, var(--session-prompt-height, 60dvh))");
      // Dismissing unrelated banners restores space without remounting the request.
      paneHeight = 712;
      resize();
      expect(above.style.getPropertyValue("--session-prompt-height")).toBe("388px");
      // Growing the request and its containing composer equally changes no allocation.
      vi.mocked(column.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 1000, 800));
      vi.mocked(prompt.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 1000, 620));
      resize();
      expect(above.style.getPropertyValue("--session-prompt-height")).toBe("388px");
    } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });

  it.each([
    { action: "Deny", decision: "deny", remember: undefined },
    { action: "Allow once", decision: "allow", remember: undefined },
    { action: "Allow for this session", decision: "allow", remember: "session" },
  ])("keeps $action and its note outside a long request, including after refusal", async ({ action, decision, remember }) => {
    const { app, env, session } = await opened();
    const command = Array.from({ length: 40 }, (_, at) => `printf 'Check ${at + 1}'`).join("\n");
    const promptId = await park(env, session, { input: { command } });
    const request = within(card() as HTMLElement).getByRole("region", { name: "Permission request" });
    const decisions = within(card() as HTMLElement).getByRole("group", { name: "Permission decision" });
    expect(within(request).getByLabelText("Arguments").textContent).toContain("$ printf 'Check 1'");
    expect(within(request).getByLabelText("Arguments").textContent).toContain("printf 'Check 40'");
    expect(within(request).queryByRole("textbox", { name: "Note" })).toBeNull();
    expect(within(request).queryByRole("button", { name: action })).toBeNull();
    await app.user.type(within(decisions).getByRole("textbox", { name: "Note" }), "Keep the receipts");
    await app.user.click(button("Hide request"));
    await app.user.click(button("Show request"));
    expect(within(card() as HTMLElement).getByRole("textbox", { name: "Note" })).toHaveProperty("value", "Keep the receipts");

    env.wire.answer("permissions.prompts.answer", () => ({ error: { code: "conflict", message: "Try the decision again.", data: {} } }));
    await app.user.click(button(action));
    await waitFor(() => expect(within(card() as HTMLElement).getByRole("status").textContent).toContain("Try the decision again."));
    const returned = within(card() as HTMLElement).getByRole("group", { name: "Permission decision" });
    expect(within(returned).getByRole("textbox", { name: "Note" })).toHaveProperty("value", "Keep the receipts");
    expect(within(returned).getByRole("status")).toBeTruthy();
    expect(within(card() as HTMLElement).getByRole("region", { name: "Permission request" }).textContent).toContain("printf 'Check 40'");
    await app.user.click(within(returned).getByRole("button", { name: action }));
    expect(await sentAnswers(env, 2)).toEqual(Array.from({ length: 2 }, () => ({
      commandId: expect.any(String), promptId, sessionId: session, decision,
      ...(remember !== undefined && { remember }), message: "Keep the receipts",
    })));
  });

  it("waits oldest first, 1 of N, and is allowed once by a click, and for this session by the other", async () => {
    const { app, env, transcript, session } = await opened();
    const first = await park(env, session, { summary: "Bash: rm -rf build" });
    const second = env.openPrompt(session, { summary: "Bash: git push", input: { command: "git push" } });
    await waitFor(() => expect((card() as HTMLElement).textContent).toContain("1 of 2 waiting"));
    expect(within(card() as HTMLElement).getByText("$ rm -rf build")).toBeTruthy();

    await app.user.click(button("Allow once"));
    expect((await sentAnswers(env, 1))[0]).toEqual({ commandId: expect.any(String), promptId: first, sessionId: session, decision: "allow" });
    // The next waits on the card at once, the only one now.
    await waitFor(() => expect(within(card() as HTMLElement).queryByText("$ git push")).not.toBeNull());
    expect((card() as HTMLElement).textContent).not.toContain("waiting");

    await app.user.click(button("Allow for this session"));
    expect((await sentAnswers(env, 2))[1]).toEqual({ commandId: expect.any(String), promptId: second, sessionId: session, decision: "allow", remember: "session" });
    await waitFor(() => expect(card()).toBeNull());
    expect(within(transcript).getAllByRole("article", { name: "Permission" }).map((article) => article.textContent)).toEqual([
      "Bash: rm -rf build — allowed",
      "Bash: git push — allowed for this session",
    ]);
  });

  it("orders denial, session allowance and one-time allowance with icons and effective keycaps", async () => {
    const { app, env, session } = await opened();
    await park(env, session);
    const shown = card() as HTMLElement;
    const actions = within(shown).getAllByRole("button").filter((control) => control.getAttribute("aria-label") !== "Hide request");
    expect(actions.map((control) => control.getAttribute("aria-label") ?? control.textContent)).toEqual(["Deny", "Allow for this session", "Allow once"]);
    for (const control of actions) expect(control.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(button("Deny").querySelector("kbd")?.textContent).toBe("Esc");
    expect(button("Allow once").querySelector("kbd")?.textContent).toBe("Ctrl+Enter");
    act(() => button("Allow once").focus());
    expect((await screen.findByRole("tooltip")).textContent).toContain("Ctrl+Enter");
    await app.user.keyboard("{Enter}");
    expect(answersSent(env)).toEqual([]);
  });

  it.each([
    { macOS: true, keyRemaps: { "permission.allow": ["Mod+Enter"] }, label: "⌘Enter", keys: "{Meta>}{Enter}{/Meta}" },
    { macOS: false, keyRemaps: { "permission.allow": ["Ctrl+Shift+Enter"] }, label: "Ctrl+Shift+Enter", keys: "{Control>}{Shift>}{Enter}{/Shift}{/Control}" },
  ])("names and dispatches the effective approval key $label", async ({ macOS, keyRemaps, label, keys }) => {
    const { app, env, session } = await opened({}, { macOS, presentation: { keyRemaps } });
    await park(env, session);
    expect(button("Allow once").querySelector("kbd")?.textContent).toBe(label);
    act(() => button("Allow once").focus());
    expect((await screen.findByRole("tooltip")).textContent).toContain(label);
    await press(app, keys);
    expect((await sentAnswers(env, 1))[0]).toEqual(expect.objectContaining({ decision: "allow" }));
  });

  it("takes the focus when it comes, the card and no button, and is allowed once by Mod+Enter", async () => {
    const { app, env, session } = await opened();
    const promptId = await park(env, session);
    await waitFor(() => expect(document.activeElement).toBe(card()));
    await press(app, MOD_ENTER);
    expect((await sentAnswers(env, 1))[0]).toEqual({ commandId: expect.any(String), promptId, sessionId: session, decision: "allow" });
  });

  it("is never approved by a bare Enter: not on the card, not in the note, not with the focus on Allow once", async () => {
    const { app, env, session } = await opened();
    await park(env, session);
    await waitFor(() => expect(document.activeElement).toBe(card()));
    await press(app, "{Enter}");
    act(() => within(card() as HTMLElement).getByRole("textbox", { name: "Note" }).focus());
    await press(app, "{Enter}");
    act(() => button("Allow once").focus());
    await press(app, "{Enter}");
    act(() => button("Allow for this session").focus());
    await press(app, "{Enter}");
    // The first answer sent is Esc's deny: no Enter before it sent anything.
    await press(app, "{Escape}");
    expect(await sentAnswers(env, 1)).toEqual([expect.objectContaining({ decision: "deny" })]);
  });

  it("is denied by Esc, the note riding the answer as its message", async () => {
    const { app, env, transcript, session } = await opened();
    const promptId = await park(env, session);
    const note = within(card() as HTMLElement).getByRole("textbox", { name: "Note" });
    act(() => note.focus());
    await press(app, "use make clean instead");
    await press(app, "{Escape}");
    expect((await sentAnswers(env, 1))[0]).toEqual({ commandId: expect.any(String), promptId, sessionId: session, decision: "deny", message: "use make clean instead" });
    await waitFor(() => expect(within(transcript).getByRole("article", { name: "Permission" }).textContent).toBe("Bash: rm -rf build — denied: use make clean instead"));
  });

  // ADR 0006: the denylist holds in every mode, and the person present may allow a denylisted call once (#1820).
  // As the environment's gate asks it: the summary and the reason both name the match as a sentence.
  const matched: DenylistMatch = { section: "paths", entry: { id: "preset:data-directory", pattern: "/var/lib/harness", note: "The harness's own data directory: its event log, keys and accounts.", enabled: true, preset: true }, matched: "/var/lib/harness/sessions" };
  const dataDirectory: ScriptedPrompt = {
    kind: "denylist",
    toolName: "Bash",
    input: { command: "ls /var/lib/harness/sessions" },
    summary: `Bash: ${describeDenylistMatch(matched)}`,
    reason: describeDenylistMatch(matched),
    mode: "bypassPermissions",
    ceiling: "bypassPermissions",
    denylist: [matched],
  };

  it("offers a denylist prompt of a bypassPermissions run Deny and Allow once, never remembered, and names its entry in words", async () => {
    const { app, env, session } = await opened();
    const promptId = await park(env, session, dataDirectory);
    const shown = card() as HTMLElement;
    expect(within(shown).getByRole("heading").textContent).toBe("Denylist · Bash");
    expect(within(shown).getAllByRole("button", { name: /^(Deny|Allow)/ }).map((found) => found.getAttribute("aria-label") ?? found.textContent)).toEqual(["Deny", "Allow once"]);
    // What was asked, then why it is on the denylist, then what the agent may do instead: each once (#1905).
    expect(shown.textContent).toContain("Bash: /var/lib/harness/sessions");
    expect(shown.textContent).not.toContain("is on the denylist");
    const entry = within(within(shown).getByRole("list", { name: "On the denylist" })).getByRole("listitem").textContent;
    expect(entry).toBe("This is the environment's data directory: its event log, keys and accounts.Instead, the agent may work in its own working directory, and ask you for anything it needs from the environment's records.");
    expect(shown.textContent).not.toContain("The same entry as before");
    await press(app, MOD_ENTER);
    expect((await sentAnswers(env, 1))[0]).toEqual({ commandId: expect.any(String), promptId, sessionId: session, decision: "allow" });
  });

  it("allows a denylist prompt once by a click, and says when the run asks about the same entry again", async () => {
    const { app, env, session } = await opened();
    const first = await park(env, session, dataDirectory);
    await app.user.click(button("Deny"));
    expect((await sentAnswers(env, 1))[0]).toMatchObject({ promptId: first, decision: "deny" });
    await waitFor(() => expect(card()).toBeNull());

    const again = await park(env, session, { ...dataDirectory, summary: "Bash: cat /var/lib/harness/sessions/log" });
    expect((card() as HTMLElement).textContent).toContain("The same entry as before: this run already asked about /var/lib/harness once (last denied).");
    await app.user.click(button("Allow once"));
    expect((await sentAnswers(env, 2))[1]).toEqual({ commandId: expect.any(String), promptId: again, sessionId: session, decision: "allow" });
  });
});

describe("a question", () => {
  const questions: ScriptedPrompt = {
    kind: "question",
    toolName: "AskUserQuestion",
    input: null,
    summary: "Which checks?",
    questions: [
      { header: "Checks", question: "Which checks?", options: ["lint", "types", "tests"].map((label) => ({ label, description: "" })), multiSelect: true },
      {
        header: "DB",
        question: "Which database?",
        options: [
          { label: "Postgres", description: "the server one" },
          { label: "SQLite", description: "a file" },
        ],
        multiSelect: false,
      },
    ],
  };

  it("offers its options, several at once where it allows, and a free answer, sent by Mod+Enter keyed by each question", async () => {
    const { app, env, transcript, session } = await opened();
    const promptId = await park(env, session, questions);
    const shown = card() as HTMLElement;
    const checks = within(shown).getByRole("group", { name: /Which checks\?/ });
    const database = within(shown).getByRole("group", { name: /Which database\?/ });
    const postgres = within(database).getByRole("radio", { name: "Postgres" });
    expect(document.getElementById(postgres.getAttribute("aria-describedby") ?? "")?.textContent).toBe("the server one");

    // Nothing chosen: nothing is sent, and one line says so.
    await press(app, MOD_ENTER);
    await within(shown).findByText("Nothing is chosen yet: choose an option or write an answer, or skip.");

    await app.user.click(within(checks).getByRole("checkbox", { name: "lint" }));
    await app.user.click(within(checks).getByRole("checkbox", { name: "tests" }));
    await app.user.click(within(database).getByRole("radio", { name: "Postgres" }));
    await app.user.click(within(database).getByRole("radio", { name: "SQLite" }));
    expect(within(database).getByRole("radio", { name: "Postgres" })).toHaveProperty("checked", false);
    act(() => within(database).getByRole("textbox", { name: "Your own answer" }).focus());
    await press(app, "3.45 or later");
    await press(app, MOD_ENTER);
    expect((await sentAnswers(env, 1))[0]).toEqual({
      commandId: expect.any(String),
      promptId,
      sessionId: session,
      decision: "allow",
      answers: { "Which checks?": "lint, tests", "Which database?": "SQLite, 3.45 or later" },
    });
    await waitFor(() => expect(within(transcript).getByRole("article", { name: "Question" }).textContent).toBe("Which checks? — lint, testsWhich database? — SQLite, 3.45 or later"));
  });

  it("accepts a nonblank note through Send and its shortcut, while blank input sends nothing", async () => {
    const { app, env, session } = await opened();
    await park(env, session, questions);
    await app.user.click(button("Send answers"));
    expect(answersSent(env)).toEqual([]);
    await app.user.type(within(card() as HTMLElement).getByRole("textbox", { name: "Note" }), "Choose the simplest check");
    await app.user.click(button("Send answers"));
    expect((await sentAnswers(env, 1))[0]).toEqual(expect.objectContaining({ decision: "allow", answers: {}, message: "Choose the simplest check" }));
    await waitFor(() => expect(card()).toBeNull());
    await park(env, session, questions);
    await app.user.type(within(card() as HTMLElement).getByRole("textbox", { name: "Note" }), "Use the same choice");
    await press(app, MOD_ENTER);
    expect((await sentAnswers(env, 2))[1]).toEqual(expect.objectContaining({ decision: "allow", answers: {}, message: "Use the same choice" }));
  });

  it("is skipped by Esc, a deny", async () => {
    const { app, env, session } = await opened();
    const promptId = await park(env, session, questions);
    await waitFor(() => expect(document.activeElement).toBe(card()));
    await press(app, "{Escape}");
    expect((await sentAnswers(env, 1))[0]).toEqual({ commandId: expect.any(String), promptId, sessionId: session, decision: "deny" });
  });
});

describe("a plan", () => {
  const plan = (ceiling: "acceptEdits" | "bypassPermissions"): ScriptedPrompt => ({
    kind: "plan",
    toolName: "ExitPlanMode",
    input: null,
    summary: "Fix the sum",
    plan: "## Steps\n\n1. Read the parser\n2. Fix the sum",
    mode: "plan",
    ceiling,
  });

  it("shows the plan, offers Keep planning and one approval per mode, greying a mode above the prompt's ceiling with its reason", async () => {
    const { app, env, session } = await opened();
    const promptId = await park(env, session, plan("acceptEdits"));
    const shown = card() as HTMLElement;
    expect(within(shown).getByRole("heading", { name: "Steps" })).toBeTruthy();
    expect(within(shown).getAllByRole("button").filter((control) => control.getAttribute("aria-label") !== "Hide request").map((control) => control.getAttribute("aria-label") ?? control.textContent)).toEqual([
      "Keep planning",
      "Approve · continue in acceptEdits",
      "Approve · continue in auto",
      "Approve · continue in bypassPermissions",
    ]);
    const auto = button("Approve · continue in auto");
    expect(auto.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(auto.getAttribute("aria-describedby") ?? "")?.textContent).toBe("above the ceiling acceptEdits");
    expect(button("Approve · continue in acceptEdits").getAttribute("aria-disabled")).toBeNull();

    await app.user.click(auto);
    await within(shown).findByText("auto is above the ceiling acceptEdits this run was resolved under.");
    // Mod+Enter approves, continuing in the default: no mode is sent.
    act(() => shown.focus());
    await press(app, MOD_ENTER);
    expect(await sentAnswers(env, 1)).toEqual([{ commandId: expect.any(String), promptId, sessionId: session, decision: "allow" }]);
  });

  it("retains a long plan and its note through scrolling, collapse and a refused decision, with the same keyboard gates", async () => {
    const { app, env, session } = await opened();
    const promptId = await park(env, session, {
      ...plan("acceptEdits"),
      plan: "## Steps\n\n" + Array.from({ length: 32 }, (_, at) => `${at + 1}. Check the recorded total.`).join("\n"),
    });
    const shown = card() as HTMLElement;
    const body = within(shown).getByLabelText("Plan body");
    Object.defineProperties(body, {
      scrollHeight: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 160 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    act(() => body.dispatchEvent(new Event("scroll")));
    expect(within(shown).getByText("Scroll to read the plan")).toBeDefined();
    await app.user.type(within(shown).getByRole("textbox", { name: "Note" }), "Keep the receipt checks");
    body.scrollTop = 640;
    act(() => body.dispatchEvent(new Event("scroll")));
    expect(within(shown).queryByText("Scroll to read the plan")).toBeNull();
    await app.user.click(button("Hide request"));
    await app.user.click(button("Show request"));
    expect(within(shown).getByRole("textbox", { name: "Note" })).toHaveProperty("value", "Keep the receipt checks");
    act(() => button("Approve · continue in acceptEdits").focus());
    await press(app, "{Enter}");
    expect(answersSent(env)).toEqual([]);
    await app.user.click(button("Approve · continue in auto"));
    expect(answersSent(env)).toEqual([]);
    const elsewhere = env.answerElsewhere(session, promptId, { heard: false });
    act(() => shown.focus());
    await press(app, MOD_ENTER);
    await waitFor(() => expect(within(card() as HTMLElement).getByRole("status").textContent).toBe("Not answered: The prompt was already answered."));
    expect(within(card() as HTMLElement).getByRole("textbox", { name: "Note" })).toHaveProperty("value", "Keep the receipt checks");
    expect(within(within(card() as HTMLElement).getByLabelText("Plan body")).getAllByRole("listitem")).toHaveLength(32);
    expect((await sentAnswers(env, 1))[0]).toEqual(expect.objectContaining({ promptId, decision: "allow", message: "Keep the receipt checks" }));
    elsewhere.hear();
    await waitFor(() => expect(card()).toBeNull());
  });

  it("sends the mode an approval names, and Esc keeps planning", async () => {
    const { app, env, transcript, session } = await opened();
    const first = await park(env, session, plan("bypassPermissions"));
    await app.user.click(button("Approve · continue in bypassPermissions"));
    expect((await sentAnswers(env, 1))[0]).toEqual({ commandId: expect.any(String), promptId: first, sessionId: session, decision: "allow", mode: "bypassPermissions" });
    await waitFor(() => expect(card()).toBeNull());

    const second = await park(env, session, plan("bypassPermissions"));
    await waitFor(() => expect(document.activeElement).toBe(card()));
    await press(app, "{Escape}");
    expect((await sentAnswers(env, 2))[1]).toEqual({ commandId: expect.any(String), promptId: second, sessionId: session, decision: "deny" });
    await waitFor(() => expect(within(transcript).getAllByRole("article", { name: "Plan" }).map((article) => article.textContent)).toHaveLength(2));
    expect(within(transcript).getAllByRole("article", { name: "Plan" })[1]?.textContent).toContain("Kept planning");
  });
});

describe("answering", () => {
  it("closes the card when another client answers first, sending nothing", async () => {
    const { env, transcript, session } = await opened();
    const promptId = await park(env, session);
    env.answerElsewhere(session, promptId, { decision: "deny" });
    await waitFor(() => expect(card()).toBeNull());
    expect(within(transcript).getByRole("article", { name: "Permission" }).textContent).toBe("Bash: rm -rf build — denied");
    expect(answersSent(env)).toEqual([]);
  });

  it("says an answer refused because another client answered first in one line on the card and in a toast, the line going when that answer is heard", async () => {
    const { app, env, transcript, session } = await opened();
    const promptId = await park(env, session);
    const elsewhere = env.answerElsewhere(session, promptId, { decision: "allow", heard: false });
    await app.user.click(button("Allow once"));
    await waitFor(() => expect(within(card() as HTMLElement).getByRole("status").textContent).toBe("Not answered: The prompt was already answered."));
    // The runtime raised the rejection's notice, which the window's toasts say too (#405).
    const toasts = within(screen.getByRole("region", { name: /^Notifications/ })).getAllByRole("listitem");
    expect(toasts.some((toast) => toast.textContent === "Answer on Receipts was rejected: already answered.")).toBe(true);
    elsewhere.hear();
    await waitFor(() => expect(card()).toBeNull());
    expect(within(transcript).getByRole("article", { name: "Permission" }).textContent).toBe("Bash: rm -rf build — allowed");
    expect(env.answered()).toHaveLength(1);
  });

  it("sends an answer again with its command id after the socket drops mid-flight, and it applies once", async () => {
    const { app, env, transcript, session } = await opened();
    await park(env, session);
    env.holdAnswers(true);
    await app.user.click(button("Allow once"));
    const [first] = await sentAnswers(env, 1);
    // Off the card at once: it can never be answered twice from here.
    await waitFor(() => expect(card()).toBeNull());
    env.holdAnswers(false);
    env.server.drop();
    // The socket is retried a second on, give or take its jitter.
    await screen.findByText("Locked: desk cannot be reached.");
    await act(async () => app.clock.advance(2_000));
    await waitFor(() => expect(env.wire.opened()).toBeGreaterThan(1));
    const [again] = await sentAnswers(env, 1);
    expect(again?.["commandId"]).toBe(first?.["commandId"]);
    await waitFor(() => expect(within(transcript).getByRole("article", { name: "Permission" }).textContent).toBe("Bash: rm -rf build — allowed"));
    expect(env.answered()).toHaveLength(1);
    expect(card()).toBeNull();
  });

  it("is dim with the capability's reason while the connection cannot answer, and a press says so and sends nothing", async () => {
    const { app, env, session } = await opened();
    await park(env, session);
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    const shown = card() as HTMLElement;
    await within(shown).findByText("desk cannot be reached.");
    for (const name of ["Deny", "Allow once", "Allow for this session"]) expect(button(name).getAttribute("aria-disabled")).toBe("true");

    await app.user.click(button("Allow once"));
    await within(shown).findByText("Not answered: desk cannot be reached.");
    act(() => shown.focus());
    await press(app, MOD_ENTER);
    await press(app, "{Escape}");
    expect(within(shown).getByRole("status").textContent).toBe("Not answered: desk cannot be reached.");
    expect(answersSent(env)).toEqual([]);
  });
});

describe("the TTL", () => {
  it("counts down in the environment's time, not the window's", async () => {
    // The environment's clock runs ten minutes ahead of the window's.
    const ahead = 10 * 60_000;
    const { app, env, session } = await opened({ hello: { serverTime: new Date(Date.parse(MANUAL_CLOCK_START) + ahead).toISOString() } });
    const expires = app.clock.now().getTime() + ahead + 2 * 60 * 60_000 + 30_000;
    await park(env, session, { ttlExpiresAt: new Date(expires).toISOString() });
    expect((card() as HTMLElement).textContent).toContain("2h 0m left");
    act(() => app.clock.advance(61_000));
    await waitFor(() => expect((card() as HTMLElement).textContent).toContain("1h 59m left"));
  });

  it("shows none for a prompt that never expires", async () => {
    const { env, session } = await opened();
    await park(env, session);
    expect((card() as HTMLElement).textContent).not.toContain("left");
  });
});
