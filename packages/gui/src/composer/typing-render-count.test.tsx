import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderApp } from "../../test/harness.js";
import { addPane } from "../grid/layout.js";
import { PANES_MOST } from "../presentation.js";

const renders = vi.hoisted(() => new Map<string, number>());
const counted = (id: string, children: ReactNode) =>
  <Profiler id={id} onRender={(at) => renders.set(at, (renders.get(at) ?? 0) + 1)}>{children}</Profiler>;

vi.mock("./activity.js", async (original) => {
  const module = await original<typeof import("./activity.js")>();
  return { ...module, Activity: (props: Parameters<typeof module.Activity>[0]) => counted(`seam:${props.sessionId}`, <module.Activity {...props} />) };
});
vi.mock("../sidebar/row.js", async (original) => {
  const module = await original<typeof import("../sidebar/row.js")>();
  return { ...module, SessionRowView: (props: Parameters<typeof module.SessionRowView>[0]) => counted(`row:${props.line.row.summary.id}`, <module.SessionRowView {...props} />) };
});
vi.mock("./composer.js", async (original) => {
  const module = await original<typeof import("./composer.js")>();
  return { ...module, Composer: (props: Parameters<typeof module.Composer>[0]) => counted(`composer:${props.sessionId}`, <module.Composer {...props} />) };
});

afterEach(() => renders.clear());

const SESSIONS = 12;
const PANES = PANES_MOST;
const KEYSTROKES = 20;

// #2201, #2215 (after #2129/#2179, typing lag with many running panes): what a keystroke renders, counted with React's Profiler.
it(`typing ${KEYSTROKES} characters with ${SESSIONS} working sessions, ${PANES} of them in panes, renders only the composer typed into`, async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: Array.from({ length: SESSIONS }, (_, i) => ({ title: `Work ${i}` })) }] });
  const env = app.environment("desk");
  for (let i = 0; i < SESSIONS; i++) env.startRun(env.sessionId(i), `Work ${i}`);
  app.open("desk");
  act(() => {
    let layout = app.presentation.values.read().paneLayout;
    for (let i = 1; i < PANES; i++) layout = addPane(layout, layout.focused, "right", { environmentId: env.environmentId, sessionId: env.sessionId(i) })!;
    app.presentation.set("paneLayout", layout);
  });
  await waitFor(() => expect(screen.getAllByRole("textbox", { name: "Message" })).toHaveLength(PANES));
  await waitFor(() => expect(document.querySelectorAll("[data-activity-seam][data-activity=working]")).toHaveLength(PANES));
  const field = within(screen.getAllByRole("region", { name: "Transcript" }).map((transcript) => transcript.closest("section[aria-label=\"Session pane\"]") as HTMLElement)[PANES - 1]!).getByRole("textbox", { name: "Message" });
  act(() => field.focus());
  expect([...renders.keys()].filter((id) => id.startsWith("row:"))).toHaveLength(SESSIONS);
  renders.clear();
  let typed = "";
  for (let key = 0; key < KEYSTROKES; key++) fireEvent.change(field, { target: { value: (typed += "x") } });
  expect(field).toHaveProperty("value", typed);
  const typedInto = `composer:${env.sessionId(PANES - 1)}`;
  const of = (kind: string) => [...renders].filter(([id]) => id.startsWith(`${kind}:`));
  // No working pane's seam renders for a keystroke: the composer memoises Activity on its own props.
  expect(of("seam")).toEqual([]);
  // The composer typed into renders twice a keystroke: the change, then the waiting draft coming back through its projection.
  expect(renders.get(typedInto)).toBeLessThanOrEqual(2 * KEYSTROKES);
  // Nothing else renders: the waiting draft is laid over the list in a step of its own, and the window reads the list and
  // the runs without it (client-runtime internal.ts, #2215), so no sidebar row and no other pane's composer draws again.
  expect(of("row")).toEqual([]);
  expect(of("composer").filter(([id]) => id !== typedInto)).toEqual([]);
  expect([...renders.keys()]).toEqual([typedInto]);
});
