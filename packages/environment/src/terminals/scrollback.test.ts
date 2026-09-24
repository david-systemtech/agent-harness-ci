import { describe, expect, it } from "vitest";
import { createScrollback, type Scrollback } from "./scrollback.js";

const AT = "2026-09-24T00:00:00.000Z";

/** Appends each piece of `pieces` as one chunk. */
const fill = (ring: Scrollback, pieces: readonly string[]): void => {
  for (const piece of pieces) ring.append(piece, AT);
};

/** `count` lines, `line-<n>` each, from `from`. */
const lines = (count: number, from = 0): string[] => Array.from({ length: count }, (_, i) => `line-${from + i}\n`);

describe("a terminal's scrollback", () => {
  it("numbers its chunks from 1 and holds them all under the caps", () => {
    const ring = createScrollback({ lines: 10, bytes: 1024 });
    expect([ring.firstSequence, ring.lastSequence, ring.truncated, ring.text()]).toEqual([0, 0, false, ""]);
    const first = ring.append("$ ls\r\n", AT);
    const second = ring.append("README.md\r\n$ ", AT);
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(first.data).toBe("$ ls\r\n");
    expect([ring.firstSequence, ring.lastSequence, ring.truncated]).toEqual([1, 2, false]);
    expect(ring.text()).toBe("$ ls\r\nREADME.md\r\n$ ");
  });

  it("keeps at most the line cap, counting an unfinished last line, and drops the oldest lines first", () => {
    const ring = createScrollback({ lines: 5, bytes: 1024 });
    fill(ring, lines(7));
    expect(ring.text()).toBe(lines(5, 2).join(""));
    expect(ring.lines()).toBe(5);
    expect(ring.truncated).toBe(true);
    // An unfinished line is a line: a prompt after five full lines pushes the oldest out.
    ring.append("$ ", AT);
    expect(ring.text()).toBe(lines(4, 3).join("") + "$ ");
    expect(ring.lines()).toBe(5);
  });

  it("cuts inside a chunk that holds more lines than the cap, keeping only its tail", () => {
    const ring = createScrollback({ lines: 3, bytes: 1024 });
    const chunk = ring.append(lines(10).join(""), AT);
    // The chunk as sent live is whole; the ring keeps the tail.
    expect(chunk.data).toBe(lines(10).join(""));
    expect(ring.text()).toBe(lines(3, 7).join(""));
    expect([ring.firstSequence, ring.lastSequence, ring.truncated]).toEqual([1, 1, true]);
  });

  it("keeps at most the byte cap, whatever the lines, cutting on a character boundary", () => {
    const ring = createScrollback({ lines: 1000, bytes: 10 });
    fill(ring, ["abcdef", "ghijkl"]);
    expect(ring.text()).toBe("cdefghijkl");
    expect(ring.bytes()).toBe(10);
    // Two-byte characters: never half of one.
    const wide = createScrollback({ lines: 1000, bytes: 5 });
    wide.append("ééé", AT);
    expect(wide.text()).toBe("éé");
    expect(wide.bytes()).toBeLessThanOrEqual(5);
    expect(wide.truncated).toBe(true);
  });

  it("drops whole chunks at the byte cap before cutting into one", () => {
    const ring = createScrollback({ lines: 1000, bytes: 8 });
    fill(ring, ["1234", "5678", "9abc"]);
    expect(ring.text()).toBe("56789abc");
    expect([ring.firstSequence, ring.lastSequence]).toEqual([2, 3]);
  });

  it("caps at whichever comes first: lines for short lines, bytes for long ones", () => {
    const short = createScrollback({ lines: 4, bytes: 1024 });
    fill(short, lines(6));
    expect(short.lines()).toBe(4);
    const long = createScrollback({ lines: 4, bytes: 30 });
    fill(long, ["x".repeat(20) + "\n", "y".repeat(20) + "\n"]);
    expect(long.lines()).toBeLessThanOrEqual(2);
    expect(long.bytes()).toBeLessThanOrEqual(30);
    expect(long.text().endsWith("y".repeat(20) + "\n")).toBe(true);
  });

  it("replays the chunks after a cursor it still reaches, and nothing after the last", () => {
    const ring = createScrollback({ lines: 100, bytes: 1024 });
    fill(ring, ["a", "b", "c", "d"]);
    expect(ring.after(0)?.map((chunk) => chunk.data)).toEqual(["a", "b", "c", "d"]);
    expect(ring.after(2)?.map((chunk) => [chunk.sequence, chunk.data])).toEqual([
      [3, "c"],
      [4, "d"],
    ]);
    expect(ring.after(4)).toEqual([]);
    // A cursor past the last is not this terminal's.
    expect(ring.after(5)).toBeUndefined();
  });

  it("cannot replay from a cursor older than what it retains: those chunks are gone", () => {
    const ring = createScrollback({ lines: 2, bytes: 1024 });
    fill(ring, ["one\n", "two\n", "three\n", "four\n"]);
    expect([ring.firstSequence, ring.lastSequence]).toEqual([3, 4]);
    expect(ring.after(1)).toBeUndefined();
    // The oldest retained chunk is whole, so a cursor just before it replays.
    expect(ring.after(2)?.map((chunk) => chunk.data)).toEqual(["three\n", "four\n"]);
  });

  it("does not replay a chunk whose head was cut: a cursor before it gets no partial chunk", () => {
    const ring = createScrollback({ lines: 2, bytes: 1024 });
    fill(ring, ["a\nb\nc\n", "d\n"]);
    expect(ring.text()).toBe("c\nd\n");
    expect(ring.firstSequence).toBe(1);
    expect(ring.after(0)).toBeUndefined();
    expect(ring.after(1)?.map((chunk) => chunk.data)).toEqual(["d\n"]);
  });

  it("holds the real caps, 5,000 lines and 8 MiB, by default", () => {
    const ring = createScrollback();
    fill(ring, lines(6000));
    expect(ring.lines()).toBe(5000);
    expect(ring.text().startsWith("line-1000\n")).toBe(true);
    expect(ring.text().endsWith("line-5999\n")).toBe(true);
    const bytes = createScrollback();
    const block = "x".repeat(1024 * 1024);
    for (let i = 0; i < 9; i += 1) bytes.append(block, AT);
    expect(bytes.bytes()).toBe(8 * 1024 * 1024);
    expect([bytes.firstSequence, bytes.lastSequence, bytes.truncated]).toEqual([2, 9, true]);
  });
});
