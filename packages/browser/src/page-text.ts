/**
 * The text a page shows, as the shell rule and challenge detection measure
 * it: what is inside the body, less what no reader sees (scripts, styles,
 * templates, the `noscript` fallback, which a browser that runs script never
 * shows, and elements marked `hidden`), with white space collapsed. It reads
 * a fetched page in jsdom as it reads a live one, so it needs no layout.
 * And the body itself, where every reader of a page starts, the snapshot's
 * among them.
 *
 * The module is one function that returns what it holds, so challenge
 * detection and the snapshot run from its source text in a page's isolated
 * world too (./reader-in-page.ts, ./snapshot/in-page.ts): it reaches for
 * nothing outside itself.
 */

/** The page-text helpers, made afresh wherever they run: on jsdom, or in a page's isolated world. */
export function pageTextModule() {
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;

  /** The elements whose content no reader sees. */
  const UNSEEN = new Set(["script", "style", "template", "noscript", "head"]);

  /**
   * The text under `root`, white space collapsed and trimmed, leaving out
   * what no reader sees and every element `leaveOut` names.
   */
  const shownText = (root: Node, leaveOut: (element: Element) => boolean = () => false): string => {
    const parts: string[] = [];
    const shown = (element: Element): boolean => !UNSEEN.has(element.localName) && !element.hasAttribute("hidden") && !leaveOut(element);
    const walk = (node: Node): void => {
      if (node.nodeType === TEXT_NODE) parts.push(node.nodeValue ?? "");
      else if (node.nodeType === ELEMENT_NODE ? shown(node as Element) : node === root) {
        // An element's edge separates words, as a block's does on the page: `<p>a</p><p>b</p>` reads `a b`.
        parts.push(" ");
        for (const child of Array.from(node.childNodes)) walk(child);
      }
    };
    walk(root);
    return parts.join("").replace(/\s+/g, " ").trim();
  };

  /**
   * The element a reader of `document` starts from: its body, or its root
   * element where it has none. The body is read through the `body` getter
   * on the document's prototype chain, never as `document.body`: a page's
   * element named `body` takes the document's own member's place (HTML's
   * named properties, #1052). The chain is walked rather than
   * `Document.prototype` named, since Node has no global `Document` and a
   * jsdom document's getter is its own realm's.
   */
  const pageBody = (document: Document): Element => {
    for (let prototype = Object.getPrototypeOf(document) as object | null; prototype !== null; prototype = Object.getPrototypeOf(prototype) as object | null) {
      const getter = Object.getOwnPropertyDescriptor(prototype, "body")?.get;
      if (getter !== undefined) return (getter.call(document) as HTMLElement | null) ?? document.documentElement;
    }
    return document.documentElement;
  };

  return { shownText, pageBody };
}

export const { shownText, pageBody } = pageTextModule();
