import { CONTAINMENT_LEVELS, MODES, ROUTINE_PRESETS } from "@agent-harness/contracts";

/**
 * A routine's YAML as the editor holds it (docs/specs/tui.md, "The
 * routines"; #533). The codec is the environment's (routines spec, "YAML
 * export and import"), so the terminal UI reads no YAML: it finds the line
 * an issue's path names by the documents' block layout, which is the layout
 * the environment exports, and writes the issue there as a comment.
 */

/** What starts a comment the terminal UI wrote over a line the environment refused; taken out again before the next round's. */
export const ISSUE_MARK = "# refused:";

/** One issue the environment found: the document's place among the file's routine documents, the path in it, and what is wrong. */
export interface DocumentIssue {
  readonly document: number;
  readonly path: readonly (string | number)[];
  readonly message: string;
  /** The line it names in the text sent, from 1: a YAML problem's, at the document's root. */
  readonly line?: number;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isMark = (line: string): boolean => line.trimStart().startsWith(ISSUE_MARK);
/** A line with content: neither blank nor only a comment. */
const isContent = (line: string): boolean => line.trim() !== "" && !line.trimStart().startsWith("#");
const isSeparator = (line: string): boolean => /^---(\s|$)/.test(line);

const escaped = (key: string): string => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Each routine document's lines, `[from, to)`: the parts between `---` lines that hold anything, as the environment counts them. */
const documentRanges = (lines: readonly string[]): readonly (readonly [number, number])[] => {
  const ranges: [number, number][] = [];
  let from = 0;
  for (let at = 0; at <= lines.length; at++) {
    if (at < lines.length && !isSeparator(lines[at] ?? "")) continue;
    if (lines.slice(from, at).some(isContent)) ranges.push([from, at]);
    from = at + 1;
  }
  return ranges;
};

/**
 * The line `path` names in `lines[from, to)`: a key's, a sequence item's
 * dash, at the depth the path reaches. A value written on its key's line (a
 * scalar, a flow map) is as deep as it goes: an issue inside it is put on
 * that line, as is one whose next step is not found.
 */
const lineOf = (lines: readonly string[], from: number, to: number, path: readonly (string | number)[]): number => {
  // A sequence item's dash line reads as its first key, indented past the dash.
  let item: { readonly at: number; readonly text: string } | null = null;
  const text = (at: number): string => (item?.at === at ? item.text : (lines[at] ?? ""));
  const content = (start: number, end: number) => Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i).filter((at) => isContent(text(at)));
  let found = content(from, to)[0] ?? from;
  let scope: readonly [number, number] = [from, to];
  for (const step of path) {
    const inside = content(scope[0], scope[1]);
    if (inside.length === 0) break;
    const depth = Math.min(...inside.map((at) => indentOf(text(at))));
    const level = inside.filter((at) => indentOf(text(at)) === depth);
    // Where what starts at `at` ends: the next line of content at its depth or shallower, a sequence's items under a key at its own depth kept with it.
    const end = (at: number, sequence: boolean) =>
      inside.find((next) => next > at && (indentOf(text(next)) < depth || (indentOf(text(next)) === depth && !(sequence && /^-(\s|$)/.test(text(next).trimStart()))))) ?? scope[1];
    if (typeof step === "number") {
      const dash = level.filter((at) => /^-(\s|$)/.test(text(at).trimStart()))[step];
      if (dash === undefined) break;
      found = dash;
      item = { at: dash, text: text(dash).replace(/^(\s*)-/, "$1 ") };
      scope = [dash, end(dash, false)];
      continue;
    }
    const key = new RegExp(`^(["']?)${escaped(step)}\\1\\s*:(\\s|$)`);
    const at = level.find((line) => key.test(text(line).trimStart()));
    if (at === undefined) break;
    found = at;
    const value = text(at)
      .trimStart()
      .replace(key, "")
      .trim();
    if (value !== "" && !value.startsWith("#") && !/^[|>]/.test(value)) break;
    scope = [at + 1, end(at, true)];
  }
  return found;
};

/** Where an issue is in its document, as a person reads the document: `schedule.day`, `delivery[1].on`. */
export const pathWords = (path: readonly (string | number)[]): string =>
  path
    .map((step) => (typeof step === "number" ? `[${step}]` : step))
    .join(".")
    .replace(/\.\[/g, "[");

/** An issue as its comment says it: where in the document, unless at its root, and what is wrong, on one line. */
const commentOf = (issue: DocumentIssue): string => {
  const where = pathWords(issue.path);
  return `${ISSUE_MARK} ${where === "" ? "" : `${where}: `}${issue.message.replace(/\s+/g, " ").trim()}`;
};

/**
 * `yaml` with each issue written as a comment over the line its path names,
 * indented as that line is, and the comments an earlier round wrote taken
 * out. An issue whose document is not found goes at the top.
 */
export const annotated = (yaml: string, issues: readonly DocumentIssue[]): string => {
  const lines = yaml.split("\n");
  const ranges = documentRanges(lines);
  const over = new Map<number, string[]>();
  for (const issue of issues) {
    const range = ranges[issue.document];
    const target = issue.line !== undefined && issue.line >= 1 && issue.line <= lines.length ? issue.line - 1 : range ? lineOf(lines, range[0], range[1], issue.path) : 0;
    // A comment of an earlier round is taken out: one over it goes over the line after it.
    let at = target;
    while (at < lines.length - 1 && isMark(lines[at] ?? "")) at++;
    over.set(at, [...(over.get(at) ?? []), commentOf(issue)]);
  }
  return lines.flatMap((line, at) => [...(over.get(at) ?? []).map((comment) => `${" ".repeat(indentOf(line))}${comment}`), ...(isMark(line) ? [] : [line])]).join("\n");
};

/**
 * Whether a document asks for `bypassPermissions`, read from its top-level
 * `mode` line: what the confirmation goes by when the environment cannot be
 * asked (`routines.checkImport`), so a routine saved offline asks it too.
 */
export const asksBypass = (yaml: string): boolean => /^mode\s*:\s*(["']?)bypassPermissions\1\s*(#.*)?$/m.test(yaml);

/** How many routine documents `yaml` holds, as the environment counts them: what an import offline mints its ids by. */
export const documentCount = (yaml: string): number => documentRanges(yaml.split("\n")).length;

/**
 * `/routines new`'s template (#533): a routine document with every key, the
 * presets written in (`ROUTINE_PRESETS`), each key's choices in a comment
 * over it. Saved as it is, it makes nothing: an edit saved unchanged sends
 * nothing.
 */
export const ROUTINE_TEMPLATE = [
  "# A new routine: set its name, when it runs and what it does, then save and close the",
  "# editor to make it on this environment. Close it without saving to make nothing.",
  "# A key with a preset may be left out; each comment says what a key takes.",
  "kind: routine",
  "version: 1",
  "name: New routine",
  "enabled: true",
  `# ${["manual", "hourly", "daily", "weekdays", "weekly", "days", "monthly", "cron"].join(", ")}; for example`,
  '# { kind: weekly, day: monday, at: "09:00" } or { kind: cron, expression: "*/30 9-17 * * 1-5" }',
  'schedule: { kind: daily, at: "09:00" }',
  "# An IANA zone, such as Europe/London; left out, this environment's own.",
  "# timezone: Europe/London",
  "# run-once fires the latest due time missed while the environment was down, within seven days; skip skips them.",
  `if-missed: ${ROUTINE_PRESETS.ifMissed}`,
  "# A directory ({ kind: directory, path: ~/code/project }), a worktree made per firing",
  "# ({ kind: worktree, repository: ~/code/project }), or a scratch directory made per firing.",
  "workspace: { kind: scratch }",
  "# { provider: claude, email: you@example.com, organisation: null }; null for the default account.",
  "account: null",
  "# null for the strongest model of the account's family, and its default effort.",
  "model: null",
  "effort: null",
  `# ${MODES.join(", ")}; null for the unattended mode in the settings.`,
  "mode: null",
  `# ${CONTAINMENT_LEVELS.join(", ")}; null for the containment in the settings.`,
  "containment: null",
  "# Whether a firing's run gets the forge's credentials: inherit, allow or deny.",
  `injection: ${ROUTINE_PRESETS.injection}`,
  "# Names from the skill set, loaded for every run of a firing.",
  "skills: []",
  "# What runs first, whose unchanged output skips the firing: a script in the scripts directory",
  "# ({ kind: script, path: check.sh, timeout-seconds: 60 }) or a URL ({ kind: url, url: https://example.com/feed }).",
  "pre-check: null",
  "# The final text that delivers nothing.",
  `silent-marker: "${ROUTINE_PRESETS.silenceMarker}"`,
  `max-duration-minutes: ${ROUTINE_PRESETS.maxDurationMinutes}`,
  "# Up to eight targets, each on success, failure or both: client-notice, or a webhook endpoint by its name",
  "# ({ kind: webhook, target: hermes-home, on: success }).",
  "delivery:",
  ...ROUTINE_PRESETS.delivery.map((target) => `  - { kind: ${target.kind}, on: ${target.on} }`),
  "instructions: |-",
  "  Say what this routine should do each time it fires.",
  "",
].join("\n");
