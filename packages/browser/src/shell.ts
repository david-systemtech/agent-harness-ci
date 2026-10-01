import { pageBody, shownText } from "./page-text.js";

/**
 * The shell rule `web_read` uses (browser spec, "`web_read`"; #292): a
 * fetched page that is an app's shell, whose content its script renders,
 * so reading it without a browser gives next to nothing. `web_read` answers
 * one with a sentence pointing at `browser_open`, never an empty page.
 */

/** Under this many characters of text, a page is next to empty. */
export const SHELL_TEXT_CHARS = 200;

/** A line telling the reader to turn JavaScript on, in the words pages use. */
const ENABLE_JAVASCRIPT =
  /\b(?:enable|turn on|activate|allow)\s+(?:your\s+)?(?:javascript|js)\b|\b(?:javascript|js)\s+(?:is\s+)?(?:required|disabled|(?:must|needs to) be (?:enabled|turned on))|\brequires?\s+javascript\b/i;

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/**
 * Whether `root` holds an app's element with nothing in it yet: a custom
 * element (an HTML element whose name has a hyphen), as a Lit app's root is
 * (Home Assistant's `<home-assistant>`) before its script defines it.
 */
const emptyAppElement = (root: Element): boolean =>
  Array.from(root.querySelectorAll("*")).some((element) => element.namespaceURI === HTML_NAMESPACE && element.localName.includes("-") && shownText(element) === "");

/**
 * Whether `document` is a shell: under 200 characters of text beside a
 * `noscript` element or an "enable JavaScript" line, as a script-rendered
 * app's served page is. A Lit app's shell has neither (its fallback is an
 * empty custom element), so an app's empty element counts beside them. A
 * short real page, with none of the three, is read as it is.
 */
export const isShell = (document: Document): boolean => {
  const body = pageBody(document);
  const text = shownText(body);
  if (text.length >= SHELL_TEXT_CHARS) return false;
  return document.querySelector("noscript") !== null || ENABLE_JAVASCRIPT.test(text) || emptyAppElement(body);
};
