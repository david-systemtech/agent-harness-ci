/**
 * The text a page shows, as the shell rule and challenge detection measure
 * it: what is inside the body, less what no reader sees (scripts, styles,
 * templates, the `noscript` fallback, which a browser that runs script never
 * shows, and elements marked `hidden`), with white space collapsed. It reads
 * a fetched page in jsdom as it reads a live one, so it needs no layout.
 *
 * The module is one function that returns what it holds, so challenge
 * detection runs from its source text in a page's isolated world too
 * (./reader-in-page.ts): it reaches for nothing outside itself.
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

  return { shownText };
}

export const { shownText } = pageTextModule();
