import type { ExtensionChrome } from "./chrome.js";
import { startOptionsPage } from "./options-page.js";
import { ownFileReader } from "./port.js";

/** Chrome's own, of which the page uses the part `ExtensionChrome` types. */
declare const chrome: ExtensionChrome;

// The options page's script, a module, so it runs once the page's markup is parsed.
void startOptionsPage(document, { chrome, readOwnFile: ownFileReader(chrome, (url, init) => fetch(url, init)) });
