import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deleteSession, query, type SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../../test/cleanups.js";
import { createConfigDirQueue } from "./config-dir-queue.js";

/** The pinned SDK's deletion and persistence policy, with real files and no provider process or network. */
const { tempDir } = useCleanups();
const SESSION = "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a";
const OTHER = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

const localCopy = (directory: string, sessionId: string): string => {
  const project = join(directory, "projects", "test-project");
  const results = join(project, sessionId, "tool-results");
  mkdirSync(results, { recursive: true });
  writeFileSync(join(project, `${sessionId}.jsonl`), `${JSON.stringify({ type: "user", sessionId, message: { role: "user", content: "Screenshot" } })}\n`);
  const image = join(results, "mcp-browser-blob-1-test.png");
  writeFileSync(image, "image-for-tests");
  return image;
};

describe("the pinned SDK's tool image copies (#622)", () => {
  it("deletes the transcript's nested tool-results along with its local session, leaving another session's image alone", async () => {
    const directory = tempDir();
    const image = localCopy(directory, SESSION);
    const other = localCopy(directory, OTHER);

    await createConfigDirQueue().run(directory, () => deleteSession(SESSION));

    expect(existsSync(image)).toBe(false);
    expect(existsSync(join(directory, "projects", "test-project", `${SESSION}.jsonl`))).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("image-for-tests");
  });

  it("deletes only the external store's entries when given a session store, leaving the local image copy", async () => {
    const directory = tempDir();
    const image = localCopy(directory, SESSION);
    const deleted: string[] = [];
    const store: SessionStore = {
      append: async () => undefined,
      load: async () => null,
      delete: async (key) => { deleted.push(key.sessionId); },
    };

    await createConfigDirQueue().run(directory, () => deleteSession(SESSION, { sessionStore: store }));

    expect(deleted).toEqual([SESSION]);
    expect(readFileSync(image, "utf8")).toBe("image-for-tests");
  });

  it("refuses to disable local persistence while mirroring to a session store", () => {
    const store: SessionStore = { append: async () => undefined, load: async () => null };
    expect(() => query({ prompt: "Screenshot", options: { sessionStore: store, persistSession: false } })).toThrow(/sessionStore cannot be used with persistSession: false/);
  });
});
