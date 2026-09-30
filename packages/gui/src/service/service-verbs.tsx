import { drainEnvironment, rebuildProjections, uuidv7, type EnvironmentView, type Runtime, type ServiceOutcome } from "@agent-harness/client-runtime";
import { useState } from "react";
import { nameOf } from "../connections/words.js";
import { Button, Dialog, DialogClose, DialogContent } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";

/** A verb of the Service row: its button, what its dialog asks and says it does, its confirming button, and what it sends. */
interface Verb {
  readonly button: string;
  readonly question: (name: string) => string;
  readonly description: (name: string) => string;
  readonly confirm: string;
  readonly send: (runtime: Runtime, environmentId: string, name: string, commandId: string) => Promise<ServiceOutcome>;
}

const VERBS: readonly Verb[] = [
  {
    button: "Drain…",
    question: (name) => `Drain ${name}?`,
    description: (name) => `${name} refuses new runs, lets the running ones finish for up to 30 minutes, then stops.`,
    confirm: "Drain",
    send: drainEnvironment,
  },
  {
    button: "Rebuild projections…",
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
      <div className="flex gap-2">
        {VERBS.map((verb) => (
          <Button
            key={verb.button}
            disabled={!writable}
            onClick={() => {
              setSaid(undefined);
              setAsking(verb);
            }}
          >
            {verb.button}
          </Button>
        ))}
      </div>
      {said !== undefined && <p className={`text-sm ${said.ok ? "text-ink-muted" : "text-signal"}`}>{said.line}</p>}
      <Dialog open={asking !== undefined} onOpenChange={(open) => !open && setAsking(undefined)}>
        {asking !== undefined && (
          <DialogContent title={asking.question(name)} description={asking.description(name)}>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button tone="danger" onClick={() => run(asking)}>
                {asking.confirm}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
};
