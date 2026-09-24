import { describe, expect, it } from "vitest";
import { createConfigDirQueue } from "./config-dir-queue.js";
import { readStoredSession, resolveForkPoint, resolveRewindPoint, type StoredMessage } from "./history.js";

/**
 * Where a fork from a message or a rewind re-enters the stored chain
 * (claude-adapter spec, "Queue, read-now, fork and rewind on the Claude
 * adapter"; Artemis's `resolveRewindPoint`, ported): the entry before the
 * user message, and the drop acknowledgement only when everything after it
 * is that one turn's.
 */

const user = (uuid: string, content: unknown): StoredMessage => ({ type: "user", uuid, message: { role: "user", content } });
const assistant = (uuid: string): StoredMessage => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text: "..." }] } });

const chain: StoredMessage[] = [
  user("p1", "First prompt"),
  assistant("a1"),
  user("p2", "Second prompt"),
  assistant("a2"),
  user("r2", [{ type: "tool_result", tool_use_id: "t", content: "ok" }]),
  assistant("a3"),
];

describe("the rewind point", () => {
  it("re-enters at the entry before the prompt and declares the turn it drops when the rest is that turn", () => {
    expect(resolveRewindPoint(chain, "p2")).toEqual({ resumeSessionAt: "a1", dropsTurn: "p2" });
  });

  it("counts the interrupt marker as the turn's own", () => {
    const stopped = [...chain.slice(0, 4), user("m", [{ type: "text", text: "[Request interrupted by user]" }])];
    expect(resolveRewindPoint(stopped, "p2")).toEqual({ resumeSessionAt: "a1", dropsTurn: "p2" });
  });

  it("declares nothing when another exchange follows, and lets the provider truncate unvalidated", () => {
    const deeper = [...chain, user("p3", "Third"), assistant("a4")];
    expect(resolveRewindPoint(deeper, "p2")).toEqual({ resumeSessionAt: "a1" });
    const notified = [...chain, user("n", "<task-notification><task-id>t</task-id></task-notification>"), assistant("a5")];
    expect(resolveRewindPoint(notified, "p2")).toEqual({ resumeSessionAt: "a1" });
  });

  it("has no point for the first message or one not in the chain", () => {
    expect(resolveRewindPoint(chain, "p1")).toBeNull();
    expect(resolveRewindPoint(chain, "missing")).toBeNull();
  });

  it("forks from the entry before an anchored prompt, dropping nothing", () => {
    expect(resolveForkPoint(chain, "p2")).toEqual({ resumeSessionAt: "a1" });
    expect(resolveForkPoint(chain, "p1")).toBeNull();
  });
});

describe("reading the stored session", () => {
  it("reads through the session helper under the account's directory, from the store when there is one", async () => {
    const env: Record<string, string | undefined> = {};
    const seen: { sessionId: string; options: unknown; directory: string | undefined }[] = [];
    const messages = await readStoredSession({
      queue: createConfigDirQueue(env),
      directory: "/data/accounts/work",
      providerSessionId: "provider-1",
      sessionStore: null,
      getSessionMessages: async (sessionId, options) => {
        seen.push({ sessionId, options, directory: env["CLAUDE_CONFIG_DIR"] });
        return [{ type: "user", uuid: "p1", session_id: "provider-1", message: {}, parent_tool_use_id: null, parent_agent_id: null }];
      },
    });
    expect(messages).toEqual([{ type: "user", uuid: "p1", message: {} }]);
    expect(seen).toEqual([{ sessionId: "provider-1", options: {}, directory: "/data/accounts/work" }]);
  });
});
