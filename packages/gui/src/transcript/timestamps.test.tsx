import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderApp } from "../../test/harness.js";

it("shows recorded times without hovering on messages, reasoning, tools and turn ends after reopening", async () => {
  let app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Timed receipts" }] }] });
  app.open("desk");
  let transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  const env = app.environment("desk"), session = env.sessionId();
  const promptTime = app.clock.now().toISOString();
  const { runId } = env.startRun(session, "Check the totals");
  act(() => app.clock.advance(60_000));
  const replyTime = app.clock.now().toISOString();
  env.emit(session, "assistant.delta", { runId, itemId: "reply", fragments: [{ kind: "text", text: "Checking." }] });
  env.emit(session, "assistant.thinking", { runId, itemId: "thought", text: "Compare totals.", aborted: false });
  act(() => app.clock.advance(60_000));
  const toolTime = app.clock.now().toISOString();
  env.emit(session, "tool.started", { runId, toolCallId: "timed-read", name: "Read", input: { file_path: "totals.txt" }, title: null, agentId: null, parentToolCallId: null });
  env.emit(session, "assistant.text", { runId, itemId: "reply", text: "The totals agree.", aborted: false });
  env.emit(session, "tool.ended", { runId, toolCallId: "timed-read", status: "ok", output: "42", durationMs: 10 });
  act(() => app.clock.advance(60_000));
  const endTime = app.clock.now().toISOString();
  env.endRun(session, runId);
  for (let pass = 0; pass < 2; pass++) {
    await within(transcript).findByRole("article", { name: "Turn ended" });
    await app.user.click(within(transcript).getByRole("button", { name: "Read a file" }));
    const timed = (element: HTMLElement) => element.closest("[data-row-id]")?.querySelector("time");
    await waitFor(() => expect(timed(within(transcript).getByRole("article", { name: "Reply" }))?.dateTime).toBe(replyTime));
    expect(timed(within(transcript).getByRole("article", { name: "Your message" }))?.dateTime).toBe(promptTime);
    expect(timed(within(transcript).getByRole("article", { name: "Turn ended" }))?.dateTime).toBe(endTime);
    const tool = within(transcript).getByRole("group", { name: "Read: totals.txt" }).querySelector("time");
    expect(tool?.dateTime).toBe(toolTime);
    for (const time of transcript.querySelectorAll("time")) {
      expect(time.title).toBe(time.dateTime);
      expect(time.className).not.toMatch(/\bhidden\b|group-hover/);
      expect(time.className).toContain("whitespace-nowrap");
    }
    expect(transcript.querySelectorAll(`time[datetime="${replyTime}"]`)).toHaveLength(2);
    if (pass === 0) {
      app = await app.remount();
      transcript = await screen.findByRole("region", { name: "Transcript" });
    }
  }
  act(() => app.clock.advance(24 * 3_600_000));
  await waitFor(() => {
    for (const time of transcript.querySelectorAll("time")) expect(time.textContent).toMatch(/^\d{4}-\d{2}-\d{2} · \d{2}:\d{2}$/);
  });
});
