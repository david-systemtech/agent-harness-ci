import type { RequestAnswer } from "@agent-harness/client-runtime";
import { WORKSPACES_BROWSE_CAP } from "@agent-harness/contracts";
import { useEffect, useState } from "react";
import { Switch } from "../ui/index.js";
import { DialogAction as Button } from "../ui/dialog-action.js";
import { ArrowLeft, Folder, Eye } from "lucide-react";
import { Tooltip } from "../ui/tooltip.js";
import { useRuntime } from "../window-context.js";
import { Entry, PickerLine, ViewTitle } from "./parts.js";

/**
 * Browsing an environment's directories (workspace-picker spec, "Browsing
 * an environment's directories"; #421): `workspaces.browse` on the
 * environment the picker is on, since this computer's own dialog cannot see
 * another machine. The directory listed is taken by its first button, `..`
 * goes up to its parent, each subdirectory (a repository's root marked) is
 * gone into, dot-directories are listed on a switch, and a directory holding
 * more than were listed says so.
 */

/** Where a browse starts and how it lists: from `path` (the home when absent), dot-directories or not. */
export interface BrowseAt {
  readonly path: string | undefined;
  readonly hidden: boolean;
}

export interface BrowseProps {
  readonly environmentId: string;
  /** The environment's name, as the picker says it. */
  readonly where: string;
  readonly at: BrowseAt;
  /** What the first button says of the directory listed ("Work in /home/milo"). */
  readonly takeWords: (path: string) => string;
  /** Takes the directory listed. */
  take(path: string): void;
  /** Browses another directory, Back returning here. */
  go(path: string): void;
  /** Lists the directory again with the dot-directories shown or not, in this one's place: Back returns where this one's does. */
  relist(at: BrowseAt): void;
  back(): void;
  /** What the picker says now of a choice, over the listing's own line. */
  readonly line: string | undefined;
  /** Whether a choice waits for the environment's answer: nothing else is chosen meanwhile. */
  readonly waiting: boolean;
}

/** A directory's child `name`, in its separator. */
const childOf = (path: string, name: string): string => {
  const separator = /^[A-Za-z]:\\|^\\\\/.test(path) ? "\\" : "/";
  return path.endsWith("/") || path.endsWith("\\") ? `${path}${name}` : `${path}${separator}${name}`;
};

/** What went wrong asking to list `path`, in one line. */
const refusedLine = (failure: Extract<RequestAnswer<"workspaces.browse">, { readonly ok: false }>["error"], path: string, where: string): string => {
  if (failure.code === "not_found") return `${path} is not a directory on ${where}.`;
  if (failure.data?.["reason"] === "not_readable") return `${where} cannot list ${path}.`;
  return `${where} could not list ${path}: ${failure.message}`;
};

export const Browse = ({ environmentId, where, at, takeWords, take, go, relist, back, line, waiting }: BrowseProps) => {
  const runtime = useRuntime();
  const [answer, setAnswer] = useState<RequestAnswer<"workspaces.browse"> | null>(null);
  useEffect(() => {
    let current = true;
    setAnswer(null);
    void runtime.requests
      .call(environmentId, "workspaces.browse", { ...(at.path !== undefined && { path: at.path }), ...(at.hidden && { hidden: true }) })
      .then((listed) => current && setAnswer(listed));
    return () => {
      current = false;
    };
  }, [runtime, environmentId, at.path, at.hidden]);

  const asked = at.path ?? `${where}'s home`;
  const listing = answer?.ok === true ? answer.result : undefined;
  const parent = listing?.parent ?? null;
  const own = answer === null ? `Listing ${asked}…` : !answer.ok ? refusedLine(answer.error, asked, where) : listing?.truncated === true ? TRUNCATED : undefined;
  return (
    <>
      <ViewTitle>
        Browse {where}: {listing?.path ?? asked}
      </ViewTitle>
      {listing !== undefined && (
        <>
          <Button icon={Folder} className="self-start" disabled={waiting} onClick={() => take(listing.path)}>
            {takeWords(listing.path)}
          </Button>
          <ul aria-label={`Directories in ${listing.path}`} className="flex max-h-64 flex-col overflow-y-auto">
            {parent !== null && <Entry name=".." detail={`up to ${parent}`} disabled={waiting} choose={() => go(parent)} />}
            {listing.directories.map((directory) => (
              <Entry
                key={directory.name}
                name={`${directory.name}/`}
                detail={directory.repository ? "repository" : undefined}
                disabled={waiting}
                choose={() => go(childOf(listing.path, directory.name))}
              />
            ))}
          </ul>
        </>
      )}
      <label className="flex items-center gap-2 text-xs text-ink-muted">
        <Tooltip content="Dot-directories" keys="Space"><Switch aria-label="Dot-directories" checked={at.hidden} disabled={waiting} onCheckedChange={(hidden) => relist({ path: listing?.path ?? at.path, hidden })} /></Tooltip><Eye aria-hidden="true" className="size-4" />
        Dot-directories
      </label>
      <PickerLine line={line ?? own} />
      <Button icon={ArrowLeft} className="self-start" disabled={waiting} onClick={back}>
        Back
      </Button>
    </>
  );
};

/** What a directory holding more than the environment lists says. */
const TRUNCATED = `Only the first ${WORKSPACES_BROWSE_CAP.toLocaleString("en")} directories are listed: type a path to reach the rest.`;
