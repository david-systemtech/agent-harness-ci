import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { PresentationValues } from "../../src/presentation.js";
import type { SceneGeometry, SceneViewport } from "../scene-registry.js";

const environmentId = "0199cc00-0000-4000-8000-000000000001";
const sessionId = "0199dd00-0000-4000-8000-000000000001";

export const script: Script = { environments: [{
  name: "desk", reach: "local", environmentId,
  sessions: Array.from({ length: 9 }, (_, index) => ({
    ...(index === 0 && { id: sessionId }),
    title: index === 0 ? "Plan the next task" : `Task ${index + 1}`,
  })),
}] };

export const presentation: Partial<PresentationValues> = {
  paneLayout: {
    rows: [{ id: "row-1", height: 100, panes: [{ id: "pane-1", width: 100, session: { environmentId, sessionId } }] }],
    focused: "pane-1",
  },
};

/** §9.1–9.2: the sidebar is 224px; frame insets and gap total 21px at both viewports. */
export const geometry = ({ width }: SceneViewport): readonly SceneGeometry[] => [
  { selector: "[data-sidebar-card]", width: 224 },
  { selector: "[data-session-card]", width: width - 245 },
  { selector: "[data-sidebar-caption]", height: 32 },
  { selector: 'nav[aria-label="Sessions"] button[aria-label="New session"]', height: 28 },
  { selector: 'input[aria-label="Filter the sessions"]', height: 24 },
  { selector: '[aria-label="Hide sidebar"]', width: 24, height: 24 },
  { selector: '[aria-label="New group"]', width: 24, height: 24 },
  { selector: '[aria-label="By repository"]', width: 24, height: 24 },
  { selector: '[aria-label="Resize the sidebar"]', width: 8 },
];
