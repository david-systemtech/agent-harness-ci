import { FilePenLine, FilePlus2 } from "lucide-react";
import { useMemo } from "react";
import { classes } from "../ui/classes.js";

type LineKind = "header" | "hunk" | "added" | "removed" | "context";
interface DiffLine {
  readonly text: string;
  readonly kind: LineKind;
  readonly old: number | null;
  readonly next: number | null;
}
const HEADERS = /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|Binary files )/;
const COLOURS: Readonly<Record<LineKind, string>> = {
  header: "font-semibold text-ink", hunk: "bg-wash-strong text-ink-faint",
  added: "bg-mint/8 text-mint", removed: "bg-signal/8 text-signal", context: "text-ink-faint",
};

/** Parse each hunk's own coordinates; metadata and no-newline markers consume neither side. */
const readDiff = (text: string) => {
  const input = text.replace(/\n$/, "").split("\n", 20_001);
  let old = 0, next = 0, oldRemaining = 0, nextRemaining = 0, inHunk = false;
  const lines: DiffLine[] = [];
  for (const text of input.slice(0, 20_000)) {
    let kind: LineKind = "context", before: number | null = null, after: number | null = null;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (text.startsWith("diff --git ") || (!inHunk && HEADERS.test(text))) { kind = "header"; inHunk = false; }
    else if (hunk) { kind = "hunk"; old = Number(hunk[1]); next = Number(hunk[3]); oldRemaining = Number(hunk[2] ?? 1); nextRemaining = Number(hunk[4] ?? 1); inHunk = true; }
    else if (inHunk && text.startsWith("+")) { kind = "added"; after = next++; nextRemaining--; }
    else if (inHunk && text.startsWith("-")) { kind = "removed"; before = old++; oldRemaining--; }
    else if (inHunk && text.startsWith(" ")) { before = old++; oldRemaining--; after = next++; nextRemaining--; }
    if (oldRemaining <= 0 && nextRemaining <= 0) inHunk = false;
    lines.push({ text, kind, old: before, next: after });
    if (lines.length === 600) break;
  }
  return { lines, clipped: input.length > lines.length };
};

/** Pair replacement rows, highlighting the changed middle without marking it as a search match. */
const changedRanges = (lines: readonly DiffLine[]) => {
  const ranges = new Map<number, readonly [number, number]>();
  for (let at = 0; at < lines.length; at++) {
    if (lines[at]?.kind !== "removed") continue;
    const removed = at;
    while (lines[at]?.kind === "removed") at++;
    const added = at;
    while (lines[at]?.kind === "added") at++;
    for (let offset = 0; offset < Math.min(added - removed, at - added); offset++) {
      const before = lines[removed + offset]?.text ?? "", after = lines[added + offset]?.text ?? "";
      let start = 1, tail = 0;
      while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
      while (tail < Math.min(before.length, after.length) - start && before[before.length - tail - 1] === after[after.length - tail - 1]) tail++;
      ranges.set(removed + offset, [start, before.length - tail]);
      ranges.set(added + offset, [start, after.length - tail]);
    }
    at--;
  }
  return ranges;
};

/** Draw supplied unified diffs identically in tool cards and the Diff pane (look.md §8.2). */
export const DiffView = ({ text }: { readonly text: string }) => {
  const { lines, clipped } = useMemo(() => readDiff(text), [text]);
  const ranges = useMemo(() => changedRanges(lines), [lines]);
  return <div data-diff className="min-w-0 border border-hairline bg-wash">
    <div data-diff-body className="max-h-96 overflow-auto font-mono text-2xs leading-[1.45]">
      {lines.map((line, index) => {
        const range = ranges.get(index);
        const fileHeader = line.kind === "header" && line.text.startsWith("+++ ");
        const oldPath = lines[index - 1]?.text.slice(4).replace(/^a\//, "");
        const path = fileHeader ? (line.text === "+++ /dev/null" ? oldPath ?? "Deleted file" : line.text.slice(4).replace(/^b\//, "")) : null;
        // Unified metadata is consumed by the parser; the visible file header is one path row.
        if (line.kind === "header" && (line.text.startsWith("--- ") || line.text.startsWith("index ") || (line.text.startsWith("diff --git ") && lines.slice(index + 1).some((candidate) => candidate.text.startsWith("+++ "))))) return null;
        const end = lines.findIndex((candidate, next) => next > index && candidate.kind === "header");
        const changes = path === null ? [] : lines.slice(index + 1, end < 0 ? undefined : end);
        const writing = path !== null && lines[index - 1]?.text === "--- /dev/null";
        const Icon = writing ? FilePlus2 : FilePenLine;
        return <div key={index} className={classes("flex min-w-max whitespace-pre", COLOURS[line.kind])}>
          {line.kind !== "header" && <>
            <span data-diff-gutter aria-hidden="true" className="w-10 shrink-0 select-none border-r border-hairline px-1 text-right text-ink-faint/70">{line.old}</span>
            <span data-diff-gutter aria-hidden="true" className="w-10 shrink-0 select-none border-r border-hairline px-1 text-right text-ink-faint/70">{line.next}</span>
          </>}
          <span className={classes("px-2.5", line.kind === "header" && "flex items-center gap-2 py-1")}>
            {path !== null && <Icon aria-hidden="true" className="size-3 shrink-0" />}
            {line.text.startsWith("new file mode") && <FilePlus2 aria-hidden="true" className="size-3 shrink-0" />}
            {range === undefined ? (path ?? (line.text.length === 0 ? " " : line.text)) : <>{line.text.slice(0, range[0])}<span data-diff-change className={classes("rounded-[2px] px-px", line.kind === "added" ? "bg-mint/25" : "bg-signal/25")}>{line.text.slice(range[0], range[1])}</span>{line.text.slice(range[1])}</>}
          {path !== null && <><span className="rounded-sm bg-wash-strong px-1 text-ink-muted">{path.split(".").at(-1)}</span>{!clipped && <><span className="text-mint">+{changes.filter((change) => change.kind === "added").length}</span><span className="text-signal">-{changes.filter((change) => change.kind === "removed").length}</span></>}</>}
          </span>
        </div>;
      })}
    </div>
    {clipped && <p className="border-t border-hairline px-2.5 py-1 text-xs text-amber">Diff clipped: showing at most 600 rows and reading at most 20000 lines.</p>}
  </div>;
};

/** An edit supplies the replaced fragment, not the whole file; coordinates are relative to that fragment. */
export const editDiff = (input: Readonly<Record<string, unknown>>): { readonly text: string; readonly added: number; readonly removed: number } | null => {
  const before = input["old_string"], after = input["new_string"], content = input["content"];
  if (typeof after !== "string" && typeof content !== "string") return null;
  const writing = typeof content === "string" && typeof after !== "string";
  const oldText = writing ? "" : typeof before === "string" ? before : null;
  if (oldText === null) return null;
  const nextText = writing ? content : after;
  if (typeof nextText !== "string") return null;
  const oldLines = oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n", 20_001);
  const nextLines = nextText === "" ? [] : nextText.replace(/\n$/, "").split("\n", 20_001);
  const path = input["file_path"] ?? input["filePath"] ?? input["path"];
  const name = typeof path === "string" ? path : "Changed fragment";
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(oldLines.length, nextLines.length) && oldLines[prefix] === nextLines[prefix]) prefix++;
  while (suffix < Math.min(oldLines.length, nextLines.length) - prefix && oldLines[oldLines.length - suffix - 1] === nextLines[nextLines.length - suffix - 1]) suffix++;
  const removed = oldLines.length - prefix - suffix, added = nextLines.length - prefix - suffix;
  const start = Math.max(0, prefix - 3), tail = Math.min(3, suffix);
  const body = [
    ...oldLines.slice(start, prefix).map((line) => ` ${line}`),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((line) => `-${line}`),
    ...nextLines.slice(prefix, nextLines.length - suffix).map((line) => `+${line}`),
    ...nextLines.slice(nextLines.length - suffix, nextLines.length - suffix + tail).map((line) => ` ${line}`),
  ];
  return { text: [`--- ${writing ? "/dev/null" : name}`, `+++ ${name}`, `@@ -${oldLines.length === 0 ? 0 : start + 1},${prefix - start + removed + tail} +${nextLines.length === 0 ? 0 : start + 1},${prefix - start + added + tail} @@`, ...body].join("\n"), added, removed };
};
