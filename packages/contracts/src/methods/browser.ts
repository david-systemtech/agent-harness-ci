import { z } from "zod";
import { BrowserStatus } from "../browser-status.js";
import { defineMethod } from "../method.js";

/**
 * The browser's methods (browser spec, "Settings, methods, events and
 * notices"; ADR 0014, ADR 0024), each with one scope.
 */

/**
 * The extension's folder, its listener and an unpaired connection, which the
 * Browser card and its health check read. A folder found missing is made
 * again before the answer.
 */
export const browserStatus = defineMethod({
  name: "browser.status",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: BrowserStatus,
  errors: [],
});
