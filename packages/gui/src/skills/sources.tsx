import { adminCall, oneLine, plainRefusal, uuidv7, type PlainRefusal, type RefusedAnswer, type RequestAnswer } from "@agent-harness/client-runtime";
import { CATALOGUE, PRODUCT_NAME, SKILL_SOURCE_LIMIT, SkillSourceUrl, skillCollectionName, type CommandMethodName, type SkillsViewSource } from "@agent-harness/contracts";
import { ArrowRight, GitBranch, Folder, Link, Pin, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { nameOf } from "../connections/words.js";
import { useWindowFrame } from "../frame/window-controls.js";
import { useChecklist } from "../setup/checklist-window.js";
import { SetupNotice } from "../setup/notice.js";
import { Button, Dialog, DialogContent, Input, Fact, Tooltip } from "../ui/index.js";
import { useClientVersion, useClock, useObservable, useRuntime, useShell } from "../window-context.js";
import { SkillButton, useSkillVerb } from "./skill-verb.js";

/** The skills refusals whose message the environment words plainly itself (setup-copy.md §5.9; #1855). */
const PLAIN_REASONS: ReadonlySet<string> = new Set(["unreachable", "duplicate", "source_limit", "no_skills"]);

/** What Set up says when the address typed is no repository's (setup-copy.md §5.9), never the params' words. */
const NOT_AN_ADDRESS = "Enter the address of a repository, like https://github.com/you/skills.";

/**
 * A refusal of a probe or of a collection's add or remove, said plainly
 * (setup-copy.md §5.9): a probe's problem and an add's conflict in the
 * environment's own words, git's words for Details; a refused address as an
 * instruction; anything else through the refusal mapper, for `verb`.
 */
export const collectionRefusal = (refusal: RefusedAnswer, verb: string): PlainRefusal => {
  const reason = refusal.data?.["reason"];
  if (refusal.code === "conflict" && typeof reason === "string" && PLAIN_REASONS.has(reason)) {
    const said = refusal.data?.["line"];
    return { line: refusal.message, details: [...(typeof said === "string" ? [said] : []), `${refusal.code} (${reason})`] };
  }
  if (refusal.code === "invalid_params") return { line: NOT_AN_ADDRESS, details: [`${refusal.code}: ${refusal.message}`] };
  return plainRefusal(refusal, verb);
};

/** A refusal on the Skills card: an error notice, its line the title, the fix in place and the raw words under Details. */
export const RefusedLine = ({ environmentId, refusal, actions }: { readonly environmentId: string; readonly refusal: PlainRefusal; readonly actions?: ReactNode }) => {
  const shell = useShell();
  const version = useClientVersion();
  const frame = useWindowFrame();
  const environment = useObservable(useRuntime().projections.environments).find((view) => view.environmentId === environmentId);
  return (
    <SetupNotice
      tone="error"
      title={refusal.line}
      {...(actions !== undefined && { actions })}
      {...(refusal.details.length > 0 && { details: {
        report: { app: { version, platform: frame?.platform ?? "unknown" }, ...(environment !== undefined && { computer: { name: nameOf(environment) } }), line: refusal.line, details: refusal.details },
        copy: (text: string) => shell?.clipboard === undefined ? Promise.reject(new Error("This app has no clipboard.")) : shell.clipboard.writeText(text),
      } })}
    />
  );
};

/** A collection's add or remove as Set up sends it: one at a time, a fresh command id each, its refusal kept to say plainly. */
export const useCollectionVerb = () => {
  const clock = useClock();
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<PlainRefusal | undefined>(undefined);
  const inFlight = useRef(false);
  const send = async <N extends CommandMethodName>(call: () => Promise<RequestAnswer<N>>, verb: string): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setSending(true);
    setRefusal(undefined);
    try {
      const answer = await adminCall(call);
      if (!answer.ok) setRefusal(collectionRefusal(answer.refusal, verb));
      return answer.ok;
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  return { send, sending, refusal, commandId: () => uuidv7(clock.now()) };
};

/**
 * More options › Add from a link (setup-copy.md §5.9): a repository's
 * address, Look for skills, then the skill folders found to tick and Add
 * selected. An address the source URL rule refuses is answered with an
 * instruction here, before anything is sent, keeping what was typed.
 */
export const AddFromLink = ({ environmentId, say }: { readonly environmentId: string; readonly say: (line: string) => void }) => {
  const runtime = useRuntime();
  const field = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [asked, setAsked] = useState<string | undefined>(undefined);
  const [bad, setBad] = useState(false);
  const look = () => {
    const address = url.trim();
    if (!SkillSourceUrl.safeParse(address).success) {
      setAsked(undefined);
      setBad(true);
      field.current?.focus();
      return;
    }
    setBad(false);
    setAsked(address);
    runtime.requests.refresh(environmentId, "skills.probe", { url: address });
  };
  return (
    <section aria-label="Add from a link" className="flex flex-col gap-3">
      <h4 className="text-sm font-semibold">Add from a link</h4>
      <label className="flex flex-col gap-1 text-sm"><span className="flex items-center gap-1"><Link aria-hidden="true" className="size-3.5" />Repository address</span><Input
        ref={field}
        placeholder="https://github.com/you/skills"
        className="font-mono text-xs"
        aria-label="Repository address"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") look(); }}
      /></label>
      <SkillButton environmentId={environmentId} method="skills.probe" onClick={look}>Look for skills</SkillButton>
      {bad && <RefusedLine environmentId={environmentId} refusal={{ line: NOT_AN_ADDRESS, details: [] }} />}
      {asked !== undefined && <FoundFolders key={asked} environmentId={environmentId} url={asked} done={say} partly={say} />}
    </section>
  );
};

/** A probed folder as its tick names it: the repository's own name for its root, and how many skills it holds. */
const folderWords = (identity: string, folder: string, count: number): string =>
  `${folder === "." ? skillCollectionName({ identity, folder }, []) : folder} · ${count === 1 ? "1 skill" : `${count} skills`}`;

/**
 * The skill folders a look found at `url` (setup-copy.md §5.9): `Found {n}
 * skill folders:`, each ticked to add, and Add selected, which adds each in
 * turn; or what kept the look from the repository, with Go to Forges for a
 * private one. Choosing a moved collection's folders again (`replacing`)
 * looks afresh on the branch it follows, adds the chosen ones following
 * that branch, and removes the moved one once they are added; or first,
 * when the chosen ones would not fit beside it under the limit of
 * collections, or include its original folder (`followed` is how many are followed now). A refusal part
 * way has `partly` say on the card itself what was done before it: the
 * folders added, and the moved one removed.
 */
export const FoundFolders = ({ environmentId, url, replacing, done, partly }: {
  readonly environmentId: string;
  readonly url: string;
  readonly replacing?: { readonly source: SkillsViewSource; readonly followed: number };
  readonly done: (line: string) => void;
  readonly partly: (line: string) => void;
}) => {
  const runtime = useRuntime();
  // Capability answers change with the connection, even while its probe result stays cached.
  useObservable(runtime.connections.list);
  const { choose: goTo } = useChecklist();
  const branch = replacing?.source.follow.kind === "branch" ? replacing.source.follow.branch : null;
  const params = useMemo(() => ({ url, ...(branch !== null && { branch }) }), [url, branch]);
  const probed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "skills.probe", params), [runtime, environmentId, params]));
  const [picked, choose] = useState<readonly string[]>([]);
  // Each new look starts with no ticks; accepted-folder lines are kept separately below.
  useEffect(() => choose([]), [probed.result]);
  const { send, sending, refusal, commandId } = useCollectionVerb();
  // Set once the moved collection is removed, so a retry after a refused add never removes it again.
  const removed = useRef(false);
  // Keep accepted folders for this panel, so a refused retry still says what earlier attempts added.
  const added = useRef<string[]>([]);
  const choosingAgain = replacing !== undefined;
  useEffect(() => {
    // Choosing again reads the repository as it is now, never a look kept from before: once, so not
    // when following the answer is already fetching it (none kept, or the one kept no longer fresh).
    if (choosingAgain && !runtime.requests.cached(environmentId, "skills.probe", params).read().loading) runtime.requests.refresh(environmentId, "skills.probe", params);
  }, [runtime, environmentId, params, choosingAgain]);
  if (probed.error !== null) {
    const problem = probed.error.data?.["problem"];
    return (
      <RefusedLine
        environmentId={environmentId}
        refusal={collectionRefusal(probed.error, "Look for skills")}
        {...(problem === "authentication" && { actions: <Button variant="outline" size="sm" onClick={() => goTo("forges")}><ArrowRight aria-hidden="true" />Go to Forges</Button> })}
      />
    );
  }
  const probe = probed.result;
  if (probe === null) return <p role="status" className="text-sm text-ink-muted">Looking for skills…</p>;
  const folders = [...(probe.root === null ? [] : [probe.root]), ...probe.folders];
  // Validate before effects run too, so an old tick never submits a folder absent from this look.
  const chosen = picked.filter((folder) => folders.some((found) => found.folder === folder && found.count > 0));
  if (folders.length === 0) return <p className="text-sm">No skill folders were found there.</p>;
  const finishing = replacing !== undefined && added.current.length > 0 && !removed.current;
  const adding = runtime.capability(environmentId, "skills.sources.add");
  const removing = replacing !== undefined && !removed.current ? runtime.capability(environmentId, "skills.sources.remove") : undefined;
  const blocked = ((chosen.length > 0 || !finishing) && adding.status === "absent" ? adding.message : undefined)
    ?? (removing?.status === "absent" ? removing.message : undefined);
  const reason = blocked ?? (chosen.length === 0 && !finishing ? "Choose a skill folder first." : undefined);
  const add = async () => {
    if ((chosen.length > 0 && runtime.capability(environmentId, "skills.sources.add").status === "absent")
      || (replacing !== undefined && !removed.current && runtime.capability(environmentId, "skills.sources.remove").status === "absent")) return;
    const remove = async () => {
      if (replacing === undefined || removed.current) return true;
      removed.current = await send(() => runtime.requests.call(environmentId, "skills.sources.remove", { commandId: commandId(), sourceId: replacing.source.id }), "Add selected");
      return removed.current;
    };
    // Remove first when the chosen folders would exceed the limit or duplicate the moved collection.
    // A refused add leaves that removal recorded, so a retry does not remove it again.
    const first = replacing !== undefined && (replacing.followed + chosen.length > SKILL_SOURCE_LIMIT
      || (probe.identity === replacing.source.identity && chosen.includes(replacing.source.folder)));
    if (first && !(await remove())) return;
    const addedLines = () => added.current.map((name) => `Added ${name}.`);
    const stopped = () => {
      const lines = [...addedLines(), ...(replacing !== undefined && removed.current ? [`${skillCollectionName(replacing.source, CATALOGUE.skills)} was removed to make room for its new folders.`] : [])];
      if (lines.length > 0) partly(lines.join(" "));
    };
    for (const folder of chosen) {
      const ok = await send(
        () => runtime.requests.call(environmentId, "skills.sources.add", { commandId: commandId(), url, folder, probeId: probe.probeId, follow: { kind: "branch", branch } }),
        "Add selected",
      );
      // A refused add stops here, its refusal said, the folders added so far no longer ticked.
      if (!ok) {
        stopped();
        return;
      }
      added.current.push(skillCollectionName({ identity: probe.identity, folder }, CATALOGUE.skills));
      choose((held) => held.filter((value) => value !== folder));
    }
    if (!first && !(await remove())) {
      stopped();
      return;
    }
    done(addedLines().join(" "));
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">{folders.length === 1 ? "Found 1 skill folder:" : `Found ${folders.length} skill folders:`}</p>
      {probe.truncated && <p className="text-sm text-ink-muted">{PRODUCT_NAME} stopped looking after 2,000 folders, so there may be more.</p>}
      {folders.map((folder) => (
        <label key={folder.folder} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-beam focus-visible:outline-beam"
            disabled={folder.count === 0 || sending || adding.status === "absent" || removing?.status === "absent"}
            checked={chosen.includes(folder.folder)}
            onChange={(event) => choose(event.target.checked ? [...chosen, folder.folder] : chosen.filter((value) => value !== folder.folder))}
          /><Folder aria-hidden="true" className="size-3.5" />
          {folderWords(probe.identity, folder.folder, folder.count)}
        </label>
      ))}
      <span className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={reason !== undefined || sending} onClick={() => void add()}><Plus aria-hidden="true" />Add selected</Button>
        {reason !== undefined && <span className="text-xs text-ink-muted">{reason}</span>}
      </span>
      {refusal !== undefined && <RefusedLine environmentId={environmentId} refusal={refusal} />}
    </div>
  );
};

/** The probe is cached by its submitted URL/branch, never copied into component state. */
export const AddSource = ({ environmentId, say, title = "Skill sources" }: {
  readonly environmentId: string;
  readonly say: (line: string) => void;
  readonly title?: string;
}) => {
  const runtime = useRuntime();
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [asked, setAsked] = useState<{ readonly url: string; readonly branch?: string } | undefined>(undefined);
  return (
    <section aria-label="Add a source" className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold">{title}</h3>
      <p className="text-2xs text-ink-muted">
        At most {SKILL_SOURCE_LIMIT} sources. Probe a URL, then choose its skill folders. A folder with its own SKILL.md is one skill, including the repository
        root.
      </p>
      <label className="flex flex-col gap-1 text-xs"><span className="flex items-center gap-1"><Link aria-hidden="true" className="size-3.5" />Repository URL</span><Tooltip content="Repository URL · Type to edit"><Input
        placeholder="https://git.example.test/team/procedures.git"
        className="font-mono text-xs"
        aria-label="Source URL"
        value={url}
        onChange={(event) => {
          setUrl(event.target.value);
          setAsked(undefined);
        }}
      /></Tooltip></label>
      <label className="flex flex-col gap-1 text-xs"><span className="flex items-center gap-1"><GitBranch aria-hidden="true" className="size-3.5" />Branch (optional)</span><Tooltip content="Branch · Type to edit"><Input
        placeholder="Default branch"
        className="font-mono text-xs"
        aria-label="Source branch (optional)"
        value={branch}
        onChange={(event) => {
          setBranch(event.target.value);
          setAsked(undefined);
        }}
      /></Tooltip></label>
      <SkillButton
        environmentId={environmentId}
        method="skills.probe"
        onClick={() => {
          const params = { url, ...(branch.trim() !== "" && { branch: branch.trim() }) };
          setAsked(params);
          runtime.requests.refresh(environmentId, "skills.probe", params);
        }}
      >
        Probe repository
      </SkillButton>
      {asked !== undefined && <ProbeFolders key={JSON.stringify(asked)} environmentId={environmentId} params={asked} say={say} />}
    </section>
  );
};

const ProbeFolders = ({
  environmentId,
  params,
  say,
}: {
  readonly environmentId: string;
  readonly params: { readonly url: string; readonly branch?: string };
  readonly say: (line: string) => void;
}) => {
  const runtime = useRuntime();
  const probed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "skills.probe", params), [runtime, environmentId, params]));
  const [chosen, choose] = useState<readonly string[]>([]);
  const [followKind, setFollowKind] = useState<"branch" | "pinned">("branch");
  const { send, sending, commandId } = useSkillVerb(say);
  const probe = probed.result;
  if (probed.error !== null)
    return (
      <p role="status" className="text-sm text-amber">
        {oneLine(probed.error.message)}
      </p>
    );
  if (probe === null) return <p className="text-2xs text-ink-muted">Probing repository…</p>;
  const folders = [...(probe.root === null ? [] : [probe.root]), ...probe.folders];
  return (
    <>
      <p className="text-2xs text-ink-muted">
        {probe.identity}: {probe.branch}, {probe.commit}
      </p>
      {probe.truncated && <p className="text-sm text-amber">The probe reached its directory limit; more folders may exist.</p>}
      {folders.length === 0 && <p>No skill folders were found.</p>}
      {folders.map((folder) => (
        <div key={folder.folder} className="flex flex-col gap-1">
          <label className="flex items-center gap-2">
            <Tooltip content={`Track ${folder.folder}`} keys="Space"><input
              type="checkbox"
              className="accent-beam focus-visible:outline-beam"
              disabled={folder.count === 0 || sending}
              checked={chosen.includes(folder.folder)}
              onChange={(event) => choose(event.target.checked ? [...chosen, folder.folder] : chosen.filter((value) => value !== folder.folder))}
            /></Tooltip><Folder aria-hidden="true" className="size-3.5" />
            Track {folder.folder}: {folder.count} skill(s)
          </label>
          <p className="text-2xs text-ink-muted">Licence: {folder.licence ?? "No licence file found"}</p>
          {folder.members.map((member) => (
            <p key={member.path} className="text-2xs text-ink-muted">
              {member.name ?? member.path}: {member.description} ({member.invocation}){member.problems.map((problem) => ` — ${problem.message}`).join("")}
            </p>
          ))}
        </div>
      ))}
      <label className="flex items-center gap-2">
        <Tooltip content="Pin at this commit" keys="Space"><input
          type="checkbox"
          className="accent-beam focus-visible:outline-beam"
          checked={followKind === "pinned"}
          onChange={(event) => setFollowKind(event.target.checked ? "pinned" : "branch")}
        /></Tooltip><Pin aria-hidden="true" className="size-3.5" />
        Pin at this commit
      </label>
      <SkillButton
        environmentId={environmentId}
        method="skills.sources.add"
        busy={sending}
        reason={chosen.length === 0 ? "Choose a skill folder first." : undefined}
        onClick={() => {
          void (async () => {
            for (const folder of chosen) {
              const ok = await send(
                () =>
                  runtime.requests.call(environmentId, "skills.sources.add", {
                    commandId: commandId(),
                    url: params.url,
                    folder,
                    probeId: probe.probeId,
                    follow: followKind === "pinned" ? { kind: "pinned", commit: probe.commit } : { kind: "branch", branch: params.branch ?? null },
                  }),
                `Tracking ${folder}.`,
              );
              if (!ok) break;
              choose((held) => held.filter((value) => value !== folder));
            }
          })();
        }}
      >
        Track selected folders
      </SkillButton>
    </>
  );
};

export const SourceCard = ({
  environmentId,
  source,
  say,
}: {
  readonly environmentId: string;
  readonly source: SkillsViewSource;
  readonly say: (line: string) => void;
}) => {
  const runtime = useRuntime();
  const { send, sending, commandId, refusal, clearRefusal } = useSkillVerb(say);
  const [removing, setRemoving] = useState(false);
  const [branch, setBranch] = useState(source.follow.kind === "branch" ? (source.follow.branch ?? "") : "");
  const pinned = source.follow.kind === "pinned";
  return (
    <section aria-label={`${source.identity} — ${source.folder}`} className="flex flex-col gap-2 rounded-lg border border-hairline bg-panel p-3">
      <h3 className="flex items-center gap-2 text-xs font-semibold break-all"><GitBranch aria-hidden="true" className="size-4 shrink-0" />
        {source.identity} — {source.folder}
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-sm">
        <Fact name="URL">{source.url}</Fact>
        <Fact name="Follows">{pinned ? "Pinned commit" : source.follow.kind === "branch" ? (source.follow.branch ?? "Default branch") : ""}</Fact>
        <Fact name="Commit">{source.commit}</Fact>
        <Fact name="Skills">{source.skillCount}</Fact>
        <Fact name="Last sync">{source.attemptedAt ?? "None since the environment started"}</Fact>
        <Fact name="Outcome since">{source.sync.since}</Fact>
      </dl>
      <p className="text-2xs text-ink-muted">
        {source.sync.outcome === "ok"
          ? "Synced"
          : source.sync.outcome === "failed"
            ? source.sync.line
            : `The layout moved. Skill folders found: ${source.sync.folders.join(", ") || "none"}. Keeping the last good skills.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <SkillButton
          environmentId={environmentId}
          method="skills.sources.pull"
          busy={sending}
          reason={pinned ? "Pinned sources do not sync; unpin first." : undefined}
          onClick={() => {
            void send(() => runtime.requests.call(environmentId, "skills.sources.pull", { commandId: commandId(), sourceId: source.id }), "Source pulled.");
          }}
        >
          Pull now
        </SkillButton>
        <SkillButton
          environmentId={environmentId}
          method="skills.sources.setFollow"
          busy={sending}
          onClick={() => {
            void send(
              () =>
                runtime.requests.call(environmentId, "skills.sources.setFollow", {
                  commandId: commandId(),
                  sourceId: source.id,
                  follow: pinned ? { kind: "branch", branch: null } : { kind: "pinned", commit: source.commit },
                }),
              pinned ? "Source unpinned." : "Source pinned.",
            );
          }}
        >
          {pinned ? "Unpin" : "Pin current commit"}
        </SkillButton>
        <SkillButton
          environmentId={environmentId}
          method="skills.sources.remove"
          busy={sending}
          onClick={() => {
            clearRefusal();
            setRemoving(true);
          }}
        >
          Remove source
        </SkillButton>
      </div>
      <label className="flex flex-col gap-1 text-xs"><span className="flex items-center gap-1"><GitBranch aria-hidden="true" className="size-3.5" />Follow branch</span><Tooltip content="Follow branch · Type to edit"><Input className="font-mono text-xs" aria-label={`Branch for ${source.identity} — ${source.folder}`} value={branch} onChange={(event) => setBranch(event.target.value)} /></Tooltip></label>
      <SkillButton
        environmentId={environmentId}
        method="skills.sources.setFollow"
        busy={sending}
        onClick={() => {
          void send(
            () =>
              runtime.requests.call(environmentId, "skills.sources.setFollow", {
                commandId: commandId(),
                sourceId: source.id,
                follow: { kind: "branch", branch: branch.trim() || null },
              }),
            "Source branch changed.",
          );
        }}
      >
        Follow branch
      </SkillButton>
      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogContent title="Remove skill source" description="Its skills leave every account on the next run; a live run keeps its snapshot.">
          {refusal !== undefined && (
            <p role="status" className="text-sm text-amber">
              {refusal}
            </p>
          )}
          <SkillButton
            environmentId={environmentId}
            method="skills.sources.remove"
            busy={sending}
            onClick={() => {
              void send(
                () => runtime.requests.call(environmentId, "skills.sources.remove", { commandId: commandId(), sourceId: source.id }),
                "Source removed.",
              ).then((ok) => {
                if (ok) setRemoving(false);
              });
            }}
          >
            Confirm remove source
          </SkillButton>
          <Tooltip content="Cancel" keys="Escape"><Button onClick={() => setRemoving(false)}><X aria-hidden="true" />Cancel</Button></Tooltip>
        </DialogContent>
      </Dialog>
    </section>
  );
};
