import { act, screen, waitFor, within } from "@testing-library/react";
import type { FakeAnswer } from "@agent-harness/client-runtime/testing/fake-wire";
import { describe, expect, it } from "vitest";
import { renderApp, type EnvironmentHandle, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * Queued messages in the window (docs/specs/gui.md, "A session pane"; ADR
 * 0022; #401): each message of `projections.runs.session`'s queue drawn after
 * its turn, marked Queued, or Steering when the provider holds it and its
 * adapter steers, with Read now (`runs.readNow`) and Edit (`runs.withdraw`),
 * and the strip over the composer counting the queue; each action dim with
 * the runtime's reason when absent, never hidden. Driven through the harness
 * over the scripted environment with a live run.
 */

/** The local environment with one session opened in the pane. */
const opened = async (more: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }], ...more }] });
  app.open("desk");
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  const env = app.environment("desk");
  return { app, env, transcript, session: env.sessionId() };
};

/** The composer's box. */
const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

/** Keys typed into the composer's box, focused first: jsdom lays nothing out, so a click would land on the sidebar's divider. */
const write = async (app: RenderedApp, keys: string) => {
  act(() => box().focus());
  await app.user.keyboard(keys);
};

/** The article of the transcript that holds `text`; null when none does. */
const articleOf = (transcript: HTMLElement, text: string) => within(transcript).queryByText(text)?.closest("article") ?? null;

/** How the article holding `text` is named: "Your message", "Queued message", "Steering message". */
const kindOf = (transcript: HTMLElement, text: string) => articleOf(transcript, text)?.getAttribute("aria-label");

/** The texts given, in the order the transcript draws the articles holding them. */
const inOrder = (transcript: HTMLElement, ...texts: string[]) => {
  const drawn = within(transcript).getAllByRole("article");
  return [...texts].sort((a, b) => drawn.indexOf(articleOf(transcript, a) as HTMLElement) - drawn.indexOf(articleOf(transcript, b) as HTMLElement));
};

/** A run live on the session, with `queued` sent during it from the composer, each drawn as a queued message. */
const withQueue = async (more: Partial<ScriptedEnvironment>, ...queued: string[]) => {
  const opening = await opened(more);
  const { app, env, transcript, session } = opening;
  const run = env.startRun(session, "Fix the receipts");
  await within(transcript).findByRole("article", { name: "Your message" });
  for (const text of queued) {
    await write(app, `${text}{Enter}`);
    await waitFor(() => expect(kindOf(transcript, text)).toMatch(/^(Queued|Steering) message$/));
  }
  return { ...opening, runId: run.runId };
};

describe("a queued message", () => {
  it("is drawn after its turn, marked Queued, in the order sent", async () => {
    const { transcript } = await withQueue({}, "and the tests", "and the docs");
    expect(kindOf(transcript, "and the tests")).toBe("Queued message");
    expect(within(articleOf(transcript, "and the tests") as HTMLElement).getByText("Queued")).toBeTruthy();
    expect(inOrder(transcript, "and the docs", "and the tests", "Fix the receipts")).toEqual(["Fix the receipts", "and the tests", "and the docs"]);
  });

  it("is marked Steering while the provider holds it and its adapter steers, Queued while a provider that does not steer holds it", async () => {
    const steering = await withQueue({ queue: "provider", provider: { providerQueue: true, steering: true } }, "use the other parser");
    expect(kindOf(steering.transcript, "use the other parser")).toBe("Steering message");
    expect(within(articleOf(steering.transcript, "use the other parser") as HTMLElement).getByText("Steering")).toBeTruthy();
    steering.app.view.unmount();

    const holding = await withQueue({ queue: "provider", provider: { providerQueue: true, steering: false } }, "use the other parser");
    expect(kindOf(holding.transcript, "use the other parser")).toBe("Queued message");
  });

  it("names its attachments as the transcript does, each with its size", async () => {
    const { env, transcript, session, runId } = await withQueue({});
    env.emit(session, "message.sent", {
      runId,
      messageId: "0199a200-0000-4000-8000-00000000aaaa",
      text: "look at this",
      attachments: [{ kind: "image", name: "shot.png", mediaType: "image/png", size: 2048 }],
      delivery: "queued",
      heldBy: "environment",
      ceiling: "bypassPermissions",
    });
    await waitFor(() => expect(kindOf(transcript, "look at this")).toBe("Queued message"));
    expect(within(articleOf(transcript, "look at this") as HTMLElement).getByText("shot.png · 2 KB")).toBeTruthy();
  });

  it("keeps its place when an interrupt re-owns it, and stays after its turn once the run has ended", async () => {
    const { env, transcript, session, runId } = await withQueue({ queue: "provider", provider: { providerQueue: true, steering: true } }, "first thought", "second thought");
    const [first] = env.queued(session);
    env.emit(session, "message.requeued", { runId, messageId: first?.messageId ?? "" });
    await waitFor(() => expect(kindOf(transcript, "first thought")).toBe("Queued message"));
    expect(kindOf(transcript, "second thought")).toBe("Steering message");
    expect(inOrder(transcript, "second thought", "first thought")).toEqual(["first thought", "second thought"]);

    // Interrupted, the provider hands back what it held; the turn's line is drawn, and the queue after it, in order.
    env.endRun(session, runId, { reason: "interrupted" });
    const turn = await within(transcript).findByText(/^Interrupted/);
    await waitFor(() => expect(kindOf(transcript, "second thought")).toBe("Queued message"));
    const drawn = [...transcript.querySelectorAll("article, p")];
    const at = (element: Element | null) => drawn.indexOf(element as Element);
    expect(at(turn)).toBeLessThan(at(articleOf(transcript, "first thought")));
    expect(inOrder(transcript, "second thought", "first thought", "Fix the receipts")).toEqual(["Fix the receipts", "first thought", "second thought"]);

    // A run that does not read them draws after them: they stay after the turn they were sent during.
    env.startRun(session, "Now the parser");
    await waitFor(() => expect(kindOf(transcript, "Now the parser")).toBe("Your message"));
    expect(inOrder(transcript, "Now the parser", "second thought", "first thought")).toEqual(["first thought", "second thought", "Now the parser"]);
  });
});

/** The requests sent for `method`, their params alone. */
const sent = (env: EnvironmentHandle, method: string) => env.requests(method).map((request) => request.params);

/** What the control's tooltip says, once it has the focus as a person tabbing to it gives it. */
const tooltipOf = async (control: HTMLElement) => {
  act(() => control.focus());
  const tooltip = await screen.findByRole("tooltip");
  const said = tooltip.textContent;
  act(() => control.blur());
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  return said;
};

/** The action named `name` on the queued message holding `text`. */
const actionOn = (transcript: HTMLElement, text: string, name: "Read now" | "Edit") => within(articleOf(transcript, text) as HTMLElement).getByRole("button", { name });

describe("Read now", () => {
  it("reads the whole queue in order, as its tooltip says: the run is interrupted and the next opens with every queued message", async () => {
    const { app, env, transcript, session, runId } = await withQueue({ queue: "provider", provider: { providerQueue: true, steering: true } }, "and the tests", "and the docs");
    expect(await tooltipOf(actionOn(transcript, "and the docs", "Read now"))).toMatch(/the whole queue now, in the order it was sent/);

    await app.user.click(actionOn(transcript, "and the docs", "Read now"));
    await waitFor(() => expect(sent(env, "runs.readNow")).toEqual([expect.objectContaining({ sessionId: session })]));
    // Read by the next run: each is the user's message opening it, after the interrupted turn, in the order sent.
    await waitFor(() => expect(kindOf(transcript, "and the tests")).toBe("Your message"));
    expect(kindOf(transcript, "and the docs")).toBe("Your message");
    expect(inOrder(transcript, "and the docs", "and the tests", "Fix the receipts")).toEqual(["Fix the receipts", "and the tests", "and the docs"]);
    expect(env.liveRun(session)).not.toBe(runId);
  });
});

describe("provider queue parity after an interrupt and replay", () => {
  it("reads the re-owned whole queue once in order and refuses withdrawing a message the next run has read", async () => {
    const { app, env, transcript, session } = await withQueue({ queue: "provider", provider: { providerQueue: true, steering: true } }, "and the tests", "and the docs");
    const queuedIds = env.queued(session).map((message) => message.messageId);
    const view = app.runtime.projections.session(env.environmentId, session);
    await app.user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(env.liveRun(session)).toBeUndefined());
    expect(env.queued(session).map((message) => [message.text, message.heldBy])).toEqual([["and the tests", "environment"], ["and the docs", "environment"]]);
    await act(async () => { env.discovery("nothing"); env.server.drop(); });
    await screen.findByText("Locked: desk cannot be reached.");
    await act(async () => { env.discovery("ready"); app.clock.advance(5_000); });
    await waitFor(() => expect(view.read().freshness).toBe("live"));
    await app.user.click(actionOn(transcript, "and the docs", "Read now"));
    await waitFor(() => expect(kindOf(transcript, "and the docs")).toBe("Your message"));
    expect(sent(env, "runs.readNow")).toHaveLength(1);
    const nextRun = env.liveRun(session) ?? "";
    expect(view.read().runs.map((run) => run.queuedMessageIds)).toEqual([[], queuedIds]);
    expect(view.read().items.filter((item) => item.kind === "user-message").map((item) => item.text)).toEqual(["Fix the receipts", "and the tests", "and the docs"]);
    expect(app.runtime.projections.runs.session(env.environmentId, session).read().queue).toEqual([]);
    expect(await app.runtime.commands.dispatch(env.environmentId, "runs.withdraw", { messageId: env.messageId(session, "and the tests") })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(box().value).toBe("");
    env.endRun(session, nextRun);
    await waitFor(() => expect(view.read().runs.at(-1)?.state).toBe("ended"));
    await act(async () => { env.server.drop(); });
    await waitFor(() => expect(view.read().freshness).toBe("cached"));
    await act(async () => { app.clock.advance(5_000); });
    await waitFor(() => expect(view.read().freshness).toBe("live"));
    expect(view.read().runs).toHaveLength(2);
    expect(within(transcript).getAllByRole("article", { name: "Your message" })).toHaveLength(3);
    expect(inOrder(transcript, "and the docs", "and the tests", "Fix the receipts")).toEqual(["Fix the receipts", "and the tests", "and the docs"]);
    expect(env.liveRun(session)).toBeUndefined();
  });
});

describe("Edit", () => {
  it("takes the message back with runs.withdraw, and its text comes into the composer through the session's draft", async () => {
    const { app, env, transcript, session } = await withQueue({ queue: "provider", provider: { providerQueue: true, steering: true } }, "and the tests", "and the docs");
    const [first] = env.queued(session);

    await app.user.click(actionOn(transcript, "and the tests", "Edit"));
    await waitFor(() => expect(box().value).toBe("and the tests"));
    expect(sent(env, "runs.withdraw")).toEqual([expect.objectContaining({ messageId: first?.messageId })]);
    expect(env.summary(session).draft).toBe("and the tests");
    // Taken back, it is in the composer and nowhere in the transcript; the other waits on.
    expect(articleOf(transcript, "and the tests")).toBeNull();
    expect(kindOf(transcript, "and the docs")).toBe("Steering message");
  });

  it("sends what this window typed first, so the text comes back after it and nothing typed is lost", async () => {
    const { app, env, transcript, session } = await withQueue({}, "and the docs");
    await write(app, "half a thought");
    const before = env.requests().length;

    await app.user.click(actionOn(transcript, "and the docs", "Edit"));
    await waitFor(() => expect(box().value).toBe("half a thought\n\nand the docs"));
    const order = env.requests().slice(before).map((request) => request.method);
    expect(order.filter((method) => method === "sessions.setDraft" || method === "runs.withdraw")).toEqual(["sessions.setDraft", "runs.withdraw"]);
    expect(env.summary(session).draft).toBe("half a thought\n\nand the docs");
  });

  it("sends one withdraw while one is on its way for the message, however often it is pressed", async () => {
    const { app, env, transcript, session } = await withQueue({}, "and the docs");
    const [message] = env.queued(session);
    const answers: ((answer: FakeAnswer) => void)[] = [];
    env.wire.answer("runs.withdraw", () => new Promise<FakeAnswer>((resolve) => answers.push(resolve)));

    await app.user.click(actionOn(transcript, "and the docs", "Edit"));
    await waitFor(() => expect(answers).toHaveLength(1));
    await app.user.click(actionOn(transcript, "and the docs", "Edit"));
    await app.user.click(within(strip() as HTMLElement).getByRole("button", { name: "Edit newest" }));

    // The environment takes it back as it does: the message leaves the queue and its text is the draft, then the receipt.
    env.emit(session, "message.withdrawn", { runId: message?.runId ?? "", messageId: message?.messageId ?? "", heldBy: "environment" });
    const draft = env.emit(session, "session.draft-set", { draft: "and the docs" }, { fields: { draft: "and the docs" } });
    answers[0]?.({ result: { receipt: { status: "accepted", sequence: draft.sequence, changed: true }, result: { messageId: message?.messageId, sessionId: session, heldBy: "environment" } } });
    await waitFor(() => expect(box().value).toBe("and the docs"));
    expect(env.requests("runs.withdraw")).toHaveLength(1);
  });
});

/** The strip over the composer; null while it is not drawn. */
const strip = () => screen.queryByRole("region", { name: "Queued messages" });

describe("the strip over the composer", () => {
  it("counts the queue, and offers Read now and Edit for the newest message a withdraw can reach", async () => {
    const { app, env, transcript, session } = await withQueue({}, "and the tests", "and the docs");
    const shown = strip() as HTMLElement;
    expect(within(shown).getByText("2 messages queued")).toBeTruthy();
    const newest = env.queued(session).at(-1);

    await app.user.click(within(shown).getByRole("button", { name: "Edit newest" }));
    await waitFor(() => expect(box().value).toBe("and the docs"));
    expect(sent(env, "runs.withdraw")).toEqual([expect.objectContaining({ messageId: newest?.messageId })]);
    await waitFor(() => expect(within(strip() as HTMLElement).getByText("1 message queued")).toBeTruthy());

    await app.user.click(within(strip() as HTMLElement).getByRole("button", { name: "Read now" }));
    await waitFor(() => expect(sent(env, "runs.readNow")).toEqual([expect.objectContaining({ sessionId: session })]));
    await waitFor(() => expect(kindOf(transcript, "and the tests")).toBe("Your message"));
    // Nothing queued, no strip.
    expect(strip()).toBeNull();
  });

  it("is not drawn while nothing is queued", async () => {
    const { env, transcript, session } = await opened();
    env.startRun(session, "Fix the receipts");
    await within(transcript).findByRole("article", { name: "Your message" });
    expect(strip()).toBeNull();
  });
});

/** Whether the control is drawn dim: there, and saying it cannot be used now. */
const dim = (control: HTMLElement) => control.getAttribute("aria-disabled") === "true";

describe("an action that cannot be used now", () => {
  it("is dim with the runtime's reason, never hidden, and a press says the reason in one line and dispatches nothing", async () => {
    const { app, env, transcript } = await withQueue({}, "and the tests");
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await screen.findByText("Locked: desk cannot be reached.");

    const shown = strip() as HTMLElement;
    const actions = [
      actionOn(transcript, "and the tests", "Read now"),
      actionOn(transcript, "and the tests", "Edit"),
      within(shown).getByRole("button", { name: "Read now" }),
      within(shown).getByRole("button", { name: "Edit newest" }),
    ];
    for (const action of actions) {
      expect(dim(action)).toBe(true);
      expect(await tooltipOf(action)).toContain("desk cannot be reached.");
    }

    await app.user.click(actionOn(transcript, "and the tests", "Edit"));
    await screen.findByText("Not withdrawn: desk cannot be reached.");
    await app.user.click(within(shown).getByRole("button", { name: "Read now" }));
    await screen.findByText("Not read now: desk cannot be reached.");
    expect(env.requests("runs.withdraw")).toEqual([]);
    expect(env.requests("runs.readNow")).toEqual([]);
  });

  it("says why a message the provider is opening a turn with can no longer be taken back, and that nothing is left to read", async () => {
    const { env, transcript, session, runId } = await withQueue({ queue: "provider", provider: { providerQueue: true } }, "and the tests");
    // The turn ends with the message still the provider's: a turn it opens reads it, and no withdraw reaches it.
    env.endRun(session, runId);
    await waitFor(() => expect(dim(actionOn(transcript, "and the tests", "Edit"))).toBe(true));
    expect(await tooltipOf(actionOn(transcript, "and the tests", "Edit"))).toContain("The provider is opening a turn with this message: it can no longer be withdrawn.");
    expect(await tooltipOf(actionOn(transcript, "and the tests", "Read now"))).toContain("Nothing is queued to read.");
    const shown = strip() as HTMLElement;
    expect(within(shown).getByText("1 message queued")).toBeTruthy();
    expect(dim(within(shown).getByRole("button", { name: "Edit newest" }))).toBe(true);
    expect(await tooltipOf(within(shown).getByRole("button", { name: "Edit newest" }))).toContain("Nothing is queued to withdraw.");
  });

  it("is not dim while it can be used", async () => {
    const { transcript } = await withQueue({}, "and the tests");
    expect(dim(actionOn(transcript, "and the tests", "Read now"))).toBe(false);
    expect(dim(actionOn(transcript, "and the tests", "Edit"))).toBe(false);
  });
});

/** A queued message's id as the environment's refusals name it. */
const SOME_MESSAGE = "0199a200-0000-4000-8000-000000000003";

describe("a refusal from the environment", () => {
  it("is one line, and the message stays queued and the composer keeps what was typed: the provider read it first", async () => {
    const { app, env, transcript } = await withQueue(
      {
        receipts: {
          "runs.withdraw": {
            rejected: "not_found",
            message: `No queued message ${SOME_MESSAGE} is on this environment: the provider has read it.`,
            data: { kind: "message", messageId: SOME_MESSAGE },
          },
        },
      },
      "and the tests",
    );
    await write(app, "half a thought");
    await app.user.click(actionOn(transcript, "and the tests", "Edit"));
    await screen.findByText("Not withdrawn: the provider read it first.");
    expect(kindOf(transcript, "and the tests")).toBe("Queued message");
    expect(box().value).toBe("half a thought");
    expect(env.summary(env.sessionId()).draft).toBe("half a thought");
  });

  it("is one line with the environment's own words for any other refusal, and asks again at the next press", async () => {
    const reason = "The Claude adapter cannot withdraw a queued message: its CLI has no cancel-by-id control.";
    const { app, env, transcript } = await withQueue(
      {
        receipts: {
          "runs.withdraw": { rejected: "invalid_params", message: reason, data: { reason: "unsupported", capability: "withdraw", provider: "claude" } },
          "runs.readNow": { rejected: "conflict", message: "The run has already ended." },
        },
      },
      "and the tests",
    );
    await app.user.click(actionOn(transcript, "and the tests", "Edit"));
    await screen.findByText(`Not withdrawn: ${reason}`);
    expect(dim(actionOn(transcript, "and the tests", "Edit"))).toBe(false);
    await app.user.click(actionOn(transcript, "and the tests", "Edit"));
    await waitFor(() => expect(env.requests("runs.withdraw")).toHaveLength(2));

    await app.user.click(actionOn(transcript, "and the tests", "Read now"));
    await screen.findByText("Not read now: The run has already ended.");
    expect(kindOf(transcript, "and the tests")).toBe("Queued message");
  });
});

describe("↑ in an empty composer (composer.withdrawLast)", () => {
  it("takes the newest queued message back, and ↑ is the composer's own again once its text is in the box", async () => {
    const { app, env, transcript, session } = await withQueue({}, "and the tests", "and the docs");
    const newest = env.queued(session).at(-1);
    await write(app, "{ArrowUp}");
    await waitFor(() => expect(box().value).toBe("and the docs"));
    expect(sent(env, "runs.withdraw")).toEqual([expect.objectContaining({ messageId: newest?.messageId })]);
    expect(kindOf(transcript, "and the tests")).toBe("Queued message");

    await write(app, "{ArrowUp}");
    expect(env.requests("runs.withdraw")).toHaveLength(1);
    expect(kindOf(transcript, "and the tests")).toBe("Queued message");
  });

  it("walks the session's prompts as before while nothing is queued", async () => {
    const { app, env, transcript, session } = await opened();
    env.startRun(session, "Fix the receipts");
    await within(transcript).findByRole("article", { name: "Your message" });
    await write(app, "{ArrowUp}");
    expect(box().value).toBe("Fix the receipts");
    expect(env.requests("runs.withdraw")).toEqual([]);
  });

  it("refuses in one line while the verb cannot be used, walking nothing", async () => {
    const { app, env } = await withQueue({}, "and the tests");
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await screen.findByText("Locked: desk cannot be reached.");
    await write(app, "{ArrowUp}");
    await screen.findByText("Not withdrawn: desk cannot be reached.");
    expect(box().value).toBe("");
    expect(env.requests("runs.withdraw")).toEqual([]);
  });

  it("does nothing more while its withdraw is on its way, so no prompt is walked into the box the text is coming to", async () => {
    const { app, env } = await withQueue({}, "and the docs");
    env.wire.answer("runs.withdraw", () => new Promise<FakeAnswer>(() => undefined));
    await write(app, "{ArrowUp}");
    await waitFor(() => expect(env.requests("runs.withdraw")).toHaveLength(1));
    await write(app, "{ArrowUp}");
    expect(box().value).toBe("");
    expect(env.requests("runs.withdraw")).toHaveLength(1);
  });
});
