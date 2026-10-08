import { gaugeOf, identityWords, modelDisplayName, modelName, modelsOf, pickerModels, pinWords } from "@agent-harness/client-runtime";
import type { AccountCatalogue, AccountRecord, ModelEntry } from "@agent-harness/contracts";
import { ArrowLeft, Cpu, Layers, Search, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MenuLabel } from "../ui/index.js";
import { MenuGroup, MenuSub, MenuSubContent, MenuSubTrigger } from "../ui/menu.js";
import { useSettingsIfHeld } from "../settings/settings-window.js";
import { useObservable, useRuntime } from "../window-context.js";
import { RunChoiceRow } from "./run-picker-parts.js";
import { UsageRings } from "./window-reading.js";

/**
 * The account and model lists both run pickers draw (#1894): the status
 * line's (`pickers.tsx`) and the new-session surface's
 * (`../new-session/chips.tsx`), so a person picking an account and model
 * sees the same rows on either. An account's row carries its usage rings
 * (#1822); the models put the favourites first, else the provider's
 * recommended models with how to pin favourites, and every other model
 * under Other models (#1821), each named as the provider names it (#1824).
 */

/** What a menu says while it has nothing to list: it is reading, or why it could not. */
export const Waiting = ({ children }: { readonly children: ReactNode }) => <p className="px-2 py-1.5 text-xs text-ink-faint">{children}</p>;

const NO_FAVOURITES: readonly string[] = [];

/**
 * The environment's favourite models (`accounts.favouriteModels`) as the
 * request cache last read them; none until they are read, or where they
 * cannot be. A picker reads them as it opens, so they are in by the time
 * its models are.
 */
export const useFavouriteModels = (environmentId: string): readonly string[] => {
  const runtime = useRuntime();
  const answer = useObservable(useMemo(() => runtime.requests.cached(environmentId, "settings.get", {}), [runtime, environmentId]));
  return answer.result?.values["accounts.favouriteModels"] ?? NO_FAVOURITES;
};

interface AccountChoiceRowProps {
  readonly environmentId: string;
  readonly account: AccountRecord;
  readonly icon: Parameters<typeof RunChoiceRow>[0]["icon"];
  /** Its sign-in status and what choosing it does, in words. */
  readonly note: string;
  readonly selected: boolean;
  readonly dim?: boolean;
  readonly onSelect: () => void;
}

/** An account's row: its label and identity, a note, and its identity's plan windows as usage rings, the reading in their tooltip (#1822). */
export const AccountChoiceRow = ({ environmentId, account, icon, note, selected, dim = false, onSelect }: AccountChoiceRowProps) => {
  const usage = useObservable(useRuntime().projections.usage);
  return <RunChoiceRow icon={icon} label={`${account.label} ${identityWords(account)}`} primary={account.label} identity={identityWords(account)} selected={selected} dim={dim} note={note}
    usage={<UsageRings gauge={gaugeOf(usage.gauges, environmentId, account.id)} />} onSelect={onSelect} />;
};

interface ModelChoicesProps {
  readonly environmentId: string;
  /** The environment's catalogues, as `projections.models` reads them. */
  readonly catalogues: readonly AccountCatalogue[];
  /** The account whose models are listed; null lists every account's, once each, Other models grouped by account. */
  readonly accountId: string | null;
  /** The environment's favourite models (`useFavouriteModels`). */
  readonly favourites: readonly string[];
  /** The environment's accounts, which name Other models' groups. */
  readonly accounts: readonly AccountRecord[] | null;
  /** The model the picker holds, by id: marked, and a quick pick when it is neither a favourite nor recommended. */
  readonly current: string | undefined;
  /** One column at a time, as on a phone: Other models opens as the list's page rather than a flyout. */
  readonly narrow: boolean;
  readonly dim: boolean;
  choose(entry: ModelEntry): void;
  /** Closes the picker, as Pin favourites does on its way to Settings. */
  close(): void;
}

/**
 * The Models column's list: a search over a long catalogue, the quick picks
 * with the pin hint over recommended ones, Other models (a flyout opened on
 * hover, a click or the right arrow; in one column at a time, a page of the
 * list with a row back), and Pin or Edit favourites, which opens Settings.
 */
export const ModelChoices = ({ environmentId, catalogues, accountId, favourites, accounts, current, narrow, dim, choose, close }: ModelChoicesProps) => {
  const [query, setQuery] = useState("");
  const [othersOpen, setOthersOpen] = useState(false);
  const othersList = useRef<HTMLDivElement>(null);
  // Other models drilled into from the top of the list, the keyboard on its first row; back out, on its row.
  const drilled = useRef(false);
  useEffect(() => {
    const list = othersList.current;
    if (list !== null) {
      drilled.current = true;
      list.closest("[data-run-list]")?.scrollTo?.({ top: 0 });
      list.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    } else if (drilled.current) {
      drilled.current = false;
      document.querySelector<HTMLElement>('[data-run-column="Models"] [role="menuitem"][aria-label="Other models"]')?.focus();
    }
  }, [othersOpen, narrow]);
  const settingsWindow = useSettingsIfHeld();
  const models = modelsOf(catalogues, accountId);
  const picked = pickerModels(catalogues, accountId, favourites, current);
  const pin = pinWords(picked, favourites);
  const visible = models.filter((entry) => `${modelName(entry)} ${entry.label ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const accountLabel = (id: string) => accounts?.find((entry) => entry.id === id)?.label ?? id;
  const modelRow = (entry: ModelEntry) => <RunChoiceRow key={entry.id} icon={favourites.includes(entry.id) ? Star : Cpu} label={modelName(entry)} primary={modelDisplayName(entry.id, entry.label)} machine={modelDisplayName(entry.id, entry.label) === entry.id ? undefined : entry.id}
    selected={current === entry.id} dim={dim} note={entry.efforts.length > 0 ? "Supports effort" : "Uses its own effort"}
    onSelect={() => { setOthersOpen(false); choose(entry); }} />;
  // Other models: a flyout beside the column; in one column at a time (a phone's sheet), where a flyout has no room, a page of the list.
  const othersNote = `${picked.others.reduce((count, group) => count + group.models.length, 0)} more`;
  const otherGroups = picked.others.map((group) => <MenuGroup key={group.accountId} aria-label={picked.grouped ? accountLabel(group.accountId) : undefined}>
    {picked.grouped && <MenuLabel className="px-2.5 py-1.5">{accountLabel(group.accountId)}</MenuLabel>}
    {group.models.map(modelRow)}
  </MenuGroup>);
  return <>
    {models.length > 12 && <label title="Search models · Type to filter · Tab next column" className="mb-1 flex items-center gap-2 rounded-md bg-wash px-2"><Search aria-hidden="true" className="size-3" /><input aria-label="Search models" value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 min-w-0 w-full bg-transparent text-xs outline-none" /></label>}
    {query !== "" ? visible.map(modelRow) : narrow && othersOpen && picked.others.length > 0 ? <>
      <RunChoiceRow icon={ArrowLeft} label="Back to the quick picks" onSelect={() => setOthersOpen(false)} />
      <div ref={othersList} role="group" aria-label="Other models" data-other-models-list>{otherGroups}</div>
    </> : <>
      {pin !== undefined && models.length > 0 && <Waiting>{pin}</Waiting>}
      {picked.quick.map(modelRow)}
      {picked.others.length > 0 && (narrow ? <RunChoiceRow icon={Layers} label="Other models" note={othersNote} onSelect={() => setOthersOpen(true)} /> : <MenuSub open={othersOpen} onOpenChange={setOthersOpen}>
        <MenuSubTrigger aria-label="Other models" title="Other models · Right arrow to open · ↑ ↓ Home End" data-other-models className="items-start gap-2 px-2.5 py-2 text-xs [&_svg]:size-3">
          <Layers aria-hidden="true" className="mt-0.5" /><span className="min-w-0 flex-1"><span className="block font-medium">Other models</span><span className="block text-2xs text-ink-muted">{othersNote}</span></span>
        </MenuSubTrigger>
        <MenuSubContent aria-label="Other models" data-other-models-list className="w-72 max-h-[320px] overflow-y-auto p-1.5">{otherGroups}</MenuSubContent>
      </MenuSub>)}
      {settingsWindow !== null && models.length > 0 && <RunChoiceRow icon={Star} label={picked.pinned ? "Edit favourites…" : "Pin favourites…"} under="In Settings, Default account and model."
        onSelect={() => { close(); settingsWindow.open("accounts.default-model", environmentId); }} />}
    </>}
    {models.length > 0 && visible.length === 0 && <Waiting>No models match your search.</Waiting>}
  </>;
};
