import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { PresentationValues } from "../../src/presentation.js";
import { openBeside } from "../../src/grid/layout.js";
import { PANE_CARD_UNSCROLLABLE } from "../geometry.js";
import type { SceneGeometry, SceneViewport } from "../scene-registry.js";

const environmentId = "0199cc00-0000-4000-8000-000000000001";
const sessionIds = [
  "0199dd00-0000-4000-8000-000000000001",
  "0199dd00-0000-4000-8000-000000000002",
  "0199dd00-0000-4000-8000-000000000003",
] as const;
export const script: Script = { environments: [{ name: "desk", reach: "local", environmentId, sessions: (() => [
  { id: sessionIds[0], title: "Check the ledger" },
  { id: sessionIds[1], title: "Review the receipt parser" },
  { id: sessionIds[2], title: "Compare the totals" },
])() }] };
const layout = { focused: "pane-1", rows: [{ id: "row-1", height: 100, panes: [{ id: "pane-1", width: 100, session: { environmentId, sessionId: sessionIds[0] } }] }] };
// Exercise real successive opens, rather than prescribing equal thirds in the fixture.
const two = openBeside(layout, layout.focused, "right", { environmentId, sessionId: sessionIds[1] })!;
const three = openBeside(two, two.focused, "right", { environmentId, sessionId: sessionIds[2] })!;
export const presentation: Partial<PresentationValues> = { paneLayout: three };

/** Equal thirds at desktop width, with 360px panes reachable by scrolling at laptop width (#2105). */
export const geometry = ({ width }: SceneViewport): readonly SceneGeometry[] => [
  { selector: "[data-grid-card]", width: (Math.max(width - 245, 1094) - 14) / 3, minimumWidth: 360, tolerance: 1 },
  PANE_CARD_UNSCROLLABLE,
  { selector: '[aria-label="Resize the panes"]', width: 7 },
];
export const readySelector = '[data-grid-card="pane-3"] [data-pane-caption]';
