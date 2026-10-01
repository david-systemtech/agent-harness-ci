/**
 * The silence rule (routines spec, "Silence"; #524): whether a firing's
 * final text is its routine's silence marker, so the firing delivers
 * nothing. It is Hermes's rule for its autonomous lanes, for one marker,
 * the routine's (`[SILENT]` unless it names its own), and its cases are
 * published as `cases/silence.json` for a client in another language.
 *
 * A text is silent when its first non-blank line, its last non-blank line
 * or the whole text, each trimmed and at most 64 characters, equals the
 * marker; or when the marker is bracketed and opens the trimmed text
 * (`[SILENT] nothing new`). Two texts are compared folded: trimmed,
 * upper-cased and each run of white space made one space, as written or
 * with their edge punctuation removed. Square brackets are no edge
 * punctuation, so a malformed `[SILENT` never reads as `SILENT`. A marker
 * mid-sentence is delivered, and empty text is not silence.
 */

/** The longest line, or whole text, that can be the marker: longer than any marker, with stray punctuation. */
const MARKER_LENGTH_CAP = 64;

/** Trimmed, upper-cased, and each run of white space one space. */
const folded = (text: string): string => text.trim().toUpperCase().replace(/\s+/gu, " ");

/** Whether `character` is punctuation that may pad a marker: any Unicode punctuation but a square bracket. */
const edgePunctuation = (character: string): boolean => character !== "[" && character !== "]" && /^\p{P}$/u.test(character);

/** `text` trimmed, with the punctuation at either edge removed, and trimmed again. */
const bare = (text: string): string => {
  const characters = [...text.trim()];
  let start = 0;
  let end = characters.length;
  while (start < end && edgePunctuation(characters[start] as string)) start += 1;
  while (end > start && edgePunctuation(characters[end - 1] as string)) end -= 1;
  return characters.slice(start, end).join("").trim();
};

/** The forms a text is compared in, folded: as written and bare; empty ones dropped. */
const forms = (text: string): Set<string> => new Set([folded(text), folded(bare(text))].filter((form) => form !== ""));

/** Whether `candidate`, a line or the whole text, is the marker: 1 to 64 characters once trimmed, and a form of it a form of the marker. */
const isMarker = (candidate: string, marker: ReadonlySet<string>): boolean => {
  const length = [...candidate.trim()].length;
  if (length === 0 || length > MARKER_LENGTH_CAP) return false;
  return [...forms(candidate)].some((form) => marker.has(form));
};

/** Whether `text`, a firing's final text, is silent for the routine's `marker`. */
export const isSilent = (text: string, marker: string): boolean => {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  const markerForms = forms(marker);
  const own = folded(marker);
  if (own.startsWith("[") && own.endsWith("]") && folded(trimmed).startsWith(own)) return true;
  const lines = trimmed.split(/\r\n|\r|\n/u).filter((line) => line.trim() !== "");
  return [trimmed, lines[0] ?? "", lines.at(-1) ?? ""].some((candidate) => isMarker(candidate, markerForms));
};
