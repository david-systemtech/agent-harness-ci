import type { LadderName } from "@agent-harness/theme";
import { PromptScene } from "../prompt-scene.js";
/** look.md §10.3 and §16: the real permission request error state. */
export default function Scene({ ladder }: { readonly ladder: LadderName }) { return <PromptScene kind="permission" state="error" ladder={ladder} />; }
export const readySelector = '[data-prompt-state="error"]';
export const geometry = [{ selector: '[aria-label="Message"]', height: 44 }];
