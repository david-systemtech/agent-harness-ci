import type { LadderName } from "@agent-harness/theme";
import { PromptScene, noticePermissionGeometry } from "../prompt-scene.js";

export default function Scene({ ladder }: { readonly ladder: LadderName }) {
  return <PromptScene kind="permission" ladder={ladder} withNotices />;
}
export const geometry = noticePermissionGeometry;

export const readySelector = 'main:has([aria-label="Notifications"] li:nth-child(2)) [aria-label="Parked prompt"]';
