import { describe, expect, it } from "vitest";
import {
  COMPLETIONS_NAMESPACE,
  COMPLETIONS_NAMESPACE_ALIAS,
  ChatCompletionRequest,
  CompletionsExtension,
  MAX_SYSTEM_PROMPT_CHARS,
  MODES,
} from "./index.js";

/**
 * The completions surface's request schemas (claude-adapter spec, "The
 * completions surface", "Testing Decisions": the extension schema rejects a
 * mode outside the four).
 */

describe("the completions extension schema", () => {
  it("is named agent-harness, with artemis as its alias", () => {
    expect(COMPLETIONS_NAMESPACE).toBe("agent-harness");
    expect(COMPLETIONS_NAMESPACE_ALIAS).toBe("artemis");
  });

  it("takes each of the four modes and rejects every other, Claude's default and dontAsk included", () => {
    for (const mode of MODES) expect(CompletionsExtension.safeParse({ permissionMode: mode }).success, mode).toBe(true);
    for (const mode of ["default", "dontAsk", "yolo", "BYPASSPERMISSIONS", ""]) {
      expect(CompletionsExtension.safeParse({ permissionMode: mode }).success, mode).toBe(false);
    }
  });

  it("rejects a mode outside the four under either namespace of a request", () => {
    const base = { model: "opus", messages: [{ role: "user", content: "Hi" }] };
    expect(ChatCompletionRequest.safeParse({ ...base, [COMPLETIONS_NAMESPACE]: { permissionMode: "dontAsk" } }).success).toBe(false);
    expect(ChatCompletionRequest.safeParse({ ...base, [COMPLETIONS_NAMESPACE_ALIAS]: { permissionMode: "default" } }).success).toBe(false);
    expect(ChatCompletionRequest.safeParse({ ...base, [COMPLETIONS_NAMESPACE_ALIAS]: { permissionMode: "plan" } }).success).toBe(true);
  });

  it("caps systemPrompt at 200,000 characters", () => {
    expect(CompletionsExtension.safeParse({ systemPrompt: "x".repeat(MAX_SYSTEM_PROMPT_CHARS) }).success).toBe(true);
    expect(CompletionsExtension.safeParse({ systemPrompt: "x".repeat(MAX_SYSTEM_PROMPT_CHARS + 1) }).success).toBe(false);
  });

  it("keeps the OpenAI parameters it does not name, for the surface to refuse or ignore", () => {
    const parsed = ChatCompletionRequest.parse({ model: "opus", messages: [{ role: "user", content: "Hi" }], temperature: 0.2, user: "hermes" });
    expect(parsed["temperature"]).toBe(0.2);
    expect(parsed["user"]).toBe("hermes");
  });
});
