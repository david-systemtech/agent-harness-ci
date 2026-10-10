import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../../test/cleanups.js";
import { bundledExecutable } from "./executable.js";
import { allowedResult } from "./process.js";

const { tempDir, onCleanup } = useCleanups();
const NOTE = "QUESTION_NOTE_2091: acknowledge only; run no tools.";
const question = {
  question: "Which scope?", header: "Scope", multiSelect: false,
  options: [{ label: "Local", description: "This workspace" }, { label: "Shared", description: "Every workspace" }],
};

/** The pinned SDK and bundled tool implementation, with only the model HTTP boundary scripted: no real account or API. */
describe("a question Note reaching the model", () => {
  it("includes the chosen answer and unique Note in the next model request after a real AskUserQuestion", async () => {
    const root = tempDir("question-note-");
    const requests: unknown[] = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      const body = JSON.parse(raw) as { stream?: boolean };
      requests.push(body);
      const first = requests.length === 1;
      const block = first
        ? { type: "tool_use", id: "toolu_question", name: "AskUserQuestion", input: { questions: [question] } }
        : { type: "text", text: "Acknowledged." };
      const message = {
        id: `msg_${requests.length}`, type: "message", role: "assistant", model: "claude-sonnet-4-6",
        content: [block], stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      };
      if (body.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(message));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("message_start", { message: { ...message, content: [], stop_reason: null } });
      event("content_block_start", { index: 0, content_block: first ? { ...block, input: {} } : { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: first ? { type: "input_json_delta", partial_json: JSON.stringify({ questions: [question] }) } : { type: "text_delta", text: "Acknowledged." } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
      event("message_stop", {});
      response.end();
    });
    onCleanup(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const asked: string[] = [];
    const executable = bundledExecutable();
    const made = query({
      prompt: "Ask which scope to use.",
      options: {
        cwd: root, ...(executable === null ? {} : { pathToClaudeCodeExecutable: executable }),
        model: "claude-sonnet-4-6", tools: ["AskUserQuestion"], settingSources: [], persistSession: false,
        env: { PATH: process.env["PATH"] ?? "", HOME: root, CLAUDE_CONFIG_DIR: root, ANTHROPIC_API_KEY: "token-for-tests", ANTHROPIC_BASE_URL: origin, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        canUseTool: async (tool, input, { toolUseID }) => {
          asked.push(tool);
          return allowedResult(tool, input, { decision: "allow", answers: { "Which scope?": "Local" }, message: NOTE }, [], toolUseID);
        },
      },
    });
    onCleanup(() => made.close());
    const results: unknown[] = [];
    for await (const message of made) if (message.type === "result") results.push(message);
    expect(asked).toEqual(["AskUserQuestion"]);
    expect(results).toEqual([expect.objectContaining({ subtype: "success" })]);
    expect(JSON.stringify(requests.slice(1))).toContain(NOTE);
    expect(JSON.stringify(requests.slice(1))).toContain("Local");
  });
});
