import type { ScriptedSetup } from "@agent-harness/client-runtime/testing/scripted-environment";
import { STEP_ORDER } from "@agent-harness/contracts";
import { settingsScene } from "./settings-scene.js";

/** The Set up pane's states (setup-copy.md §4.5; #1841): its rows in every state, and what Check everything again says. */
export type SetupPaneState = "states" | "passed" | "checking" | "refused" | "needs-fix";

/** Every state a row shows, a line long enough to wrap among them; the steps given no result read Not checked yet. */
const MIXED: ScriptedSetup = {
  ...Object.fromEntries(STEP_ORDER.map((step) => [step, null])),
  account: {},
  "your-machines": { state: "pending", reason: "Waiting for the first check for updates." },
  forges: {
    state: "needs-attention", reason: "The token for git.example.test has run out, so agents cannot push to your forge. Add a new token.",
    failing: ["forges.token"], actions: ["check-again"],
  },
  browser: { state: "skipped", reason: "No Chrome is paired." },
  permissions: { state: "needs-attention", reason: "The always-ask list lost 2 entries.", failing: ["permissions.denylist"], actions: ["restore"] },
  appearance: {},
};

/** The first step needing a fix after Check everything again. */
const NEEDS_FIX: ScriptedSetup = {
  permissions: { state: "needs-attention", reason: "The always-ask list lost 2 entries.", failing: ["permissions.denylist"], actions: ["restore"] },
};

/** Every step this build registers done, Browser not set up, which counts as fine. */
const FINE: ScriptedSetup = { browser: { state: "skipped", reason: "No Chrome is paired." } };

/** Real Settings on the Set up pane of `desk`, in `state`: Check everything again pressed once for each but `states`. */
export const setupPaneScene = (state: SetupPaneState) =>
  settingsScene(false, "setup.checklist", { environments: [{ name: "desk", reach: "local", capabilities: ["setup"], setup: state === "states" ? MIXED : state === "needs-fix" ? NEEDS_FIX : FINE }] },
    state === "states" ? undefined : "Check everything again",
    (world) => {
      const desk = world.environment("desk");
      if (state === "checking") desk.holdSetupChecks();
      if (state === "refused") desk.wire.answer("setup.check", () => ({ error: { code: "internal", message: "The step registry could not load.", data: {} } }));
    });
