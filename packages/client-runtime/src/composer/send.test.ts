import type { AdapterCapabilities } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { attachmentRefusal, attachmentRefused, isLive, lockOf } from "./send.js";

/** Sending: the lock, a live run, and what the provider cannot take (docs/specs/tui.md, "The composer"; docs/specs/gui.md, "A session pane"). */

describe("sending", () => {
  it("locks the composer with the runtime's line when runs.send is absent", () => {
    expect(lockOf({ status: "present" })).toEqual({ locked: false });
    expect(lockOf({ status: "absent", reason: "unreachable", message: "desk cannot be reached." })).toEqual({ locked: true, reason: "desk cannot be reached." });
  });

  it("counts a run starting, running or parked as live", () => {
    expect(["starting", "running", "parked"].every((state) => isLive(state as never))).toBe(true);
    expect(["idle", "ended", "interrupted", undefined].some((state) => isLive(state as never))).toBe(false);
  });

  it("refuses an attachment the session's provider cannot take, once it is known", () => {
    const provider = { displayName: "Claude", imageInput: true, fileInput: false } as AdapterCapabilities;
    const image = { kind: "image" as const, name: "a.png", mediaType: "image/png", data: "" };
    const file = { kind: "file" as const, name: "a.pdf", mediaType: "application/pdf", data: "" };
    expect(attachmentRefusal({ text: "x", attachments: [image] }, provider)).toBeUndefined();
    expect(attachmentRefusal({ text: "x", attachments: [file] }, provider)).toBe("Claude takes images but no other files: nothing was sent.");
    expect(attachmentRefusal({ text: "x", attachments: [image] }, { ...provider, imageInput: false, fileInput: true })).toBe("Claude takes no images: nothing was sent.");
    expect(attachmentRefusal({ text: "x", attachments: [image] }, { ...provider, imageInput: false })).toBe("Claude takes no attachments: nothing was sent.");
    expect(attachmentRefusal({ text: "x", attachments: [file] }, undefined)).toBeUndefined();
    expect(attachmentRefusal({ text: "x", attachments: [file] }, { ...provider, imageInput: false })).toBe("Claude takes no attachments: nothing was sent.");
  });

  it("refuses one attachment as it is added, by name, when the session's provider cannot take its kind", () => {
    const provider = { displayName: "Claude", imageInput: true, fileInput: false } as AdapterCapabilities;
    const image = { kind: "image" as const, name: "a.png", mediaType: "image/png", data: "" };
    const file = { kind: "file" as const, name: "notes.pdf", mediaType: "application/pdf", data: "" };
    expect(attachmentRefused(image, provider)).toBeUndefined();
    expect(attachmentRefused(file, provider)).toBe("Claude takes images but no other files: notes.pdf was not attached.");
    expect(attachmentRefused(image, { ...provider, imageInput: false, fileInput: true })).toBe("Claude takes no images: a.png was not attached.");
    expect(attachmentRefused(file, undefined)).toBeUndefined();
  });
});
