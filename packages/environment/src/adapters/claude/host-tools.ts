import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject } from "@agent-harness/contracts";
import { inProcessToolName, type InProcessToolServer } from "../../adapter/contract.js";

/**
 * An in-process tool server (#139: the completions surface's client tools)
 * as the SDK's in-process MCP server. The SDK's own `createSdkMcpServer`
 * takes each tool's input as a zod shape, which a caller's JSON Schema is
 * not, so the server answers MCP's two tool requests itself: the listing
 * hands the model each tool's schema exactly as written, and a call goes to
 * the tool's `call` with the id the CLI gives it in the request's `_meta`
 * (`claudecode/toolUseId`, the `tool_use` block's id the transcript's
 * `tool.started` carries) and the request's abort signal. An external
 * server's tools are marked read-only (`readOnlyHint`), which is what lets
 * the CLI run several of them side by side, as it runs any concurrency-safe
 * tool; they touch nothing on the environment.
 */

/** The `_meta` key under which the CLI names the `tool_use` block a tool server's call answers. */
export const TOOL_USE_ID_META = "claudecode/toolUseId";

/** The permission rule that lets every tool of a server go ahead without asking: the server's own name, as the CLI's rules take it. */
export const serverRule = (server: string): string => inProcessToolName(server, "").replace(/__$/, "");

export const hostToolServer = (server: InProcessToolServer): McpSdkServerConfigWithInstance => {
  const mcp = new McpServer({ name: server.name, version: "1.0.0" }, { capabilities: { tools: {} } });
  const tools = new Map(server.tools.map((tool) => [tool.name, tool]));
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: server.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { ...tool.inputSchema, type: "object" as const },
      ...(server.external && { annotations: { readOnlyHint: true } }),
    })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const tool = tools.get(request.params.name);
    if (tool === undefined) return { content: [{ type: "text", text: `The server ${server.name} has no tool ${request.params.name}.` }], isError: true };
    const id = request.params._meta?.[TOOL_USE_ID_META];
    try {
      const result = await tool.call((request.params.arguments ?? {}) as JsonObject, { toolCallId: typeof id === "string" && id !== "" ? id : null, signal: extra.signal });
      return { content: [{ type: "text", text: result.text }], ...(result.isError && { isError: true }) };
    } catch (error) {
      return { content: [{ type: "text", text: `The tool ${tool.name} failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });
  return { type: "sdk", name: server.name, instance: mcp };
};
