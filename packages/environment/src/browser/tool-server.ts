import type { InProcessToolServer } from "../adapter/contract.js";
import { webReadTool, type WebReader } from "./web-read.js";

/**
 * The `browser` tool server (browser spec, "The tools"): in process, on
 * every run whatever the session's browser, so its tools show as
 * `mcp__browser__<tool>`, a name permission rules and skills can address.
 * It holds `web_read`; the browser verbs join it where a run's resolved
 * browser is not none. Built once per environment: its tools are the same
 * on every run, so a kept provider process serves the next run with it.
 */

export const BROWSER_TOOL_SERVER = "browser";

export const browserToolServer = (reader: WebReader): InProcessToolServer => ({
  name: BROWSER_TOOL_SERVER,
  external: false,
  tools: [webReadTool(reader)],
});
