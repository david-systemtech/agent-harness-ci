import type { FieldAttributes, SecretField } from "../redaction.js";
import type { AriaSnapshotJSON } from "./vendor/aria-types.js";
import type { playwrightAriaSnapshot } from "./vendor/aria-snapshot.js";
import type { playwrightCssTokenizer } from "./vendor/css-tokenizer.js";
import type { playwrightDomUtils } from "./vendor/dom-utils.js";
import type { playwrightRoleUtils } from "./vendor/role-utils.js";

/**
 * The snapshot's state in a frame's isolated world (browser spec, "The
 * tools": refs live in a map in the isolated world): the vendored aria
 * snapshot, made once for the world's document, and the refs its latest
 * snapshot gave, so the code that assigns a ref is the code that resolves
 * it. The page's own scripts can neither see nor change it. Everything here
 * runs from its source text (./in-page.ts), so it reaches nothing outside
 * itself but its arguments and the page's DOM.
 */

/** What a snapshot of one frame is asked: the frame's ref prefix, and the least number a new ref may take. */
export interface FrameSnapshotOptions {
  /** Empty for the page's top frame, `f1` and so on for the others. */
  readonly prefix: string;
  readonly firstRef: number;
}

/** One frame's snapshot: its elements as a tree, and the highest ref number its world has given. */
export interface FrameSnapshot {
  readonly nodes: AriaSnapshotJSON;
  readonly lastRef: number;
}

/** The snapshot's state in one isolated world. */
export interface SnapshotWorld {
  /** Snapshots the frame's document, replacing the refs the world holds with the ones it gives. */
  snapshot(options: FrameSnapshotOptions): FrameSnapshot;
  /** The element the latest snapshot gave `ref`, while it is still on the page. */
  element(ref: string): Element | undefined;
  /** An iframe's place among the frame owners the latest snapshot met, by which its frame is stitched in. */
  ownerKey(element: Element): number | undefined;
}

/** The isolated world's global, where its snapshot state lives. */
export interface SnapshotGlobal {
  agentHarnessSnapshot?: SnapshotWorld;
}

/** The values the serialiser writes for a field that is never read, by why. */
export type FieldMarkers = { readonly [K in SecretField]: string };

/**
 * Makes the world's snapshot state from the vendored modules, each made
 * afresh in this world: a field the rule names gives its marker, and its
 * value is never read.
 */
export function installSnapshotWorld(
  secretField: (field: FieldAttributes) => SecretField | null,
  markers: FieldMarkers,
  cssTokenizer: typeof playwrightCssTokenizer,
  domUtils: typeof playwrightDomUtils,
  roleUtils: typeof playwrightRoleUtils,
  ariaSnapshot: typeof playwrightAriaSnapshot,
): SnapshotWorld {
  const secretValue = (element: Element): string | null => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return null;
    const secret = secretField({ type: element.type, autocomplete: element.getAttribute("autocomplete") });
    return secret === null ? null : markers[secret];
  };
  const dom = domUtils();
  const aria = ariaSnapshot(dom, roleUtils(cssTokenizer(), dom, secretValue), secretValue);
  let refs = new Map<string, Element>();
  let owners: Element[] = [];
  let lastRef = 0;
  return {
    snapshot({ prefix, firstRef }) {
      const root = document.body ?? document.documentElement;
      const tree = aria.generateAriaTree(root, { refPrefix: prefix, firstRef });
      refs = new Map([...tree.info].map(([ref, { element }]) => [ref, element]));
      owners = tree.frameOwners;
      for (const ref of refs.keys()) lastRef = Math.max(lastRef, Number(ref.slice(ref.lastIndexOf("e") + 1)));
      return { nodes: aria.renderAriaTreeAsJSON(tree, { refPrefix: prefix }), lastRef };
    },
    element(ref) {
      const element = refs.get(ref);
      return element?.isConnected ? element : undefined;
    },
    ownerKey(element) {
      const key = owners.indexOf(element);
      return key === -1 ? undefined : key;
    },
  };
}

/** Puts the snapshot state `install` makes on the world's global, unless the world has it already. */
export function snapshotWorld(install: () => SnapshotWorld): void {
  (globalThis as SnapshotGlobal).agentHarnessSnapshot ??= install();
}
