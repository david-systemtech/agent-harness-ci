import type { Terminal } from "@xterm/xterm";

/**
 * xterm.js under the window's content policy (#486; docs/specs/gui.md, "The
 * desktop shell"). The policy takes styles from the app scheme only, so
 * Chromium refuses the text of any `<style>` element a script adds, and
 * xterm.js 6 styles itself with three it adds as it opens: the scroll bar's
 * colours (its viewport's), and its DOM renderer's theme colours and cell
 * sizes, each rewritten as the theme or the size changes. It has no nonce
 * option and no hook. A stylesheet built through the CSSOM is not covered by
 * `style-src`, so the policy stays as it is and xterm's stylesheet text goes
 * into constructed stylesheets the document adopts instead.
 *
 * `openStyled` opens `terminal` in `parent` with the document's
 * `createElement` answering `"style"` with a stand-in for as long as `open`
 * runs, which is when xterm.js makes all three (`Viewport`'s and
 * `DomRenderer`'s constructors; it keeps each and never makes another). The
 * stand-in is a comment, which the document neither draws nor checks
 * against the policy, whose text is its constructed stylesheet's: set, it
 * replaces the sheet's rules; removed (xterm.js disposing), the sheet is
 * let go. Every other element xterm.js makes is the document's own.
 */

/** A stand-in for one of xterm.js's `<style>` elements: a comment whose text is a stylesheet `document` adopts. */
const adoptedStyle = (document: Document): Comment => {
  const sheet = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const node = document.createComment(" xterm.js's stylesheet, adopted by the document ");
  let text = "";
  Object.defineProperty(node, "textContent", {
    configurable: true,
    get: () => text,
    set: (value: string | null) => {
      text = value ?? "";
      sheet.replaceSync(text);
    },
  });
  const remove = node.remove.bind(node);
  node.remove = () => {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
    remove();
  };
  return node;
};

/** Opens `terminal` in `parent` with its stylesheets adopted by the document rather than added as `<style>` elements. */
export const openStyled = (terminal: Terminal, parent: HTMLElement): void => {
  const document = parent.ownerDocument;
  const own = Object.getOwnPropertyDescriptor(document, "createElement");
  const create = document.createElement.bind(document);
  const standing = (tag: string, options?: ElementCreationOptions): HTMLElement =>
    tag.toLowerCase() === "style" ? (adoptedStyle(document) as unknown as HTMLStyleElement) : create(tag, options);
  Object.defineProperty(document, "createElement", { configurable: true, writable: true, value: standing });
  try {
    terminal.open(parent);
  } finally {
    if (own === undefined) delete (document as { createElement?: unknown }).createElement;
    else Object.defineProperty(document, "createElement", own);
  }
};
