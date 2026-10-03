import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { SceneGeometry } from "../scene-registry.js";

export const script: Script = { environments: [{ name: "desk", reach: "local", sessions: [] }] };

/** docs/specs/look.md §9.2: the empty list keeps the sidebar's heading geometry. */
export const geometry: readonly SceneGeometry[] = [
  { selector: "[data-sidebar-card]", width: 224 },
  { selector: 'nav[aria-label="Sessions"] h2', height: 24 },
  { selector: '[data-sidebar-empty] svg', width: 28, height: 28 },
];
