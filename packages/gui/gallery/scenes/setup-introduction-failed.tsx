import type { LadderName } from "@agent-harness/theme";
import { SetupIntroductionScene } from "./setup-introduction.js";

export { geometry } from "./setup-introduction.js";

/** setup-copy.md §4.1: the desktop's start failed, its kind worded and its text under Details, open. */
export default function SetupIntroductionFailed({ ladder }: { readonly ladder: LadderName }) {
  return <SetupIntroductionScene ladder={ladder} state="failed" />;
}
