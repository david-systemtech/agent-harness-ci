import { oneLine } from "@agent-harness/client-runtime";
import { SKILL_SOURCE_LIMIT, type SkillsViewSource } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import { Button, Dialog, DialogContent, Input, Fact } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { SkillButton, useSkillVerb } from "./skill-verb.js";

/** The probe is cached by its submitted URL/branch, never copied into component state. */
export const AddSource = ({ environmentId, say }: { readonly environmentId: string; readonly say: (line: string) => void }) => {
  const runtime = useRuntime();
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [asked, setAsked] = useState<{ readonly url: string; readonly branch?: string } | undefined>(undefined);
  return (
    <section aria-label="Add a source" className="flex flex-col gap-3">
      <h3 className="font-semibold">Skill sources</h3>
      <p className="text-sm text-ink-muted">
        At most {SKILL_SOURCE_LIMIT} sources. Probe a URL, then choose its skill folders. A folder with its own SKILL.md is one skill, including the repository
        root.
      </p>
      <Input
        aria-label="Source URL"
        value={url}
        onChange={(event) => {
          setUrl(event.target.value);
          setAsked(undefined);
        }}
      />
      <Input
        aria-label="Source branch (optional)"
        value={branch}
        onChange={(event) => {
          setBranch(event.target.value);
          setAsked(undefined);
        }}
      />
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
  if (probe === null) return <p className="text-sm text-ink-muted">Probing repository…</p>;
  const folders = [...(probe.root === null ? [] : [probe.root]), ...probe.folders];
  return (
    <>
      <p className="text-sm text-ink-muted">
        {probe.identity}: {probe.branch}, {probe.commit}
      </p>
      {probe.truncated && <p className="text-sm text-amber">The probe reached its directory limit; more folders may exist.</p>}
      {folders.length === 0 && <p>No skill folders were found.</p>}
      {folders.map((folder) => (
        <div key={folder.folder} className="flex flex-col gap-1">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-beam focus-visible:outline-beam"
              disabled={folder.count === 0 || sending}
              checked={chosen.includes(folder.folder)}
              onChange={(event) => choose(event.target.checked ? [...chosen, folder.folder] : chosen.filter((value) => value !== folder.folder))}
            />
            Track {folder.folder}: {folder.count} skill(s)
          </label>
          <p className="text-sm text-ink-muted">Licence: {folder.licence ?? "No licence file found"}</p>
          {folder.members.map((member) => (
            <p key={member.path} className="text-sm text-ink-muted">
              {member.name ?? member.path}: {member.description} ({member.invocation}){member.problems.map((problem) => ` — ${problem.message}`).join("")}
            </p>
          ))}
        </div>
      ))}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="accent-beam focus-visible:outline-beam"
          checked={followKind === "pinned"}
          onChange={(event) => setFollowKind(event.target.checked ? "pinned" : "branch")}
        />
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
    <section aria-label={`${source.identity} — ${source.folder}`} className="flex flex-col gap-3 rounded-md border border-line p-4">
      <h3 className="font-semibold">
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
      <p className="text-sm text-ink-muted">
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
      <Input aria-label={`Branch for ${source.identity} — ${source.folder}`} value={branch} onChange={(event) => setBranch(event.target.value)} />
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
          <Button onClick={() => setRemoving(false)}>Cancel</Button>
        </DialogContent>
      </Dialog>
    </section>
  );
};
