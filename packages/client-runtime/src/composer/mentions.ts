/**
 * `@path` mentions: what to offer, and in what order.
 * ============================================================================
 *
 * One composer rule for every renderer (docs/specs/tui.md, "The composer";
 * docs/specs/gui.md, "A session pane"): the terminal UI's `@` list and the
 * window's rank a workspace alike, so a file found in one is found in the
 * other with the same letters.
 *
 * Naming a file to the agent is the most common thing anyone types into the
 * composer, and typing it out in full is the slowest. So `@` starts a
 * completion, and this module is everything that completion needs that is not
 * a renderer and not the environment: the scorer that ranks the candidate
 * paths against what has been typed, and the two string operations that find
 * the token under the cursor and write the answer back into it. The list is
 * left to the renderer, and so is any memory of what was picked before
 * (`FrecencyLike`: the terminal UI keeps one in its state directory); nothing
 * here draws.
 *
 * Three decisions worth knowing:
 *
 *  - **The list of paths is the environment's.** It comes from `files.list` on
 *    the session's environment (docs/specs/tui.md, "The composer" and
 *    "Terminals, files and diffs"): git's own listing in a repository, which
 *    already knows what the project ignores, else a bounded walk with a
 *    skip list, relative to the session's workspace with forward
 *    slashes. The workspace is wherever the environment is, so only the
 *    scorer and the token rules are the client's.
 *  - **The scorer is a small dynamic program, not a greedy scan.** The cheap
 *    way to score a fuzzy match is to take the first subsequence you find and
 *    grade it; that way `co/Comp` scores `packages/core/src/adapters/compose.ts`
 *    above `apps/tui/src/components/Composer.tsx`, because `co` lands
 *    consecutively on `core` while the greedy scan misses that it could have
 *    landed on the `co` of `components` too. Ranking the wrong file first is
 *    the whole failure mode of a completion, so the match is chosen by an
 *    exact best-path search over the (short) query and the (short) path,
 *    which costs a few hundred additions per candidate. A path picked often
 *    and lately, where a renderer remembers picks, is worth a bonus, never a
 *    sort key, except with nothing typed.
 *  - **A mention token starts at an `@` that follows whitespace.** Otherwise
 *    every email address in a message is a half-finished completion.
 */

/** Code-unit order, so a ranking does not depend on anybody's locale. */
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// The scorer
// ---------------------------------------------------------------------------

/** What a path is worth against a query, and where the match landed. */
export interface FileMatch {
  readonly path: string;
  readonly score: number;
  /** Offsets into `path` of the matched characters, for highlighting. */
  readonly indices: readonly number[];
}

/** A memory of what was picked before, as the matcher reads it: what to add to a path's score. */
export interface FrecencyLike {
  boost(path: string): number;
}

export interface FuzzyMatchOptions {
  /** Most results to return. Default {@link DEFAULT_MATCH_LIMIT}. */
  readonly limit?: number;
  /** Where "picked this one before" comes from. */
  readonly frecency?: FrecencyLike;
}

export const DEFAULT_MATCH_LIMIT = 12;

/** Every matched character is worth this much before bonuses. */
const MATCH = 16;
/** Landing after a `/`, `-`, `_`, `.` or space, or at the very start. */
const BONUS_BOUNDARY = 8;
/** Landing on the capital of a camelCase hump, which is a word start too. */
const BONUS_CAMEL = 7;
/** Landing on the first character of the basename — the part people type. */
const BONUS_BASENAME = 12;
/** Landing immediately after the previous match: runs read as one word. */
const BONUS_CONSECUTIVE = 10;
/** Typing a filename exactly should not have to out-argue the path it sits in. */
const BONUS_EXACT_BASENAME = 64;
/** Skipping characters costs; the first skipped one costs the most. */
const GAP_START = 3;
const GAP_EXTEND = 1;

const DELIMITERS: ReadonlySet<string> = new Set(["/", "\\", "-", "_", ".", " "]);

const NO_INDICES: readonly number[] = [];

/**
 * `paths` ranked against `query`, best first.
 *
 * Characters must appear in order, case-insensitively; anything else is not a
 * candidate. Ties go to the shorter path and then to path order, so the list
 * never reshuffles between keystrokes that do not change the ranking.
 *
 * An empty query is not a match of everything — it is the state before typing,
 * and the useful answer there is what was picked before, then alphabetical.
 */
export function fuzzyMatch(query: string, paths: readonly string[], options: FuzzyMatchOptions = {}): readonly FileMatch[] {
  const limit = options.limit ?? DEFAULT_MATCH_LIMIT;
  if (limit <= 0) return [];
  const frecency = options.frecency;
  const boost = (path: string): number => frecency?.boost(path) ?? 0;

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    // Alphabetical rather than shortest-first below the boosts: with no query
    // there is nothing that makes a short path a better guess, and a list in
    // path order is one somebody can read down.
    return [...paths]
      .map((path) => ({ path, score: boost(path), indices: NO_INDICES }))
      .sort((a, b) => b.score - a.score || byPath(a.path, b.path))
      .slice(0, limit);
  }

  const needle = alignedLower(trimmed);
  const matches: FileMatch[] = [];
  for (const path of paths) {
    const scored = scorePath(needle, path);
    if (scored !== null) matches.push({ path, score: scored.score + boost(path), indices: scored.indices });
  }
  return matches.sort(byRank).slice(0, limit);
}

const byRank = (a: FileMatch, b: FileMatch): number => b.score - a.score || a.path.length - b.path.length || byPath(a.path, b.path);

/**
 * `value` in lower case, one character per character, so an offset into the
 * result is an offset into the original. A few characters lower-case to two
 * (`İ`), which would slide every later index by one and mis-highlight the
 * rest of the path; those are left alone.
 */
function alignedLower(value: string): string {
  const lower = value.toLowerCase();
  if (lower.length === value.length) return lower;
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    const folded = character.toLowerCase();
    out += folded.length === character.length ? folded : character;
  }
  return out;
}

/**
 * The best-scoring way to match `needle` (already lower case) in `path`, or
 * `null` if it does not occur in order.
 *
 * `best[i][j]` is the best score for the first `i + 1` query characters when
 * the `i`th of them lands on `j`. Reaching `j` is either a step from `j - 1`,
 * which earns the consecutive bonus, or a jump from some earlier `k`, which
 * pays for the gap; the best `k` is carried along in a running maximum
 * (rewritten so the distance-dependent penalty factors out), which is what
 * keeps this linear in the path length per query character.
 */
function scorePath(needle: string, path: string): { readonly score: number; readonly indices: readonly number[] } | null {
  const haystack = alignedLower(path);
  const width = haystack.length;
  const height = needle.length;
  if (height === 0 || height > width || !occursInOrder(needle, haystack)) return null;

  const basenameStart = haystack.lastIndexOf("/") + 1;
  const best: number[] = new Array<number>(height * width).fill(-Infinity);
  const cameFrom: number[] = new Array<number>(height * width).fill(-1);

  const first = needle.charCodeAt(0);
  for (let j = 0; j < width; j += 1) {
    if (haystack.charCodeAt(j) === first) best[j] = MATCH + bonusAt(path, haystack, j, basenameStart);
  }

  for (let i = 1; i < height; i += 1) {
    const row = i * width;
    const previous = row - width;
    const code = needle.charCodeAt(i);
    // The best `k` no closer than two behind, held as `best[k] + GAP_EXTEND * k`
    // so that subtracting the gap penalty needs only today's `j`.
    let carried = -Infinity;
    let carriedFrom = -1;
    for (let j = i; j < width; j += 1) {
      const k = j - 2;
      if (k >= 0) {
        const candidate = (best[previous + k] ?? -Infinity) + GAP_EXTEND * k;
        if (candidate > carried) {
          carried = candidate;
          carriedFrom = k;
        }
      }
      if (haystack.charCodeAt(j) !== code) continue;
      const stepped = (best[previous + j - 1] ?? -Infinity) + BONUS_CONSECUTIVE;
      const jumped = carried - GAP_START - GAP_EXTEND * (j - 2);
      if (stepped === -Infinity && jumped === -Infinity) continue;
      const character = MATCH + bonusAt(path, haystack, j, basenameStart);
      if (stepped >= jumped) {
        best[row + j] = character + stepped;
        cameFrom[row + j] = j - 1;
      } else {
        best[row + j] = character + jumped;
        cameFrom[row + j] = carriedFrom;
      }
    }
  }

  const last = (height - 1) * width;
  let end = -1;
  let score = -Infinity;
  for (let j = height - 1; j < width; j += 1) {
    const candidate = best[last + j] ?? -Infinity;
    if (candidate > score) {
      score = candidate;
      end = j;
    }
  }
  if (end < 0) return null;

  const indices: number[] = new Array<number>(height).fill(0);
  for (let i = height - 1, j = end; i >= 0; i -= 1) {
    indices[i] = j;
    j = cameFrom[i * width + j] ?? -1;
  }

  // Typing a whole filename is not a fuzzy query, it is an answer.
  if (haystack.slice(basenameStart) === needle) score += BONUS_EXACT_BASENAME;
  return { score, indices };
}

function occursInOrder(needle: string, haystack: string): boolean {
  let at = 0;
  for (let j = 0; j < haystack.length && at < needle.length; j += 1) {
    if (haystack.charCodeAt(j) === needle.charCodeAt(at)) at += 1;
  }
  return at === needle.length;
}

/** What the position of a match is worth, before consecutiveness and gaps. */
function bonusAt(path: string, haystack: string, index: number, basenameStart: number): number {
  const basename = index === basenameStart ? BONUS_BASENAME : 0;
  if (index === 0) return basename + BONUS_BOUNDARY;
  const before = haystack.charAt(index - 1);
  if (DELIMITERS.has(before)) return basename + BONUS_BOUNDARY;
  // A hump: the previous character is not upper case and this one is. Compared
  // against the folded copy rather than with a regular expression, so this
  // stays one comparison per candidate position.
  const humped = path.charAt(index - 1) === before && path.charAt(index) !== haystack.charAt(index);
  return basename + (humped ? BONUS_CAMEL : 0);
}

// ---------------------------------------------------------------------------
// The token under the cursor
// ---------------------------------------------------------------------------

/** An `@token` in the composer's text: where it is, and what has been typed into it. */
export interface Mention {
  /** Offset of the `@`. */
  readonly start: number;
  /** Offset one past the token's last character. */
  readonly end: number;
  /** Everything after the `@`, which is empty the moment it is typed. */
  readonly query: string;
}

const isSpace = (character: string): boolean => character.length > 0 && /\s/.test(character);

/**
 * The mention the cursor is in, or `null`.
 *
 * The token is found by walking back to the nearest whitespace and asking
 * whether what starts there is an `@`. That is the rule that keeps
 * `ada@example.com` out of it — its `@` is mid-token — while still allowing an
 * `@` inside the path, as `@packages/@scope/thing` has.
 *
 * The cursor may sit anywhere from just after the `@` to the end of the token;
 * on the `@` itself it is not a mention yet, because nothing has been typed and
 * the next keystroke may well be to the left of it. The query is the whole
 * token rather than the part before the cursor, so that arrowing back into a
 * path to fix a letter does not narrow the list to a prefix of it.
 */
export function mentionAt(text: string, cursor: number): Mention | null {
  if (cursor < 0 || cursor > text.length) return null;
  let start = cursor;
  while (start > 0 && !isSpace(text.charAt(start - 1))) start -= 1;
  if (text.charAt(start) !== "@" || cursor <= start) return null;
  let end = cursor;
  while (end < text.length && !isSpace(text.charAt(end))) end += 1;
  return { start, end, query: text.slice(start + 1, end) };
}

/**
 * Write `replacement` over the token at `[start, end)`, leaving the cursor
 * past it and past one space — because the next thing typed after picking a
 * file is another word, and having to press space first is a bug people report
 * as "it ate my typing".
 *
 * The `@` is part of what is replaced, so the caller decides whether the
 * mention keeps its sigil. A space already following the token is reused
 * rather than doubled.
 */
export function replaceMention(text: string, start: number, end: number, replacement: string): { readonly text: string; readonly cursor: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const tail = after.startsWith(" ") ? after : ` ${after}`;
  return { text: `${before}${replacement}${tail}`, cursor: start + replacement.length + 1 };
}
