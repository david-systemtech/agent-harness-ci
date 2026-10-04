import { WebBrowserSurface } from "../browser/web-browser-pane.js";
import type { WebModule } from "./web-registrations.js";

/** Open only ordinary web pages, in a separate tab with no access to this client. */
export const openBrowserPage = (address: string, view: Pick<Window, "open"> = window): void => {
  const typed = address.trim();
  const hostWithPort = /^[^/?#]+:\d+(?:[/?#]|$)/.test(typed);
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(typed) && !hostWithPort;
  const url = new URL(hasScheme ? typed : `https://${typed}`);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Enter an HTTP or HTTPS page address without credentials.");
  view.open(url.href, "_blank", "noopener,noreferrer");
};

export const webModule: WebModule = { slot: "browser", registration: { Surface: WebBrowserSurface } };
