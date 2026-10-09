import type { LadderName } from "@agent-harness/theme";
import { PANE_CARD_UNSCROLLABLE } from "../geometry.js";
import { PromptScene } from "../prompt-scene.js";
/** look.md §10.3 and §16: the real permission request settled state. */
export default function Scene({ ladder }: { readonly ladder: LadderName }) { return <PromptScene kind="permission" state="settled" ladder={ladder} />; }
export const readySelector = '[data-prompt-state="settled"]';
export const geometry = [PANE_CARD_UNSCROLLABLE, { selector: '[aria-label="Message"]', height: 44 }];
