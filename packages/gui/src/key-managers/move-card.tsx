import { copyValue, moveItems, setBasePath, type MoveFollowUp, type MoveLine, type MoveOptions } from "@agent-harness/client-runtime";
import { referenceLocator, type KeyManagerConnectionRecord, type KeyManagerMoveItem, type KeyManagerMoveItemRef, type KeyManagerReference } from "@agent-harness/contracts";
import { useId, useMemo, useState } from "react";
import { Button, Dialog, DialogContent, Field, Input, Select } from "../ui/index.js";
import { useClock, useObservable, useRuntime, useShell } from "../window-context.js";

/** A value answered once for a person to paste, with where it goes; held only while its dialog is open. */
interface Copied {
  readonly value: string;
  readonly reference: KeyManagerReference;
}

export interface MoveCardProps {
  readonly environmentId: string;
  /** The connections a Move may go into, as the cached list holds them. */
  readonly connections: readonly KeyManagerConnectionRecord[];
  readonly writable: boolean;
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
export const MoveCard = ({ environmentId, connections, writable }: MoveCardProps) => {
  const heading = useId();
  const [chosen, choose] = useState<string | undefined>(undefined);
  // A choice the list no longer holds (the connection was removed) falls back to the preset.
  const connection = connections.find((each) => each.id === chosen) ?? connections.find((each) => each.id === presetOf(connections));
  if (connection === undefined) return null;
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3 rounded-md border border-line p-4">
      <h3 id={heading} className="text-base font-semibold text-ink">
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

/** The Move card's part for the connection it goes into, at its base path: the base path, the items with their targets, the Move's lines and follow-ups. */
const MoveInto = ({ environmentId, connection, writable }: { readonly environmentId: string; readonly connection: KeyManagerConnectionRecord; readonly writable: boolean }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const sender = { runtime, clock };
  const listed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "keyManagers.move.list", {}), [runtime, environmentId]));
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const [lines, setLines] = useState<readonly MoveLine[]>([]);
  const [line, setLine] = useState<string | undefined>(undefined);
  const [followUps, setFollowUps] = useState<ReadonlyMap<string, MoveFollowUp>>(new Map());
  const [copied, setCopied] = useState<Copied | undefined>(undefined);
  const [sending, setSending] = useState(false);

  const items = listed.result?.items ?? [];
  // A Move or a copy on its way takes no second press.
  const acting = !writable || sending;
  // While the base path typed differs from the one set, a Move would go to the one set: it waits for Set the base path.
  const editing = typed !== undefined && typed.trim() !== (connection.basePath ?? connection.suggestedBasePath ?? "");
  const moving = acting || editing;
  const names = new Map(items.map((item) => [item.id, item.name]));
  const basePath = typed ?? connection.basePath ?? connection.suggestedBasePath ?? "";
  const targetOf = (item: KeyManagerMoveItem) => item.targets.find((target) => target.connectionId === connection.id)?.reference;

  const move = (which: "all" | readonly KeyManagerMoveItemRef[], options: MoveOptions = {}) => {
    setLine(undefined);
    setSending(true);
    void moveItems(sender, environmentId, connection, which, names, options).then((answer) => {
      setSending(false);
      if (!answer.ok) return setLine(answer.line);
      setLines(answer.lines);
      setFollowUps((held) => new Map([...held, ...answer.lines.map((each) => [each.item.id, each.followUp] as const)]));
    });
  };
  const copy = (item: KeyManagerMoveItemRef) => {
    setSending(true);
    void copyValue(sender, environmentId, connection, item).then((answer) => {
      setSending(false);
      if (!answer.ok) return setLine(answer.line);
      setFollowUps((held) => new Map([...held, [item.id, "verify"]]));
      setCopied({ value: answer.value, reference: answer.reference });
    });
  };
  const followUp = (item: KeyManagerMoveItem) => {
    const ref = { kind: item.kind, id: item.id };
    switch (followUps.get(item.id)) {
      case "overwrite":
        return (
          <Button disabled={moving} onClick={() => move([ref], { overwrite: true })}>
            Overwrite
          </Button>
        );
      case "copy-value":
        return (
          <Button disabled={acting} onClick={() => copy(ref)}>
            Copy value
          </Button>
        );
      case "verify":
        return (
          <Button disabled={moving} onClick={() => move([ref], { verifyOnly: true })}>
            Verify the paste
          </Button>
        );
      default:
        return null;
    }
  };

  return (
    <>
      <div className="flex items-end gap-2">
        <Field label="Base path">
          <Input value={basePath} disabled={!writable} onChange={(event) => setTyped(event.target.value)} />
        </Field>
        <Button
          disabled={acting || basePath.trim() === "" || basePath.trim() === connection.basePath}
          onClick={() => void setBasePath(sender, environmentId, connection, basePath).then((set) => setLine(set.line))}
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
                <span className="text-ink-muted">{target === undefined ? "Set a base path to see where it goes." : `To ${referenceLocator(target)}`}</span>
                <span className="ml-auto flex gap-2">
                  {followUp(item)}
                  <Button disabled={moving || target === undefined} onClick={() => move([{ kind: item.kind, id: item.id }])}>
                    Move
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {connection.basePath !== null && items.length > 0 && (
        <Button tone="primary" className="self-start" disabled={moving} onClick={() => move("all")}>
          Move all
        </Button>
      )}
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
      {lines.length > 0 && (
        <ul aria-label="What the Move did" className="flex flex-col gap-1 text-sm text-ink">
          {lines.map((each) => (
            <li key={each.item.id}>{each.line}</li>
          ))}
        </ul>
      )}
      {copied !== undefined && <CopiedValueDialog environmentId={environmentId} label={connection.label} copied={copied} close={() => setCopied(undefined)} />}
    </>
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
          {clipboard !== undefined && <Button onClick={() => void clipboard.writeText(copied.value)}>Copy to the clipboard</Button>}
          <Button tone="primary" onClick={close}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
