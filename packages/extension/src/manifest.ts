import { EXTENSION_MANIFEST_KEY, PRODUCT_NAME } from "@agent-harness/contracts";

/**
 * The extension's manifest (browser spec, "The extension, its folder and its
 * listener"; ADR 0024), which the build writes beside the bundles. It
 * carries the fixed id's key, so every machine that loads the folder gives
 * it the id the environment's listener admits; it asks for no host
 * permission, since the worker reaches nothing but its environment on
 * loopback, which its content policy admits; and it names the harness
 * version it was built with as its version name, which the environment
 * reads as the folder's version.
 */

/** The service worker's bundle in the built folder. */
export const WORKER_FILE = "worker.js";

/** The options page in the built folder, whose script is `options.js` beside it. */
export const OPTIONS_PAGE = "options.html";

/**
 * The content policy of the extension's own pages and worker: scripts and
 * everything else from the extension itself, and sockets to loopback, where
 * `bridgeUrl` dials. Reading the port file is a fetch of the extension's
 * own folder, which `'self'` admits.
 */
const CONTENT_POLICY = "default-src 'self'; script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:*";

/** A harness version: semantic versioning's three numbers, then a prerelease and build metadata, if any. */
const HARNESS_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** The largest number Chrome takes in each part of a manifest's version. */
const CHROME_VERSION_PART_MAX = 65_535;

/**
 * Chrome's `version` for a harness version: its three numbers, since the
 * field takes one to four dot-separated integers of at most 65535 and no
 * prerelease (`0.4.0-rc.2` is `0.4.0`). The full harness version is the
 * version name, which is what the extension reports and the environment
 * compares; `version` orders nothing for an unpacked extension.
 */
const chromeVersion = (harnessVersion: string): string => {
  const match = HARNESS_VERSION.exec(harnessVersion);
  if (match === null) throw new Error(`${harnessVersion} is not a harness version: the extension's manifest takes major.minor.patch, with a prerelease if any.`);
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => part > CHROME_VERSION_PART_MAX)) {
    throw new Error(`${harnessVersion} has a number above ${CHROME_VERSION_PART_MAX}, which Chrome's manifest version cannot take.`);
  }
  return parts.join(".");
};

/** The manifest of the extension built with `harnessVersion`. */
export const extensionManifest = (harnessVersion: string) => ({
  manifest_version: 3,
  name: PRODUCT_NAME,
  description: `Lets your ${PRODUCT_NAME} environment on this machine use this Chrome, once you pair it from the options page.`,
  version: chromeVersion(harnessVersion),
  version_name: harnessVersion,
  key: EXTENSION_MANIFEST_KEY,
  // Chrome 116 lets a WebSocket's traffic keep a worker alive, and Chrome 120 lets an alarm fire every 30 seconds.
  minimum_chrome_version: "120",
  background: { service_worker: WORKER_FILE, type: "module" },
  options_ui: { page: OPTIONS_PAGE, open_in_tab: true },
  permissions: ["alarms", "storage"],
  content_security_policy: { extension_pages: CONTENT_POLICY },
});
