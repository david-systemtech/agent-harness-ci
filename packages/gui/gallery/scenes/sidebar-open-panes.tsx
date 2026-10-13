/* eslint-disable agent-harness/no-client-organisation-state -- Scripted environment fixtures, not renderer-owned organisation state. */
import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry } from "../scene-registry.js";

const environmentId = "0199cc00-0000-4000-8000-000000000001";
const focusedSession = "0199dd00-0000-4000-8000-000000000001";
const openSession = "0199dd00-0000-4000-8000-000000000002";
const anotherSession = "0199dd00-0000-4000-8000-000000000003";

export const script: Script = { environments: [{
  name: "desk", reach: "local", environmentId,
  sessions: [
    { id: focusedSession, title: "Focused session" },
    { id: openSession, title: "Open beside it" },
    { id: anotherSession, title: "Open below it" },
    { title: "Closed session" },
  ],
}] };

export const presentation: Partial<PresentationValues> = {
  paneLayout: {
    rows: [
      { id: "row-1", height: 50, panes: [
        { id: "pane-1", width: 50, session: { environmentId, sessionId: focusedSession } },
        { id: "pane-2", width: 50, session: { environmentId, sessionId: openSession } },
      ] },
      { id: "row-2", height: 50, panes: [
        { id: "pane-3", width: 100, session: { environmentId, sessionId: anotherSession } },
      ] },
    ],
    focused: "pane-1",
  },
};

export const readySelector = '[data-sidebar-row][aria-description="Open in a pane"]';

/** Each row state stays inside the same fixed slot at both desktop viewports. */
export const geometry: readonly SceneGeometry[] = [
  { selector: "[data-sidebar-item]", height: 54 },
  { selector: "[data-sidebar-row]", height: 50 },
  { selector: '[data-sidebar-row][aria-current="true"]', visibleWithin: "[data-sidebar-scroll]", hitTestable: true },
  { selector: '[data-sidebar-row][aria-description="Open in a pane"]', visibleWithin: "[data-sidebar-scroll]", hitTestable: true },
  { selector: "[data-sidebar-row]:not([aria-description])", visibleWithin: "[data-sidebar-scroll]", hitTestable: true },
];
