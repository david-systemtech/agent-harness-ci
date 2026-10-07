import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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

/**
 * A word's fade ends, as the browser says it: jsdom has no `AnimationEvent`, so React hears the prefixed name there, and
 * both are said (a word hears one of them).
 */
const fadeEnds = (word: HTMLElement) => {
  fireEvent.animationEnd(word);
  fireEvent(word, new Event("webkitAnimationEnd", { bubbles: true }));
};

/** The words of `element` still fading in, each as it arrived. */
const fading = (element: HTMLElement | undefined) => [...(element?.querySelectorAll("span") ?? [])].filter((span) => span.classList.contains("word-in")).map((span) => span.textContent);

/** What `element` draws, its fading words drawn as the text they hold: how it reads once nothing fades. */
const drawn = (element: HTMLElement | undefined) => {
  const copy = element?.cloneNode(true) as HTMLElement | undefined;
  for (const word of copy?.querySelectorAll(".word-in") ?? []) word.replaceWith(...word.childNodes);
  copy?.normalize();
  return copy?.querySelector(".markdown")?.outerHTML;
};

describe("streaming", () => {
  it("labels message spines and shows a caret only while a reply is streaming", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Check the totals");
    await within(transcript).findByRole("article", { name: "Your message" });
    expect(within(transcript).getByText("you")).toBeDefined();
    env.emit(session, "assistant.delta", { runId, itemId: "reply", fragments: [{ kind: "text", text: "Checking the totals. " }] });
    const reply = await within(transcript).findByRole("article", { name: "Reply" });
    expect(within(reply).getByRole("status", { name: "Reply streaming" })).toBeDefined();
    env.emit(session, "assistant.text", { runId, itemId: "reply", text: "The totals agree.", aborted: false });
    await waitFor(() => expect(within(reply).queryByRole("status", { name: "Reply streaming" })).toBeNull());
    env.endRun(session, runId);
    await within(transcript).findByRole("article", { name: "Turn ended" });
    expect(within(transcript).getByText("end")).toBeDefined();
  });

  it("keeps very long replies prewrapped and searchable rather than parsing Markdown", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Read the long report");
    env.emit(session, "assistant.text", { runId, itemId: "long", text: "# Report\n" + "Plain text. ".repeat(7400), aborted: false });
    const reply = await within(transcript).findByRole("article", { name: "Reply" });
    expect(within(reply).queryByRole("heading", { name: "Report" })).toBeNull();
    expect(reply.textContent).toContain("# Report");
  });

  it("draws Workspace check commands, running state and finished output from the shared projection", async () => {
    const { env, transcript, session } = await opened();
    const check = { terminalId: "0199a100-0000-4000-8000-000000000001", command: "pnpm lint", sourceRunId: null };
    env.emit(session, "checks.started", check);
    const row = await within(transcript).findByRole("article", { name: "Workspace check" });
    expect(row.textContent).toContain("$ pnpm lint · running");
    env.emit(session, "checks.finished", { ...check, output: "Lint failed\n", truncated: true, exitCode: 1, signal: null, timedOut: false, failure: null });
    await waitFor(() => expect(row.textContent).toContain("$ pnpm lint · exit 1"));
    expect(row.textContent).toContain("Earlier output omitted");
    expect(row.textContent).toContain("Lint failed");
    expect(within(transcript).getAllByRole("article", { name: "Workspace check" })).toHaveLength(1);
  });

  it("draws the run's prompt, then its text as the deltas arrive, and the whole text once it settles", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts");
    expect((await within(transcript).findByRole("article", { name: "Your message" })).textContent).toBe("Fix the receipts");

    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Looking at " }] });
    await waitFor(() => expect(lastReply(transcript)?.textContent).toBe("Looking at"));
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "the parser. " }] });
    await waitFor(() => expect(lastReply(transcript)?.textContent).toBe("Looking at the parser."));

    env.emit(session, "assistant.text", { runId, itemId: "i-1", text: "Looking at the parser. Found it.", aborted: false });
    await waitFor(() => expect(lastReply(transcript)?.textContent).toBe("Looking at the parser. Found it."));
  });

  it("fades each word in as it arrives while the streaming fade is on, a word held back until it is whole, and draws the text plainly with the fade off", async () => {
    const { app, env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts");
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Looking at " }] });
    await waitFor(() => expect(fading(lastReply(transcript))).toEqual(["Looking ", "at"]));
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "the par" }] });
    await waitFor(() => expect(fading(lastReply(transcript))).toEqual(["Looking ", "at ", "the"]));
    expect(lastReply(transcript)?.textContent).toBe("Looking at the");

    act(() => app.presentation.set("streamingFade", false));
    expect(lastReply(transcript)?.textContent).toBe("Looking at the par");
    expect(fading(lastReply(transcript))).toEqual([]);
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "ser. " }] });
    await waitFor(() => expect(lastReply(transcript)?.textContent).toBe("Looking at the parser."));
    expect(fading(lastReply(transcript))).toEqual([]);

    // Turned on again mid-stream, what is already there is not replayed: only what arrives after fades in.
    act(() => app.presentation.set("streamingFade", true));
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Found it. " }] });
    await waitFor(() => expect(fading(lastReply(transcript))).toEqual(["Found ", "it."]));
    expect(lastReply(transcript)?.textContent).toBe("Looking at the parser. Found it.");
  });

  it("keeps what is already shown, a half word included, when the fade is turned on, and fades in only what arrives after", async () => {
    const { app, env, transcript, session } = await opened();
    act(() => app.presentation.set("streamingFade", false));
    const { runId } = env.startRun(session, "Fix the receipts");
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Looking at the par" }] });
    await waitFor(() => expect(lastReply(transcript)?.textContent).toBe("Looking at the par"));

    act(() => app.presentation.set("streamingFade", true));
    expect(lastReply(transcript)?.textContent).toBe("Looking at the par");
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "ser. Found " }] });
    await waitFor(() => expect(lastReply(transcript)?.textContent).toBe("Looking at the parser. Found"));
    expect(fading(lastReply(transcript))).toEqual(["ser. ", "Found"]);
  });

  it("keeps whitespace that arrives on its own, a paragraph's break starting the next paragraph, while the fade is on", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts");
    const paragraphs = () => [...(lastReply(transcript)?.querySelectorAll("p") ?? [])].map((paragraph) => paragraph.textContent);
    // Each delta drawn before the next arrives, as a provider streams them.
    for (const [text, shown] of [
      ["First line. ", ["First line."]],
      ["\n\n", ["First line."]],
      ["Second ", ["First line.", "Second"]],
      [" ", ["First line.", "Second"]],
      ["line. ", ["First line.", "Second  line."]],
    ] as const) {
      env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text }] });
      await waitFor(() => expect(paragraphs()).toEqual(shown));
    }
  });

  it("folds a word back into the settled text once its fade has ended, never while a word before it is still fading", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts");
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "One two three " }] });
    await waitFor(() => expect(fading(lastReply(transcript))).toEqual(["One ", "two ", "three"]));
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "four " }] });
    await waitFor(() => expect(fading(lastReply(transcript))).toEqual(["One ", "two ", "three ", "four"]));
    const word = (text: string) => [...(lastReply(transcript)?.querySelectorAll("span") ?? [])].find((span) => span.textContent === text) as HTMLElement;

    // The later, shorter delta ends its fade first: the words before it are still fading, so nothing is folded yet.
    fadeEnds(word("four"));
    expect(fading(lastReply(transcript))).toEqual(["One ", "two ", "three ", "four"]);
    fadeEnds(word("three "));
    expect(fading(lastReply(transcript))).toEqual([]);
    expect(lastReply(transcript)?.textContent).toBe("One two three four");
  });

  it("keeps each later word's own element, its fade not replayed, when a batch before it folds, in its text and beside emphasis", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts");
    for (const [text, words] of [
      ["One ", ["One"]],
      ["two ", ["One ", "two"]],
      ["**three** ", ["One ", "two ", "three"]],
      ["four ", ["One ", "two ", "three", " ", "four"]],
    ] as const) {
      env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text }] });
      await waitFor(() => expect(fading(lastReply(transcript))).toEqual(words));
    }
    const word = (text: string) => [...(lastReply(transcript)?.querySelectorAll(".word-in") ?? [])].find((span) => span.textContent === text) as HTMLElement;
    const later = [word("two "), word("three"), word("four")];

    // The last delta's fade ends first and waits; the first's ends and folds it, the second still fading.
    fadeEnds(word("four"));
    fadeEnds(word("One "));
    await waitFor(() => expect(fading(lastReply(transcript))).toEqual(["two ", "three", " ", "four"]));
    expect(later.map((element) => element.isConnected)).toEqual([true, true, true]);
    expect([word("two "), word("three"), word("four")]).toEqual(later);
    expect(lastReply(transcript)?.textContent).toBe("One two three four");
  });

  it("keeps the words before a burst in their place when the burst lands at once", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts");
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Sure, " }] });
    await waitFor(() => expect(fading(lastReply(transcript))).toEqual(["Sure,"]));
    const burst = Array.from({ length: 250 }, (_, index) => `w${index} `).join("");
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: burst }] });
    await waitFor(() => expect(lastReply(transcript)?.textContent).toBe(`Sure, ${burst.trimEnd()}`));
  });

  it("draws markdown as it streams, closed emphasis, a heading and inline code formatted before the turn ends, and the end reflows nothing", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Write about tea");
    const chunks = ["# The History", " of Tea\n\nThe **first", "** leaves of *Camellia", " sinensis* were steeped in `po", "ts` long ago. "];
    for (const text of chunks) env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text }] });
    const reply = await waitFor(() => {
      const found = lastReply(transcript);
      expect(found?.textContent).toContain("long ago.");
      return found as HTMLElement;
    });
    expect(within(reply).getByRole("status", { name: "Reply streaming" })).toBeDefined();
    expect(reply.querySelector("h1")?.textContent).toBe("The History of Tea");
    expect(reply.querySelector("strong")?.textContent).toBe("first");
    expect(reply.querySelector("em")?.textContent).toBe("Camellia sinensis");
    expect(reply.querySelector("code")?.textContent).toBe("pots");
    expect(reply.textContent).not.toMatch(/[*#`]/);
    const streamed = drawn(reply);

    env.emit(session, "assistant.text", { runId, itemId: "i-1", text: chunks.join(""), aborted: false });
    await waitFor(() => expect(within(reply).queryByRole("status", { name: "Reply streaming" })).toBeNull());
    expect(drawn(lastReply(transcript))).toBe(streamed);
  });

  it("fades in only the words that arrive, inside emphasis too, never what was already there", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Write about tea");
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Tea was " }] });
    await waitFor(() => expect(fading(lastReply(transcript))).toEqual(["Tea ", "was"]));
    for (const word of lastReply(transcript)?.querySelectorAll(".word-in") ?? []) fadeEnds(word as HTMLElement);
    await waitFor(() => expect(fading(lastReply(transcript))).toEqual([]));

    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "**first** steeped " }] });
    await waitFor(() => expect(fading(lastReply(transcript))).toEqual(["first", " ", "steeped"]));
    expect(lastReply(transcript)?.querySelector("strong .word-in")?.textContent).toBe("first");
    expect(lastReply(transcript)?.textContent).toBe("Tea was first steeped");
  });

  it("draws markdown while it streams with the fade off too", async () => {
    const { app, env, transcript, session } = await opened();
    act(() => app.presentation.set("streamingFade", false));
    const { runId } = env.startRun(session, "Write about tea");
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "## Tea\n\n- *green*\n- black" }] });
    const reply = await waitFor(() => {
      const found = lastReply(transcript);
      expect(found?.querySelectorAll("li")).toHaveLength(2);
      return found as HTMLElement;
    });
    expect(within(reply).getByRole("heading", { name: "Tea" })).toBeDefined();
    expect(reply.querySelector("li em")?.textContent).toBe("green");
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
    const fold = await within(transcript).findByRole("button", { name: /^Thinking/ });
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
    const successful = within(transcript).getByRole("group", { name: "Bash: ls" });
    await app.user.click(within(successful).getByRole("button", { name: "Bash: ls" }));
    await app.user.click(within(successful).getByRole("button", { name: "Result" }));
    expect(successful.textContent).toContain("receipts.ts");
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

describe("delegated work and plans", () => {
  const task = (status: "running" | "completed") => ({
    taskId: "task-1",
    kind: "local_agent",
    description: "Find where totals are summed",
    status,
    startedAt: "2026-09-28T10:00:00.000Z",
    endedAt: status === "running" ? null : "2026-09-28T10:01:00.000Z",
    subagentType: "Explore",
    toolCallId: "t-agent",
    error: null,
  });

  it("shows delegated work with its agent: the subagent's calls in one row, and the live run's live work in a strip under the transcript", async () => {
    const { app, env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts");
    env.emit(session, "tool.started", { runId, toolCallId: "t-agent", name: "Task", input: { description: "Find where totals are summed" }, title: null, agentId: null, parentToolCallId: null });
    env.emit(session, "tasks.changed", { runId, tasks: [task("running")] });
    env.emit(session, "tool.started", { runId, toolCallId: "t-grep", name: "Grep", input: { pattern: "total" }, title: null, agentId: "agent-1", parentToolCallId: "t-agent" });
    env.emit(session, "tool.ended", { runId, toolCallId: "t-grep", status: "ok", output: "receipts.ts:3", durationMs: 20 });

    const agent = await within(transcript).findByRole("button", { name: "Explore: Find where totals are summed · 1 call · running" });
    const strip = screen.getByRole("list", { name: "Delegated work" });
    expect(within(strip).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Explore: Find where totals are summed · running"]);
    await app.user.click(screen.getByRole("button", { name: "Open background work in Tasks" }));
    expect(await screen.findByRole("region", { name: "Tasks" })).toBeDefined();
    await app.user.click(agent);
    expect(within(transcript).getByRole("group", { name: "Grep: total" })).toBeDefined();

    env.emit(session, "tasks.changed", { runId, tasks: [task("completed")] });
    await within(transcript).findByRole("button", { name: "Explore: Find where totals are summed · 1 call · done" });
    expect(screen.queryByRole("list", { name: "Delegated work" })).toBeNull();
  });

  it("renders a plan in place once answered, as markdown, with how it was answered; while parked it is the card's", async () => {
    const { env, transcript, session } = await opened();
    env.startRun(session, "Plan the fix");
    const promptId = env.openPrompt(session, { kind: "plan", summary: "A plan to approve", plan: "## Steps\n\n1. Read the parser\n2. Fix the sum", toolName: null, input: null });
    await screen.findByRole("region", { name: "Parked prompt" });
    expect(within(transcript).queryByRole("article", { name: "Plan" })).toBeNull();
    env.answerElsewhere(session, promptId, { decision: "deny" });
    const plan = await within(transcript).findByRole("article", { name: "Plan" });
    expect(within(plan).getByRole("heading", { name: "Steps" })).toBeDefined();
    expect(within(plan).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Read the parser", "Fix the sum"]);
    expect(plan.textContent).toContain("Kept planning");
  });
});

describe("prompts in place", () => {
  it("says which rule settled a prompt nobody answered, in the notice's words rather than the message the model reads", async () => {
    const { env, transcript, session } = await opened();
    env.startRun(session, "Clean up");
    const permission = env.openPrompt(session, { summary: "Bash: rm -rf build" });
    await screen.findByRole("region", { name: "Parked prompt" });
    env.settleAutomatically(session, permission, "run_ended", { message: "The run ended before anyone answered, so the request was denied." });
    const row = await within(transcript).findByRole("article", { name: "Permission" });
    expect(row.textContent).toBe("Bash: rm -rf build — denied: its run ended first");
  });

  it("draws an answered prompt and question at the place each was asked, not where they were answered", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Clean up");
    env.emit(session, "assistant.text", { runId, itemId: "i-1", text: "First.", aborted: false });
    const permission = env.openPrompt(session, { summary: "Bash: rm -rf build" });
    env.emit(session, "assistant.text", { runId, itemId: "i-2", text: "Second.", aborted: false });
    const question = env.openPrompt(session, {
      kind: "question",
      summary: "Which database?",
      toolName: null,
      input: null,
      questions: [{ header: "DB", question: "Which database?", options: [{ label: "Postgres", description: "" }], multiSelect: false }],
    });
    env.emit(session, "assistant.text", { runId, itemId: "i-3", text: "Third.", aborted: false });
    env.answerElsewhere(session, permission);
    env.emit(session, "prompt.answered", {
      runId,
      promptId: question,
      decision: "allow",
      message: null,
      answers: { "Which database?": "Postgres" },
      updatedInput: null,
      mode: null,
      remember: null,
      decidedBy: "0199cc00-0000-7000-8000-000000000009",
      delivery: "live",
    });

    await waitFor(() => expect(within(transcript).getByRole("article", { name: "Question" }).textContent).toContain("Postgres"));
    const order = within(transcript)
      .getAllByRole("article")
      .map((article) => `${article.getAttribute("aria-label")}: ${article.textContent}`);
    expect(order).toEqual([
      "Your message: Clean up",
      "Reply: First.",
      "Permission: Bash: rm -rf build — allowed",
      "Reply: Second.",
      "Question: Which database? — Postgres",
      "Reply: Third.",
    ]);
  });
});

describe("the cost line", () => {
  it("sits under each finished turn: its duration, its tokens, its dollars when the provider says, and how it ended when it did not complete", async () => {
    const { env, transcript, session } = await opened();
    const usage = [
      { model: "a", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 100, costUsd: 0.01, contextWindow: null },
      { model: "b", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002, contextWindow: null },
    ];
    const first = env.startRun(session, "Fix the receipts");
    env.emit(session, "assistant.text", { runId: first.runId, itemId: "i-1", text: "Done.", aborted: false });
    env.endRun(session, first.runId, { durationMs: 12_300, usage });
    expect(await within(transcript).findByText("12s · 4.1k in · 205 out · $0.012")).toBeDefined();

    const second = env.startRun(session, "And the tests");
    env.emit(session, "assistant.text", { runId: second.runId, itemId: "i-2", text: "Looking.", aborted: false });
    env.endRun(session, second.runId, { reason: "interrupted", durationMs: 800, usage: usage.map((model) => ({ ...model, costUsd: null })) });
    expect(await within(transcript).findByText("Interrupted · 800ms · 4.1k in · 205 out")).toBeDefined();

    const third = env.startRun(session, "Once more");
    env.emit(session, "assistant.text", { runId: third.runId, itemId: "i-3", text: "Hm.", aborted: false });
    env.endRun(session, third.runId, { reason: "error", durationMs: 1000 });
    expect(await within(transcript).findByText("Error · 1.0s")).toBeDefined();
    expect(within(transcript).getByText("The run failed.")).toBeDefined();
  });
});

describe("images", () => {
  const PICTURE = "aGVsbG8=";

  it("draws the images a call returned inline, its calls folded or not, and a picture the reply carries", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Look at the chart");
    env.emit(session, "tool.started", { runId, toolCallId: "t1", name: "Read", input: { file_path: "chart.png" }, title: null, agentId: null, parentToolCallId: null });
    env.emit(session, "tool.ended", { runId, toolCallId: "t1", status: "ok", output: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PICTURE } }], durationMs: 20 });
    env.emit(session, "tool.started", { runId, toolCallId: "t2", name: "Read", input: { file_path: "photo.jpg" }, title: null, agentId: null, parentToolCallId: null });
    env.emit(session, "tool.ended", { runId, toolCallId: "t2", status: "ok", output: { type: "image", file: { base64: PICTURE, type: "image/jpeg" } }, durationMs: 20 });
    const text = `Here it is: ![the totals chart](data:image/png;base64,${PICTURE}) and ![a remote one](https://example.com/c.png)`;
    env.emit(session, "assistant.text", { runId, itemId: "i-1", text, aborted: false });

    const chart = await within(transcript).findByRole("img", { name: "Returned by Read: chart.png" });
    expect(chart.getAttribute("src")).toBe(`data:image/png;base64,${PICTURE}`);
    expect(within(transcript).getByRole("img", { name: "Returned by Read: photo.jpg" }).getAttribute("src")).toBe(`data:image/jpeg;base64,${PICTURE}`);
    expect(within(transcript).getByRole("img", { name: "the totals chart" }).getAttribute("src")).toBe(`data:image/png;base64,${PICTURE}`);
    // A picture elsewhere is a link to it, never fetched on its own.
    expect(within(transcript).queryByRole("img", { name: "a remote one" })).toBeNull();
    expect(within(transcript).getByRole("link", { name: "a remote one" }).getAttribute("href")).toBe("https://example.com/c.png");
  });

  it("names a picture elsewhere inside a link by its words, the link leading where it leads, never one link inside another", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Where is it?");
    env.emit(session, "assistant.text", { runId, itemId: "i-1", text: "See [![the dashboard](https://example.com/d.png)](https://example.com/dashboard).", aborted: false });
    const link = await within(transcript).findByRole("link", { name: "the dashboard" });
    expect(link.getAttribute("href")).toBe("https://example.com/dashboard");
    expect(within(transcript).getAllByRole("link")).toHaveLength(1);
    expect(within(transcript).queryByRole("img")).toBeNull();
  });

  it("keeps the words a call returned beside its picture", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Why did it fail?");
    env.emit(session, "tool.started", { runId, toolCallId: "t1", name: "Screenshot", input: { url: "http://localhost:3000" }, title: null, agentId: null, parentToolCallId: null });
    const output = [{ type: "text", text: "The page failed to load" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PICTURE } }];
    env.emit(session, "tool.ended", { runId, toolCallId: "t1", status: "error", output, durationMs: 20 });
    expect(await within(transcript).findByRole("img", { name: "Returned by Screenshot: http://localhost:3000" })).toBeDefined();
    const call = within(transcript).getByRole("group", { name: "Screenshot: http://localhost:3000" });
    expect(call.textContent).toContain("The page failed to load");
    expect(call.textContent).not.toContain(PICTURE);
  });

  it("names an image sent with a message, whose bytes the log never holds", async () => {
    const { env, transcript, session } = await opened();
    env.startRun(session, "See this", [{ kind: "image", name: "screen.png", mediaType: "image/png", data: PICTURE }]);
    const message = await within(transcript).findByRole("article", { name: "Your message" });
    expect(within(message).getByText("screen.png · 1 KB")).toBeDefined();
  });
});

describe("an entry this version does not know", () => {
  it("renders as one dim row naming its type", async () => {
    const { env, transcript, session } = await opened();
    env.emit(session, "weird.new-thing", { anything: true });
    expect(await within(transcript).findByText("weird.new-thing: an event this version does not show")).toBeDefined();
  });
});

describe("freshness", () => {
  it("heads the transcript with a catching-up marker until the stream is live, and a cached one while its environment is not answering", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }], holdSessions: true }] });
    const env = app.environment("desk");
    app.open("desk");
    const transcript = await screen.findByRole("region", { name: "Transcript" });
    const marker = await within(transcript).findByText("Catching up…");
    expect(within(transcript).getAllByText(/./)[0]).toBe(marker);

    env.releaseSessions();
    await within(transcript).findByText("Nothing said yet.");
    expect(within(transcript).queryByText("Catching up…")).toBeNull();

    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    const cached = await within(transcript).findByText("Cached: what this window last saw of it; desk is not answering");
    expect(within(transcript).getAllByText(/./)[0]).toBe(cached);
  });
});

describe("following the end", () => {
  it("renders bottom-anchored, following new output until David scrolls up, with a way back to the end", async () => {
    const { app, env, transcript, session } = await opened();
    // jsdom lays nothing out: the transcript's box is given a height, and what it holds grows as the test says.
    let height = 1000;
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, get: () => height });
    const { runId } = env.startRun(session, "Fix the receipts");
    await within(transcript).findByRole("article", { name: "Your message" });
    expect(transcript.scrollTop).toBe(1000);

    height = 1600;
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Looking at " }] });
    await waitFor(() => expect(transcript.scrollTop).toBe(1600));

    // Scrolled up to read: the end is no longer followed, and a way back to it is offered.
    transcript.scrollTop = 300;
    fireEvent.scroll(transcript);
    const back = await screen.findByRole("button", { name: "Jump to the latest" });
    height = 2200;
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "the parser. " }] });
    await waitFor(() => expect(lastReply(transcript)?.textContent).toBe("Looking at the parser."));
    expect(transcript.scrollTop).toBe(300);

    await app.user.click(back);
    expect(transcript.scrollTop).toBe(2200);
    expect(screen.queryByRole("button", { name: "Jump to the latest" })).toBeNull();
    height = 2600;
    env.emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Found it. " }] });
    await waitFor(() => expect(transcript.scrollTop).toBe(2600));
  });
});

describe("display preferences", () => {
  it("reads the text size, reading width, reasoning shown and streaming fade on each render, and keeps them and the open session across a remount", async () => {
    const { app, env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts");
    env.emit(session, "assistant.thinking", { runId, itemId: "r-1", text: "Summed twice.", aborted: false });
    await within(transcript).findByRole("button", { name: /^Thinking/ });
    // The column the rows stand in.
    const column = () => screen.getByRole("region", { name: "Transcript" }).firstElementChild as HTMLElement;
    expect(transcript.style.fontSize).toBe("");
    expect(column().style.maxWidth).toBe("920px");

    act(() => {
      app.presentation.set("textSize", 17);
      app.presentation.set("readingWidth", "wide");
      app.presentation.set("reasoningShown", false);
      app.presentation.set("streamingFade", false);
    });
    expect(transcript.style.fontSize).toBe("");
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe(String(17 / 14));
    expect(column().style.maxWidth).toBe("80rem");
    act(() => app.presentation.set("readingWidth", "full"));
    expect(column().style.maxWidth).toBe("none");

    const again = await app.remount();
    const reopened = await screen.findByRole("region", { name: "Transcript" });
    expect(reopened.style.fontSize).toBe("");
    expect(column().style.maxWidth).toBe("none");
    expect((await within(reopened).findByRole("button", { name: /^Thinking/ })).getAttribute("aria-expanded")).toBe("false");
    again.environment("desk").emit(session, "assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Looking at the par" }] });
    await waitFor(() => expect(lastReply(reopened)?.textContent).toBe("Looking at the par"));
    expect(fading(lastReply(reopened))).toEqual([]);
  });
});

describe("the find bar", () => {
  it("opens on Mod+F and highlights matches; Enter moves to the next, Shift+Enter to the previous, and Esc closes it", async () => {
    const { app, env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Fix the parser");
    env.emit(session, "assistant.text", { runId, itemId: "i-1", text: "The Parser sums twice. Fix the **parser** first.", aborted: false });
    env.endRun(session, runId);
    await within(transcript).findByText(/sums twice/);

    await app.user.keyboard("{Control>}f{/Control}");
    const bar = screen.getByRole("search", { name: "Find in the conversation" });
    const field = within(bar).getByRole("searchbox", { name: "Find" });
    expect(document.activeElement).toBe(field);
    // Typed where the key left the caret (a click in jsdom lands on the sidebar's divider, which lays out at the pointer).
    await app.user.keyboard("parser");
    const marks = () => within(transcript).queryAllByRole("mark");
    const current = () => marks().findIndex((mark) => mark.getAttribute("aria-current") === "true");
    expect(marks().map((mark) => mark.textContent)).toEqual(["parser", "Parser", "parser"]);
    expect(within(bar).getByText("1 of 3")).toBeDefined();
    expect(current()).toBe(0);

    await app.user.keyboard("{Enter}");
    expect(within(bar).getByText("2 of 3")).toBeDefined();
    expect(current()).toBe(1);
    await app.user.keyboard("{Enter}{Enter}");
    expect(within(bar).getByText("1 of 3")).toBeDefined();
    await app.user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(within(bar).getByText("3 of 3")).toBeDefined();
    expect(current()).toBe(2);

    await app.user.keyboard("z");
    expect(within(bar).getByText("No matches")).toBeDefined();
    expect(marks()).toEqual([]);

    await app.user.keyboard("{Escape}");
    expect(screen.queryByRole("search", { name: "Find in the conversation" })).toBeNull();
    expect(marks()).toEqual([]);
    // Opened again, it offers what it looked for last, ready to be typed over.
    await app.user.keyboard("{Control>}f{/Control}");
    const again = screen.getByRole("searchbox", { name: "Find" });
    expect(again).toHaveProperty("value", "parserz");
    expect(document.activeElement).toBe(again);
  });

  it("counts again what a fold opened or shut adds or takes away while it looks", async () => {
    const { app, env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Fix the parser");
    env.emit(session, "tool.started", { runId, toolCallId: "t1", name: "Bash", input: { command: "grep parser" }, title: null, agentId: null, parentToolCallId: null });
    env.emit(session, "tool.ended", { runId, toolCallId: "t1", status: "ok", output: "src/parser.ts", durationMs: 20 });
    env.emit(session, "assistant.text", { runId, itemId: "i-1", text: "The parser is fixed.", aborted: false });
    env.endRun(session, runId);
    const fold = await within(transcript).findByRole("button", { name: "Ran a command" });

    await app.user.keyboard("{Control>}f{/Control}");
    await app.user.keyboard("parser");
    const bar = screen.getByRole("search", { name: "Find in the conversation" });
    expect(within(bar).getByText("1 of 2")).toBeDefined();

    await app.user.click(fold);
    await waitFor(() => expect(within(bar).getByText("1 of 3")).toBeDefined());
    expect(within(transcript).getAllByRole("mark")).toHaveLength(3);
    await app.user.click(fold);
    await waitFor(() => expect(within(bar).getByText("1 of 2")).toBeDefined());
  });
});

describe("a run an update cut", () => {
  it("says why the run waits and draws the continuation as an environment message", async () => {
    const { env, transcript, session } = await opened();
    const { runId } = env.startRun(session, "Fix the receipts");
    await within(transcript).findByRole("article", { name: "Your message" });
    env.emit(session, "run.update-interrupted", { runId, updateId: runId, toVersion: "0.5.0", outcome: "next-message", reason: "account", continuationRunId: null });
    await within(transcript).findByText("Updated to 0.5.0 while this ran; waits for your next message: the account changed or is signed out");
    env.emit(session, "message.sent", { runId, messageId: "0199aa00-0000-4000-8000-000000000099", text: "Check the current state, then continue.", attachments: [], delivery: "prompt", heldBy: null, ceiling: "auto" }, { actor: { kind: "system", id: "updates" } });
    const message = await within(transcript).findByRole("article", { name: "Environment message" });
    expect(within(message).getByText("Environment")).toBeTruthy();
    expect(within(message).getByText("Check the current state, then continue.")).toBeTruthy();
    expect(within(transcript).getAllByRole("article", { name: "Your message" })).toHaveLength(1);
  });
});
