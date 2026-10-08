import type { LadderName } from "@agent-harness/theme";
import { SetupIntroductionScene } from "./setup-introduction.js";

export { geometry } from "./setup-introduction.js";

/** setup-copy.md §4.1: this computer's service not running, with Start. */
export default function SetupIntroductionStopped({ ladder }: { readonly ladder: LadderName }) {
  return <SetupIntroductionScene ladder={ladder} state="stopped" />;
}
