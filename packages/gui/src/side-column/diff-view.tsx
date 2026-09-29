import { useMemo } from "react";
import { classes } from "../ui/classes.js";

/**
 * A unified diff as the window draws one (docs/specs/gui.md, "The seven
 * panes and the grid": the diff view), coloured as `git diff` colours it,
 * each colour a token: a file's header lines strong, a hunk's line cyan,
 * what was added sage, what was removed in the danger colour, the context as
 * it is.
 */

type LineKind = "header" | "hunk" | "added" | "removed" | "context";

const HEADERS = /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|Binary files )/;

const kindOf = (line: string): LineKind => {
  if (HEADERS.test(line)) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
};

const COLOURS: Readonly<Record<LineKind, string>> = {
  header: "font-semibold text-ink",
  hunk: "text-cyan",
  added: "bg-wash text-sage",
  removed: "bg-wash text-signal",
  context: "text-ink-muted",
};

/** `text`, a unified diff, one line to a row. */
export const DiffView = ({ text }: { readonly text: string }) => {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  return (
    <pre className="overflow-x-auto rounded-md border border-hairline bg-inset py-1 font-mono text-xs">
      {lines.map((line, index) => (
        <div key={index} className={classes("px-2 whitespace-pre", COLOURS[kindOf(line)])}>
          {line.length === 0 ? " " : line}
        </div>
      ))}
    </pre>
  );
};
