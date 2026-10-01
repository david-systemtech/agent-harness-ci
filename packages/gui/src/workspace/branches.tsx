import { baseName, heldWords, presetBranch, problemLine, whenWords, type RefusalPlace, type RequestAnswer } from "@agent-harness/client-runtime";
import { WORKSPACES_INSPECT_BRANCH_CAP, type InspectedRepository, type WorkspaceRequest } from "@agent-harness/contracts";
import { useEffect, useState } from "react";
import { Button, Input } from "../ui/index.js";
import { useRuntime } from "../window-context.js";
import { Entry, PickerLine, ViewTitle } from "./parts.js";

/**
 * A worktree's branch (workspace-picker spec, "Workspace requests" and
 * "Browsing an environment's directories"; #421): a new branch with its
 * presets (named from the session's id, from the main checkout's `HEAD`) or
 * named as typed, or one the repository has, from `workspaces.inspect`. A
 * branch another worktree holds is shown with that worktree and, when the
 * harness made it, its session, and not offered. Without `terminal` the
 * branches cannot be read: the capability's line says why, and a name typed
 * is offered both as a new branch and as one the repository has, for the
 * environment to judge.
 */

/** The branch part of a worktree request: an existing branch, or a new one. */
type BranchChoice = Pick<Extract<WorkspaceRequest, { readonly kind: "worktree" }>, "branch" | "newBranch">;

export interface BranchesProps {
  /** Where it is said: the environment's name and id, and the sessions listed, which name a branch's holder. */
  readonly place: RefusalPlace;
  /** The repository, as chosen: any path inside it. */
  readonly repository: string;
  /** The session the worktree is for, whose id names a new branch's preset. */
  readonly sessionId: string;
  /** Takes the worktree request. */
  choose(request: WorkspaceRequest): void;
  back(): void;
  /** What the picker says now of a choice, over the view's own line. */
  readonly line: string | undefined;
  readonly waiting: boolean;
}

/** The branch a new worktree branch starts from, as the picker says it: the main checkout's. */
const baseWords = (repository: InspectedRepository | null): string => {
  if (repository === null) return "the main checkout's HEAD";
  const main = repository.branches.find((branch) => branch.worktree === repository.mainCheckout)?.name ?? (repository.root === repository.mainCheckout ? repository.branch : null);
  return main ?? "the main checkout's HEAD";
};

export const Branches = ({ place, repository, sessionId, choose, back, line, waiting }: BranchesProps) => {
  const runtime = useRuntime();
  const { environmentId, where } = place;
  const capability = runtime.capability(environmentId, "workspaces.inspect");
  const readable = capability.status === "present";
  const [answer, setAnswer] = useState<RequestAnswer<"workspaces.inspect"> | null>(null);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!readable) return;
    let current = true;
    setAnswer(null);
    void runtime.requests.call(environmentId, "workspaces.inspect", { path: repository }).then((inspected) => current && setAnswer(inspected));
    return () => {
      current = false;
    };
  }, [runtime, environmentId, repository, readable]);

  const name = baseName(repository);
  const inspected = answer?.ok === true ? answer.result : null;
  const read = inspected?.repository ?? null;
  // A path the environment could not use, or in no repository: nothing to make a worktree of (the line says why).
  const usable = readable ? inspected !== null && inspected.problem === null && read !== null : true;
  const make = (branch: BranchChoice) => () => choose({ kind: "worktree", repository: inspected?.path ?? repository, ...branch });
  const base = baseWords(read);
  const needle = typed.trim();
  const branches = (read?.branches ?? []).filter((branch) => branch.name.toLowerCase().includes(needle.toLowerCase()));
  const named = needle !== "" && !(read?.branches ?? []).some((branch) => branch.name === needle);

  const own = (() => {
    if (!readable) return capability.message;
    if (answer === null) return `Reading ${name}'s branches…`;
    if (!answer.ok) return `${where} could not read ${repository}: ${answer.error.message}`;
    const { path, problem } = answer.result;
    if (problem !== null) return problemLine(problem, path, where);
    if (read === null) return `${path} is in no git repository on ${where}.`;
    return read.branchesTruncated ? `Only the ${WORKSPACES_INSPECT_BRANCH_CAP.toLocaleString("en")} most recently committed branches are listed: type another's name.` : undefined;
  })();

  return (
    <>
      <ViewTitle>
        A worktree of {name} on {where}: its branch
      </ViewTitle>
      {usable && (
        <>
          <Input aria-label="A new branch's name" placeholder="a new branch's name, or pick one below" value={typed} onChange={(event) => setTyped(event.target.value)} />
          <ul aria-label={`Branches of ${name}`} className="flex max-h-64 flex-col overflow-y-auto">
            {named && <Entry name={`New branch ${needle}`} detail={`from ${base}`} disabled={waiting} choose={make({ newBranch: { name: needle } })} />}
            {named && read === null && <Entry name={`Branch ${needle}`} detail="one the repository has" disabled={waiting} choose={make({ branch: needle })} />}
            <Entry name={`New branch ${presetBranch(sessionId)}`} detail={`from ${base}`} disabled={waiting} choose={make({ newBranch: {} })} />
            {branches.map((branch) =>
              branch.worktree === null ? (
                <Entry key={branch.name} name={branch.name} detail={`committed ${whenWords(new Date(branch.committedAt))}`} disabled={waiting} choose={make({ branch: branch.name })} />
              ) : (
                <Entry key={branch.name} name={branch.name} absent={heldWords(branch.worktree, branch.sessionId, place)} />
              ),
            )}
          </ul>
        </>
      )}
      <PickerLine line={line ?? own} />
      <Button className="self-start" disabled={waiting} onClick={back}>
        Back
      </Button>
    </>
  );
};
