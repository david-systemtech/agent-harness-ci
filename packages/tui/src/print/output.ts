import type { CompletionUsage, RunEndReason } from "@agent-harness/contracts";

/** What standard output carries: the answer's text, one JSON result, or each chunk as a JSON line and then the result. */
export const PRINT_FORMATS = ["text", "json", "stream-json"] as const;
export type PrintFormat = (typeof PRINT_FORMATS)[number];

/**
 * The one result the JSON formats end with, whatever became of the turn
 * (docs/specs/switch-over.md L101): the ids as far as they were learned, the
 * answer's text, the usage the run reported (never made up), how long the
 * print took, and how it ended: the run's end reason as the answer gave it,
 * `interrupted` after SIGINT, and `error` for a failure no run end names,
 * with its message.
 */
export interface PrintResult {
  readonly type: "result";
  /** Null when no environment was chosen. */
  readonly environmentId: string | null;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly text: string;
  readonly usage: CompletionUsage | null;
  readonly durationMs: number;
  readonly reason: RunEndReason;
  readonly error: string | null;
}

/** Standard output in one format: the text as it comes, each chunk as it comes, and the end. */
export interface FormatWriter {
  /** One chunk as the answer sent it, parsed. */
  chunk(raw: unknown, content: string | undefined): void;
  /** The end: the result, and in text the final newline after any text, or after a completed turn's. */
  end(result: PrintResult, completed: boolean): void;
}

export const formatWriter = (format: PrintFormat, stdout: (text: string) => void): FormatWriter => {
  let wrote = false;
  return {
    chunk(raw, content) {
      if (format === "stream-json") stdout(`${JSON.stringify(raw)}\n`);
      else if (format === "text" && content !== undefined && content !== "") {
        stdout(content);
        wrote = true;
      }
    },
    end(result, completed) {
      if (format !== "text") stdout(`${JSON.stringify(result)}\n`);
      else if (wrote || completed) stdout("\n");
    },
  };
};
