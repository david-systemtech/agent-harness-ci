import { homeEnvironment, rowSteps } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { Brain, Columns3, Minus, Monitor, Moon, Plus, RotateCcw, Sparkles, Sun, Type, type LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";
import { TEXT_SIZE_LEAST, TEXT_SIZE_MOST, normalizeTextSize, type LightOrDark, type ReadingWidth } from "../presentation.js";
import { StepLinks } from "../settings/step-links.js";
import { ChoiceList, SettingsGroup } from "../settings/part.js";
import { Button, IconButton, Input, Switch, Tooltip } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";
import { ThemePicker } from "./theme-picker.js";

/**
 * The Theme row, `appearance.theme` (docs/specs/gui.md, "Theme: tokens, the
 * setting and the lint" and "Settings"; ADR 0023, ADR 0027; #418), a
 * `client` row. This client's own preferences, each kept in presentation and
 * taking effect at once: light or dark, and the window's text size,
 * reading width, reasoning shown and streaming fade. Then the home
 * environment's theme, the one the window paints, in the theme picker
 * (#1194): its name, each seed with its hue and chroma and as a swatch in
 * both ladders, and each seed the derivation clamped to meet the rules, in
 * the words the Appearance check says; the shipped themes, the seeds'
 * controls, import and export make a candidate the window previews, Save
 * writes it (`settings.update`, `admin`), and every window repaints on the
 * `settings.changed` it brings.
 */
export const ThemePane = () => {
  const home = homeEnvironment(useObservable(useRuntime().projections.environments));
  return (
    <>
      <p className="text-sm text-ink-muted">{settingsRow("appearance.theme").hint}</p>
      <StepLinks steps={rowSteps("appearance.theme")} />
      <ClientPreferences />
      {home !== undefined && (
        <Part heading="The home environment's theme">
          <ThemePicker key={home.environmentId} view={home} />
        </Part>
      )}
    </>
  );
};

/** A named group with divided preference rows. */
const Part = ({ heading, children }: { readonly heading: string; readonly children: ReactNode }) => <SettingsGroup title={heading}>{children}</SettingsGroup>;

const Preference = ({ name, detail, icon: Icon, control }: { readonly name: string; readonly detail: string; readonly icon: LucideIcon; readonly control: (label: string) => ReactNode }) => {
  const label = useId();
  return <div className="flex flex-wrap items-center justify-between gap-3">
    <div className="flex min-w-0 flex-1 items-start gap-2.5">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span id={label} className="text-xs font-medium text-ink">{name}</span>
        <span className="text-2xs text-ink-faint">{detail}</span>
      </div>
    </div>
    {control(label)}
  </div>;
};

/** Light or dark's choices, in the order drawn, and their words. */
const LIGHT_OR_DARK_CHOICES: readonly (readonly [LightOrDark, string])[] = [
  ["system", "The OS's"],
  ["light", "Light"],
  ["dark", "Dark"],
];

/** The reading widths' words. */
const READING_WIDTH_WORDS: Readonly<Record<ReadingWidth, string>> = { comfortable: "Comfortable", wide: "Wide", full: "The whole pane" };

const MODE_ICONS = { system: Monitor, light: Sun, dark: Moon };

/**
 * This client's light or dark, kept in presentation at once and never
 * read-only (client-local, no registry key; ADR 0023): on the Theme row and
 * the Appearance step's card (#594).
 */
export const LightOrDarkPreference = () => {
  const [lightOrDark, setLightOrDark] = usePresentation("lightOrDark");
  const choice = useId();
  return (
    <Preference
      name="Light or dark"
      icon={Monitor}
      detail="This client's own: the theme's light or dark ladder, or the one the OS prefers, followed as it switches."
      control={(label) => (
        <div role="radiogroup" aria-labelledby={label} className="flex flex-wrap gap-0.5 rounded-md border border-hairline bg-inset p-0.5 text-xs text-ink">
          {LIGHT_OR_DARK_CHOICES.map(([value, words]) => {
            const Icon = MODE_ICONS[value];
            return <Tooltip key={value} content={words} keys="Arrow keys">
              <label className={`flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1 has-focus-visible:outline-2 has-focus-visible:outline-beam ${lightOrDark === value ? "bg-raised" : "hover:bg-wash"}`}>
                <input type="radio" name={choice} checked={lightOrDark === value} onChange={() => setLightOrDark(value)} className="sr-only" />
                <Icon aria-hidden="true" className="size-3.5" />{words}
              </label>
            </Tooltip>;
          })}
        </div>
      )}
    />
  );
};

/** This client's own preferences, kept in presentation and never read-only: no environment holds them. */
const ClientPreferences = () => {
  const [textSize, setTextSize] = usePresentation("textSize");
  const [readingWidth, setReadingWidth] = usePresentation("readingWidth");
  const [reasoningShown, setReasoningShown] = usePresentation("reasoningShown");
  const [streamingFade, setStreamingFade] = usePresentation("streamingFade");
  return (
    <Part heading="This client">
      <LightOrDarkPreference />
      <Preference
        name="Text size"
        icon={Type}
        detail="Scales the whole window, from 11 to 20 pixels. The preset is 14."
        control={(label) => (
          <div className="flex flex-wrap items-center gap-1.5">
            <IconButton label="Decrease text size" keys="Enter / Space" size="icon-xs" disabled={textSize <= TEXT_SIZE_LEAST} onClick={() => setTextSize(textSize - 1)}><Minus aria-hidden="true" /></IconButton>
            <Tooltip content="Text size" keys="Arrow keys; Enter to apply">
              <Input key={textSize} type="number" aria-labelledby={label} min={TEXT_SIZE_LEAST} max={TEXT_SIZE_MOST} step={1} defaultValue={textSize}
                onBlur={(event) => {
                  const size = normalizeTextSize(event.currentTarget.valueAsNumber);
                  event.currentTarget.value = String(size);
                  setTextSize(size);
                }}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} className="w-16 text-center font-mono tabular-nums" />
            </Tooltip>
            <IconButton label="Increase text size" keys="Enter / Space" size="icon-xs" disabled={textSize >= TEXT_SIZE_MOST} onClick={() => setTextSize(textSize + 1)}><Plus aria-hidden="true" /></IconButton>
            <Tooltip content="Reset text size" keys="Enter / Space"><Button size="xs" aria-label="Reset text size" onClick={() => setTextSize(14)}><RotateCcw aria-hidden="true" />Reset</Button></Tooltip>
          </div>
        )}
      />
      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-2 text-xs font-medium"><Columns3 aria-hidden="true" className="size-4 text-ink-muted" />Reading width</span>
        <ChoiceList label="Reading width" value={readingWidth} onValueChange={(value) => setReadingWidth(value as ReadingWidth)} choices={[
          { value: "comfortable", label: READING_WIDTH_WORDS.comfortable, note: "A centred 920px column at the preset text size." },
          { value: "wide", label: READING_WIDTH_WORDS.wide, note: "More room for long replies, up to 80rem." },
          { value: "full", label: READING_WIDTH_WORDS.full, note: "Use all the space in the session pane." },
        ]} />
      </div>
      <Preference
        name="Reasoning shown"
        icon={Brain}
        detail="A run's reasoning is drawn unfolded."
        control={(label) => <Tooltip content="Reasoning shown" keys="Space"><Switch aria-labelledby={label} checked={reasoningShown} onCheckedChange={setReasoningShown} /></Tooltip>}
      />
      <Preference
        name="Streaming fade"
        icon={Sparkles}
        detail="Text still streaming fades in word by word."
        control={(label) => <Tooltip content="Streaming fade" keys="Space"><Switch aria-labelledby={label} checked={streamingFade} onCheckedChange={setStreamingFade} /></Tooltip>}
      />
    </Part>
  );
};
