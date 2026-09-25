import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JsonObject } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { HostToolCall, HostToolResult, InProcessToolServer } from "../../adapter/contract.js";
import { TOOL_USE_ID_META, hostToolServer, serverRule } from "./host-tools.js";

/**
 * An in-process tool server as Claude's CLI reaches it (#139): an MCP client
 * connected to the server `hostToolServer` builds, over MCP's in-memory
 * transport, as the SDK connects the CLI to an in-process server. What is
 * asserted is what the CLI would list and what a call reaches.
 */

const WEATHER_SCHEMA = { type: "object", properties: { city: { type: "string", description: "A city." } }, required: ["city"], additionalProperties: false };

/** A server whose tools record every call and answer what `answer` says. */
const serverWith = (external: boolean, answer: (input: JsonObject) => Promise<HostToolResult> = async () => ({ text: "Sunny", isError: false })) => {
  const calls: { readonly input: JsonObject; readonly call: HostToolCall }[] = [];
  const server: InProcessToolServer = {
    name: "client",
    external,
    tools: [
      {
        name: "get_weather",
        description: "The weather in a city.",
        inputSchema: WEATHER_SCHEMA,
        call: (input, call) => {
          calls.push({ input, call });
          return answer(input);
        },
      },
      { name: "ping", description: "", inputSchema: { type: "object", properties: {} }, call: async () => ({ text: "pong", isError: false }) },
    ],
  };
  return { server, calls };
};

const connected = async (server: InProcessToolServer) => {
  const config = hostToolServer(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await config.instance.connect(serverSide);
  const client = new Client({ name: "cli", version: "1.0.0" });
  await client.connect(clientSide);
  return { config, client };
};

describe("an in-process tool server as Claude's in-process MCP server", () => {
  it("is an sdk server under the server's name, listing each tool with its schema exactly as written", async () => {
    const { server } = serverWith(true);
    const { config, client } = await connected(server);
    expect(config).toMatchObject({ type: "sdk", name: "client" });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))).toEqual([
      { name: "get_weather", description: "The weather in a city.", inputSchema: WEATHER_SCHEMA },
      { name: "ping", description: "", inputSchema: { type: "object", properties: {} } },
    ]);
    // An external server's tools touch nothing here: marked read-only, which lets the CLI run several side by side.
    expect(tools.map((tool) => tool.annotations?.readOnlyHint)).toEqual([true, true]);
    await client.close();
  });

  it("marks no tool read-only on a server that is not external", async () => {
    const { client } = await connected(serverWith(false).server);
    expect((await client.listTools()).tools.map((tool) => tool.annotations)).toEqual([undefined, undefined]);
    await client.close();
  });

  it("hands a call its arguments and the tool_use id the CLI names in _meta, and answers what the tool said", async () => {
    const { server, calls } = serverWith(true);
    const { client } = await connected(server);
    const result = await client.callTool({ name: "get_weather", arguments: { city: "Manila" }, _meta: { [TOOL_USE_ID_META]: "toolu_1" } });
    expect(result).toMatchObject({ content: [{ type: "text", text: "Sunny" }] });
    expect(result.isError).toBeUndefined();
    expect(calls).toMatchObject([{ input: { city: "Manila" }, call: { toolCallId: "toolu_1" } }]);
    expect(calls[0]?.call.signal).toBeInstanceOf(AbortSignal);
    // With no id named, the call has none.
    await client.callTool({ name: "get_weather", arguments: { city: "Cebu" } });
    expect(calls[1]?.call.toolCallId).toBeNull();
    await client.close();
  });

  it("answers an error result for a tool that failed, one that threw, and one it does not have", async () => {
    let fail: "error" | "throw" = "error";
    const { server } = serverWith(true, async () => {
      if (fail === "throw") throw new Error("the caller went away");
      return { text: "No such city.", isError: true };
    });
    const { client } = await connected(server);
    expect(await client.callTool({ name: "get_weather", arguments: { city: "Atlantis" } })).toMatchObject({ content: [{ text: "No such city." }], isError: true });
    fail = "throw";
    expect(await client.callTool({ name: "get_weather", arguments: { city: "Atlantis" } })).toMatchObject({ content: [{ text: "The tool get_weather failed: the caller went away" }], isError: true });
    expect(await client.callTool({ name: "nothing", arguments: {} })).toMatchObject({ isError: true });
    await client.close();
  });

  it("names the rule that allows a server's every tool by the server alone", () => {
    expect(serverRule("client")).toBe("mcp__client");
  });
});
