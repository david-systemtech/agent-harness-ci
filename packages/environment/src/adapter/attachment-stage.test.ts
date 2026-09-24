import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { createAttachmentStage } from "./attachment-stage.js";
import type { AttachmentData } from "./contract.js";

/**
 * The attachment stage on disk (claude-adapter spec, #185's notes): the
 * bytes of a queued message's attachments, one file per attachment under a
 * directory named by the message's id, written whole or not at all and read
 * back against the log's record of them.
 */

const { tempDir } = useCleanups();

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text));

const image: AttachmentData = { kind: "image", name: "screen.png", mediaType: "image/png", data: bytes("pixels") };
const file: AttachmentData = { kind: "file", name: "notes.txt", mediaType: "text/plain", data: bytes("some notes") };

/** The log's record of an attachment: what `message.sent` keeps of it. */
const recordOf = ({ kind, name, mediaType, data }: AttachmentData) => ({ kind, name, mediaType, size: data.byteLength });

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe("the attachment stage", () => {
  it("writes each attachment's bytes to <directory>/<messageId>/<index> and reads them back with the log's record", () => {
    const directory = join(tempDir(), "attachments");
    const stage = createAttachmentStage(directory);
    const messageId = randomUUID();
    stage.write(messageId, [image, file]);

    expect(readdirSync(join(directory, messageId)).sort()).toEqual(["0", "1"]);
    expect(readFileSync(join(directory, messageId, "0"), "utf8")).toBe("pixels");
    expect(readFileSync(join(directory, messageId, "1"), "utf8")).toBe("some notes");
    expect(stage.list()).toEqual([messageId]);
    const read = stage.read(messageId, [recordOf(image), recordOf(file)]);
    expect(read?.map((attachment) => ({ ...attachment, data: Buffer.from(attachment.data).toString() }))).toEqual([
      { kind: "image", name: "screen.png", mediaType: "image/png", data: "pixels" },
      { kind: "file", name: "notes.txt", mediaType: "text/plain", data: "some notes" },
    ]);
  });

  it.skipIf(process.platform === "win32")("keeps its directories to their owner, 0700, and its files 0600", () => {
    const directory = join(tempDir(), "attachments");
    const stage = createAttachmentStage(directory);
    const messageId = randomUUID();
    stage.write(messageId, [image]);
    expect(modeOf(directory)).toBe(0o700);
    expect(modeOf(join(directory, messageId))).toBe(0o700);
    expect(modeOf(join(directory, messageId, "0"))).toBe(0o600);
  });

  it("replaces what a message had staged when it is staged again", () => {
    const stage = createAttachmentStage(join(tempDir(), "attachments"));
    const messageId = randomUUID();
    stage.write(messageId, [image, file]);
    stage.write(messageId, [file]);
    expect(stage.read(messageId, [recordOf(file)])?.map((attachment) => attachment.name)).toEqual(["notes.txt"]);
    expect(stage.read(messageId, [recordOf(image), recordOf(file)])).toBeUndefined();
  });

  it("throws, leaving nothing behind, when the bytes cannot be written", () => {
    const root = tempDir();
    // A file where its directory should be: nothing can be written under it.
    writeFileSync(join(root, "attachments"), "in the way");
    const stage = createAttachmentStage(join(root, "attachments"));
    expect(() => stage.write(randomUUID(), [image])).toThrow();
    expect(readdirSync(root)).toEqual(["attachments"]);
  });

  it("reads nothing for a message with no bytes staged, or bytes that are not whole", () => {
    const directory = join(tempDir(), "attachments");
    const stage = createAttachmentStage(directory);
    expect(stage.read(randomUUID(), [recordOf(image)])).toBeUndefined();
    const messageId = randomUUID();
    stage.write(messageId, [image]);
    expect(stage.read(messageId, [{ ...recordOf(image), size: 99 }])).toBeUndefined();
    expect(stage.read(messageId, [recordOf(image), recordOf(file)])).toBeUndefined();
  });

  it("removes a message's bytes, and a removal of nothing does nothing", () => {
    const directory = join(tempDir(), "attachments");
    const stage = createAttachmentStage(directory);
    const messageId = randomUUID();
    stage.write(messageId, [image]);
    stage.remove(messageId);
    stage.remove(messageId);
    stage.remove(randomUUID());
    expect(stage.list()).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("lists only message ids, drops a write a crash left half done, and lists nothing before its first write", () => {
    const directory = join(tempDir(), "attachments");
    const stage = createAttachmentStage(directory);
    expect(stage.list()).toEqual([]);
    const messageId = randomUUID();
    stage.write(messageId, [image]);
    mkdirSync(join(directory, ".partial-left-by-a-crash"));
    writeFileSync(join(directory, ".partial-left-by-a-crash", "0"), "half");
    mkdirSync(join(directory, "not-a-message"));
    expect(stage.list()).toEqual([messageId]);
    stage.dropPartial();
    expect(readdirSync(directory).sort()).toEqual([messageId, "not-a-message"].sort());
  });

  it("refuses a message id that is not one the environment mints, so nothing is written outside its directory", () => {
    const stage = createAttachmentStage(join(tempDir(), "attachments"));
    expect(() => stage.write("../escape", [image])).toThrow(/not a message id/);
    expect(() => stage.remove("../escape")).toThrow(/not a message id/);
  });
});
