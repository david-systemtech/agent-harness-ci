import type { LadderName } from "@agent-harness/theme";
import { SetupIntroductionScene } from "./setup-introduction.js";

export { geometry } from "./setup-introduction.js";

/** setup-copy.md §4.1: an app with no service of its own, as a browser tab. */
export default function SetupIntroductionUnavailable({ ladder }: { readonly ladder: LadderName }) {
  return <SetupIntroductionScene ladder={ladder} state="unavailable" />;
}
