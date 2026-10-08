import { act, screen, waitFor, within } from "@testing-library/react";
import { FILE_UNDO_CONFLICT_REASONS, type SessionDiffFile } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

const CHANGE = "0199aa00-0000-4000-8000-000000000002";
const opened = async (options: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Undo", workspace: { kind: "directory", path: "/work/receipts" } }], capabilities: ["fileUndo"], ...options }] });
  app.open("desk");
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  return { app, env: app.environment("desk"), transcript, session: app.environment("desk").sessionId() };
};
const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const write = async (app: RenderedApp, keys: string) => {
  act(() => box().focus());
  await app.user.keyboard(keys);
};

describe("GUI file undo", () => {
  it.each(["restored", "deleted"] as const)("submits typed undo once for the focused Session and draws the shared %s row", async (action) => {
    const { app, env, transcript, session } = await opened();
    env.wire.answer("files.undo", () => {
      const result = { changeId: CHANGE, path: "src/app.ts", action };
      const event = env.emit(session, "files.undo-finished", result);
      return { result: { receipt: { status: "accepted", sequence: event.sequence, changed: true }, result } };
    });
    await write(app, "/undo{Escape}{Enter}");
    await within(transcript).findByText(`File undo: ${action} src/app.ts.`);
    expect(env.requests("files.undo").map((request) => request.params)).toEqual([{ sessionId: session, commandId: expect.any(String) }]);
    expect(env.requests("runs.start")).toEqual([]);
    expect(env.requests("sessions.undoRewind")).toEqual([]);
    await waitFor(() => expect(box().value).toBe(""));
  });
  it("runs undo from slash selection without sending a prompt", async () => {
    const { app, env, transcript, session } = await opened();
    env.wire.answer("files.undo", () => {
      const result = { changeId: CHANGE, path: "new.ts", action: "deleted" as const };
      const event = env.emit(session, "files.undo-finished", result);
      return { result: { receipt: { status: "accepted", sequence: event.sequence, changed: true }, result } };
    });
    await write(app, "/un");
    await app.user.click(await screen.findByRole("option", { name: /\/undo/ }));
    await within(transcript).findByText("File undo: deleted new.ts.");
    expect(env.requests("files.undo")).toHaveLength(1);
    expect(env.requests("runs.start")).toEqual([]);
  });

  it.each(["Keep this thought", "/undo"])("keeps draft %s when palette undo succeeds", async (draft) => {
    const { app, env, transcript, session } = await opened({ sessions: [{ title: "Undo", draft }] });
    await waitFor(() => expect(box().value).toBe(draft));
    env.wire.answer("files.undo", () => {
      const result = { changeId: CHANGE, path: "src/app.ts", action: "restored" as const };
      const event = env.emit(session, "files.undo-finished", result);
      return { result: { receipt: { status: "accepted", sequence: event.sequence, changed: true }, result } };
    });
    await write(app, "{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    await app.user.click(within(palette).getByRole("option", { name: /^\/undo/ }));
    await within(transcript).findByText("File undo: restored src/app.ts.");
    expect(box().value).toBe(draft);
    expect(env.requests("files.undo")).toHaveLength(1);
    expect(env.requests("runs.start")).toEqual([]);
  });

  it.each([
    [{ capabilities: [] }, "desk runs an older agent-harness without this. Update desk to use it."],
    [{ scopes: ["read", "sessions:write", "runs:drive"] }, "This app has limited access to desk, so it cannot use terminals or files. Pair again with full access to change this."],
  ] satisfies [Partial<ScriptedEnvironment>, string][])("dims unavailable undo with the shared capability reason", async (options, reason) => {
    const { app, env } = await opened(options);
    await write(app, "/undo");
    const option = await screen.findByRole("option", { name: /\/undo/ });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain(reason);
    expect(app.runtime.capability(env.environmentId, "files.undo")).toMatchObject({ status: "absent", message: reason });
    await write(app, "{Enter}");
    await screen.findByText(`Cannot undo file change: ${reason}`);
    expect(box().value).toBe("/undo");
    expect(env.requests("files.undo")).toEqual([]);
    expect(env.requests("runs.start")).toEqual([]);
  });
  it.each(FILE_UNDO_CONFLICT_REASONS)("keeps the command and saved draft on a %s refusal", async (reason) => {
    const { app, env, transcript, session } = await opened({ sessions: [{ title: "Undo", draft: "Keep this thought" }] });
    await waitFor(() => expect(box().value).toBe("Keep this thought"));
    env.wire.answer("files.undo", () => ({ result: { receipt: { status: "rejected", sequence: 4, changed: false, reason: "conflict", error: { code: "conflict", message: `Undo refused: ${reason}.`, data: { reason } } } } }));
    await write(app, "{Control>}a{/Control}/undo{Escape}{Enter}");
    await screen.findByText(`Cannot undo file change: Undo refused: ${reason}.`);
    expect(box().value).toBe("/undo");
    expect(env.summary(session).draft).toBe("Keep this thought");
    expect(env.requests("files.undo")).toHaveLength(1);
    expect(env.requests("sessions.setDraft")).toEqual([]);
    expect(env.requests("runs.start")).toEqual([]);
    expect(env.requests("sessions.undoRewind")).toEqual([]);
    expect(within(transcript).queryByText(/^File undo:/)).toBeNull();
  });

  it("dims unreachable undo and refuses it without queuing or discarding the composer", async () => {
    const { app, env } = await opened();
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await screen.findByText("Locked: desk cannot be reached.");
    await write(app, "/undo");
    const option = await screen.findByRole("option", { name: /\/undo/ });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain("desk cannot be reached.");
    await write(app, "{Enter}");
    await screen.findByText("Cannot undo file change: desk cannot be reached.");
    expect(box().value).toBe("/undo");
    expect(env.requests("files.undo")).toEqual([]);
    expect(env.requests("runs.start")).toEqual([]);
  });

  it.each(["receipt", "event"] as const)("refreshes visible diffs through the shared runtime on an undo %s", async (source) => {
    const changed: { files: SessionDiffFile[] } = { files: [{ path: "src/app.ts", diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-before\n+after\n", changes: [] }] };
    const tree = { diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-before\n+after\n" };
    const { app, env, transcript, session } = await opened({ sessionDiff: changed, workingTree: tree });
    await write(app, "/diff{Enter}");
    const diff = screen.getByRole("region", { name: "Diff" });
    await within(diff).findByRole("article", { name: "src/app.ts" });
    await within(diff).findAllByText((_, element) => element?.textContent === "+after");
    const result = { changeId: CHANGE, path: "src/app.ts", action: "restored" as const };
    const consume = () => { changed.files = []; tree.diff = ""; };
    if (source === "receipt") {
      env.wire.answer("files.undo", () => {
        consume();
        return { result: { receipt: { status: "accepted", sequence: 4, changed: true }, result } };
      });
      await write(app, "/undo{Enter}");
      await screen.findByText("File undo: restored src/app.ts.");
    } else {
      consume();
      env.emit(session, "files.undo-finished", result, { actor: { kind: "client_session", id: "another-client" } });
      await within(transcript).findByText("File undo: restored src/app.ts.");
    }
    await within(diff).findByText("Nothing yet.");
    await within(diff).findByText("Nothing changed.");
    expect(within(diff).queryByRole("article", { name: "src/app.ts" })).toBeNull();
    expect(env.requests("diffs.session")).toHaveLength(2);
    expect(env.requests("diffs.workingTree")).toHaveLength(2);
    expect(env.requests("files.undo")).toHaveLength(source === "receipt" ? 1 : 0);
  });

});
