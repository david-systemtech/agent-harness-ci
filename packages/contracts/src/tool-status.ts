import { z } from "zod";

/** How a tool call ended, shared by transcript events and tool terminals. */
export const TOOL_STATUSES = ["ok", "error", "cancelled"] as const;
export const ToolStatus = z.enum(TOOL_STATUSES).meta({ description: "How a tool call ended: ok, error, or cancelled." });
export type ToolStatus = z.infer<typeof ToolStatus>;
