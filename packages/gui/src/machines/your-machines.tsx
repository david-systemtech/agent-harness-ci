import { SettingsCardGrid } from "../settings/part.js";
import { LOCAL_PLACEHOLDER_ID, type EnvironmentView, type SecretProtection } from "@agent-harness/client-runtime";
import { useEffect, useState } from "react";
import { useObservable, useRuntime, useShell } from "../window-context.js";
import { AddAMachine } from "./add-a-machine.js";
import { MachineCard } from "./machine-card.js";
import { SetUpOffer } from "./set-up-offer.js";

/** The environments as Your machines lists them: the local one first (ADR 0025's This machine), then the rest in the saved sequence. */
const localFirst = (views: readonly EnvironmentView[]): readonly EnvironmentView[] => [
  ...views.filter((view) => view.kind === "local"),
  ...views.filter((view) => view.kind !== "local"),
];

/** Another environment named as `view` is, told apart by nothing a person reads: the names compared whatever their case. */
const namesakeOf = (view: EnvironmentView, views: readonly EnvironmentView[]): EnvironmentView | undefined => {
  const name = view.name?.toLocaleLowerCase();
  return name === undefined ? undefined : views.find((other) => other.environmentId !== view.environmentId && other.name?.toLocaleLowerCase() === name);
};

/**
 * How the desktop's secrets keep tokens (`shell.secrets.protection`), asked
 * once as the pane opens; undefined until it answers, and on a shell that
 * cannot say (a browser tab, which keeps tokens in memory) or fails to.
 */
const useSecretProtection = (): SecretProtection | undefined => {
  const runtime = useRuntime();
  const shell = useShell();
  const [protection, setProtection] = useState<SecretProtection | undefined>(undefined);
  useEffect(() => {
    if (runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.secrets.protection").status !== "present") return undefined;
    let open = true;
    void shell?.secrets?.protection?.().then(
      (answer) => open && setProtection(answer),
      () => undefined,
    );
    return () => {
      open = false;
    };
  }, [runtime, shell]);
  return protection;
};

/**
 * Your machines (ADR 0025, ADR 0027; docs/specs/gui.md, "Settings: the rail,
 * the rows and the addresses"; #416, #577): a card per connection, the local
 * environment first, each editing its own environment; above them, what
 * forgetting one did; after them, Add a machine, whose exchange makes a
 * card that offers Set up this machine until it is taken or declined.
 */
export const YourMachines = () => {
  const environments = localFirst(useObservable(useRuntime().projections.environments));
  const [forgotten, setForgotten] = useState<string | undefined>(undefined);
  const [added, setAdded] = useState<readonly string[]>([]);
  const unprotected = useSecretProtection() === "unprotected";
  const decline = (environmentId: string) => setAdded((now) => now.filter((id) => id !== environmentId));
  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      {forgotten !== undefined && <p className="text-sm text-ink">{forgotten}</p>}
      <SettingsCardGrid>{environments.map((view) => (
        <MachineCard
          key={view.environmentId}
          view={view}
          namesake={namesakeOf(view, environments)}
          unprotected={unprotected}
          forgotten={setForgotten}
          offer={added.includes(view.environmentId) ? <SetUpOffer view={view} decline={() => decline(view.environmentId)} /> : undefined}
        />
      ))}</SettingsCardGrid>
      <AddAMachine added={(environmentId) => setAdded((now) => (now.includes(environmentId) ? now : [...now, environmentId]))} />
    </div>
  );
};
