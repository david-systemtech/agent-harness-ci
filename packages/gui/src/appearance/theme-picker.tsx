import { ReadOnlyAccess } from "../connections/limited-access.js";
import { LOCAL_PLACEHOLDER_ID, type EnvironmentView } from "@agent-harness/client-runtime";
import { MAX_SEED_CHROMA, THEME_SEED_NAMES, Theme, ThemeName, type ThemeSeedName } from "@agent-harness/contracts";
import { LADDERS, SEED_TOKENS, SHIPPED_THEMES, clampWords, cssVariables, derive, readThemeFile, themeFile, type DerivedTheme, type LadderName } from "@agent-harness/theme";
import { Download, Palette, Save, SlidersHorizontal, Upload, X } from "lucide-react";
import { useId, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from "react";
import { THIS_MACHINE } from "../connections/words.js";
import { CopyLine } from "../settings/copy-line.js";
import { lackingLines, readOnlyLine, writersOf } from "../settings/generic-editor.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { sameTheme, usePreviewTheme } from "../theme/window-theme.js";
import { SettingsGroup } from "../settings/part.js";
import { Button, Input, Tooltip } from "../ui/index.js";
import { useRuntime, useShell } from "../window-context.js";

/**
 * The theme picker (ADR 0023, phase D; docs/specs/switch-over.md, #84's
 * "phase-D theme picker"; #1194), shared by the Theme row, on the home
 * environment, and the Appearance step's card, on the environment the
 * checklist checks. It shows the environment's saved theme as this window
 * read it (`settings.get` in the request cache), and a candidate made from
 * it: one of the three shipped themes, a name, each seed's hue and chroma
 * inside the setting's bounds, or a theme file imported. The candidate's
 * swatches in both ladders and each clamp in the Appearance check's words
 * follow it, and the window paints it as a live preview; nothing is written
 * until Save writes `appearance.theme` once through `settings.update`
 * (`admin`), and Cancel paints the latest saved theme again. A refused
 * write keeps the candidate and says why. Without the writer's scope, or
 * while the environment is not reached, the theme is read-only, with the
 * reason said once; Export, the theme file of what is shown, stays open.
 * Light or dark and the display preferences are this client's own and are
 * not the picker's.
 */

/** The most a theme file is read at: one is a few hundred bytes, so a larger file is none. */
const MAX_THEME_FILE_BYTES = 64 * 1024;

/** The keys the picker writes. */
const THEME_KEYS = ["appearance.theme"] as const;

/** What the picker last said of what it did: done, or refused and why. */
interface Said {
  readonly refused: boolean;
  readonly line: string;
}

/** A theme's file name: its name, with what a file name cannot hold made a dash. */
const fileNameOf = (theme: Theme): string => `${theme.name.replace(/[\\/:*?"<>|]/g, "-")}.json`;

export const ThemePicker = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const settings = useSettingsValues(view.environmentId);
  const saved = Theme.safeParse(settings.values?.["appearance.theme"]).data;
  const [candidate, setCandidate] = useState<Theme | undefined>(undefined);
  const [said, setSaid] = useState<Said | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);
  const nameField = useId();

  const changed = candidate !== undefined && (saved === undefined || !sameTheme(candidate, saved));
  usePreviewTheme(changed ? candidate : undefined);
  const on = view.name ?? THIS_MACHINE;
  const ready = view.phase === "ready";
  const lacking = ready ? lackingLines(runtime, view.environmentId, writersOf(THEME_KEYS)) : [];
  const writable = ready && lacking.length === 0;
  const shown = changed ? candidate : saved;

  const edit = (next: Theme) => {
    setSaid(undefined);
    setCandidate(next);
  };

  const take = (name: string, text: string | undefined) => {
    if (text === undefined) return setSaid({ refused: true, line: `Not imported: ${name} is larger than a theme file can be.` });
    const read = readThemeFile(text);
    if (!read.ok) return setSaid({ refused: true, line: `Not imported: ${read.reason}` });
    edit(read.theme);
  };
  const importFile = () => {
    const dialogs = shell?.dialogs;
    if (dialogs === undefined || runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.dialogs").status !== "present") return filePicker.current?.click();
    void dialogs.openFileContents({ title: "Import a theme", filters: [{ name: "Theme", extensions: ["json"] }], maxBytes: MAX_THEME_FILE_BYTES }).then(([file]) => {
      if (file !== undefined) take(file.name, file.bytes === null ? undefined : new TextDecoder().decode(file.bytes));
    });
  };
  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const [file] = [...(input.files ?? [])];
    // Emptied, so that choosing the same file again is a change.
    input.value = "";
    if (file === undefined) return;
    if (file.size > MAX_THEME_FILE_BYTES) return take(file.name, undefined);
    void file.text().then((text) => take(file.name, text));
  };

  const save = () => {
    if (!changed) return;
    const writing = candidate;
    setSaving(true);
    setSaid(undefined);
    void settings.save("appearance.theme", writing).then((outcome) => {
      setSaving(false);
      if (!outcome.ok) return setSaid({ refused: true, line: `Not saved: ${outcome.line}` });
      setCandidate((now) => (now === writing ? undefined : now));
      setSaid({ refused: false, line: `Saved ${writing.name} on ${on}.` });
    });
  };

  const cancel = () => {
    setSaid(undefined);
    setCandidate(undefined);
  };

  const named = shown !== undefined && ThemeName.safeParse(shown.name).success;
  return (
    <div className="flex flex-col gap-3">
      {!ready && <p className="text-sm text-amber">{readOnlyLine(runtime, view, settings.values !== null)}</p>}
      {lacking.map((line) => (
        <ReadOnlyAccess key={line} environmentId={view.environmentId} line={line}><p className="text-sm text-amber">Read-only: {line}</p></ReadOnlyAccess>
      ))}
      {saved !== undefined && (
        <p className="text-sm font-medium text-ink">
          {saved.name}, on {on}
        </p>
      )}
      {shown !== undefined && (
        <>
          {changed && (
            <p className="text-sm text-ink-muted">
              Previewing {shown.name} in this window: not saved on {on}.
            </p>
          )}
          <SettingsGroup title="Theme choices">
          <ShippedThemes shown={shown} disabled={!writable} choose={edit} />
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={nameField} className="text-sm text-ink">
              Name
            </label>
            <Palette aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
            <Tooltip content="Theme name · Type to edit"><Input id={nameField} value={shown.name} disabled={!writable} onChange={(event) => edit({ ...shown, name: event.target.value })} className="min-w-0 flex-1" /></Tooltip>
          </div>
          {!named && <p className="text-xs text-signal">A theme&apos;s name is 1 to 40 characters on one line, with no white space at either end.</p>}
          </SettingsGroup>
          <SettingsGroup title="Theme seeds"><Seeds theme={shown} disabled={!writable} change={(seed, value) => edit({ ...shown, seeds: { ...shown.seeds, [seed]: value } })} /></SettingsGroup>
          <SettingsGroup title="Preview and contrast"><Derived theme={shown} /></SettingsGroup>
          <div className="flex flex-wrap gap-2">
            <Tooltip content="Save theme" keys="Enter / Space"><Button variant="default" disabled={!writable || !changed || !named || saving} onClick={save}>
              <Save aria-hidden="true" />Save
            </Button></Tooltip>
            <Tooltip content="Cancel theme" keys="Enter / Space"><Button disabled={!changed} onClick={cancel}>
              <X aria-hidden="true" />Cancel
            </Button></Tooltip>
            <Tooltip content="Import theme" keys="Enter / Space"><Button disabled={!writable} onClick={importFile}>
              <Upload aria-hidden="true" />Import
            </Button></Tooltip>
            <Tooltip content="Export theme" keys="Enter / Space"><Button disabled={!named} onClick={() => setExporting(true)}>
              <Download aria-hidden="true" />Export
            </Button></Tooltip>
          </div>
          <input ref={filePicker} type="file" accept=".json,application/json" hidden aria-label="Theme file to import" onChange={picked} />
          {said !== undefined && <p className={said.refused ? "text-sm text-signal" : "text-sm text-ink-muted"}>{said.line}</p>}
          {exporting && named && <Exported theme={shown} />}
        </>
      )}
    </div>
  );
};

/** The three shipped themes by name, the one shown checked; choosing one makes it the candidate. */
const ShippedThemes = ({ shown, disabled, choose }: { readonly shown: Theme; readonly disabled: boolean; readonly choose: (theme: Theme) => void }) => {
  const label = useId();
  const group = useId();
  return (
    <div className="flex flex-col gap-2">
      <span id={label} className="text-sm text-ink">
        Shipped themes
      </span>
      <div role="radiogroup" aria-labelledby={label} className="flex flex-wrap gap-2 text-xs text-ink">
        {SHIPPED_THEMES.map((theme) => (
          <Tooltip key={theme.name} content={theme.name} keys="Arrow keys"><label className="flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-2 has-checked:bg-wash-strong">
            <input type="radio" name={group} checked={sameTheme(theme, shown)} disabled={disabled} onChange={() => choose(theme)} className="accent-beam" />
            <Palette aria-hidden="true" className="size-3.5" />{theme.name}
          </label></Tooltip>
        ))}
      </div>
    </div>
  );
};

/** A seed's controls' bounds: the setting's own (`ThemeSeed`), a hue in whole degrees and a chroma in steps of 0.005. */
const HUE = { min: 0, max: 359, step: 1 } as const;
const CHROMA = { min: 0, max: MAX_SEED_CHROMA, step: 0.005 } as const;

/** A chroma as a slider gives it, at the thousandths a seed is written in, so a step's float noise is not kept. */
const thousandths = (value: string): number => Math.round(Number(value) * 1000) / 1000;

/** Each seed: its hue and chroma in words, and a slider for each, named by the seed. */
const Seeds = ({ theme, disabled, change }: { readonly theme: Theme; readonly disabled: boolean; readonly change: (seed: ThemeSeedName, value: Theme["seeds"][ThemeSeedName]) => void }) => (
  <ul aria-label="Seeds" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
    {THEME_SEED_NAMES.map((seed) => {
      const { hue, chroma } = theme.seeds[seed];
      return (
        <li key={seed} className="flex flex-col gap-1 rounded-lg border border-hairline p-3">
          <span className="flex items-center gap-1.5 text-xs text-ink-muted">
            <SlidersHorizontal aria-hidden="true" className="size-3.5" />
            {seed}: hue {hue}, chroma {chroma}
          </span>
          <div className="flex gap-3">
            <Tooltip content={`${seed} hue`} keys="Arrow keys"><input
              type="range"
              aria-label={`${seed} hue`}
              {...HUE}
              value={hue}
              disabled={disabled}
              onChange={(event) => change(seed, { hue: Math.round(Number(event.target.value)), chroma })}
              className="min-w-0 flex-1 accent-beam"
            /></Tooltip>
            <Tooltip content={`${seed} chroma`} keys="Arrow keys"><input
              type="range"
              aria-label={`${seed} chroma`}
              {...CHROMA}
              value={chroma}
              disabled={disabled}
              onChange={(event) => change(seed, { hue, chroma: thousandths(event.target.value) })}
              className="min-w-0 flex-1 accent-beam"
            /></Tooltip>
          </div>
        </li>
      );
    })}
  </ul>
);

/** How a swatch group is named, by its ladder. */
const LADDER_WORDS: Readonly<Record<LadderName, string>> = { light: "Light ladder", dark: "Dark ladder" };

/** What the theme package derives of a theme: a swatch of each seed in both ladders, and each seed it clamped, in the Appearance check's words. */
const Derived = ({ theme }: { readonly theme: Theme }) => {
  const derived = useMemo(() => derive(theme), [theme]);
  const clamped = THEME_SEED_NAMES.flatMap((seed) => {
    const own = derived.clamps.filter((clamp) => clamp.seed === seed);
    return own.length === 0 ? [] : [`${seed}: ${clampWords(own)}`];
  });
  return (
    <>
      <div className="flex flex-wrap gap-3">
        {LADDERS.map((ladder) => (
          <Swatches key={ladder} derived={derived} ladder={ladder} />
        ))}
      </div>
      {clamped.length === 0 ? (
        <p className="text-sm text-ink-muted">No seed is clamped: both ladders meet the contrast, gamut and hue-separation rules.</p>
      ) : (
        <ul aria-label="Clamped seeds" className="flex flex-col gap-1 text-sm text-amber">
          {clamped.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </>
  );
};

/**
 * Each seed's swatch in one ladder: the ladder is painted on the group
 * itself as the window paints its root (every token a CSS variable), so a
 * swatch is its seed's token and never a literal colour (ADR 0023), in the
 * ladder named whatever ladder the window paints.
 */
const Swatches = ({ derived, ladder }: { readonly derived: DerivedTheme; readonly ladder: LadderName }) => (
  <div
    role="group"
    aria-label={LADDER_WORDS[ladder]}
    style={{ ...cssVariables(derived[ladder]), colorScheme: ladder } as CSSProperties}
    className="flex flex-col gap-2 rounded-lg border border-hairline bg-abyss p-3"
  >
    <span className="text-xs text-ink-muted">{LADDER_WORDS[ladder]}</span>
    <div className="flex flex-wrap gap-2">
      {THEME_SEED_NAMES.map((seed) => (
        <span key={seed} role="img" aria-label={seed} title={seed} style={{ backgroundColor: `var(--${SEED_TOKENS[seed]})` }} className="size-6 rounded-sm border border-line" />
      ))}
    </div>
  </div>
);

/** A theme's file, to copy or download: its name and seeds as JSON, and nothing else. */
const Exported = ({ theme }: { readonly theme: Theme }) => {
  const heading = useId();
  const text = themeFile(theme);
  const fileName = fileNameOf(theme);
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
      <h4 id={heading} className="text-sm font-medium text-ink">
        {fileName}
      </h4>
      <CopyLine label="The theme file: the name and the seven seeds" text={text} />
      <Tooltip content="Download theme" keys="Enter"><a href={`data:application/json;charset=utf-8,${encodeURIComponent(text)}`} download={fileName} className="flex items-center gap-1.5 text-sm text-beam-text underline">
        <Download aria-hidden="true" className="size-4" />
        Download {fileName}
      </a></Tooltip>
    </section>
  );
};
