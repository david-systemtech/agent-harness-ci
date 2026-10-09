import { ArrowRight, Copy, Pencil, RefreshCw, X } from "lucide-react";
import { ActionButton as Button, AccessField as Field } from "./action-button.js";
import { copyValue, moveItems, moveOfferWords, setBasePath, type MoveFollowUp, type MoveLine, type MoveOptions } from "@agent-harness/client-runtime";
import { referenceLocator, type KeyManagerConnectionRecord, type KeyManagerMoveItem, type KeyManagerMoveItemRef, type KeyManagerMoveLocator } from "@agent-harness/contracts";
import { useEffect, useId, useMemo, useRef, useState, type Ref } from "react";
import { useSettings } from "../settings/settings-window.js";
import { useChecklist } from "../setup/checklist-window.js";
import { Dialog, DialogContent, Input, Select } from "../ui/index.js";
import { useClock, useObservable, useRuntime, useShell } from "../window-context.js";
import { RefusalLine } from "./refusal-line.js";

/** What a Move card's last action said: a line, or a refusal's plain line with its raw words for Details. */
interface Said {
  readonly ok: boolean;
  readonly line: string;
  readonly details?: readonly string[] | undefined;
}

/** A line a Move card's action said; a refusal as an alert, its raw words under Details. */
const SaidLine = ({ said }: { readonly said: Said }) => (said.ok ? <p className="text-sm text-ink-muted">{said.line}</p> : <RefusalLine line={said.line} details={said.details} />);

/** A value answered once for a person to paste, with where it goes; held only while its dialog is open. */
interface Copied {
  readonly value: string;
  readonly reference: KeyManagerMoveLocator;
}

export interface MoveCardProps {
  readonly environmentId: string;
  /** The connections a Move may go into, as the cached list holds them. */
  readonly connections: readonly KeyManagerConnectionRecord[];
  readonly writable: boolean;
  /** The card's region, which an opening at it focuses (the Key manager card's, #590). */
  readonly ref?: Ref<HTMLElement>;
}

/** The connection a Move is preset to go into: the one runs receive the variables of, else the first. */
const presetOf = (connections: readonly KeyManagerConnectionRecord[]): string | undefined => (connections.find((connection) => connection.injects) ?? connections[0])?.id;

/**
 * Move stored tokens (key-managers spec, "Move stored tokens"; ADR 0028;
 * #425): the items `keyManagers.move.list` holds, each with its target on
 * the connection the Move goes into; that connection's base path, preset to
 * the one it suggests (said until one is set) and set with
 * `keyManagers.connections.setBasePath`; Move per item, and Move all once a
 * base path is set, each Move answering one line per item. A target holding
 * another value offers Overwrite; one the login cannot write offers Copy
 * value (`keyManagers.move.copyValue`), shown once for a person to paste,
 * and then Verify the paste, a verify-only Move that finishes the swap.
 */
export const MoveCard = ({ environmentId, connections, writable, ref }: MoveCardProps) => {
  const heading = useId();
  const [chosen, choose] = useState<string | undefined>(undefined);
  // A choice the list no longer holds (the connection was removed) falls back to the preset.
  const connection = connections.find((each) => each.id === chosen) ?? connections.find((each) => each.id === presetOf(connections));
  if (connection === undefined) return null;
  return (
    <section ref={ref} tabIndex={-1} aria-labelledby={heading} className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-3 outline-none">
      <h3 id={heading} className="text-xs font-semibold text-ink">
        Move stored tokens
      </h3>
      <p className="text-sm text-ink-muted">Each is written to the key manager, read back, swapped for a reference to it, and its stored copy deleted.</p>
      {connections.length > 1 && (
        <Field label="Move into">
          <Select value={connection.id} onChange={(event) => choose(event.target.value)}>
            {connections.map((each) => (
              <option key={each.id} value={each.id}>
                {each.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {/* Keyed by the connection and its base path, so what was typed and answered for one target never carries to another. */}
      <MoveInto key={`${connection.id} ${connection.basePath ?? ""}`} environmentId={environmentId} connection={connection} writable={writable} />
    </section>
  );
};

/**
 * A Move into one connection, as a card holds it: the items
 * `keyManagers.move.list` holds, named as people know them; each Move's
 * lines and what each item offers next (Overwrite, Copy value, Verify the
 * paste), a value Copy value answered while its dialog is open, and a
 * refusal of the whole Move or of a copy, said for the button that asked.
 */
const useMoves = (environmentId: string, connection: KeyManagerConnectionRecord, writable: boolean) => {
  const runtime = useRuntime();
  const clock = useClock();
  const sender = { runtime, clock };
  const listed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "keyManagers.move.list", {}), [runtime, environmentId]));
  const [lines, setLines] = useState<readonly MoveLine[]>([]);
  const [said, setSaid] = useState<Said | undefined>(undefined);
  const [followUps, setFollowUps] = useState<ReadonlyMap<string, MoveFollowUp>>(new Map());
  const [copied, setCopied] = useState<Copied | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const items = listed.result?.items ?? [];
  const names = new Map(items.map((item) => [item.id, item.name]));
  // A Move or a copy on its way takes no second press.
  const acting = !writable || sending;

  /** Sets the base path first when `basePath` differs from the one set, then moves; a refusal is said for the button `verb`. */
  const move = (which: "all" | readonly KeyManagerMoveItemRef[], verb: string, options: MoveOptions = {}, basePath?: string) => {
    setSaid(undefined);
    setSending(true);
    const placed = basePath === undefined || basePath.trim() === connection.basePath ? Promise.resolve(null) : setBasePath(sender, environmentId, connection, basePath, verb);
    void placed.then(async (set) => {
      if (set !== null && !set.ok) return set;
      return moveItems(sender, environmentId, connection, which, names, verb, options);
    }).then((answer) => {
      setSending(false);
      if (!answer.ok) return setSaid(answer);
      if (!("lines" in answer)) return;
      setLines(answer.lines);
      setFollowUps((held) => new Map([...held, ...answer.lines.map((each) => [each.item.id, each.followUp] as const)]));
    });
  };
  const copy = (item: KeyManagerMoveItemRef) => {
    setSending(true);
    void copyValue(sender, environmentId, connection, item).then((answer) => {
      setSending(false);
      if (!answer.ok) return setSaid(answer);
      setFollowUps((held) => new Map([...held, [item.id, "verify"]]));
      setCopied({ value: answer.value, reference: answer.reference });
    });
  };
  /** What `item` offers after the last Move: Overwrite, Copy value or Verify the paste; null for nothing. `moving` holds a Move back. */
  const followUp = (item: KeyManagerMoveItemRef, moving: boolean) => {
    const ref = { kind: item.kind, id: item.id };
    switch (followUps.get(item.id)) {
      case "overwrite":
        return (
          <Button icon={ArrowRight} label="Overwrite" disabled={moving} onClick={() => move([ref], "Overwrite", { overwrite: true })}>
            Overwrite
          </Button>
        );
      case "copy-value":
        return (
          <Button icon={Copy} label="Copy value" disabled={acting} onClick={() => copy(ref)}>
            Copy value
          </Button>
        );
      case "verify":
        return (
          <Button icon={RefreshCw} label="Verify the paste" disabled={moving} onClick={() => move([ref], "Verify the paste", { verifyOnly: true })}>
            Verify the paste
          </Button>
        );
      default:
        return null;
    }
  };
  const dialog = copied === undefined ? null : <CopiedValueDialog environmentId={environmentId} label={connection.label} copied={copied} close={() => setCopied(undefined)} />;
  return { listed, items, lines, said, setSaid, acting, sender, move, followUp, dialog };
};

/** The Move card's part for the connection it goes into, at its base path: the base path, the items with their targets, the Move's lines and follow-ups. */
const MoveInto = ({ environmentId, connection, writable }: { readonly environmentId: string; readonly connection: KeyManagerConnectionRecord; readonly writable: boolean }) => {
  const { listed, items, lines, said, setSaid, acting, sender, move, followUp, dialog } = useMoves(environmentId, connection, writable);
  const [typed, setTyped] = useState<string | undefined>(undefined);
  // While the base path typed differs from the one set, a Move would go to the one set: it waits for Set the base path.
  const editing = typed !== undefined && typed.trim() !== (connection.basePath ?? connection.suggestedBasePath ?? "");
  const moving = acting || editing;
  const basePath = typed ?? connection.basePath ?? connection.suggestedBasePath ?? "";
  const targetOf = (item: KeyManagerMoveItem) => item.targets.find((target) => target.connectionId === connection.id)?.reference;

  return (
    <>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Base path">
          <Input value={basePath} disabled={!writable} onChange={(event) => setTyped(event.target.value)} />
        </Field>
        <Button icon={Pencil} label="Set the base path"
          disabled={acting || basePath.trim() === "" || basePath.trim() === connection.basePath}
          onClick={() => void setBasePath(sender, environmentId, connection, basePath, "Set the base path").then(setSaid)}
        >
          Set the base path
        </Button>
      </div>
      {connection.basePath === null && connection.suggestedBasePath !== null && <p className="text-sm text-ink-muted">Suggested: {connection.suggestedBasePath}.</p>}
      {listed.result === null ? (
        <p className="text-sm text-ink-faint">{listed.error === null ? "Reading the stored tokens…" : `The stored tokens could not be read: ${listed.error.message}`}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-ink-muted">No stored token is left to move here.</p>
      ) : (
        <ul aria-label="Stored tokens" className="flex flex-col gap-2">
          {items.map((item) => {
            const target = targetOf(item);
            return (
              <li key={item.id} aria-label={item.name} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink">{item.name}</span>
                <span className="min-w-0 break-all font-mono text-xs text-ink-muted">{target === undefined ? "Set a base path to see where it goes." : `To ${referenceLocator(target)}`}</span>
                <span className="ml-auto flex gap-2">
                  {followUp(item, moving)}
                  <Button icon={ArrowRight} label="Move" disabled={moving || target === undefined} onClick={() => move([{ kind: item.kind, id: item.id }], "Move")}>
                    Move
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {connection.basePath !== null && items.length > 0 && (
        <Button icon={ArrowRight} label="Move all" variant="default" className="self-start" disabled={moving} onClick={() => move("all", "Move all")}>
          Move all
        </Button>
      )}
      {said !== undefined && <SaidLine said={said} />}
      {lines.length > 0 && (
        <ul aria-label="What the Move did" className="flex flex-col gap-1 text-sm text-ink">
          {lines.map((each) => (
            <li key={each.item.id}>{each.line}</li>
          ))}
        </ul>
      )}
      {dialog}
    </>
  );
};

export interface MoveSavedTokensProps {
  readonly environmentId: string;
  /** The connections a Move may go into, as the cached list holds them; at least one. */
  readonly connections: readonly KeyManagerConnectionRecord[];
  readonly writable: boolean;
  /** Whether the card was opened at it (the Forges card's Move to your key manager): it takes the focus once drawn. */
  readonly focused: boolean;
}

/**
 * Move saved tokens on the Key manager card (setup-copy.md §5.7; ADR 0028;
 * #590, #1851), drawn only while agent-harness keeps tokens itself: how many,
 * and whether to move them into the connection runs get the keys of (the
 * first, else; another chosen where there are several), in the folder
 * typed there, preset to the one set or suggested. Move them sets that
 * folder as the connection's base path where it differs, then moves every
 * one, each answered in a line with what it offers next (Overwrite, Copy
 * value, Verify the paste).
 */
export const MoveSavedTokens = ({ environmentId, connections, writable, focused }: MoveSavedTokensProps) => {
  const [chosen, choose] = useState<string | undefined>(undefined);
  const connection = connections.find((each) => each.id === chosen) ?? connections.find((each) => each.id === presetOf(connections));
  if (connection === undefined) return null;
  // Keyed by the connection alone: Move them sets the base path itself, and the Move in flight keeps its lines and follow-ups past that.
  return <MoveSavedInto key={connection.id} environmentId={environmentId} connections={connections} connection={connection} choose={choose} writable={writable} focused={focused} />;
};

const MoveSavedInto = ({
  environmentId,
  connections,
  connection,
  choose,
  writable,
  focused,
}: Omit<MoveSavedTokensProps, "connections"> & { readonly connections: readonly KeyManagerConnectionRecord[]; readonly connection: KeyManagerConnectionRecord; readonly choose: (id: string) => void }) => {
  const heading = useId();
  const section = useRef<HTMLElement>(null);
  const { items, lines, said, acting, move, followUp, dialog } = useMoves(environmentId, connection, writable);
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const folder = typed ?? connection.basePath ?? connection.suggestedBasePath ?? "";
  const drawn = items.length > 0 || lines.length > 0;
  useEffect(() => {
    if (focused && drawn) section.current?.focus();
  }, [focused, drawn]);
  if (!drawn) return null;
  return (
    <section ref={section} data-move-saved-tokens tabIndex={-1} aria-labelledby={heading} className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-3 outline-none">
      <h3 id={heading} className="text-sm font-semibold text-ink">
        Move saved tokens
      </h3>
      {items.length > 0 && <p className="text-sm text-ink">{moveOfferWords(items.length, connection.label)}</p>}
      {connections.length > 1 && (
        <Field label="Move into">
          <Select value={connection.id} disabled={!writable} onChange={(event) => choose(event.target.value)}>
            {connections.map((each) => (
              <option key={each.id} value={each.id}>
                {each.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {items.length > 0 && (
        <>
          <Field label={`Folder in ${connection.label}`}>
            <Input value={folder} disabled={!writable} onChange={(event) => setTyped(event.target.value)} />
          </Field>
          <Button icon={ArrowRight} label="Move them" variant="default" className="self-start" disabled={acting || folder.trim() === ""} onClick={() => move("all", "Move them", {}, folder)}>
            Move them
          </Button>
        </>
      )}
      {said !== undefined && <SaidLine said={said} />}
      {lines.length > 0 && (
        <ul aria-label="What the Move did" className="flex flex-col gap-2 text-sm text-ink">
          {lines.map((each) => (
            <li key={each.item.id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0">{each.line}</span>
              {followUp(each.item, acting)}
            </li>
          ))}
        </ul>
      )}
      {dialog}
    </section>
  );
};

/**
 * The value Copy value answered, shown once (ADR 0028's Copy the value): its
 * target, the value in a field to select, and Copy to the clipboard where
 * the shell has one. Done lets it go; nothing else on the client holds it.
 */
const CopiedValueDialog = ({ environmentId, label, copied, close }: { readonly environmentId: string; readonly label: string; readonly copied: Copied; readonly close: () => void }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const clipboard = runtime.capability(environmentId, "shell.clipboard").status === "present" ? shell?.clipboard : undefined;
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        title={`Paste this value into ${label}`}
        description="It is shown this once: paste it at the place below in your key manager, then Verify the paste to finish the move."
        className="max-w-lg"
      >
        <p className="text-sm text-ink">At {referenceLocator(copied.reference)}</p>
        <Field label="The stored token">
          <Input readOnly value={copied.value} className="font-mono" onFocus={(event) => event.target.select()} />
        </Field>
        <div className="flex justify-end gap-2">
          {clipboard !== undefined && <Button icon={Copy} label="Copy to the clipboard" onClick={() => void clipboard.writeText(copied.value)}>Copy to the clipboard</Button>}
          <Button icon={X} label="Done" variant="default" onClick={close}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Move to your key manager, on a stored token (the Set up specification,
 * "4. Forges"; ADR 0028; #590): the full checklist on the environment that
 * holds it, at the Key manager card's Move stored tokens, which takes the
 * focus.
 */
export const MoveToKeyManager = ({ environmentId }: { readonly environmentId: string }) => {
  const { pick } = useSettings();
  const { open } = useChecklist();
  return (
    <Button icon={ArrowRight} label="Move to your key manager"
      onClick={() => {
        pick(environmentId);
        open("key-manager", "move-stored-tokens");
      }}
    >
      Move to your key manager
    </Button>
  );
};
