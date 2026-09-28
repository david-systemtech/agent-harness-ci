import { act, screen, waitFor, within } from "@testing-library/react";
import { TOOL_QUIET_MS } from "@agent-harness/client-runtime";
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

describe("tool calls", () => {
  /** A run on the opened session, and its calls as the environment says them. */
  const calling = async () => {
    const opening = await opened();
    const { env, session } = opening;
    const { runId } = env.startRun(session, "Fix the receipts");
    const started = (toolCallId: string, name: string, input: Record<string, unknown>) =>
      env.emit(session, "tool.started", { runId, toolCallId, name, input, title: null, agentId: null, parentToolCallId: null });
    const ended = (toolCallId: string, status: "ok" | "error", output: unknown) => env.emit(session, "tool.ended", { runId, toolCallId, status, output, durationMs: 20 });
    return { ...opening, runId, started, ended };
  };

  it("folds a run's finished calls into one count row, and shows running and failed calls in full", async () => {
    const { app, transcript, started, ended } = await calling();
    started("t1", "Bash", { command: "ls" });
    ended("t1", "ok", "receipts.ts");
    started("t2", "Read", { file_path: "receipts.ts" });
    ended("t2", "ok", "export const total = 0;");
    started("t3", "Bash", { command: "pnpm test" });
    ended("t3", "error", "FAIL totals\nexpected 3, got 6");
    started("t4", "Edit", { file_path: "totals.ts" });

    const count = await within(transcript).findByRole("button", { name: "Ran a command, read a file" });
    expect(count.getAttribute("aria-expanded")).toBe("false");
    expect(within(transcript).queryByRole("group", { name: "Bash: ls" })).toBeNull();
    const failed = within(transcript).getByRole("group", { name: "Bash: pnpm test" });
    expect(failed.textContent).toContain("expected 3, got 6");
    expect(within(transcript).getByRole("group", { name: "Edit: totals.ts" }).textContent).toContain("Running");

    await app.user.click(count);
    expect(count.getAttribute("aria-expanded")).toBe("true");
    expect(within(transcript).getByRole("group", { name: "Bash: ls" }).textContent).toContain("receipts.ts");
    expect(within(transcript).getByRole("group", { name: "Read: receipts.ts" })).toBeDefined();
  });

  it("turns a call quiet for three minutes amber, the minutes moving on, until it says something again", async () => {
    const { app, env, session, runId, transcript, started } = await calling();
    started("t1", "Bash", { command: "pnpm test" });
    const call = await within(transcript).findByRole("group", { name: "Bash: pnpm test" });
    act(() => app.clock.advance(TOOL_QUIET_MS - 1000));
    expect(call.textContent).not.toContain("No output");
    act(() => app.clock.advance(1000));
    expect(call.textContent).toContain("No output for 3 min");
    act(() => app.clock.advance(60_000));
    expect(call.textContent).toContain("No output for 4 min");

    env.emit(session, "tool.updated", { runId, toolCallId: "t1", update: { elapsedSeconds: 240 } });
    await waitFor(() => expect(call.textContent).not.toContain("No output"));
    act(() => app.clock.advance(TOOL_QUIET_MS));
    expect(call.textContent).toContain("No output for 3 min");
  });
});
