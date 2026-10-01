/**
 * The published cases of the silence rule (routines spec, "Silence"; #524):
 * a final text, the routine's marker, and whether the rule finds the text
 * silent, written to the JSON Schema export as `cases/silence.json` for a
 * client in another language to run its own implementation against. They
 * follow Hermes's response-filter tests, for one marker.
 */

/** One published case of the silence rule. */
export interface SilenceCase {
  /** What the case shows. */
  readonly note: string;
  /** The firing's final text. */
  readonly text: string;
  /** The routine's silence marker. */
  readonly marker: string;
  /** Whether the text is silent: the firing delivers nothing. */
  readonly silent: boolean;
}

const preset = "[SILENT]";

/** The silence rule's cases, published as `cases/silence.json`. */
export const SILENCE_CASES: readonly SilenceCase[] = [
  // The marker alone.
  { note: "the marker alone", text: "[SILENT]", marker: preset, silent: true },
  { note: "the marker padded with white space", text: "  [SILENT] \t", marker: preset, silent: true },
  { note: "the marker in lower case", text: "[silent]", marker: preset, silent: true },
  { note: "the marker between blank lines", text: "\n\n[SILENT]\n\n", marker: preset, silent: true },
  { note: "the marker in bold", text: "**[SILENT]**", marker: preset, silent: true },
  { note: "the marker with a full stop", text: "[SILENT].", marker: preset, silent: true },
  { note: "a backtick is a symbol, not punctuation, so it stays", text: "`[SILENT]`", marker: preset, silent: false },
  { note: "the marker's brackets are part of it", text: "SILENT", marker: preset, silent: false },
  { note: "a bracket is never edge punctuation, so a malformed marker stays malformed", text: "[SILENT", marker: preset, silent: false },
  // Beside a note.
  { note: "the marker on the first line, a note after it", text: "[SILENT]\n\nNothing new this tick.", marker: preset, silent: true },
  { note: "the marker on the last line, a note before it", text: "2 deals filtered\n\n[SILENT]", marker: preset, silent: true },
  { note: "the marker on the last line after Windows line ends", text: "Two releases, both seen before.\r\n\r\n[SILENT]", marker: preset, silent: true },
  { note: "the bracketed marker opening the text", text: "[SILENT] No changes detected", marker: preset, silent: true },
  { note: "the bracketed marker opening the text with no space after it", text: "[SILENT]No changes", marker: preset, silent: true },
  { note: "the bracketed marker opening a long text", text: `[SILENT] ${"Every source was read and nothing changed. ".repeat(5).trim()}`, marker: preset, silent: true },
  // Delivered.
  { note: "the marker mid-sentence", text: "The lane said [SILENT] mid-sentence and kept talking", marker: preset, silent: false },
  { note: "the marker on a middle line", text: "Checked the feeds.\n[SILENT]\nThree releases since Monday.", marker: preset, silent: false },
  { note: "the marker ending a sentence on the last line", text: "Three releases since Monday.\nNothing else, so not [SILENT]", marker: preset, silent: false },
  { note: "empty text", text: "", marker: preset, silent: false },
  { note: "white space alone", text: " \n\t \r\n", marker: preset, silent: false },
  // The 64-character bound.
  { note: "the marker after punctuation, 64 characters", text: `${"!".repeat(56)}[SILENT]`, marker: preset, silent: true },
  { note: "the marker after punctuation, 65 characters", text: `${"!".repeat(57)}[SILENT]`, marker: preset, silent: false },
  // The routine's own marker.
  { note: "a marker of words, with a full stop", text: "Nothing to report.", marker: "NOTHING TO REPORT", silent: true },
  { note: "a marker of words, its white space collapsed", text: "nothing   to\treport", marker: "NOTHING TO REPORT", silent: true },
  { note: "a marker of words over two lines, as the whole text", text: "Nothing to\nreport", marker: "NOTHING TO REPORT", silent: true },
  { note: "the preset is no marker once a routine names its own", text: "[SILENT]", marker: "NOTHING TO REPORT", silent: false },
  { note: "an own bracketed marker opening the text", text: "[quiet] the feeds were unchanged", marker: "[QUIET]", silent: true },
  { note: "an own marker without brackets does not count opening a sentence", text: "Silent retry succeeded", marker: "SILENT", silent: false },
  { note: "an own marker without brackets on its own first line", text: "Silent\nThe feeds were unchanged.", marker: "SILENT", silent: true },
  { note: "an own marker with edge punctuation, the text without it", text: "nothing new", marker: "Nothing new.", silent: true },
  { note: "an own marker with edge punctuation, the text with other punctuation", text: "Nothing new!", marker: "Nothing new.", silent: true },
  { note: "an own marker of punctuation alone, as written", text: "...", marker: "...", silent: true },
  { note: "an own marker of punctuation alone is never matched by other punctuation", text: "?", marker: "...", silent: false },
  { note: "an own marker in another script, in full-width brackets", text: "【静默】", marker: "静默", silent: true },
  { note: "an own marker in another script, with its full stop", text: "静默。", marker: "静默", silent: true },
  { note: "an own marker in another script, mid-sentence", text: "the lane said 静默 mid-sentence and kept talking", marker: "静默", silent: false },
];
