import { DENYLIST_SECTION_NAMES, editedSection, listWords, sectionHasPresets, sectionHolds, type DenylistEdit, type EnvironmentView } from "@agent-harness/client-runtime";
import { DENYLIST_SECTIONS, type DenylistEntry, type DenylistSection } from "@agent-harness/contracts";
import { FileCode, Pencil, Plus, RotateCcw, Save, ShieldAlert, Text, Trash2, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Button, Dialog, DialogClose, DialogContent, Input, Switch, Tooltip } from "../ui/index.js";
import { DenylistTest } from "./denylist-test.js";
import { Part } from "../settings/part.js";
import type { DenylistValues } from "./use-denylist.js";

/**
 * The denylist (permissions spec, "The denylist"; #415): its four sections
 * from `permissions.denylist.get`, each entry with its pattern, note,
 * whether it is a preset and whether it is enabled; an entry added, edited,
 * enabled or disabled, or removed, each a write of its whole section through
 * `permissions.denylist.set` at once; a section's presets put back after one
 * confirmation (`permissions.denylist.restorePresets`); and a value tested
 * against it. What each sends and says is the client runtime's. The
 * denylist is the holder's (`useDenylist`), so what else it restores shows
 * here.
 */
export const DenylistPart = ({ view, values, writable }: { readonly view: EnvironmentView; readonly values: DenylistValues; readonly writable: boolean }) => {
  const { denylist, answer } = values;
  const ready = view.phase === "ready";
  return (
    <Part title="Denylist">
      <p className="text-sm text-ink-muted">Never approved on its own in any mode: a call that matches an enabled entry asks a person, and on an unattended run it is denied.</p>
      {denylist === null
        ? ready && <p className="text-sm text-ink-faint">{answer.error === null ? "Reading the denylist…" : `The denylist could not be read: ${answer.error.message}`}</p>
        : DENYLIST_SECTIONS.map((section) => <SectionCard key={section} section={section} entries={denylist[section]} values={values} writable={writable} />)}
      <DenylistTest environmentId={view.environmentId} ready={ready} />
    </Part>
  );
};

interface SectionCardProps {
  readonly section: DenylistSection;
  readonly entries: readonly DenylistEntry[];
  readonly values: DenylistValues;
  readonly writable: boolean;
}

/** What a section's last write or restore said: a refusal, or what a restore did. */
interface Said {
  readonly line: string;
  readonly refused: boolean;
}

/** One section: what it holds, its entries, a new entry's fields, Restore presets where it has any, and one line for what it last did. */
const SectionCard = ({ section, entries, values, writable }: SectionCardProps) => {
  const heading = useId();
  const name = DENYLIST_SECTION_NAMES[section];
  const [said, setSaid] = useState<Said | undefined>(undefined);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [restoring, setRestoring] = useState(false);
  // A write or restore of this section is unanswered: each write sends the whole section as last shown, so nothing else
  // writes it until the answer is shown, or the later write would undo the earlier.
  const [writing, setWriting] = useState(false);

  /** Writes the section with `edit` made; true once the environment has taken it. */
  const send = async (edit: DenylistEdit): Promise<boolean> => {
    setSaid(undefined);
    setWriting(true);
    try {
      const saved = await values.save(section, editedSection(entries, edit));
      if (!saved.ok) setSaid({ line: saved.line, refused: true });
      return saved.ok;
    } finally {
      setWriting(false);
    }
  };
  const restore = () => {
    setRestoring(false);
    setSaid(undefined);
    setWriting(true);
    void values
      .restore([section])
      .then((restored) => setSaid({ line: restored.line, refused: !restored.ok }))
      .finally(() => setWriting(false));
  };

  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={heading} className="flex items-center gap-1.5 text-xs font-semibold text-ink">
          <ShieldAlert aria-hidden="true" className="size-4" />{name}
        </h4>
        {sectionHasPresets(section) && (
          <Button title="Restore presets (Enter or Space)" size="sm" disabled={!writable || writing} onClick={() => setRestoring(true)}>
            <RotateCcw aria-hidden="true" data-icon="inline-start" />Restore presets
          </Button>
        )}
      </header>
      <p className="text-2xs text-ink-muted">{sectionHolds(section)}</p>
      {entries.length === 0 ? (
        <p className="text-sm text-ink-faint">No entry yet.</p>
      ) : (
        <ul aria-label="Entries" className="flex flex-col gap-1">
          {entries.map((entry) =>
            editing === entry.id ? (
              <EntryForm key={entry.id} entry={entry} writing={writing} send={send} close={() => setEditing(undefined)} />
            ) : (
              <EntryRow key={entry.id} entry={entry} writable={writable && !writing} send={send} edit={() => setEditing(entry.id)} />
            ),
          )}
        </ul>
      )}
      <AddEntry section={name} writable={writable} writing={writing} send={send} />
      {said !== undefined && <p className={`text-xs ${said.refused ? "text-signal" : "text-ink-muted"}`}>{said.line}</p>}
      <RestorePresetsDialog open={restoring} sections={[section]} cancel={() => setRestoring(false)} restore={restore} />
    </section>
  );
};

interface RestorePresetsDialogProps {
  /** Whether it is asking. */
  readonly open: boolean;
  /** The sections whose presets it asks to restore; undefined for every section's. */
  readonly sections: readonly DenylistSection[] | undefined;
  readonly cancel: () => void;
  readonly restore: () => void;
}

/**
 * The one confirmation a restore of the denylist's presets asks (permissions
 * spec, "The denylist"): a section's Restore presets, and the Permissions
 * step's Restore on its card (#594), which names its target sections or,
 * naming none, every section.
 */
export const RestorePresetsDialog = ({ open, sections, cancel, restore }: RestorePresetsDialogProps) => {
  const named = sections?.map((section) => DENYLIST_SECTION_NAMES[section]) ?? [];
  return (
    <Dialog open={open} onOpenChange={(opened) => !opened && cancel()}>
      {open && (
        <DialogContent
          title={`Restore the presets ${named.length === 0 ? "the denylist" : listWords(named)} lost?`}
          description={`Each preset ${named.length === 1 ? "the section" : "a section"} no longer holds is put back at its end, enabled; a preset edited or disabled stays as it is.`}
        >
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button title="Cancel (Esc)"><X aria-hidden="true" data-icon="inline-start" />Cancel</Button>
            </DialogClose>
            <Button title="Restore (Enter or Space)" variant="default" onClick={restore}>
              <RotateCcw aria-hidden="true" data-icon="inline-start" />Restore
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
};

interface EntryRowProps {
  readonly entry: DenylistEntry;
  readonly writable: boolean;
  readonly send: (edit: DenylistEdit) => Promise<boolean>;
  readonly edit: () => void;
}

/** An entry: whether it is enabled, its pattern, whether it is a preset and its note, then Edit and Remove. */
const EntryRow = ({ entry, writable, send, edit }: EntryRowProps) => (
  <li aria-label={entry.pattern} className="flex flex-wrap items-start gap-2 rounded-md bg-wash px-2.5 py-2 text-xs">
    <Tooltip content={`Enable ${entry.pattern}`} keys="Space to toggle"><Switch aria-label="Enabled" checked={entry.enabled} disabled={!writable} onCheckedChange={(enabled) => void send({ kind: "enable", id: entry.id, enabled })} /></Tooltip>
    <div className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
      <span className={`break-all font-mono ${entry.enabled ? "text-ink" : "text-ink-faint"}`}>{entry.pattern}</span>
      {entry.preset && <span className="text-2xs text-ink-faint">preset</span>}
      {entry.note !== "" && <span className="text-2xs text-ink-muted">{entry.note}</span>}
    </div>
    <span className="ml-auto flex gap-1">
      <Button title="Edit (Enter or Space)" size="xs" disabled={!writable} onClick={edit}>
        <Pencil aria-hidden="true" data-icon="inline-start" />Edit
      </Button>
      <Button title="Remove (Enter or Space)" size="xs" disabled={!writable} onClick={() => void send({ kind: "remove", id: entry.id })}>
        <Trash2 aria-hidden="true" data-icon="inline-start" />Remove
      </Button>
    </span>
  </li>
);

interface EntryFormProps {
  readonly entry: DenylistEntry;
  /** A write of the section is unanswered: Save waits for it. */
  readonly writing: boolean;
  readonly send: (edit: DenylistEdit) => Promise<boolean>;
  readonly close: () => void;
}

/** An entry being edited: its pattern and note, saved under its id, so a preset stays one. */
const EntryForm = ({ entry, writing, send, close }: EntryFormProps) => {
  const [pattern, setPattern] = useState(entry.pattern);
  const [note, setNote] = useState(entry.note);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send({ kind: "edit", id: entry.id, pattern, note }).then((saved) => saved && close());
  };
  return (
    <li aria-label={entry.pattern}>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-2xs"><span className="flex items-center gap-1.5"><FileCode aria-hidden="true" className="size-3.5" />Pattern</span><Input aria-label="Pattern" title="Pattern (Enter to submit)" value={pattern} onChange={(event) => setPattern(event.target.value)} className="w-full font-mono" /></label>
        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-2xs"><span className="flex items-center gap-1.5"><Text aria-hidden="true" className="size-3.5" />Note</span><Input aria-label="Note" title="Note (Enter to submit)" value={note} onChange={(event) => setNote(event.target.value)} className="w-full" /></label>
        <Button title="Save (Enter)" type="submit" variant="default" disabled={writing || pattern.trim() === ""}>
          <Save aria-hidden="true" data-icon="inline-start" />Save
        </Button>
        <Button title="Cancel (Enter or Space)" onClick={close}><X aria-hidden="true" data-icon="inline-start" />Cancel</Button>
      </form>
    </li>
  );
};

interface AddEntryProps {
  readonly section: string;
  readonly writable: boolean;
  /** A write of the section is unanswered: Add waits for it, while the fields can still be typed in. */
  readonly writing: boolean;
  readonly send: (edit: DenylistEdit) => Promise<boolean>;
}

/** A new entry's pattern and note, added at the section's end; the fields empty again once the environment has taken it. */
const AddEntry = ({ section, writable, writing, send }: AddEntryProps) => {
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send({ kind: "add", pattern, note }).then((saved) => {
      if (!saved) return;
      setPattern("");
      setNote("");
    });
  };
  return (
    <form aria-label={`Add to ${section}`} onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-2xs"><span className="flex items-center gap-1.5"><FileCode aria-hidden="true" className="size-3.5" />New pattern</span><Input aria-label="New pattern" title="New pattern (Enter to submit)" placeholder="Pattern" value={pattern} disabled={!writable} onChange={(event) => setPattern(event.target.value)} className="w-full font-mono" /></label>
      <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-2xs"><span className="flex items-center gap-1.5"><Text aria-hidden="true" className="size-3.5" />New note</span><Input aria-label="New note" title="New note (Enter to submit)" placeholder="Note" value={note} disabled={!writable} onChange={(event) => setNote(event.target.value)} className="w-full" /></label>
      <Button title="Add (Enter)" type="submit" disabled={!writable || writing || pattern.trim() === ""}>
        <Plus aria-hidden="true" data-icon="inline-start" />Add
      </Button>
    </form>
  );
};
