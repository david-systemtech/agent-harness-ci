import { describe, expect, it } from "vitest";
import { draftsAfterAnswer, type QueuedCommand } from "./rules.js";

// The draft revision rule on the client's side (#2207).
const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const draft = (commandId: string, baseRevision: number | undefined, fields: Partial<QueuedCommand> = {}): QueuedCommand => ({
  commandId,
  method: "sessions.setDraft",
  target: { kind: "session", id: sessionId },
  params: { sessionId, draft: `typed ${commandId}`, ...(baseRevision !== undefined && { baseRevision }) },
  state: "queued",
  ...fields,
});
const answered = (sent: string | null, baseRevision?: number) => ({ sessionId, draft: sent, ...(baseRevision !== undefined && { baseRevision }) });
const summary = (stored: string | null, draftRevision: number) => ({ summary: { id: sessionId, draft: stored, draftRevision } });

describe("drafts queued behind an answered sessions.setDraft", () => {
  it("drops a stale queued draft when the one answered was dropped, and keeps one on a newer base", () => {
    const queued = [draft("stale", 0), draft("newer", 2), draft("unconditional", undefined)];
    expect(draftsAfterAnswer(answered("A's replay", 0), summary("B's newer draft", 2), queued)).toEqual({ drop: ["stale"], rebase: new Map() });
  });

  it("rebases a queued draft onto the answer's revision when the one answered was written, so its own next draft is not stale", () => {
    expect(draftsAfterAnswer(answered("one", 4), summary("one", 5), [draft("next", 4)])).toEqual({ drop: [], rebase: new Map([["next", 5]]) });
    // An empty draft sent is none stored: written all the same.
    expect(draftsAfterAnswer(answered("", 4), summary(null, 5), [draft("next", 4)])).toEqual({ drop: [], rebase: new Map([["next", 5]]) });
  });

  it("leaves everything when the answered draft had no base, the answer no summary, or nothing of the session waits", () => {
    const queued = [draft("next", 0)];
    const none = { drop: [], rebase: new Map() };
    expect(draftsAfterAnswer(answered("old client"), summary("B", 2), queued)).toEqual(none);
    expect(draftsAfterAnswer(answered("A", 0), undefined, queued)).toEqual(none);
    expect(draftsAfterAnswer(answered("A", 0), summary("B", 2), [draft("other", 0, { target: { kind: "session", id: "another" } }), draft("sent", 0, { state: "sent" })])).toEqual(none);
    expect(draftsAfterAnswer(answered("A", 0), summary("B", 2), [{ ...draft("rename", 0), method: "sessions.rename" }])).toEqual(none);
  });
});
