import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { createTranscriptImages } from "./store.js";

const { tempDir } = useCleanups();
const data = (text: string) => Buffer.from(text).toString("base64");

describe("retained transcript image storage", () => {
  it("caps decoded bytes per session, drops oldest content first across restarts, and deduplicates", () => {
    const root = tempDir();
    let store = createTranscriptImages(root, 6);
    const first = store.retain("one", "image/png", data("one"));
    const second = store.retain("one", "image/png", data("two"));
    expect(store.retain("one", "image/png", data("one"))).toEqual(first);
    store = createTranscriptImages(root, 6);
    expect(store.read("one", first.hash!)).toEqual({ mediaType: "image/png", data: data("one") });
    const third = store.retain("one", "image/png", data("tri"));
    expect(store.read("one", first.hash!)).toBeNull();
    expect(store.read("one", second.hash!)).toEqual({ mediaType: "image/png", data: data("two") });
    expect(store.read("one", third.hash!)).toEqual({ mediaType: "image/png", data: data("tri") });
    const other = store.retain("other", "image/png", data("one"));
    store.purge("one");
    expect(store.read("one", third.hash!)).toBeNull();
    expect(store.read("other", other.hash!)).toEqual({ mediaType: "image/png", data: data("one") });
  });

  it("rejects an oversized image without evicting retained content and refuses paths", () => {
    const store = createTranscriptImages(tempDir(), 3);
    const first = store.retain("one", "image/png", data("one"));
    const oversized = store.retain("one", "image/png", data("oversized"));
    expect(store.read("one", oversized.hash!)).toBeNull();
    expect(store.read("one", first.hash!)).toEqual({ mediaType: "image/png", data: data("one") });
    expect(store.read("one", "../outside")).toBeNull();
  });
});
