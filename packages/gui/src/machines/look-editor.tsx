import { adminCall, uuidv7, type EnvironmentView } from "@agent-harness/client-runtime";
import {
  ENVIRONMENT_COLOURS,
  ENVIRONMENT_ICONS,
  ENVIRONMENT_NAME_MAX,
  EnvironmentName,
  type EnvironmentColour,
  type EnvironmentIcon,
} from "@agent-harness/contracts";
import { useId, useState, type FormEvent } from "react";
import { Button, Input } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";

/** The three commands that set an environment's look, by the part each sets. */
const LOOK_METHODS = { name: "environment.rename", icon: "environment.setIcon", colour: "environment.setColour" } as const;
type LookPart = keyof typeof LOOK_METHODS;

/** The three commands, which the editor is writable only with. */
export const LOOK_COMMANDS = Object.values(LOOK_METHODS);

/** What a refused part says before why. */
const REFUSED: Readonly<Record<LookPart, string>> = { name: "Not renamed", icon: "Icon not set", colour: "Colour not set" };

const SELECT = "h-8 rounded-md border border-line bg-inset px-2 text-sm text-ink outline-none focus-visible:border-beam disabled:text-ink-faint";

/**
 * An environment's name, icon and colour on its card (workspace-picker spec,
 * "Name, icon and colour"; ADR 0025; #323): a name typed and renamed, an
 * icon and a colour chosen from the fixed sets, each sent as its own `admin`
 * command directly, never queued. What the environment answers reaches every
 * badge in the window through the runtime's descriptor, so the card keeps
 * nothing but the name being typed and why the last command was refused.
 * Read-only unless `writable` (the card says why not).
 */
export const LookEditor = ({ view, writable }: { readonly view: EnvironmentView; readonly writable: boolean }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const ids = { icon: useId(), colour: useId() };
  const [refused, setRefused] = useState<string | undefined>(undefined);

  const send = async (part: LookPart, value: string) => {
    setRefused(undefined);
    const commandId = uuidv7(clock.now());
    const { environmentId } = view;
    const outcome = await adminCall(() => {
      switch (part) {
        case "name":
          return runtime.requests.call(environmentId, LOOK_METHODS.name, { commandId, name: value });
        case "icon":
          return runtime.requests.call(environmentId, LOOK_METHODS.icon, { commandId, icon: value as EnvironmentIcon });
        case "colour":
          return runtime.requests.call(environmentId, LOOK_METHODS.colour, { commandId, colour: value as EnvironmentColour });
      }
    });
    if (!outcome.ok) setRefused(`${REFUSED[part]}: ${outcome.line}`);
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Keyed by the name, so a name set anywhere, here or by another client, is the field's again. */}
      <NameField
        key={view.name}
        name={view.name ?? ""}
        writable={writable}
        rename={(name) => {
          if (!EnvironmentName.safeParse(name).success) return setRefused(`${REFUSED.name}: a name is 1 to ${ENVIRONMENT_NAME_MAX} characters, none of them a control character.`);
          void send("name", name);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={ids.icon} className="w-14 text-sm text-ink-muted">
          Icon
        </label>
        <select id={ids.icon} value={view.icon ?? ""} disabled={!writable} onChange={(event) => void send("icon", event.target.value)} className={SELECT}>
          {view.icon === null && <option value="">none</option>}
          {ENVIRONMENT_ICONS.map((icon) => (
            <option key={icon} value={icon}>
              {icon}
            </option>
          ))}
        </select>
        <label htmlFor={ids.colour} className="text-sm text-ink-muted">
          Colour
        </label>
        <select id={ids.colour} value={view.colour ?? ""} disabled={!writable} onChange={(event) => void send("colour", event.target.value)} className={SELECT}>
          {view.colour === null && <option value="">none</option>}
          {ENVIRONMENT_COLOURS.map((colour) => (
            <option key={colour} value={colour}>
              {colour}
            </option>
          ))}
        </select>
      </div>
      {refused !== undefined && <p className="text-xs text-signal">{refused}</p>}
    </div>
  );
};

/** The name as it is typed, renamed with its button. */
const NameField = ({ name, writable, rename }: { readonly name: string; readonly writable: boolean; readonly rename: (name: string) => void }) => {
  const id = useId();
  const [typed, setTyped] = useState(name);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    rename(typed);
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <label htmlFor={id} className="w-14 text-sm text-ink-muted">
        Name
      </label>
      <Input id={id} value={typed} disabled={!writable} onChange={(event) => setTyped(event.target.value)} className="w-56" />
      <Button type="submit" disabled={!writable || typed.trim() === "" || typed === name}>
        Rename
      </Button>
    </form>
  );
};
