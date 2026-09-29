/**
 * Held to the harness's wire type: every attachment built here is one
 * `AttachmentInput` from `@agent-harness/contracts` accepts.
 */

import { chmod, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UNKNOWN_MEDIA_TYPE } from "@agent-harness/client-runtime";
import { AttachmentInput, MAX_ATTACHMENT_BYTES } from "@agent-harness/contracts";
import { afterAll, describe, expect, it } from "vitest";

import { readAttachment } from "./attachments.js";

const temporaries: string[] = [];
const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
};
afterAll(async () => {
  for (const directory of temporaries) await rm(directory, { recursive: true, force: true });
});

/** Whether the wire would take it, which is the whole point of building one here. */
const onTheWire = (value: unknown): boolean => AttachmentInput.safeParse(value).success;

describe("readAttachment", () => {
  it("reads an image by extension and a file otherwise, relative to cwd", async () => {
    const dir = await temporaryDirectory("agent-harness-attach-");
    await writeFile(join(dir, "shot.PNG"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(dir, "notes.md"), "# hi");
    await writeFile(join(dir, "blob.bin"), Buffer.from([1, 2, 3]));

    const image = await readAttachment("shot.PNG", dir);
    expect(image.ok && image.attachment).toEqual({
      kind: "image",
      name: "shot.PNG",
      mediaType: "image/png",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
    });
    expect(image.ok && image.path).toBe(join(dir, "shot.PNG"));

    const file = await readAttachment("notes.md", dir);
    expect(file.ok && file.attachment).toMatchObject({ kind: "file", name: "notes.md", mediaType: "text/markdown" });

    // The wire always carries a media type, so an extension that implies none is plain bytes.
    const blob = await readAttachment("blob.bin", dir);
    expect(blob.ok && blob.attachment).toMatchObject({ kind: "file", name: "blob.bin", mediaType: UNKNOWN_MEDIA_TYPE });
    expect(UNKNOWN_MEDIA_TYPE).toBe("application/octet-stream");

    for (const result of [image, file, blob]) expect(result.ok && onTheWire(result.attachment)).toBe(true);
  });

  it("explains a missing path or a directory", async () => {
    const dir = await temporaryDirectory("agent-harness-attach-");
    const missing = await readAttachment("nope.png", dir);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.reason).toMatch(/does not exist/);
    const directory = await readAttachment(".", dir);
    expect(!directory.ok && directory.reason).toMatch(/not a file/);
  });

  it("refuses a file past the cap without reading it", async () => {
    const dir = await temporaryDirectory("agent-harness-attach-");
    // Sparse: the size is what is checked, so the disk never holds the bytes.
    await writeFile(join(dir, "disk.img"), "");
    await truncate(join(dir, "disk.img"), MAX_ATTACHMENT_BYTES + 1);

    const result = await readAttachment("disk.img", dir);

    expect(!result.ok && result.reason).toBe("disk.img is 20 MB; the limit is 20 MB.");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("explains a file it can see but not read, rather than throwing", async () => {
    const dir = await temporaryDirectory("agent-harness-attach-");
    await writeFile(join(dir, "locked.txt"), "secret");
    await chmod(join(dir, "locked.txt"), 0o000);

    const result = await readAttachment("locked.txt", dir);

    expect(!result.ok && result.reason).toMatch(/cannot be read/);
  });
});

describe("a path the way a person types it", () => {
  it("expands ~ to the home directory", async () => {
    // `/attach ~/shot.png` resolved under the *working directory* — as a
    // folder literally named `~` — and reported the file missing. Every shell
    // a person has ever typed that into expanded it.
    const home = await temporaryDirectory("agent-harness-home-");
    const cwd = await temporaryDirectory("agent-harness-cwd-");
    await writeFile(join(home, "notes.md"), "# hi");

    const result = await readAttachment("~/notes.md", cwd, { home });

    expect(result.ok && result.attachment).toMatchObject({ kind: "file", name: "notes.md" });
  });
});

describe("a long name", () => {
  it("reads back the longest name a file system allows whole", async () => {
    const dir = await temporaryDirectory("agent-harness-attach-");
    // Most file systems stop a name at 255 bytes, so the longest one there is is read back whole.
    const name = `${"b".repeat(251)}.txt`;
    await writeFile(join(dir, name), "x");
    const result = await readAttachment(name, dir);
    expect(result.ok && result.attachment.name).toBe(name);
  });
});
