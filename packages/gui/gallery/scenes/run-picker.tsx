import type { Script, ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { Cpu } from "lucide-react";
import { SlashCommands } from "../../src/composer/slash-commands.js";
import { KeyDispatch } from "../../src/keys/key-dispatch.js";
import { PaneLine, PaneLines } from "../../src/session/pane-line.js";
import { PaneDialogs } from "../../src/status/pane-dialogs.js";
import { RunPickerColumns } from "../../src/status/pickers.js";
import { RunChoicesProvider, useModelChoice } from "../../src/status/run-choices.js";
import { Button, Menu, MenuContent, MenuTrigger, Tooltip } from "../../src/ui/index.js";
import { useObservable, useRuntime } from "../../src/window-context.js";
import type { SceneGeometry } from "../scene-registry.js";

const environmentId = "0199cc00-0000-4000-8000-000000000053";
const sessionId = "0199dd00-0000-4000-8000-000000000054";
// The second email is long enough to break mid-word in the 224px column, the rest fit: the rows keep one shape (#1895).
const emailOf = (index: number) => index === 1 ? "account-2.with-a-long-address@example.test" : `account-${index + 1}@example.test`;
const accounts = Array.from({ length: 8 }, (_, index) => ({ id: `account-${index + 1}`, label: `Account ${index + 1}`, identity: { provider: "claude", email: emailOf(index), organisation: null } }));
// The provider's own aliases first, named from the client runtime's display table (#1824), then enough samples to search.
const models = [
  { id: "fable", family: "fable", tier: 14, label: "Fable", efforts: ["low", "medium", "high"] },
  { id: "opus", family: "opus", tier: 13, label: "Opus", efforts: ["low", "medium", "high"] },
  { id: "sonnet", family: "sonnet", tier: 12, label: "Sonnet", efforts: ["low", "medium", "high"] },
  { id: "haiku", family: "haiku", tier: 11, label: "Haiku", efforts: [] },
  ...Array.from({ length: 11 }, (_, index) => ({ id: `sample-model-${index + 1}`, family: "sample", tier: index, label: `Sample model ${index + 1}`, efforts: ["low", "medium", "high"] })),
];
export const script: Script = { environments: [{ environmentId, name: "desk", reach: "local", icon: "desktop", colour: "teal", accounts,
  // eslint-disable-next-line agent-harness/no-client-organisation-state -- Scripted environment fixtures supply the session summary.
  sessions: [{ id: sessionId, title: "Run choices", accountId: "account-1", model: "fable" }], models: [{ accountId: "account-1", live: true, models }],
  // Three favourites pinned (#1821): they head the models, the session's own model after them, the eleven others under Other models.
  settings: { "accounts.favouriteModels": ["sample-model-3", "sample-model-7", "sample-model-11"] },
}] };
const usageWindow = (window: string, utilisation: number) => ({ window, utilisation, observedAt: "2026-09-24T00:00:00.000Z", resetsAt: "2026-09-24T05:00:00.000Z", verdict: null });
/** Accounts hold two plan windows, one or none in turn, so the rows show they keep one height (#1822). */
const windowsOf = (index: number) => [[usageWindow("five_hour", 0.8), usageWindow("seven_day", 0.35)], [usageWindow("five_hour", 0.95)], []][index % 3] ?? [];
export const arrange = (world: ScriptedWorld) => {
  world.environment("desk").setUsage(accounts.flatMap((account, index) => windowsOf(index).length === 0 ? [] : [{ accountId: account.id, identity: account.identity,
    readAt: "2026-09-24T00:00:00.000Z", unavailableReason: null, windows: windowsOf(index),
  }]));
};

const Popup = ({ compact }: { readonly compact: boolean }) => {
  const [choice] = useModelChoice(environmentId, sessionId);
  return <Menu defaultOpen modal={false}>
    <Tooltip content="Model · Enter to open · Escape to close"><MenuTrigger asChild><Button><Cpu aria-hidden="true" />Choose a run</Button></MenuTrigger></Tooltip>
    <MenuContent side="top" align="start" role={compact ? "dialog" : "menu"} aria-label="Run choices" aria-labelledby={undefined}
      className={compact ? "w-auto max-w-[calc(100vw-16px)] rounded-[10px] p-0 [&_[data-run-picker]]:w-[480px]" : "w-auto max-w-[calc(100vw-16px)] overflow-hidden rounded-[10px] p-0"}>
      <RunPickerColumns environmentId={environmentId} sessionId={sessionId} accountId="account-1" model={choice ?? { model: "fable", effort: "high" }} initialStage="Models" close={() => undefined} compact={compact} />
    </MenuContent>
  </Menu>;
};

/** Each scene draws the production columns over the scripted runtime. */
export const RunPickerScene = ({ compact = false }: { readonly compact?: boolean }) => {
  const environments = useObservable(useRuntime().projections.environments);
  return <main className="flex min-h-screen items-end bg-abyss p-6 text-ink">
    <KeyDispatch macOS={false}><RunChoicesProvider><PaneLines><SlashCommands><PaneLine environmentId={environmentId} sessionId={sessionId}><PaneDialogs environmentId={environmentId} sessionId={sessionId}>
      {environments.some((entry) => entry.environmentId === environmentId && entry.phase === "ready") && <Popup compact={compact} />}
    </PaneDialogs></PaneLine></SlashCommands></PaneLines></RunChoicesProvider></KeyDispatch>
  </main>;
};
export default RunPickerScene;

/** look.md §10.6: 224/256/256 columns, 6px list insets and independently capped lists. */
export const geometry: readonly SceneGeometry[] = [
  { selector: '[data-run-column="Accounts"]', width: 224 },
  { selector: '[data-run-column="Models"]', width: 256 },
  { selector: '[data-run-column="Effort"]', width: 256 },
  { selector: '[data-run-column="Accounts"] [data-run-list]', height: 320 },
  { selector: '[data-run-column="Models"] [data-run-list]', height: 320 },
  { selector: '[data-run-column="Accounts"] [data-usage-rings]', height: 16 },
  // An email is one line, cut with an ellipsis, so a long address no longer makes its row taller (#1895).
  { selector: '[data-run-column="Accounts"] [data-run-identity]', unbroken: true },
  // The session's own row reads a shorter note, so the other rows are compared with each other.
  { selector: '[data-run-column="Accounts"] [role="menuitem"]:has([data-run-identity]):not([data-selected])', sameHeight: true },
];
