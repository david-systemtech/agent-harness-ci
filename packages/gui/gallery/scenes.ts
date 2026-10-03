import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";

/** One URL per scene. These scripts drive the same app and runtime as the GUI harness. */
export const scenes: Readonly<Record<string, Script>> = {
  "window-empty": { environments: [{ name: "desk", reach: "local", sessions: [] }] },
};
