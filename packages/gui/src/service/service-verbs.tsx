import { DialogFooter } from "../ui/dialog.js";
import { Layers, Power, X, type LucideIcon } from "lucide-react";
import { drainEnvironment, rebuildProjections, uuidv7, type EnvironmentView, type Runtime, type ServiceOutcome } from "@agent-harness/client-runtime";
import { useState } from "react";
import { nameOf } from "../connections/words.js";
import { Button, Dialog, DialogClose, DialogContent } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";

/** A verb of the Service row: its button, what its dialog asks and says it does, its confirming button, and what it sends. */
interface Verb {
  readonly button: string;
  readonly icon: LucideIcon;
  readonly question: (name: string) => string;
  readonly description: (name: string) => string;
  readonly confirm: string;
  readonly send: (runtime: Runtime, environmentId: string, name: string, commandId: string) => Promise<ServiceOutcome>;
}

const VERBS: readonly Verb[] = [
  {
    button: "Drain…",
    icon: Power,
    question: (name) => `Drain ${name}?`,
    description: (name) => `${name} refuses new runs, lets the running ones finish for up to 30 minutes, then stops.`,
    confirm: "Drain",
    send: drainEnvironment,
  },
  {
    button: "Rebuild projections…",
    icon: Layers,
    question: (name) => `Rebuild ${name}'s projections?`,
    description: (name) => `${name} drops its projection tables and replays its event log into them; the log itself does not change.`,
    confirm: "Rebuild",
    send: rebuildProjections,
  },
];

/**
 * Drain (`environment.drain`) and Rebuild projections
 * (`environment.rebuildProjections`) (env spec, "Lifecycle"; #417), each
 * an `admin` command asked once in a dialog, what it did, or why not, said
 * in one line under them.
 */
export const ServiceVerbs = ({ view, writable }: { readonly view: EnvironmentView; readonly writable: boolean }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [asking, setAsking] = useState<Verb | undefined>(undefined);
  const [said, setSaid] = useState<ServiceOutcome | undefined>(undefined);
  const name = nameOf(view);

  const run = (verb: Verb) => {
    setAsking(undefined);
    void verb.send(runtime, view.environmentId, name, uuidv7(clock.now())).then(setSaid);
  };

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {VERBS.map((verb) => (
          <Button
            key={verb.button}
            variant="outline"
            title={`${verb.button} (Enter or Space)`}
            disabled={!writable}
            onClick={() => {
              setSaid(undefined);
              setAsking(verb);
            }}
          >
            <verb.icon aria-hidden="true" data-icon="inline-start" />{verb.button}
          </Button>
        ))}
      </div>
      {said !== undefined && <p className={`text-sm ${said.ok ? "text-ink-muted" : "text-signal"}`}>{said.line}</p>}
      <Dialog open={asking !== undefined} onOpenChange={(open) => !open && setAsking(undefined)}>
        {asking !== undefined && (
          <DialogContent showClose={false} data-service-confirmation title={asking.question(name)} description={asking.description(name)}>
            <DialogFooter>
              <DialogClose asChild>
                <Button title="Cancel (Enter, Space or Escape)"><X aria-hidden="true" data-icon="inline-start" />Cancel</Button>
              </DialogClose>
              <Button variant="destructive" title={`${asking.confirm} (Enter or Space)`} onClick={() => run(asking)}>
                <asking.icon aria-hidden="true" data-icon="inline-start" />{asking.confirm}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
};
