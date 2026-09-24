import { randomUUID } from "node:crypto";
import { TERMINAL_SCROLLBACK } from "@agent-harness/contracts";

/**
 * A terminal's scrollback (tui spec, "Terminals, files and diffs"): the
 * bounded in-memory history of one terminal's output, which is all that is
 * kept of it; output never enters the event log. Output arrives as chunks,
 * each numbered from 1 in the terminal's own sequence, which is the cursor a
 * subscription replays from. The ring keeps at most 5,000 lines or 8 MiB,
 * whichever comes first, dropping the oldest output: whole chunks while they
 * fit in what has to go, then the head of the oldest one left, so the text is
 * always the newest tail. A line is a newline, and an unfinished last line
 * counts as one, so a prompt after the cap pushes the oldest line out.
 */

/** One chunk of output: its sequence, the id and time its event carries, and its text as the ring retains it. */
export interface Chunk {
  readonly sequence: number;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly data: string;
}

/** The caps: lines and UTF-8 bytes. */
export interface ScrollbackCaps {
  readonly lines: number;
  readonly bytes: number;
}

export interface Scrollback {
  /**
   * Adds a chunk and answers it whole, as a live subscriber is sent it; the
   * ring then drops what the caps no longer hold, which may be the head of
   * this very chunk.
   */
  append(data: string, occurredAt: string): Chunk;
  /** The oldest retained chunk's sequence; 0 while there is none. */
  readonly firstSequence: number;
  /** The newest chunk's sequence; 0 before any output. */
  readonly lastSequence: number;
  /** Whether any output has been dropped at the caps. */
  readonly truncated: boolean;
  /** The retained output, oldest first. */
  text(): string;
  /**
   * The chunks after `cursor`, whole, oldest first; undefined when the ring
   * cannot replay from it: some chunk after it was dropped, or had its head
   * cut, or the cursor is past the last chunk (not this terminal's).
   */
  after(cursor: number): readonly Chunk[] | undefined;
  /** Drops every retained chunk; the sequence goes on from where it was, and the ring says it was truncated. */
  clear(): void;
  /** How many lines are retained, an unfinished last one counted. */
  lines(): number;
  /** How many UTF-8 bytes are retained. */
  bytes(): number;
}

interface Held {
  readonly sequence: number;
  readonly eventId: string;
  readonly occurredAt: string;
  data: string;
  bytes: number;
  newlines: number;
}

const countNewlines = (text: string): number => {
  let count = 0;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count += 1;
  return count;
};

/** The index of the `k`th newline of `text`, from 1; -1 when it has fewer. */
const nthNewline = (text: string, k: number): number => {
  let at = -1;
  for (let found = 0; found < k; found += 1) {
    at = text.indexOf("\n", at + 1);
    if (at < 0) return -1;
  }
  return at;
};

/** `text` without its first `drop` UTF-8 bytes, moved on to the next character boundary so no character is halved. */
const dropBytes = (text: string, drop: number): string => {
  const buffer = Buffer.from(text, "utf8");
  let start = drop;
  while (start < buffer.length && ((buffer[start] as number) & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
};

export const createScrollback = (caps: ScrollbackCaps = TERMINAL_SCROLLBACK): Scrollback => {
  let held: Held[] = [];
  /** The index in `held` of the oldest retained chunk: dropping one moves it, and the array is compacted now and then. */
  let start = 0;
  let last = 0;
  let totalBytes = 0;
  let totalNewlines = 0;
  let truncated = false;
  /** Whether the oldest retained chunk had its head cut: it cannot be replayed whole. */
  let headCut = false;

  const head = (): Held | undefined => held[start];
  const newest = (): Held | undefined => held[held.length - 1];
  const count = (): number => held.length - start;

  const lineCount = (): number => {
    const tail = newest();
    if (tail === undefined || totalBytes === 0) return 0;
    return totalNewlines + (tail.data.endsWith("\n") ? 0 : 1);
  };

  const dropHead = (): void => {
    const chunk = head();
    if (chunk === undefined) return;
    totalBytes -= chunk.bytes;
    totalNewlines -= chunk.newlines;
    start += 1;
    headCut = false;
    truncated = true;
    if (start > 1024 && start * 2 > held.length) {
      held = held.slice(start);
      start = 0;
    }
  };

  /** Replaces the oldest chunk's text with its tail `rest`, or drops it when nothing is left. */
  const cutHead = (chunk: Held, rest: string): void => {
    if (rest.length === 0) return dropHead();
    const bytes = Buffer.byteLength(rest, "utf8");
    const newlines = countNewlines(rest);
    totalBytes += bytes - chunk.bytes;
    totalNewlines += newlines - chunk.newlines;
    chunk.data = rest;
    chunk.bytes = bytes;
    chunk.newlines = newlines;
    headCut = true;
    truncated = true;
  };

  /** Drops the output up to and including the `k`th newline from the head: the oldest `k` lines. */
  const dropLines = (k: number): void => {
    let remaining = k;
    while (remaining > 0 && count() > 1) {
      const chunk = head() as Held;
      if (chunk.newlines >= remaining) break;
      remaining -= chunk.newlines;
      dropHead();
    }
    if (remaining <= 0) return;
    const chunk = head() as Held;
    const at = nthNewline(chunk.data, remaining);
    if (at < 0) return dropHead();
    cutHead(chunk, chunk.data.slice(at + 1));
  };

  const dropExcessBytes = (): void => {
    let excess = totalBytes - caps.bytes;
    while (excess > 0 && count() > 1 && (head() as Held).bytes <= excess) {
      excess -= (head() as Held).bytes;
      dropHead();
    }
    if (excess <= 0) return;
    const chunk = head() as Held;
    cutHead(chunk, dropBytes(chunk.data, excess));
  };

  return {
    append(data, occurredAt) {
      last += 1;
      const chunk: Held = {
        sequence: last,
        eventId: randomUUID(),
        occurredAt,
        data,
        bytes: Buffer.byteLength(data, "utf8"),
        newlines: countNewlines(data),
      };
      held.push(chunk);
      totalBytes += chunk.bytes;
      totalNewlines += chunk.newlines;
      const answer: Chunk = { sequence: chunk.sequence, eventId: chunk.eventId, occurredAt, data };
      const excessLines = lineCount() - caps.lines;
      if (excessLines > 0) dropLines(excessLines);
      if (totalBytes > caps.bytes) dropExcessBytes();
      return answer;
    },
    get firstSequence() {
      return head()?.sequence ?? 0;
    },
    get lastSequence() {
      return last;
    },
    get truncated() {
      return truncated;
    },
    text: () =>
      held
        .slice(start)
        .map((chunk) => chunk.data)
        .join(""),
    after(cursor) {
      if (cursor > last || cursor < 0) return undefined;
      const oldest = head();
      if (oldest === undefined) return cursor === last ? [] : undefined;
      // The oldest chunk replays only whole: a cursor must be at or after it when its head was cut.
      const earliest = headCut ? oldest.sequence : oldest.sequence - 1;
      if (cursor < earliest) return undefined;
      return held.slice(start + (cursor - oldest.sequence + 1)).map(({ sequence, eventId, occurredAt, data }) => ({ sequence, eventId, occurredAt, data }));
    },
    clear() {
      while (count() > 0) dropHead();
    },
    lines: lineCount,
    bytes: () => totalBytes,
  };
};
