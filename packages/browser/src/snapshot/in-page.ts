import type { InPageSource } from "../driver/page.js";
import { redactedFieldValue, secretField } from "../redaction.js";
import { playwrightAriaSnapshot } from "./vendor/aria-snapshot.js";
import { playwrightCssTokenizer } from "./vendor/css-tokenizer.js";
import { playwrightDomUtils } from "./vendor/dom-utils.js";
import { playwrightRoleUtils } from "./vendor/role-utils.js";
import { installSnapshotWorld, snapshotWorld, type FieldMarkers, type FrameSnapshot, type FrameSnapshotOptions, type SnapshotGlobal } from "./world.js";

/**
 * The snapshot's in-page functions (browser spec, "The tools"): what the
 * driver runs in each frame's isolated world. `snapshotFrame` is composed
 * from several functions' source texts, the vendored aria snapshot's among
 * them, into one function declaration, since `Runtime.callFunctionOn` sends
 * one; each part reaches nothing outside itself but its arguments, so the
 * declaration runs alone in the page as it runs in a test's jsdom.
 */

/** The value written for each kind of field whose value is never read. */
const FIELD_MARKERS: FieldMarkers = {
  password: redactedFieldValue("password"),
  "payment-card": redactedFieldValue("payment-card"),
  "one-time-code": redactedFieldValue("one-time-code"),
};

/**
 * Snapshots the frame's document: its elements as Playwright's aria
 * snapshot reads them in its `ai` mode, a ref (with the frame's prefix) on
 * each element that can be acted on, iframes marked with their place among
 * the frame owners, and the refs kept in the world's map for the verbs that
 * act by them. The world's snapshot state is made on its first call.
 */
export const snapshotFrame: InPageSource<[FrameSnapshotOptions], FrameSnapshot> = {
  declaration: `function snapshotFrame(options) {
  const install = () => (${installSnapshotWorld})(${secretField}, ${JSON.stringify(FIELD_MARKERS)}, ${playwrightCssTokenizer}, ${playwrightDomUtils}, ${playwrightRoleUtils}, ${playwrightAriaSnapshot});
  return (${snapshotWorld})(install).snapshot(options);
}`,
};

/** Called on an iframe element (`this`): its place among the frame owners the latest snapshot of its document met, or null. */
export function frameOwnerKey(this: Element): number | null {
  return (globalThis as SnapshotGlobal).agentHarnessSnapshot?.ownerKey(this) ?? null;
}
