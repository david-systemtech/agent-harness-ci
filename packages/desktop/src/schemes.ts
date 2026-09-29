import { PRODUCT_NAME } from "@agent-harness/contracts";

/**
 * The desktop's schemes (docs/specs/gui.md, "The desktop shell"): the app
 * scheme the renderer loads from, `agent-harness://app/`, whose other hosts
 * are deep links the runtime parses, and the preview scheme.
 */
export const APP_SCHEME = PRODUCT_NAME;
export const APP_HOST = "app";
/** The renderer's origin, which IndexedDB keys its documents by. */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_URL = `${APP_ORIGIN}/`;
/** Content served from memory to a sandboxed frame (the preview's, #410). */
export const PREVIEW_SCHEME = `${PRODUCT_NAME}-preview`;

const parsed = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

/** Whether `url` is one of the renderer's own pages, on the app scheme's `app` host. */
export const isAppPage = (url: string): boolean => {
  const target = parsed(url);
  return target?.protocol === `${APP_SCHEME}:` && target.host === APP_HOST;
};

/** Whether `url` is an http or https link, the only kind the OS's browser is handed. */
export const isWebLink = (url: string): boolean => {
  const protocol = parsed(url)?.protocol;
  return protocol === "http:" || protocol === "https:";
};

/** Whether `url` is on the preview scheme. */
export const isPreview = (url: string): boolean => parsed(url)?.protocol === `${PREVIEW_SCHEME}:`;
