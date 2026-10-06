import { openHeaderMenu } from "../test/header-actions.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ScriptedPrompt } from "@agent-harness/client-runtime/testing/scripted-environment";
import { describe, expect, it } from "vitest";
import { renderApp, type EnvironmentHandle, type RenderedApp } from "../test/harness.js";

/**
 * Parked asks (docs/specs/gui.md, "Parked asks, attention and notices"; story
 * 10; #149's list is the reference): the header's button counts every
 * environment's parked prompts and opens one view of them, oldest first,
 * each with its environment's badge, its session's title, its kind, what it
 * asks and its TTL on its environment's clock. A permission or denylist row
 * is allowed or denied in place; a question or a plan is opened; Allow all
 * and Deny all answer every permission row after one confirmation, never a
 * denylist row. Driven through the harness over two scripted environments.
 */

/** desk, this machine, with two sessions, and laptop, paired, with one; a run going on each session. */
const twoEnvironments = async () => {
  const app = await renderApp({
    environments: [
      { name: "desk", reach: "local", sessions: [{ title: "Receipts" }, { title: "Invoices" }] },
      { name: "laptop", reach: "paired", sessions: [{ title: "Parser" }] },
    ],
  });
  const desk = app.environment("desk");
  const laptop = app.environment("laptop");
  desk.startRun(desk.sessionId(0), "Clean the build");
  desk.startRun(desk.sessionId(1), "Total the invoices");
  laptop.startRun(laptop.sessionId(0), "Split the parser");
  return { app, desk, laptop };
};

/** Parks a prompt on the `index`th session of `env`, a second after the one before, so the list has an order to keep. */
const park = (app: RenderedApp, env: EnvironmentHandle, index: number, prompt: ScriptedPrompt = {}): string => {
  act(() => app.clock.advance(1_000));
  return env.openPrompt(env.sessionId(index), prompt);
};

/** The header's Parked asks button, found while a dialog over the window hides it from the tree too. */
const asksButton = () => screen.getByRole("button", { name: /^Parked asks/, hidden: true });

/** Opens the view from the header, and gives it. */
const openView = async (app: RenderedApp) => {
  const chip = screen.queryByRole("button", { name: /^Parked asks/ });
  if (chip !== null) await app.user.click(chip);
  else {
    const menu = await openHeaderMenu(app);
    await app.user.click(within(menu).getByRole("menuitem", { name: "Parked asks" }));
  }
  return screen.findByRole("dialog", { name: "Parked asks" });
};

/** The view's rows, as each reads, found while a confirmation over the view hides it from the tree too. */
const rows = (view: HTMLElement) => within(within(view).getByRole("list", { name: "Parked asks", hidden: true })).queryAllByRole("listitem", { hidden: true });

/** The params of every `permissions.prompts.answer` the window sent to `env`. */
const answersSent = (env: EnvironmentHandle) => env.requests("permissions.prompts.answer").map((request) => request.params);

describe("the Parked asks button", () => {
  it("counts the parked prompts across every environment, and opens the view", async () => {
    const { app, desk, laptop } = await twoEnvironments();
    expect(screen.queryByRole("button", { name: /^Parked asks/ })).toBeNull();
    park(app, desk, 0);
    park(app, laptop, 0, { kind: "question", summary: "Which database?" });
    await waitFor(() => expect(asksButton().getAttribute("aria-label")).toBe("Parked asks, 2 waiting"));
    expect(asksButton().textContent).toBe("2 waiting");

    const view = await openView(app);
    expect(rows(view)).toHaveLength(2);
  });
});

describe("the view", () => {
  it("lists every environment's parked asks oldest first: the badge, the session, the kind, what it asks and the TTL on its environment's clock", async () => {
    const { app, desk, laptop } = await twoEnvironments();
    const expires = (ms: number) => new Date(app.clock.now().getTime() + ms).toISOString();
    park(app, desk, 0, { summary: "Bash: rm -rf build", ttlExpiresAt: expires(2 * 60 * 60_000 + 30_000) });
    park(app, laptop, 0, {
      kind: "question",
      summary: "Which database?",
      questions: [{ header: "DB", question: "Which database should the parser read?", options: [], multiSelect: false }],
    });
    park(app, desk, 1, { kind: "plan", summary: "Plan: total by month" });
    park(app, laptop, 0, { kind: "denylist", summary: "Read: ~/.ssh/id_ed25519" });
    await waitFor(() => expect(asksButton().getAttribute("aria-label")).toBe("Parked asks, 4 waiting"));

    const view = await openView(app);
    expect(rows(view).map((row) => row.textContent)).toEqual([
      "deskReceiptsPermissionBash: rm -rf build2h 0m leftAllowDenyOpen",
      "laptopParserQuestionWhich database should the parser read?Open",
      "deskInvoicesPlanPlan: total by monthOpen",
      "laptopParserDenylistRead: ~/.ssh/id_ed25519AllowDenyOpen",
    ]);
    act(() => app.clock.advance(61_000));
    await waitFor(() => expect(rows(view)[0]?.textContent).toContain("1h 59m left"));
  });

  it("gives parked actions icons and keyboard hints while keeping Allow off Enter", async () => {
    const { app, desk } = await twoEnvironments();
    park(app, desk, 0);
    await waitFor(() => expect(asksButton().getAttribute("aria-label")).toBe("Parked asks, 1 waiting"));
    const view = await openView(app);
    for (const button of within(view).getAllByRole("button")) expect(button.querySelector("svg")).not.toBeNull();
    const allow = within(view).getByRole("button", { name: "Allow" });
    act(() => allow.blur());
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => allow.focus());
    expect((await screen.findByRole("tooltip")).textContent).toContain("Space");
    await app.user.keyboard("{Enter}");
    expect(answersSent(desk)).toEqual([]);
  });

  it("says when nothing is waiting", async () => {
    const { app } = await twoEnvironments();
    const view = await openView(app);
    expect(within(view).getByText("Nothing is waiting on you.")).toBeDefined();
    expect(within(view).queryByRole("list", { name: "Parked asks" })).toBeNull();
  });
});

describe("answering from the view", () => {
  it("allows or denies a permission row in place, which leaves the list at once, and a bare Enter on Allow sends nothing", async () => {
    const { app, desk, laptop } = await twoEnvironments();
    const first = park(app, desk, 0, { summary: "Bash: rm -rf build" });
    const second = park(app, laptop, 0, { summary: "Bash: git push", input: { command: "git push" } });
    await waitFor(() => expect(asksButton().getAttribute("aria-label")).toBe("Parked asks, 2 waiting"));
    const view = await openView(app);

    within(rows(view)[0] as HTMLElement)
      .getByRole("button", { name: "Allow" })
      .focus();
    await app.user.keyboard("{Enter}");
    expect(answersSent(desk)).toEqual([]);

    await app.user.click(within(rows(view)[0] as HTMLElement).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(answersSent(desk)).toEqual([{ commandId: expect.any(String), promptId: first, sessionId: desk.sessionId(0), decision: "allow" }]));
    expect(rows(view).map((row) => row.textContent)).toEqual(["laptopParserPermissionBash: git pushAllowDenyOpen"]);

    await app.user.click(within(rows(view)[0] as HTMLElement).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(answersSent(laptop)).toEqual([{ commandId: expect.any(String), promptId: second, sessionId: laptop.sessionId(0), decision: "deny" }]));
    await waitFor(() => expect(within(view).getByText("Nothing is waiting on you.")).toBeDefined());
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Parked asks/, hidden: true })).toBeNull());
  });

  it("opens a question's or a plan's session in the focused pane, closing the view; any row opens its session so", async () => {
    const { app, desk, laptop } = await twoEnvironments();
    park(app, laptop, 0, { kind: "question", summary: "Which database?" });
    park(app, desk, 1, { kind: "plan", summary: "Plan: total by month" });
    await waitFor(() => expect(asksButton().getAttribute("aria-label")).toBe("Parked asks, 2 waiting"));
    const view = await openView(app);
    expect(within(rows(view)[0] as HTMLElement).queryByRole("button", { name: "Allow" })).toBeNull();

    await app.user.click(within(rows(view)[0] as HTMLElement).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Parked asks" })).toBeNull());
    expect(app.shown()).toEqual({ environmentId: laptop.environmentId, sessionId: laptop.sessionId(0) });
    expect(answersSent(laptop)).toEqual([]);

    await app.user.click(within(rows(await openView(app))[1] as HTMLElement).getByRole("button", { name: "Open" }));
    expect(app.shown()).toEqual({ environmentId: desk.environmentId, sessionId: desk.sessionId(1) });
  });
});

describe("Allow all and Deny all", () => {
  it("answer every permission row after one confirmation, passing over a denylist row", async () => {
    const { app, desk, laptop } = await twoEnvironments();
    const first = park(app, desk, 0, { summary: "Bash: rm -rf build" });
    park(app, laptop, 0, { kind: "denylist", summary: "Read: ~/.ssh/id_ed25519" });
    const third = park(app, laptop, 0, { summary: "Bash: git push", input: { command: "git push" } });
    await waitFor(() => expect(asksButton().getAttribute("aria-label")).toBe("Parked asks, 3 waiting"));
    const view = await openView(app);

    await app.user.click(within(view).getByRole("button", { name: "Allow all" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Allow all 2 permissions once?" });
    expect(within(confirm).getByText("The denylist prompt stays: each is answered on its own.")).toBeDefined();
    // Nothing is sent until it is confirmed.
    expect([...answersSent(desk), ...answersSent(laptop)]).toEqual([]);

    await app.user.click(within(confirm).getByRole("button", { name: "Allow 2" }));
    await waitFor(() => expect(answersSent(desk)).toEqual([{ commandId: expect.any(String), promptId: first, sessionId: desk.sessionId(0), decision: "allow" }]));
    await waitFor(() => expect(answersSent(laptop)).toEqual([{ commandId: expect.any(String), promptId: third, sessionId: laptop.sessionId(0), decision: "allow" }]));
    expect(rows(view).map((row) => row.textContent)).toEqual(["laptopParserDenylistRead: ~/.ssh/id_ed25519AllowDenyOpen"]);
    // With fewer than two permission rows, neither is offered.
    expect(within(view).queryByRole("button", { name: "Allow all" })).toBeNull();
  });

  it("asks before denying, answers nothing when cancelled, and never a prompt that parked while it asked", async () => {
    const { app, desk, laptop } = await twoEnvironments();
    const first = park(app, desk, 0);
    const second = park(app, laptop, 0);
    await waitFor(() => expect(asksButton().getAttribute("aria-label")).toBe("Parked asks, 2 waiting"));
    const view = await openView(app);

    await app.user.click(within(view).getByRole("button", { name: "Deny all" }));
    await app.user.click(within(await screen.findByRole("alertdialog", { name: "Deny all 2 permissions?" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Deny all 2 permissions?" })).toBeNull());
    expect([...answersSent(desk), ...answersSent(laptop)]).toEqual([]);

    await app.user.click(within(view).getByRole("button", { name: "Deny all" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Deny all 2 permissions?" });
    const late = park(app, desk, 1);
    await waitFor(() => expect(rows(view)).toHaveLength(3));
    await app.user.click(within(confirm).getByRole("button", { name: "Deny 2" }));
    await waitFor(() => expect(answersSent(laptop).map((params) => params["promptId"])).toEqual([second]));
    await waitFor(() => expect(answersSent(desk).map((params) => params["promptId"])).toEqual([first]));
    expect(answersSent(desk).map((params) => params["decision"])).toEqual(["deny"]);
    expect(rows(view).map((row) => row.textContent)).toEqual(["deskInvoicesPermissionBash: rm -rf buildAllowDenyOpen"]);
    expect(late).not.toBe(first);
  });
});
