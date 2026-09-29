import type { ElectronContents, RequestListener } from "./electron.js";
import { APP_SCHEME, isAppPage, isPreview, isWebLink } from "./schemes.js";

/**
 * Two of the window's four hardening layers (docs/specs/gui.md, "The
 * desktop shell"); the sandbox and the content policy are the others.
 */

/**
 * Navigation stays on the app scheme: a link elsewhere, followed or opened
 * in a new window, is refused, and an http or https one handed to the OS's
 * browser. Any other is dropped.
 */
export const lockNavigation = (contents: ElectronContents, openExternal: (url: string) => void): void => {
  contents.on("will-navigate", (details) => {
    if (isAppPage(details.url)) return;
    details.preventDefault();
    if (isWebLink(details.url)) openExternal(details.url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebLink(url)) openExternal(url);
    return { action: "deny" };
  });
};

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/** A declared address's WebSocket origin: `http://host:port` is `ws://host:port`, `https:` is `wss:`. */
const socketOrigin = (address: string): string => {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new TypeError(`network.allow takes http and https addresses, and ${JSON.stringify(address)} is not one.`);
  }
  if (!isWebLink(url.href)) throw new TypeError(`network.allow takes http and https addresses, and ${JSON.stringify(address)} is not one.`);
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
};

/** The WebSocket lockdown's side the renderer reaches, through the shell's `network.allow`. */
export interface NetworkLockdown {
  /** Declares the whole list of addresses the renderer may open a WebSocket to, replacing the last. */
  allow(addresses: readonly string[]): void;
}

/**
 * Chromium's requests are cancelled unless they go to the app scheme's
 * `app` host, the preview scheme, or a WebSocket to an address the renderer
 * declared (its connections') or to loopback, where this machine's
 * environment listens. HTTP to an environment is the shell's `http`, made
 * outside Chromium. DevTools' own frontend (`devtools:`) runs in the
 * window's profile and passes too: no page can load it.
 */
export const lockNetwork = (webRequest: { onBeforeRequest(listener: RequestListener): void }): NetworkLockdown => {
  let declared: ReadonlySet<string> = new Set();
  const permitted = (address: string): boolean => {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return false;
    }
    if (url.protocol === `${APP_SCHEME}:`) return isAppPage(address);
    if (isPreview(address) || url.protocol === "devtools:") return true;
    if (url.protocol === "ws:" || url.protocol === "wss:") return LOOPBACK.test(url.hostname) || declared.has(`${url.protocol}//${url.host}`);
    return false;
  };
  webRequest.onBeforeRequest((details, answer) => answer({ cancel: !permitted(details.url) }));
  return {
    allow(addresses) {
      declared = new Set(addresses.map(socketOrigin));
    },
  };
};
