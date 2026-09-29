/**
 * The text a page shows, as the shell rule and challenge detection measure
 * it: what is inside the body, less what no reader sees (scripts, styles,
 * templates, the `noscript` fallback, which a browser that runs script never
 * shows, and elements marked `hidden`), with white space collapsed. It reads
 * a fetched page in jsdom as it reads a live one, so it needs no layout.
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** The elements whose content no reader sees. */
const UNSEEN = new Set(["script", "style", "template", "noscript", "head"]);

/**
 * The text under `root`, white space collapsed and trimmed, leaving out
 * what no reader sees and every element `leaveOut` names.
 */
export const shownText = (root: Node, leaveOut: (element: Element) => boolean = () => false): string => {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) parts.push(node.nodeValue ?? "");
    if (node.nodeType !== ELEMENT_NODE && node !== root) return;
    if (node.nodeType === ELEMENT_NODE) {
      const element = node as Element;
      if (UNSEEN.has(element.localName) || element.hasAttribute("hidden") || leaveOut(element)) return;
      // An element's edge separates words, as a block's does on the page: `<p>a</p><p>b</p>` reads `a b`.
      parts.push(" ");
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return parts.join("").replace(/\s+/g, " ").trim();
};
