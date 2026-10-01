import {
  askRestorable,
  changeHeading,
  groupHeading,
  hasTag,
  parseWhen,
  rowKey,
  whenWords,
  type EnvironmentView,
  type MergedGroupHeading,
  type SessionRow,
} from "@agent-harness/client-runtime";
import { useState, type FormEvent, type ReactNode } from "react";
import { EnvironmentGlyph } from "../connections/environment-badge.js";
import { THIS_MACHINE } from "../connections/words.js";
import { Button, Dialog, DialogClose, DialogContent, Input } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { useOrganise } from "./organise.js";
import { notDone, quoted } from "./words.js";

/**
 * The sidebar's dialogs (docs/specs/gui.md, "The window and the sidebar";
 * #398), one at a time: a snooze to a date and time; a session's tags, one
 * added or taken off at a time; a new group to move a session into; Delete,
 * asked once, for a session or a merged group; and Restore, what each
 * environment can still restore. Each reads the session or the group from
 * the list as it is now, so what it shows follows the list, and closes
 * itself once what it is about is gone.
 */

/** The longest tag a session takes (`Tag`'s 40 characters) and group name (`GroupName`'s 80). */
const TAG_MOST = 40;
const GROUP_NAME_MOST = 80;

const nameOf = (environments: readonly EnvironmentView[], environmentId: string): string =>
  environments.find((view) => view.environmentId === environmentId)?.name ?? THIS_MACHINE;

/** A dialog that closes when dismissed (Esc, the overlay, a Close button). */
const Shown = ({ close, title, description, children }: { close(): void; readonly title: string; readonly description?: string; readonly children: ReactNode }) => (
  <Dialog open onOpenChange={(open) => !open && close()}>
    <DialogContent title={title} {...(description !== undefined && { description })}>
      {children}
    </DialogContent>
  </Dialog>
);

/** A dialog's buttons, at its foot. */
const Actions = ({ children }: { readonly children: ReactNode }) => <div className="flex justify-end gap-2">{children}</div>;

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
            <Button>Cancel</Button>
          </DialogClose>
          <Button type="submit" tone="primary" disabled={!(at instanceof Date)}>
            Snooze
          </Button>
        </Actions>
      </form>
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
              <Button aria-label={`Take #${held} off`} onClick={() => organise.send(environmentId, "sessions.untag", { sessionId: summary.id, tag: held })}>
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submitted(add)} className="flex gap-2">
        <Input aria-label="A tag to add" maxLength={TAG_MOST} value={typed} onChange={(event) => setTyped(event.target.value)} />
        <Button type="submit" disabled={tag === "" || held}>
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
  const runtime = useRuntime();
  const organise = useOrganise();
  const [typed, setTyped] = useState("");
  const name = typed.trim();
  const move = () => {
    if (name === "") return;
    organise.hear(runtime.commands.moveToGroup(row.environmentId, row.summary.id, name).then((answer) => [answer]), notDone("sessions.setGroup"));
    close();
  };
  return (
    <Shown close={close} title={`Move ${quoted(row.summary.title)} into a new group`}>
      <form onSubmit={submitted(move)} className="flex flex-col gap-3">
        <Input aria-label="The group's name" maxLength={GROUP_NAME_MOST} value={typed} onChange={(event) => setTyped(event.target.value)} />
        <Actions>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button type="submit" tone="primary" disabled={name === ""}>
            Move
          </Button>
        </Actions>
      </form>
    </Shown>
  );
};

const DeleteDialog = ({ row, close }: { readonly row: SessionRow; close(): void }) => {
  const runtime = useRuntime();
  const organise = useOrganise();
  const environments = useObservable(runtime.projections.environments);
  const title = quoted(row.summary.title);
  const remove = () => {
    organise.send(row.environmentId, "sessions.delete", { sessionId: row.summary.id });
    organise.say(`Deleted ${title}. Restore brings it back within 30 days.`);
    close();
  };
  return (
    <Shown close={close} title={`Delete ${title} on ${nameOf(environments, row.environmentId)}?`} description="Restore brings it back within 30 days; after that it is gone.">
      <Actions>
        <DialogClose asChild>
          <Button>Keep it</Button>
        </DialogClose>
        <Button tone="danger" onClick={remove}>
          Delete
        </Button>
      </Actions>
    </Shown>
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
    <Shown close={close} title={`Delete the group ${quoted(group.name)}?`} description={`On ${on}. Its sessions stay, in no group.`}>
      <Actions>
        <DialogClose asChild>
          <Button>Keep it</Button>
        </DialogClose>
        <Button tone="danger" onClick={remove}>
          Delete
        </Button>
      </Actions>
    </Shown>
  );
};

const RestoreDialog = ({ close }: { close(): void }) => {
  const runtime = useRuntime();
  const organise = useOrganise();
  const environments = useObservable(runtime.projections.environments);
  // Asked once, as the dialog opens.
  const [asked] = useState(() => askRestorable(runtime.requests, runtime.projections.environments.read()));
  const { found, failed, asking } = useObservable(asked);
  return (
    <Shown close={close} title="Restore a deleted session" description="What each environment deleted in the last 30 days; after that it is purged.">
      {asking > 0 && <p className="text-sm text-ink-muted">Asking each environment what it deleted…</p>}
      {failed.map(({ environmentId, message }) => (
        <p key={environmentId} className="text-sm text-ink-muted">{`${nameOf(environments, environmentId)} could not be asked: ${message}`}</p>
      ))}
      {asking === 0 && failed.length === 0 && found.length === 0 && <p className="text-sm text-ink-muted">Nothing deleted can be restored: a deleted session is purged after 30 days.</p>}
      {found.length > 0 && (
        <ul aria-label="Deleted sessions" className="flex flex-col gap-1">
          {found.map(({ environmentId, summary }) => {
            const offer = runtime.commands.admits(environmentId, "sessions.restore");
            const absent = offer.status === "absent" ? offer.message : undefined;
            const view = environments.find((candidate) => candidate.environmentId === environmentId);
            return (
              <li key={`${environmentId}/${summary.id}`} className="flex flex-wrap items-center gap-2 text-sm">
                <EnvironmentGlyph view={view} label={view?.name ?? THIS_MACHINE} />
                <span className="min-w-0 flex-1 truncate">{summary.title}</span>
                <span className="text-xs text-ink-muted">{`restorable until ${whenWords(new Date(summary.purgeAt))}`}</span>
                <Button
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
          <Button>Close</Button>
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
  if (dialog.kind === "restore") return <RestoreDialog close={close} />;
  if (dialog.kind === "delete-group") {
    const group = list.groups.find((held) => groupHeading(held.key) === dialog.heading);
    return group === undefined ? null : <DeleteGroupDialog group={group} close={close} />;
  }
  const row = list.rows.find((held) => rowKey(held) === dialog.row);
  if (row === undefined) return null;
  switch (dialog.kind) {
    case "snooze":
      return <SnoozeDialog row={row} close={close} />;
    case "tags":
      return <TagsDialog row={row} close={close} />;
    case "new-group":
      return <NewGroupDialog row={row} close={close} />;
    case "delete":
      return <DeleteDialog row={row} close={close} />;
  }
};
