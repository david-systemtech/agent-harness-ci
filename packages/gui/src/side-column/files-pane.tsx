import { binaryNote, browse, directoryOf, fileMarks, formatBytes, LOCAL_PLACEHOLDER_ID, type RequestAnswer } from "@agent-harness/client-runtime";
import { FILES_LIST_CAP } from "@agent-harness/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CornerLeftUp, File, FileCode, FileImage, FileJson, FileText, Folder, RefreshCw, Pin, PinOff, Copy } from "lucide-react";
import { Button, IconButton, Tooltip } from "../ui/index.js";
import { useObservable, useRuntime, useShell } from "../window-context.js";
import { Highlighted, fileLineCount, FILE_DISPLAY_LINES } from "./highlighted.js";

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

/** Measured file-kind colours; filenames remain neutral and readable. */
const fileIcon = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const extension = name.slice(name.lastIndexOf(".") + 1);
  if (["ts", "tsx", "js", "jsx", "py", "rs", "go", "sh", "css", "html", "c", "cpp", "java", "rb"].includes(extension)) return { icon: FileCode, colour: "text-cyan" };
  if (["json", "yaml", "yml", "toml", "ini", "env", "lock"].includes(extension)) return { icon: FileJson, colour: "text-amber" };
  if (["md", "markdown", "txt", "rst"].includes(extension)) return { icon: FileText, colour: "text-ink-muted" };
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(extension)) return { icon: FileImage, colour: "text-sage" };
  return { icon: File, colour: "text-ink-faint" };
};

/** The workspace root or the current relative directory. */
const directoryName = (directory: string) => (directory === "" ? "The workspace" : `${directory}/`);

export const FilesPane = ({ environmentId, sessionId, place, go }: FilesPaneProps) => {
  const runtime = useRuntime();
  // File-view shortcuts are pane-local presentation, independent of session organisation.
  const [savedFiles, setSavedFiles] = useState<readonly string[]>([]);
  const [readSizes, setReadSizes] = useState<ReadonlyMap<string, number>>(() => new Map());
  const listing = useObservable(useMemo(() => runtime.requests.cached(environmentId, "files.list", { sessionId }), [runtime, environmentId, sessionId]));
  const rows = useMemo(() => (listing.result === null ? null : browse(listing.result.files, place.directory, "")), [listing.result, place.directory]);
  const currentFile = place.file;
  if (currentFile !== null) {
    return (
      <FileView
        environmentId={environmentId}
        sessionId={sessionId}
        path={currentFile}
        sized={(size) => setReadSizes((held) => new Map(held).set(currentFile, size))}
        pinned={savedFiles.includes(currentFile)}
        pin={() => setSavedFiles((held) => held.includes(currentFile) ? held.filter((path) => path !== currentFile) : [...held, currentFile])}
        back={() => go({ directory: place.directory, file: null })}
        directory={(path) => go({ directory: path, file: null })}
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-files-caption className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 py-1">
        <IconButton label="Go up" keys="Enter / Space"
          {...(place.directory === "" && { disabledReason: "Already at the workspace root" })}
          size="icon-xs" onClick={() => go({ directory: directoryOf(place.directory), file: null })}><ArrowLeft aria-hidden="true" /></IconButton>
        <Folder aria-hidden="true" className="size-3.5 shrink-0 text-beam-text" />
        <h3 title={directoryName(place.directory)} className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{directoryName(place.directory)}</h3>
        <IconButton label="Refresh files" keys="Enter / Space" size="icon-xs" onClick={() => { setReadSizes(new Map()); runtime.requests.refresh(environmentId, "files.list", { sessionId }); }}><RefreshCw aria-hidden="true" /></IconButton>
      </div>
      {savedFiles.length > 0 && <div role="region" aria-label="Pinned files" style={{ maxHeight: 96, overflowY: "auto" }} className="flex shrink-0 flex-col border-b border-hairline p-1">
        {savedFiles.map((path) => <Tooltip key={path} content={`Open pinned ${path}`} keys="Enter / Space"><Button aria-label={`Open pinned ${path}`} size="xs" className="justify-start" onClick={() => go({ directory: directoryOf(path), file: path })}><Pin aria-hidden="true" /><span className="truncate font-mono">{path}</span></Button></Tooltip>)}
      </div>}
      {listing.result?.truncated === true && (
        <p className="px-3 text-xs text-amber">{`The workspace holds more than the ${FILES_LIST_CAP.toLocaleString("en")} files listed; the rest are not shown.`}</p>
      )}
      {rows === null ? (
        <p className="px-3 py-1 text-sm text-ink-faint">{listing.error === null ? "Listing…" : `Not listed: ${listing.error.message}`}</p>
      ) : rows.length === 0 ? (
        <p className="px-3 py-1 text-sm text-ink-faint">Nothing here.</p>
      ) : (
        <ul aria-label={`In ${directoryName(place.directory)}`} className="min-h-0 flex-1 overflow-y-auto p-[6px]">
          {rows.map((row) => {
            const { icon: Icon, colour } = row.kind === "file" ? fileIcon(row.path) : { icon: row.kind === "up" ? CornerLeftUp : Folder, colour: "text-beam-text" };
            const size = readSizes.get(row.path);
            return <li key={`${row.kind} ${row.path}`}>
              <Tooltip content={row.kind === "up" ? `Up to ${directoryName(row.path)}` : row.path} keys="Enter / Space to open">
                <button type="button" aria-label={row.kind === "up" ? `Up to ${directoryName(row.path)}` : undefined}
                  data-file-row className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-ink outline-none hover:bg-wash focus-visible:bg-wash focus-visible:outline-2 focus-visible:outline-beam"
                  onClick={() => go(row.kind === "file" ? { directory: place.directory, file: row.path } : { directory: row.path, file: null })}>
                  <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${colour}`} />
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  {row.kind === "file" && size !== undefined && <>{" "}<span className="shrink-0 font-mono text-2xs text-ink-faint">{formatBytes(size)}</span></>}
                  {row.kind === "dir" && <>{" "}<span className="shrink-0 font-mono text-2xs text-ink-faint">{`${String(row.files)} ${row.files === 1 ? "file" : "files"}`}</span></>}
                </button>
              </Tooltip>
            </li>;
          })}
        </ul>
      )}
    </div>
  );
};

interface FileViewProps {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly path: string;
  readonly pinned: boolean;
  pin(): void;
  sized(size: number): void;
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
const FileView = ({ environmentId, sessionId, path, back, directory, pinned, pin, sized }: FileViewProps) => {
  const runtime = useRuntime();
  const shell = useShell();
  const clipboard = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.clipboard").status === "present" ? shell?.clipboard : undefined;
  const [copyNote, setCopyNote] = useState<{ readonly path: string; readonly message: string } | null>(null);
  const [read, setRead] = useState<{ readonly path: string; readonly answer: RequestAnswer<"files.read"> } | null>(null);
  // The pane's latest way to a directory: the read is made again only for another file.
  const toDirectory = useRef(directory);
  const onSize = useRef(sized);
  useLayoutEffect(() => {
    toDirectory.current = directory;
    onSize.current = sized;
  });
  useEffect(() => {
    let current = true;
    void runtime.requests.call(environmentId, "files.read", { sessionId, path }).then((answer) => {
      if (!current) return;
      if (!answer.ok && answer.error.data?.["reason"] === "not_a_file") toDirectory.current(path);
      else {
        setRead({ path, answer });
        if (answer.ok) onSize.current(answer.result.size);
      }
    });
    return () => {
      current = false;
    };
  }, [runtime, environmentId, sessionId, path]);
  const answer = read?.path === path ? read.answer : null;
  const from = directoryOf(path);
  const text = answer?.ok === true && !answer.result.binary ? answer.result.text : null;
  const lines = text === null ? 0 : fileLineCount(text);
  const copyReason = clipboard === undefined ? "This client has no clipboard" : text === null ? "No text to copy"
    : answer?.ok === true && answer.result.truncated ? "Only the first 2 MiB were read"
    : lines > FILE_DISPLAY_LINES ? "Only the first 20,000 lines are displayed" : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-file-header className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 py-1">
        <IconButton label={`Back to ${directoryName(from)}`} keys="Enter / Space" size="icon-xs" onClick={back}><ArrowLeft aria-hidden="true" /></IconButton>
        <FileCode aria-hidden="true" className="size-3.5 shrink-0 text-cyan" />
        <h3 aria-label={answer?.ok === true ? `${path} · ${fileMarks(answer.result).join(" · ")}` : path} title={path} className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
          <span className="font-semibold">{path}</span>
          {answer?.ok === true && <span className="text-ink-muted">{` · ${fileMarks(answer.result).join(" · ")}`}</span>}
        </h3>
        <IconButton label={pinned ? "Unpin file" : "Pin file"} keys="Enter / Space" size="icon-xs" aria-pressed={pinned} onClick={pin}>{pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}</IconButton>
        <IconButton label="Copy file" keys="Enter / Space" size="icon-xs" {...(copyReason !== undefined && { disabledReason: copyReason })} onClick={() => {
          if (clipboard !== undefined && text !== null && copyReason === undefined) void clipboard.writeText(text).then(
            () => setCopyNote({ path, message: "Copied file." }), () => setCopyNote({ path, message: "File could not be copied." }),
          );
        }}><Copy aria-hidden="true" /></IconButton>
      </div>
      {text !== null && <p className="shrink-0 px-3 py-1 font-mono text-2xs text-ink-faint">{`${lines.toLocaleString("en")} ${lines === 1 ? "line" : "lines"}`}</p>}
      {copyNote?.path === path && <p role="status" className="px-3 font-mono text-2xs text-ink-muted">{copyNote.message}</p>}
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
