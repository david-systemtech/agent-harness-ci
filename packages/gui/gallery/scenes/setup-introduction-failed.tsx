import type { LadderName } from "@agent-harness/theme";
import { SetupIntroductionScene } from "./setup-introduction.js";

export { geometry } from "./setup-introduction.js";

export default function SetupIntroductionFailed({ ladder }: { readonly ladder: LadderName }) {
  return <SetupIntroductionScene ladder={ladder} failed />;
}
