import { binaryNote, browse, directoryOf, fileMarks, type RequestAnswer } from "@agent-harness/client-runtime";
import { FILES_LIST_CAP } from "@agent-harness/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { Highlighted } from "./highlighted.js";

/**
 * The Files pane (docs/specs/gui.md, "The seven panes and the grid"): the
 * session's workspace one directory at a time from `files.list` (in the
 * request cache, as the composer's `@` reads it), its directories first with
 * how many files each holds, then its files, and a way up below the top; a
 * file opens in the file view through `files.read`. Where it is is the side
 * column's (`/files <path>` moves it), so it comes back as it was left.
 */

/** Where the Files pane is: a directory of the workspace ("" its top), and the file open in it, if one is. */
export interface FilesPlace {
  readonly directory: string;
  readonly file: string | null;
}

/** The workspace's top, with no file open. */
export const WORKSPACE_TOP: FilesPlace = Object.freeze({ directory: "", file: null });

export interface FilesPaneProps {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly place: FilesPlace;
  go(place: FilesPlace): void;
}

/** What a directory is called above its rows: the workspace's top, or its path. */
const directoryName = (directory: string) => (directory === "" ? "The workspace" : `${directory}/`);

export const FilesPane = ({ environmentId, sessionId, place, go }: FilesPaneProps) => {
  const runtime = useRuntime();
  const listing = useObservable(useMemo(() => runtime.requests.cached(environmentId, "files.list", { sessionId }), [runtime, environmentId, sessionId]));
  const rows = useMemo(() => (listing.result === null ? null : browse(listing.result.files, place.directory, "")), [listing.result, place.directory]);
  if (place.file !== null) {
    return (
      <FileView
        environmentId={environmentId}
        sessionId={sessionId}
        path={place.file}
        back={() => go({ directory: place.directory, file: null })}
        directory={(path) => go({ directory: path, file: null })}
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h3 className="shrink-0 truncate px-3 pt-2 pb-1 font-mono text-xs font-semibold text-ink">{directoryName(place.directory)}</h3>
      {listing.result?.truncated === true && (
        <p className="px-3 text-xs text-amber">{`The workspace holds more than the ${FILES_LIST_CAP.toLocaleString("en")} files listed; the rest are not shown.`}</p>
      )}
      {rows === null ? (
        <p className="px-3 py-1 text-sm text-ink-faint">{listing.error === null ? "Listing…" : `Not listed: ${listing.error.message}`}</p>
      ) : rows.length === 0 ? (
        <p className="px-3 py-1 text-sm text-ink-faint">Nothing here.</p>
      ) : (
        <ul aria-label={`In ${directoryName(place.directory)}`} className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {rows.map((row) => (
            <li key={`${row.kind} ${row.path}`}>
              <button
                type="button"
                aria-label={row.kind === "up" ? `Up to ${directoryName(row.path)}` : undefined}
                className="flex w-full min-w-0 items-baseline gap-2 rounded-sm px-2 py-0.5 text-left font-mono text-xs text-ink outline-none hover:bg-wash focus-visible:bg-wash"
                onClick={() => go(row.kind === "file" ? { directory: place.directory, file: row.path } : { directory: row.path, file: null })}
              >
                <span className={row.kind === "file" ? "truncate" : "truncate text-beam-text"}>{row.name}</span>
                {row.kind === "dir" && (
                  <>
                    {" "}
                    <span className="shrink-0 text-ink-faint">{`${String(row.files)} ${row.files === 1 ? "file" : "files"}`}</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

interface FileViewProps {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly path: string;
  /** Back to the directory the file was opened from. */
  back(): void;
  /** The path named a directory, not a file: open it instead. */
  directory(path: string): void;
}

/**
 * A file read through `files.read`, highlighted: marked with its size, and
 * with "the first 2 MiB" when only its head was read; a binary file is said,
 * never drawn. Read each time it is opened.
 */
const FileView = ({ environmentId, sessionId, path, back, directory }: FileViewProps) => {
  const runtime = useRuntime();
  const [read, setRead] = useState<{ readonly path: string; readonly answer: RequestAnswer<"files.read"> } | null>(null);
  // The pane's latest way to a directory: the read is made again only for another file.
  const toDirectory = useRef(directory);
  useLayoutEffect(() => {
    toDirectory.current = directory;
  });
  useEffect(() => {
    let current = true;
    void runtime.requests.call(environmentId, "files.read", { sessionId, path }).then((answer) => {
      if (!current) return;
      if (!answer.ok && answer.error.data?.["reason"] === "not_a_file") toDirectory.current(path);
      else setRead({ path, answer });
    });
    return () => {
      current = false;
    };
  }, [runtime, environmentId, sessionId, path]);
  const answer = read?.path === path ? read.answer : null;
  const from = directoryOf(path);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-2 pt-1.5 pb-1">
        <Button className="h-7 shrink-0 px-2 text-xs" onClick={back}>
          {`Back to ${directoryName(from)}`}
        </Button>
      </div>
      <h3 className="shrink-0 truncate px-3 pb-1 font-mono text-xs text-ink">
        <span className="font-semibold">{path}</span>
        {answer?.ok === true && (
          <>
            {" · "}
            <span className="text-ink-muted">{fileMarks(answer.result).join(" · ")}</span>
          </>
        )}
      </h3>
      {answer === null ? (
        <p className="px-3 py-1 text-sm text-ink-faint">Reading…</p>
      ) : !answer.ok ? (
        <p className="px-3 py-1 text-sm text-ink-faint">{`Not read: ${answer.error.message}`}</p>
      ) : answer.result.binary || answer.result.text === null ? (
        <p className="px-3 py-1 text-sm text-ink-faint">{binaryNote(answer.result.size)}</p>
      ) : (
        <Highlighted path={path} text={answer.result.text} />
      )}
    </div>
  );
};
