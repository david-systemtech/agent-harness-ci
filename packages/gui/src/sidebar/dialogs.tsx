import {
  askRestorable,
  changeHeading,
  groupChoices,
  groupHeading,
  hasTag,
  parseWhen,
  presetTimes,
  rowKey,
  snoozeStands,
  whenWords,
  type EnvironmentView,
  type MergedGroupHeading,
  type SessionRow,
} from "@agent-harness/client-runtime";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { EnvironmentGlyph } from "../connections/environment-badge.js";
import { THIS_MACHINE } from "../connections/words.js";
import type { Offer } from "../keys/key-dispatch.js";
import { Dialog, DialogClose, DialogContent, Input } from "../ui/index.js";
import { DialogAction as Button } from "../ui/dialog-action.js";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, DialogFooter } from "../ui/dialog.js";
import { ArchiveRestore, Trash2, X, Clock, Plus } from "lucide-react";
import { useObservable, useRuntime } from "../window-context.js";
import { useOrganise } from "./organise.js";
import { notDone, quoted } from "./words.js";
import { SessionInstructionsDialog } from "../instructions/session-instructions.js";

/**
 * The sidebar's dialogs (docs/specs/gui.md, "The window and the sidebar";
 * #398), one at a time: a snooze to a date and time; a session's tags, one
 * added or taken off at a time; a new group to move a session into; Delete,
 * asked once, for a session or a merged group; and Restore, what each
 * environment can still restore. Each reads the session or the group from
 * the list as it is now, so what it shows follows the list, and closes
 * itself once what it is about is gone. A session pane's bare `/snooze` and
 * `/group` (#753) open Snooze's presets and Move to group's choices as a
 * dialog of their own, offering what the row's context menu offers.
 */

/** The longest tag a session takes (`Tag`'s 40 characters) and group name (`GroupName`'s 80). */
const TAG_MOST = 40;
const GROUP_NAME_MOST = 80;

const nameOf = (environments: readonly EnvironmentView[], environmentId: string): string =>
  environments.find((view) => view.environmentId === environmentId)?.name ?? THIS_MACHINE;

/** A dialog that closes when dismissed (Esc, the overlay, a Close button). */
const Shown = ({ close, title, description, children, wide = false }: { close(): void; readonly title: string; readonly description?: string; readonly children: ReactNode; readonly wide?: boolean }) => (
  <Dialog open onOpenChange={(open) => !open && close()}>
    <DialogContent title={title} onKeyDown={(event) => { if (event.key === "Escape") close(); }} {...(description !== undefined && { description })} className={wide ? "max-w-[32rem] max-h-[calc(100dvh-4rem)] overflow-y-auto" : "max-h-[calc(100dvh-4rem)] overflow-y-auto"}>
      {children}
    </DialogContent>
  </Dialog>
);

/** A dialog's buttons, at its foot. */
const Actions = ({ children }: { readonly children: ReactNode }) => <DialogFooter>{children}</DialogFooter>;

/** One of a dialog's choices: its name, then a detail; dim, with the line saying why under it, while it cannot be chosen. */
const Choice = ({ offer, detail, onClick, children }: { readonly offer: Offer; readonly detail?: string; onClick(): void; readonly children: string }) => {
  const absent = offer.status === "absent" ? offer.message : undefined;
  return (
    <li className="flex flex-col">
      <Button aria-label={detail === undefined ? children : `${children} ${detail}`} disabled={absent !== undefined} onClick={onClick} className="justify-between">
        <span>{children}</span>
        {detail !== undefined && <span className="text-xs text-ink-muted">{detail}</span>}
      </Button>
      {absent !== undefined && <span className="px-2 text-xs text-ink-faint">{absent}</span>}
    </li>
  );
};

const PRESENT: Offer = { status: "present" };

/** A form's submit, its default action kept from the page. */
const submitted = (then: () => void) => (event: FormEvent) => {
  event.preventDefault();
  then();
};

const SnoozeDialog = ({ row, close }: { readonly row: SessionRow; close(): void }) => {
  const runtime = useRuntime();
  const organise = useOrganise();
  const [typed, setTyped] = useState("");
  const at = typed === "" ? null : parseWhen(typed, runtime.environmentNow(row.environmentId));
  const snooze = () => {
    if (!(at instanceof Date)) return;
    organise.send(row.environmentId, "sessions.snooze", { sessionId: row.summary.id, until: at.toISOString() });
    close();
  };
  return (
    <Shown close={close} title={`Snooze ${quoted(row.summary.title)} until`} description="A date and time on this computer's calendar.">
      <form onSubmit={submitted(snooze)} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Date and time
          <Input type="datetime-local" value={typed} onChange={(event) => setTyped(event.target.value)} />
        </label>
        <p role="status" className="min-h-4 text-xs text-ink-muted">
          {at === null ? "" : at instanceof Date ? `Until ${whenWords(at)}.` : at.problem}
        </p>
        <Actions>
          <DialogClose asChild>
            <Button icon={X} keys="Escape">Cancel</Button>
          </DialogClose>
          <Button icon={Clock} type="submit" variant="default" disabled={!(at instanceof Date)}>
            Snooze
          </Button>
        </Actions>
      </form>
    </Shown>
  );
};

/** Snooze's presets, as the row's context menu offers them: each on this client's calendar from the environment's now, A date and time…, and Wake now while a snooze stands. */
const SnoozePresetsDialog = ({ row, close }: { readonly row: SessionRow; close(): void }) => {
  const runtime = useRuntime();
  const organise = useOrganise();
  const { environmentId, summary } = row;
  const now = runtime.environmentNow(environmentId);
  const snooze = (at: Date) => () => {
    organise.send(environmentId, "sessions.snooze", { sessionId: summary.id, until: at.toISOString() });
    close();
  };
  const wake = () => {
    organise.send(environmentId, "sessions.unsnooze", { sessionId: summary.id });
    close();
  };
  return (
    <Shown close={close} title={`Snooze ${quoted(summary.title)} until`} description="Each time on this computer's calendar.">
      <ul aria-label="When" className="flex flex-col gap-1">
        {presetTimes(now).map(({ label, at, absent }) =>
          at === null ? (
            <Choice key={label} offer={{ status: "absent", message: absent ?? "Not now." }} onClick={() => undefined}>
              {label}
            </Choice>
          ) : (
            <Choice key={label} offer={PRESENT} detail={whenWords(at)} onClick={snooze(at)}>
              {label}
            </Choice>
          ),
        )}
        <Choice offer={PRESENT} onClick={() => organise.open({ kind: "snooze", row: rowKey(row) })}>
          A date and time…
        </Choice>
        {snoozeStands(summary, now) && (
          <Choice offer={runtime.commands.admits(environmentId, "sessions.unsnooze")} onClick={wake}>
            Wake now
          </Choice>
        )}
      </ul>
      <Actions>
        <DialogClose asChild>
          <Button icon={X} keys="Escape">Cancel</Button>
        </DialogClose>
      </Actions>
    </Shown>
  );
};

const TagsDialog = ({ row, close }: { readonly row: SessionRow; close(): void }) => {
  const organise = useOrganise();
  const [typed, setTyped] = useState("");
  const { environmentId, summary } = row;
  const tag = typed.trim();
  const held = tag !== "" && hasTag(summary, tag);
  const add = () => {
    if (tag === "" || held) return;
    organise.send(environmentId, "sessions.tag", { sessionId: summary.id, tag });
    setTyped("");
  };
  return (
    <Shown close={close} title={`Tags of ${quoted(summary.title)}`} description="Add a tag, or take one off, one at a time.">
      {summary.tags.length === 0 ? (
        <p className="text-sm text-ink-muted">No tags.</p>
      ) : (
        <ul aria-label="Its tags" className="flex flex-wrap gap-1">
          {summary.tags.map((held) => (
            <li key={held} className="flex items-center gap-1 rounded-sm bg-wash pl-2 text-sm">
              #{held}
              <Button icon={X} aria-label={`Take #${held} off`} onClick={() => organise.send(environmentId, "sessions.untag", { sessionId: summary.id, tag: held })}>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submitted(add)} className="flex gap-2">
        <Input aria-label="A tag to add" maxLength={TAG_MOST} value={typed} onChange={(event) => setTyped(event.target.value)} />
        <Button icon={Plus} type="submit" disabled={tag === "" || held}>
          Add
        </Button>
      </form>
      {held && <p className="text-xs text-ink-muted">{`It has #${tag} already.`}</p>}
      <Actions>
        <DialogClose asChild>
          <Button>Done</Button>
        </DialogClose>
      </Actions>
    </Shown>
  );
};

const NewGroupDialog = ({ row, close }: { readonly row: SessionRow; close(): void }) => {
  const organise = useOrganise();
  const [typed, setTyped] = useState("");
  const name = typed.trim();
  const move = () => {
    if (name === "") return;
    organise.move(row.environmentId, row.summary.id, name);
    close();
  };
  return (
    <Shown close={close} title={`Move ${quoted(row.summary.title)} into a new group`}>
      <form onSubmit={submitted(move)} className="flex flex-col gap-3">
        <Input aria-label="The group's name" maxLength={GROUP_NAME_MOST} value={typed} onChange={(event) => setTyped(event.target.value)} />
        <Actions>
          <DialogClose asChild>
            <Button icon={X} keys="Escape">Cancel</Button>
          </DialogClose>
          <Button type="submit" variant="default" disabled={name === ""}>
            Move
          </Button>
        </Actions>
      </form>
    </Shown>
  );
};

/** Move to group's choices, as the row's context menu offers them: every merged heading (the one it is in dim), New group…, and No group while it is in one. */
const MoveToGroupDialog = ({ row, close }: { readonly row: SessionRow; close(): void }) => {
  const runtime = useRuntime();
  const organise = useOrganise();
  const list = useObservable(runtime.projections.sessionList);
  const choices = groupChoices(list.groups, row, "");
  const move = (name: string | null) => () => {
    organise.move(row.environmentId, row.summary.id, name);
    close();
  };
  return (
    <Shown close={close} title={`Move ${quoted(row.summary.title)} to a group`}>
      <ul aria-label="Groups" className="flex flex-col gap-1">
        {choices.listed.map(({ heading, here }) => (
          <Choice key={heading.key} offer={here ? { status: "absent", message: "It is in this group." } : PRESENT} onClick={move(heading.name)}>
            {heading.name}
          </Choice>
        ))}
        <Choice offer={PRESENT} onClick={() => organise.open({ kind: "new-group", row: rowKey(row) })}>
          New group…
        </Choice>
        {choices.out && (
          <Choice offer={PRESENT} onClick={move(null)}>
            No group
          </Choice>
        )}
      </ul>
      <Actions>
        <DialogClose asChild>
          <Button icon={X} keys="Escape">Cancel</Button>
        </DialogClose>
      </Actions>
    </Shown>
  );
};

const DeleteDialog = ({ row, close }: { readonly row: SessionRow; close(): void }) => {
  const runtime = useRuntime();
  const organise = useOrganise();
  const environments = useObservable(runtime.projections.environments);
  const [checked, setChecked] = useState<"checking" | "idle" | "live" | "failed">("checking");
  const [failure, setFailure] = useState("");
  const runs = useObservable(runtime.projections.runs);
  const live = runs.sessions.get(row.environmentId)?.get(row.summary.id)?.state;
  useEffect(() => {
    let current = true;
    void runtime.requests.call(row.environmentId, "sessions.get", { sessionId: row.summary.id }).then((answer) => {
      if (!current) return;
      if (!answer.ok) { setFailure(answer.error.message); setChecked("failed"); return; }
      setChecked(answer.result.summary.activity.state === "idle" ? "idle" : "live");
    });
    return () => { current = false; };
  }, [runtime, row.environmentId, row.summary.id]);
  const title = quoted(row.summary.title);
  const remove = () => {
    organise.send(row.environmentId, "sessions.delete", { sessionId: row.summary.id });
    organise.say(`Deleted ${title}. Restore brings it back within 30 days.`);
    close();
  };
  return (
    <AlertDialog open onOpenChange={(open) => !open && close()}>
      <AlertDialogContent title={`Delete ${title} on ${nameOf(environments, row.environmentId)}?`} description="Restore brings it back within 30 days; after that it is gone.">
        {checked === "checking" && <p role="status" className="text-sm text-ink-muted">Checking whether a run is live…</p>}
        {checked === "failed" && <p role="status" className="text-sm text-signal">Could not check the run: {failure}</p>}
        {checked !== "checking" && (live === "running" || live === "parked" || live === "starting" || (live === undefined && checked === "live")) && <p className="text-sm text-amber">A run is live on this session. Deleting it stops the run.</p>}
        <Actions>
          <AlertDialogCancel asChild><Button icon={X} keys="Escape" onClick={close}>Keep it</Button></AlertDialogCancel>
          <Button icon={Trash2} variant="destructive" disabled={checked === "checking" || checked === "failed"} onClick={remove}>Delete</Button>
        </Actions>
      </AlertDialogContent>
    </AlertDialog>
  );
};

const DeleteGroupDialog = ({ group, close }: { readonly group: MergedGroupHeading; close(): void }) => {
  const runtime = useRuntime();
  const organise = useOrganise();
  const environments = useObservable(runtime.projections.environments);
  const on = group.groups.map((member) => nameOf(environments, member.environmentId)).join(" and ");
  const remove = () => {
    organise.hear(changeHeading(runtime.commands, group, { delete: true }), notDone("groups.delete"));
    close();
  };
  return (
    <AlertDialog open onOpenChange={(open) => !open && close()}>
      <AlertDialogContent title={`Delete the group ${quoted(group.name)}?`} description={`On ${on}. Its sessions stay, in no group.`}>
        <Actions>
          <AlertDialogCancel asChild><Button icon={X} keys="Escape" onClick={close}>Keep it</Button></AlertDialogCancel>
          <Button icon={Trash2} variant="destructive" onClick={remove}>Delete</Button>
        </Actions>
      </AlertDialogContent>
    </AlertDialog>
  );
};

const RestoreDialog = ({ query, close }: { readonly query: string; close(): void }) => {
  const runtime = useRuntime();
  const organise = useOrganise();
  const environments = useObservable(runtime.projections.environments);
  // Asked once, as the dialog opens.
  const [asked] = useState(() => askRestorable(runtime.requests, runtime.projections.environments.read()));
  const { found: deleted, failed, asking } = useObservable(asked);
  // Those whose titles hold what `/restore` was given, as the terminal UI's restore picker filters them.
  const needle = query.trim().toLowerCase();
  const found = deleted.filter(({ summary }) => summary.title.toLowerCase().includes(needle));
  return (
    <Shown wide close={close} title="Restore a deleted session" description="What each environment deleted in the last 30 days; after that it is purged.">
      {asking > 0 && <p className="text-sm text-ink-muted">Asking each environment what it deleted…</p>}
      {failed.map(({ environmentId, message }) => (
        <p key={environmentId} className="text-sm text-ink-muted">{`${nameOf(environments, environmentId)} could not be asked: ${message}`}</p>
      ))}
      {asking === 0 && failed.length === 0 && deleted.length === 0 && <p className="text-sm text-ink-muted">Nothing deleted can be restored: a deleted session is purged after 30 days.</p>}
      {asking === 0 && deleted.length > 0 && found.length === 0 && <p className="text-sm text-ink-muted">{`No deleted session's title holds “${query.trim()}”.`}</p>}
      {found.length > 0 && (
        <ul aria-label="Deleted sessions" className="flex flex-col gap-1">
          {found.map(({ environmentId, summary }) => {
            const offer = runtime.commands.admits(environmentId, "sessions.restore");
            const absent = offer.status === "absent" ? offer.message : undefined;
            const view = environments.find((candidate) => candidate.environmentId === environmentId);
            return (
              <li key={`${environmentId}/${summary.id}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-hairline bg-inset/60 px-3 py-2 text-sm">
                <EnvironmentGlyph view={view} label={view?.name ?? THIS_MACHINE} />
                <span className="min-w-0 flex-1 truncate">{summary.title}</span>
                <span className="text-xs text-ink-muted">{`restorable until ${whenWords(new Date(summary.purgeAt))}`}</span>
                <Button
                  icon={ArchiveRestore}
                  aria-label={`Restore ${quoted(summary.title)}`}
                  disabled={absent !== undefined}
                  onClick={() => {
                    organise.send(environmentId, "sessions.restore", { sessionId: summary.id });
                    close();
                  }}
                >
                  Restore
                </Button>
                {absent !== undefined && <span className="basis-full text-xs text-ink-faint">{absent}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <Actions>
        <DialogClose asChild>
          <Button icon={X} keys="Escape">Close</Button>
        </DialogClose>
      </Actions>
    </Shown>
  );
};

/** The dialog the sidebar has open, if any; one about a session or a group no longer listed closes. */
export const SidebarDialogs = () => {
  const runtime = useRuntime();
  const { dialog, open } = useOrganise();
  const list = useObservable(runtime.projections.sessionList);
  const close = () => open(null);
  if (dialog === null) return null;
  if (dialog.kind === "restore") return <RestoreDialog query={dialog.query ?? ""} close={close} />;
  if (dialog.kind === "delete-group") {
    const group = list.groups.find((held) => groupHeading(held.key) === dialog.heading);
    return group === undefined ? null : <DeleteGroupDialog group={group} close={close} />;
  }
  const row = list.rows.find((held) => rowKey(held) === dialog.row);
  if (row === undefined) return null;
  switch (dialog.kind) {
    case "instructions":
      return <SessionInstructionsDialog environmentId={row.environmentId} sessionId={row.summary.id} title={row.summary.title} close={close} />;
    case "snooze":
      return <SnoozeDialog row={row} close={close} />;
    case "snooze-presets":
      return <SnoozePresetsDialog row={row} close={close} />;
    case "move-to-group":
      return <MoveToGroupDialog row={row} close={close} />;
    case "tags":
      return <TagsDialog row={row} close={close} />;
    case "new-group":
      return <NewGroupDialog row={row} close={close} />;
    case "delete":
      return <DeleteDialog row={row} close={close} />;
  }
};
