import type { LadderName } from "@agent-harness/theme";
import { SetupIntroductionScene } from "./setup-introduction.js";

export { geometry } from "./setup-introduction.js";

/** setup-copy.md §4.1: agent-harness turned off on this computer, with the switch that turns it on. */
export default function SetupIntroductionOff({ ladder }: { readonly ladder: LadderName }) {
  return <SetupIntroductionScene ladder={ladder} state="off" />;
}
