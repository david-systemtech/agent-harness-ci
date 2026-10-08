import { effortName, modelName } from "@agent-harness/client-runtime";
import { useMemo } from "react";
import { Select } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { useAuthoringRun } from "./authoring-run.js";

/** Resolves the account and model with the runtime's environment presets, and the effort from settings. */
export const useAuthoringPicker = (environmentId: string) => {
  const runtime = useRuntime();
  const run = useAuthoringRun();
  const held = run.choices.get(environmentId);
  const view = useObservable(useMemo(() => runtime.projections.newSession({ focus: { kind: "environment", environmentId }, ...(held !== undefined && { chips: held.chips }) }), [runtime, environmentId, held?.chips]));
  const settings = useObservable(useMemo(() => runtime.requests.cached(environmentId, "settings.get", {}), [runtime, environmentId]));
  const preset = settings.result?.values["accounts.defaultEffort"];
  const asked = held?.effort ?? (typeof preset === "string" ? preset : "");
  const effort = view.model.value?.efforts.includes(asked) ? asked : "";
  const chosenEffort = held?.effort === undefined ? {} : { effort: held.effort };
  const chooseAccount = (accountId: string) => run.choose(environmentId, { chips: { account: { environmentId, accountId } }, ...chosenEffort });
  const chooseModel = (model: string) => run.choose(environmentId, { chips: { ...held?.chips, model }, ...chosenEffort });
  const chooseEffort = (effort: string) => run.choose(environmentId, { chips: held?.chips ?? {}, ...(effort !== "" && { effort }) });
  return { view, effort, chooseAccount, chooseModel, chooseEffort };
};

export const AuthoringPicker = ({ picker }: { readonly picker: ReturnType<typeof useAuthoringPicker> }) => {
  const { view, effort, chooseAccount, chooseModel, chooseEffort } = picker;
  return <div className="flex flex-wrap gap-2" role="group" aria-label="Authoring account, model and effort">
    <label className="flex flex-col gap-1 text-sm">Account
      <Select aria-label="Authoring account" value={view.account.value?.id ?? ""} onChange={(event) => chooseAccount(event.target.value)}>
        <option value="" disabled>No account resolves</option>
        {view.account.options.map((account) => <option key={account.id} value={account.id} disabled={account.status.state !== "signed-in"}>{account.label}</option>)}
      </Select>
    </label>
    <label className="flex flex-col gap-1 text-sm">Model
      <Select aria-label="Authoring model" value={view.model.value?.id ?? ""} onChange={(event) => chooseModel(event.target.value)}>
        <option value="" disabled>No model resolves</option>
        {view.model.options.map((model) => <option key={model.id} value={model.id}>{modelName(model)}</option>)}
      </Select>
    </label>
    <label className="flex flex-col gap-1 text-sm">Effort
      <Select aria-label="Authoring effort" value={effort} onChange={(event) => chooseEffort(event.target.value)}>
        <option value="">Environment default effort</option>
        {view.model.value?.efforts.map((value) => <option key={value} value={value}>{effortName(value)}</option>)}
      </Select>
    </label>
  </div>;
};
