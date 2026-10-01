/**
 * The page driver's in-page functions: what it runs inside a page, always in
 * the isolated world it made for the frame, so the page's own scripts can
 * neither see nor change them (browser spec, "One page driver for three
 * browsers"). Each is sent as its own source text (`Runtime.callFunctionOn`),
 * so each is a plain function declaration that reaches nothing outside
 * itself: no import, no module-scope name, only the page's DOM, its
 * arguments, and the snapshot's state in the world, which finds an element
 * by the ref the latest snapshot gave it (../snapshot/world.ts). Their
 * values come back by value, so each answers plain JSON.
 */

import type { PageArgs } from "@agent-harness/contracts";
import type { SnapshotGlobal } from "../snapshot/world.js";

/** An element an action names: by the ref a snapshot gave it, or by a CSS selector. */
export type ElementTarget = PageArgs<"click">["target"];

/** Where an element a selector names is, as `locateElement` answers it. */
export type LocatedElement =
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "none" }
  /** A ref no element has now: the world's latest snapshot did not give it, or its element left the page. */
  | { readonly kind: "stale" }
  | { readonly kind: "hidden" }
  /** Another element takes a click at its centre: an overlay, a banner; `by` names it as a selector would (`div#banner.cookie`). */
  | { readonly kind: "covered"; readonly by: string }
  | {
      readonly kind: "found";
      /** The centre of the element's part inside the viewport, in the viewport's pixels. */
      readonly x: number;
      readonly y: number;
      /** Whether it takes typed text: a text field, a textarea or an editable element, neither disabled nor read-only. */
      readonly editable: boolean;
    };

/**
 * The element the target names in the frame's document (the first a
 * selector matches, or the one the latest snapshot gave a ref), scrolled
 * into the middle of the viewport, with the centre of its visible part: where
 * a real click lands on it, in the frame's own viewport. An element with no
 * visible part (no size, clipped wholly out of the viewport, or reported not
 * visible) is `hidden`; one another element sits over at that centre, which
 * would take the click, is `covered`, read in the element's own tree, so a
 * shadow root's content is not taken to be covered by its host.
 */
export function locateElement(target: ElementTarget): LocatedElement {
  let element: Element | null;
  if ("ref" in target) {
    element = (globalThis as SnapshotGlobal).agentHarnessSnapshot?.element(target.ref) ?? null;
    if (element === null) return { kind: "stale" };
  } else {
    try {
      element = document.querySelector(target.selector);
    } catch (error) {
      return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
    }
    if (element === null) return { kind: "none" };
  }
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const box = element.getBoundingClientRect();
  const left = Math.max(box.left, 0);
  const top = Math.max(box.top, 0);
  const right = Math.min(box.right, window.innerWidth);
  const bottom = Math.min(box.bottom, window.innerHeight);
  if (right <= left || bottom <= top) return { kind: "hidden" };
  if (typeof element.checkVisibility === "function" && !element.checkVisibility({ visibilityProperty: true })) return { kind: "hidden" };
  const x = (left + right) / 2;
  const y = (top + bottom) / 2;
  // What a click at the centre reaches, read in the element's own tree: the element, or something inside it (a shadow tree's content answers as its host).
  const scope = element.getRootNode() as Document | ShadowRoot;
  const hit = typeof scope.elementFromPoint === "function" ? scope.elementFromPoint(x, y) : null;
  if (hit !== null && hit !== element && !element.contains(hit)) {
    const classes = Array.from(hit.classList, (name) => `.${name}`).join("");
    return { kind: "covered", by: `${hit.localName}${hit.id === "" ? "" : `#${hit.id}`}${classes}` };
  }
  const untypable = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  const editable =
    element instanceof HTMLInputElement
      ? !untypable.includes(element.type) && !element.disabled && !element.readOnly
      : element instanceof HTMLTextAreaElement
        ? !element.disabled && !element.readOnly
        : element instanceof HTMLElement && element.isContentEditable === true;
  return { kind: "found", x, y, editable };
}

/**
 * Focuses the field the target names and selects all it holds, so what is
 * typed next replaces it: an input's or a textarea's value, an editable
 * element's contents. `gone` when nothing matches it any more, or its ref
 * names no element now.
 */
export function selectFieldContents(target: ElementTarget): "selected" | "gone" | "not-editable" {
  const element = "ref" in target ? ((globalThis as SnapshotGlobal).agentHarnessSnapshot?.element(target.ref) ?? null) : document.querySelector(target.selector);
  if (element === null) return "gone";
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus();
    element.select();
    return "selected";
  }
  if (element instanceof HTMLElement && element.isContentEditable === true) {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return "selected";
  }
  return "not-editable";
}

/** Scrolls the element the latest snapshot gave `ref` into the middle of the viewport; `stale` when no element has the ref now. */
export function scrollToElement(ref: string): "scrolled" | "stale" {
  const element = (globalThis as SnapshotGlobal).agentHarnessSnapshot?.element(ref);
  if (element === undefined) return "stale";
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  return "scrolled";
}

/**
 * Whether the element the latest snapshot gave `ref` shows: it has a box,
 * and the browser does not report it hidden; `stale` when no element has the
 * ref now, which it never will again.
 */
export function elementShows(ref: string): "shown" | "hidden" | "stale" {
  const element = (globalThis as SnapshotGlobal).agentHarnessSnapshot?.element(ref);
  if (element === undefined) return "stale";
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return "hidden";
  if (typeof element.checkVisibility === "function" && !element.checkVisibility({ visibilityProperty: true })) return "hidden";
  return "shown";
}

/**
 * Called on an iframe element (`this`): where its frame's viewport starts in
 * the viewport of the document holding it, inside its border and padding, so
 * a point in the frame plus this is the point in its parent.
 */
export function frameOwnerOrigin(this: Element): { x: number; y: number } {
  const box = this.getBoundingClientRect();
  const style = window.getComputedStyle(this);
  return { x: box.left + this.clientLeft + (parseFloat(style.paddingLeft) || 0), y: box.top + this.clientTop + (parseFloat(style.paddingTop) || 0) };
}

/**
 * Whether the frame's document shows `text`: its words in that order, read
 * with white space collapsed and case ignored, in the text a person sees,
 * the text inside open shadow roots included (a Lit app's is all there).
 * What no one sees is left out: scripts, styles, templates, the `noscript`
 * fallback, the fallback inside a frame, a canvas, a video or an object, and
 * an element the browser reports not visible. A block's edge and a line
 * break separate words, as they do on the screen.
 */
export function showsText(text: string): boolean {
  // What never shows its content as text: a frame's, a canvas's and a video's fallback, and an object's while its resource shows.
  const unseen = new Set(["script", "style", "template", "noscript", "head", "iframe", "canvas", "video", "audio", "object"]);
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue ?? "");
      return;
    }
    if (node instanceof Element) {
      if (unseen.has(node.localName)) return;
      // A line break separates the words either side of it, though it is laid out inline.
      if (node.localName === "br") {
        parts.push(" ");
        return;
      }
      if (typeof node.checkVisibility === "function" && !node.checkVisibility({ visibilityProperty: true })) return;
      const block = !window.getComputedStyle(node).display.startsWith("inline");
      if (block) parts.push(" ");
      // A shadow host shows its shadow tree, and a slot the nodes assigned to it, else its own fallback.
      const assigned = node instanceof HTMLSlotElement ? node.assignedNodes({ flatten: true }) : [];
      if (node.shadowRoot !== null) walk(node.shadowRoot);
      else for (const child of assigned.length > 0 ? assigned : Array.from(node.childNodes)) walk(child);
      if (block) parts.push(" ");
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(document.documentElement);
  const normal = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
  return normal(parts.join("")).includes(normal(text));
}

/** The frame's origin's local and session storage, by key; a storage the page may not use reads empty. */
export function readStorage(): { origin: string; local: Record<string, string>; session: Record<string, string> } {
  const read = (storage: () => Storage): Record<string, string> => {
    const entries: Record<string, string> = {};
    try {
      const store = storage();
      for (let index = 0; index < store.length; index++) {
        const key = store.key(index);
        if (key !== null) entries[key] = store.getItem(key) ?? "";
      }
    } catch {
      // An opaque origin, or storage switched off: nothing to read.
    }
    return entries;
  };
  return { origin: location.origin, local: read(() => localStorage), session: read(() => sessionStorage) };
}
