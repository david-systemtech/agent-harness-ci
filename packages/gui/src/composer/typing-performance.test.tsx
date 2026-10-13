import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Profiler } from "react";
import { DRAFT_DEBOUNCE_MS } from "@agent-harness/client-runtime";
import { expect, it, vi } from "vitest";
import { renderApp } from "../../test/harness.js";
import { addPane } from "../grid/layout.js";

const renders = vi.hoisted(() => new Map<string, number>());

// Instrument the real transcript, including updates from its subscriptions and contexts.
vi.mock("../transcript/transcript.js", async (original) => {
  const module = await original<typeof import("../transcript/transcript.js")>();
  return {
    ...module,
    Transcript: (props: import("../transcript/transcript.js").TranscriptProps) =>
      <Profiler id={`transcript:${props.sessionId}`} onRender={(id) => renders.set(id, (renders.get(id) ?? 0) + 1)}>
        <module.Transcript {...props} />
      </Profiler>,
  };
});

vi.mock("./activity.js", async (original) => {
  const module = await original<typeof import("./activity.js")>();
  return {
    ...module,
    Activity: (props: Parameters<typeof module.Activity>[0]) =>
      <Profiler id={`activity:${props.sessionId}`} onRender={(id) => renders.set(id, (renders.get(id) ?? 0) + 1)}>
        <module.Activity {...props} />
      </Profiler>,
    BackgroundWork: (props: Parameters<typeof module.BackgroundWork>[0]) =>
      <Profiler id={`tasks:${props.sessionId}`} onRender={(id) => renders.set(id, (renders.get(id) ?? 0) + 1)}>
        <module.BackgroundWork {...props} />
      </Profiler>,
  };
});

vi.mock("../status/status-line.js", async (original) => {
  const module = await original<typeof import("../status/status-line.js")>();
  return {
    ...module,
    StatusLine: (props: Parameters<typeof module.StatusLine>[0]) =>
      <Profiler id={`status:${props.sessionId}`} onRender={(id) => renders.set(id, (renders.get(id) ?? 0) + 1)}>
        <module.StatusLine {...props} />
      </Profiler>,
  };
});

it("typing in a busy four-pane window does not render transcripts, tasks or status", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: Array.from({ length: 4 }, (_, i) => ({ title: `Work ${i}` })) }] });
  const env = app.environment("desk");
  for (let i = 0; i < 4; i++) {
    const sessionId = env.sessionId(i);
    const { runId } = env.startRun(sessionId, `Work ${i}`);
    env.emit(sessionId, "tasks.changed", { runId, tasks: Array.from({ length: 12 }, (_, task) => ({
      taskId: `task-${task}`, kind: "local_agent", description: `Inspect part ${task}`, status: "running",
      startedAt: app.clock.now().toISOString(), endedAt: null, subagentType: "Explore", toolCallId: null, error: null,
    })) });
    for (let row = 0; row < 40; row++) {
      env.emit(sessionId, "assistant.text", { runId, itemId: `reply-${row}`, text: `Reply ${i} ${row}`, aborted: false });
    }
  }
  app.open("desk");
  act(() => {
    let layout = app.presentation.values.read().paneLayout;
    for (let i = 1; i < 4; i++) {
      layout = addPane(layout, layout.focused, "right", { environmentId: env.environmentId, sessionId: env.sessionId(i) })!;
    }
    app.presentation.set("paneLayout", layout);
  });
  await waitFor(() => expect(screen.getAllByRole("textbox", { name: "Message" })).toHaveLength(4));
  for (let i = 0; i < 4; i++) await screen.findByText(`Reply ${i} 39`);
  const panes = screen.getAllByRole("region", { name: "Transcript" }).map((transcript) => transcript.closest("section[aria-label=\"Session pane\"]") as HTMLElement);
  const field = within(panes[3]!).getByRole("textbox", { name: "Message" });
  act(() => field.focus());
  renders.clear();
  for (const text of ["a", "ab", "abc", "abcd"]) fireEvent.change(field, { target: { value: text } });
  expect(field).toHaveProperty("value", "abcd");
  expect(env.requests("sessions.setDraft")).toEqual([]);
  expect([...renders.entries()]).toEqual([]);

  act(() => app.clock.advance(DRAFT_DEBOUNCE_MS));
  await waitFor(() => expect(env.summary(env.sessionId(3)).draft).toBe("abcd"));
  expect(env.requests("sessions.setDraft")).toHaveLength(1);
  expect(field).toHaveProperty("value", "abcd");

  renders.clear();
  const sessionId = env.sessionId(3);
  const runId = env.liveRun(sessionId)!;
  act(() => env.emit(sessionId, "assistant.delta", { runId, itemId: "live-reply", fragments: [{ kind: "text", text: "Streaming " }] }));
  await waitFor(() => expect(within(panes[3]!).getAllByRole("article", { name: "Reply" }).at(-1)?.textContent).toContain("Streaming"));
  expect(renders.get(`transcript:${sessionId}`)).toBeGreaterThan(0);
  for (let i = 0; i < 3; i++) expect(renders.get(`transcript:${env.sessionId(i)}`)).toBeUndefined();
  act(() => env.emit(sessionId, "tasks.changed", { runId, tasks: [] }));
  await waitFor(() => expect(within(panes[3]!).queryByRole("list", { name: "Delegated work" })).toBeNull());
  expect(field).toHaveProperty("value", "abcd");
});
