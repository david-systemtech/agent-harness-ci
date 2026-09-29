/**
 * Held to the harness's wire type: every attachment built here is one
 * `AttachmentInput` from `@agent-harness/contracts` accepts, whichever
 * renderer read its bytes.
 */

import { AttachmentInput, MAX_ATTACHMENT_BYTES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";

import { MAX_ATTACHMENT_NAME, UNKNOWN_MEDIA_TYPE, attachmentFromBytes, mediaTypeOf, overLimit } from "./attachments.js";

/** Whether the wire would take it, which is the whole point of building one here. */
const onTheWire = (value: unknown): boolean => AttachmentInput.safeParse(value).success;

describe("attachmentFromBytes", () => {
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

  it("makes an image of an image media type and a file of anything else", () => {
    expect(attachmentFromBytes("clipboard.png", "image/png", png)).toEqual({
      kind: "image",
      name: "clipboard.png",
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    });
    expect(attachmentFromBytes("notes.txt", "text/plain", new TextEncoder().encode("hi"))).toMatchObject({
      kind: "file",
      mediaType: "text/plain",
      data: "aGk=",
    });
  });

  it("is null past the cap and an attachment exactly at it", () => {
    expect(attachmentFromBytes("big.png", "image/png", new Uint8Array(MAX_ATTACHMENT_BYTES + 1))).toBeNull();
    const at = attachmentFromBytes("big.png", "image/png", new Uint8Array(MAX_ATTACHMENT_BYTES));
    expect(at?.kind).toBe("image");
    expect(onTheWire(at)).toBe(true);
  });

  it("always answers with something the wire takes: a media type it accepts and a name that is there", () => {
    const odd = attachmentFromBytes("", "not a media type", png);
    expect(odd).toMatchObject({ kind: "file", name: "attachment", mediaType: UNKNOWN_MEDIA_TYPE });
    expect(onTheWire(odd)).toBe(true);
  });

  it("cuts a long name to the wire's length, never through half of an emoji", () => {
    expect(MAX_ATTACHMENT_NAME).toBe(255);
    const long = attachmentFromBytes(`${"a".repeat(300)}.png`, "image/png", png);
    expect(long?.name).toBe("a".repeat(255));
    expect(onTheWire(long)).toBe(true);

    // 254 letters and an emoji: the emoji's second half would be the 256th unit, so both halves go.
    const emoji = attachmentFromBytes(`${"a".repeat(254)}🎉 and more`, "image/png", png);
    expect(emoji?.name).toBe("a".repeat(254));
    expect(onTheWire(emoji)).toBe(true);
  });
});

describe("the media type a name implies", () => {
  it("reads an image or a file by its extension, ignoring case, and claims nothing for the rest", () => {
    expect(mediaTypeOf("shot.PNG")).toBe("image/png");
    expect(mediaTypeOf("photo.jpeg")).toBe("image/jpeg");
    expect(mediaTypeOf("notes.pdf")).toBe("application/pdf");
    expect(mediaTypeOf("archive.tar.gz")).toBe(UNKNOWN_MEDIA_TYPE);
    expect(mediaTypeOf("Makefile")).toBe(UNKNOWN_MEDIA_TYPE);
  });

  it("says a file past the cap in one line, its size in whole megabytes", () => {
    expect(overLimit("big.mov", 31 * 1024 * 1024)).toBe("big.mov is 31 MB; the limit is 20 MB.");
  });
});

describe("the bytes", () => {
  it("are standard padded base64, whatever their length", () => {
    const text = (value: string) => attachmentFromBytes("a.txt", "text/plain", new TextEncoder().encode(value))?.data;
    expect([text(""), text("f"), text("fo"), text("foo"), text("foob"), text("fooba"), text("foobar")]).toEqual(["", "Zg==", "Zm8=", "Zm9v", "Zm9vYg==", "Zm9vYmE=", "Zm9vYmFy"]);
  });

  it("encode every byte value, across the pieces a long attachment is written in", () => {
    const all = Uint8Array.from({ length: 3 * 4096 + 256 }, (_, index) => index % 256);
    expect(attachmentFromBytes("all.bin", "application/octet-stream", all)?.data).toBe(Buffer.from(all).toString("base64"));
  });
});
