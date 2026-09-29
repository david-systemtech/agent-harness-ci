/**
 * What `@` picked before, and how much it is worth now.
 * ============================================================================
 *
 * One of the pure modules carried with their tests (docs/specs/tui.md,
 * "Testing Decisions"). The scorer that ranks the workspace's paths and the
 * rules for the `@` token are the client runtime's (`fuzzyMatch`,
 * `mentionAt`, `replaceMention`), shared with the window; the memory of what
 * was picked is the terminal UI's own: `MENTIONS_FILE` in its state directory
 * (`stateDirectory` in `platform/node-platform.ts`), client-local
 * presentation like the history and the snippets (docs/specs/tui.md, "The
 * entry point and the platform"). Frecency is a bonus to the scorer, not a
 * sort key: a path picked often and lately is worth about as much as a couple
 * of word-boundary bonuses, enough to win between near-identical candidates,
 * never enough to float an irrelevant file above a good textual match.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FrecencyLike } from "@agent-harness/client-runtime";

/** Code-unit order, so which paths are kept does not depend on anybody's locale. */
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface FrecencyEntry {
  /** When it was last picked. */
  readonly at: number;
  /** How many times, ever. */
  readonly count: number;
}

interface StoredFrecency {
  readonly version?: unknown;
  readonly entries?: unknown;
}

const FRECENCY_VERSION = 1;

/** The `@` pick memory's file name in the terminal UI's state directory; the caller joins the two. */
export const MENTIONS_FILE = "mentions.json";

/** A pick is worth half as much a fortnight later. */
const FRECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
/** The most a boost can be worth: a basename bonus and a couple of boundaries. */
const FRECENCY_MAX = 48;
/** Picks beyond this stop making a path more special. */
const FRECENCY_FULL_COUNT = 16;
/** How many paths the file keeps, so a long-lived install does not grow one forever. */
const FRECENCY_KEEP = 512;

/**
 * Which paths were picked, how often, and how long ago.
 *
 * Both halves matter and neither alone is enough: counting only frequency
 * makes last month's refactor outrank this morning's work forever, and
 * counting only recency forgets the file someone lives in the moment they open
 * something else. So a count is worth less the older it is — an exponential
 * decay, which needs one timestamp per path instead of a history.
 *
 * `now` is a parameter everywhere rather than a read of the clock, because a
 * test cannot wait a fortnight.
 *
 * `Frecency.load(path)` reads the file back and remembers where it lives, so
 * `save` writes there; `new Frecency()` is a memory with no file, which
 * `save` leaves alone.
 */
export class Frecency implements FrecencyLike {
  readonly #entries = new Map<string, FrecencyEntry>();
  readonly #path: string | undefined;

  /** Nothing remembered yet; `save` writes to `path` when there is one. */
  constructor(path?: string) {
    this.#path = path;
  }

  /**
   * The memory in the file at `path`. A missing or unreadable file means
   * nothing is remembered, which is exactly how a fresh install behaves — a
   * completion is never something a cache file gets to break.
   */
  static async load(path: string): Promise<Frecency> {
    const frecency = new Frecency(path);
    let parsed: StoredFrecency | null;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as StoredFrecency | null;
    } catch {
      return frecency;
    }
    if (parsed === null || parsed.version !== FRECENCY_VERSION) return frecency;
    const entries = parsed.entries;
    if (typeof entries !== "object" || entries === null) return frecency;
    for (const [picked, value] of Object.entries(entries)) {
      if (typeof value !== "object" || value === null) continue;
      const { at, count } = value as Partial<FrecencyEntry>;
      if (typeof at === "number" && typeof count === "number" && count > 0) frecency.#entries.set(picked, { at, count });
    }
    return frecency;
  }

  /** What to add to a path's match score. Zero for a path never picked. */
  boost(path: string, now: number = Date.now()): number {
    const entry = this.#entries.get(path);
    if (entry === undefined) return 0;
    const age = Math.max(0, now - entry.at);
    const recency = 0.5 ** (age / FRECENCY_HALF_LIFE_MS);
    const often = Math.log2(1 + Math.min(entry.count, FRECENCY_FULL_COUNT)) / Math.log2(1 + FRECENCY_FULL_COUNT);
    return FRECENCY_MAX * recency * often;
  }

  /** This path was just chosen. */
  record(path: string, now: number = Date.now()): void {
    const entry = this.#entries.get(path);
    this.#entries.set(path, { at: now, count: (entry?.count ?? 0) + 1 });
  }

  /**
   * Write what is remembered, atomically, keeping only the paths worth the most
   * so the file stays small. A failure is swallowed: losing the order of a
   * completion list is not worth an error in front of someone's prompt.
   */
  async save(): Promise<void> {
    const path = this.#path;
    if (path === undefined) return;
    const kept = [...this.#entries.entries()].sort((a, b) => this.boost(b[0]) - this.boost(a[0]) || byPath(a[0], b[0])).slice(0, FRECENCY_KEEP);
    const file = { version: FRECENCY_VERSION, entries: Object.fromEntries(kept) };
    try {
      // Owner-only, as the rest of the state directory is.
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${String(process.pid)}.tmp`;
      await writeFile(temp, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temp, path);
    } catch {
      // Nothing to do about it and nothing worth saying.
    }
  }
}
