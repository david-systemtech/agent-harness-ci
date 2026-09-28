import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The transcript (docs/specs/gui.md, "A session pane"; #399): a session
 * opened into the pane through presentation, drawn from
 * `projections.session` as the scripted environment streams a run into it.
 */

/** The local environment with one session, opened in the pane. */
const opened = async (more: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }], ...more }] });
  app.open("desk");
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  // Live: the freshness marker gone, and the empty session says so.
  await within(transcript).findByText("Nothing said yet.");
  const env = app.environment("desk");
  return { app, env, transcript, session: env.sessionId() };
};

/** The last reply in the transcript, as it reads. */
const lastReply = (transcript: HTMLElement) => within(transcript).getAllByRole("article", { name: "Reply" }).at(-1);

/** The words of `element` still fading in, each as it arrived. */
const fading = (element: HTMLElement | undefined) => [...(element?.querySelectorAll("span") ?? [])].filter((span) => span.style.animationName === "word-in").map((span) => span.textContent);

describe("streaming", () => {
  it("draws the run's prompt, then its text as the deltas arrive, and the whole text once it settles", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts");
    expect((await within(transcript).findByRole("article", { name: "Your message" })).textContent).toBe("Fix the receipts");

    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Looking at " }] });
    await waitFor(() => expect(lastReply(transcript)?.textContent).toBe("Looking at "));
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "the parser. " }] });
    await waitFor(() => expect(lastReply(transcript)?.textContent).toBe("Looking at the parser. "));

    env.emit(session, "assistant.text", { runId, itemId: "i-1", text: "Looking at the parser. Found it.", aborted: false });
    await waitFor(() => expect(lastReply(transcript)?.textContent).toBe("Looking at the parser. Found it."));
  });

  it("fades each word in as it arrives while the streaming fade is on, a word held back until it is whole, and draws the text plainly with the fade off", async () => {
    const { app, env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts");
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Looking at " }] });
    await waitFor(() => expect(fading(lastReply(transcript))).toEqual(["Looking ", "at "]));
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "the par" }] });
    await waitFor(() => expect(fading(lastReply(transcript))).toEqual(["Looking ", "at ", "the "]));
    expect(lastReply(transcript)?.textContent).toBe("Looking at the ");

    act(() => app.presentation.set("streamingFade", false));
    expect(lastReply(transcript)?.textContent).toBe("Looking at the par");
    expect(fading(lastReply(transcript))).toEqual([]);
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "ser. " }] });
    await waitFor(() => expect(lastReply(transcript)?.textContent).toBe("Looking at the parser. "));
    expect(fading(lastReply(transcript))).toEqual([]);

    // Turned on again mid-stream, what is already there is not replayed: only what arrives after fades in.
    act(() => app.presentation.set("streamingFade", true));
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Found it. " }] });
    await waitFor(() => expect(fading(lastReply(transcript))).toEqual(["Found ", "it. "]));
    expect(lastReply(transcript)?.textContent).toBe("Looking at the parser. Found it. ");
  });

  it("renders settled text as markdown, its fenced code highlighted", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Plan it");
    const text = ["## The plan", "", "- read `receipts.ts`", "- fix the total", "", "```ts", "const total = items.length;", "```"].join("\n");
    env.emit(session, "assistant.text", { runId, itemId: "i-1", text, aborted: false });
    const reply = await waitFor(() => {
      const found = lastReply(transcript);
      if (!found) throw new Error("no reply yet");
      return found;
    });
    expect(within(reply).getByRole("heading", { name: "The plan" })).toBeDefined();
    expect(within(reply).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["read receipts.ts", "fix the total"]);
    const code = reply.querySelector("pre code");
    expect(code?.textContent).toBe("const total = items.length;\n");
    // Highlighted: the keyword stands in an element of its own, apart from the rest of the line.
    expect(within(code as HTMLElement).getByText("const").tagName).toBe("SPAN");
  });
});

describe("reasoning", () => {
  it("sits behind a fold, open or shut by the reasoning-shown preference, each fold opened or shut by a click until the preference moves", async () => {
    const { app, env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts");
    env.emit(session, "assistant.thinking", { runId, itemId: "r-1", text: "The totals are summed twice.\n\nFix the second sum.", aborted: false });
    const fold = await within(transcript).findByRole("button", { name: /^Reasoning/ });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(within(transcript).getByText("Fix the second sum.")).toBeDefined();

    // Shut, its first line says what is in it, and the rest is not drawn.
    act(() => app.presentation.set("reasoningShown", false));
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toContain("The totals are summed twice.");
    expect(within(transcript).queryByText("Fix the second sum.")).toBeNull();

    await app.user.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(within(transcript).getByText("Fix the second sum.")).toBeDefined();

    // The preference moving is an instruction about every fold, the one clicked open included.
    act(() => app.presentation.set("reasoningShown", true));
    act(() => app.presentation.set("reasoningShown", false));
    expect(fold.getAttribute("aria-expanded")).toBe("false");
  });
});
