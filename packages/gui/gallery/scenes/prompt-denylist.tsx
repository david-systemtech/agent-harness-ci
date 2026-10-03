import type { LadderName } from "@agent-harness/theme";
import { PromptScene, promptGeometry } from "../prompt-scene.js";

export default function Scene({ ladder }: { readonly ladder: LadderName }) {
  return <PromptScene kind="denylist" ladder={ladder} />;
}
export const geometry = promptGeometry("denylist");
