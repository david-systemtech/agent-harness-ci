import { homeEnvironment, rowKeys, rowSteps, type EnvironmentView } from "@agent-harness/client-runtime";
import { THEME_SEED_NAMES, Theme, settingsRow } from "@agent-harness/contracts";
import { LADDERS, SEED_TOKENS, clampWords, cssVariables, derive, type DerivedTheme, type LadderName } from "@agent-harness/theme";
import { useId, useMemo, type CSSProperties, type ReactNode } from "react";
import { THIS_MACHINE } from "../connections/words.js";
import { READING_WIDTHS, TEXT_SIZE_LEAST, TEXT_SIZE_MOST, type LightOrDark, type ReadingWidth } from "../presentation.js";
import { GenericEditor } from "../settings/generic-editor.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { StepLinks } from "../settings/step-links.js";
import { Select, Switch } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";

/**
 * The Theme row, `appearance.theme` (docs/specs/gui.md, "Theme: tokens, the
 * setting and the lint" and "Settings"; ADR 0023, ADR 0027; #418), a
 * `client` row. This client's own preferences, each kept in presentation and
 * taking effect at once: light or dark, and the transcript's text size,
 * reading width, reasoning shown and streaming fade. Then the home
 * environment's theme, the one the window paints: its name, each seed with
 * its hue and chroma and as a swatch in both ladders, and each seed the
 * derivation clamped to meet the rules, in the words the Appearance check
 * says; the generic editor writes it (`settings.update`, `admin`; the picker
 * is phase D), and every window repaints on the `settings.changed` it
 * brings.
 */
export const ThemePane = () => {
  const home = homeEnvironment(useObservable(useRuntime().projections.environments));
  return (
    <>
      <p className="text-sm text-ink-muted">{settingsRow("appearance.theme").hint}</p>
      <StepLinks steps={rowSteps("appearance.theme")} />
      <ClientPreferences />
      {home !== undefined && <HomeTheme key={home.environmentId} view={home} />}
    </>
  );
};

/** A part of the pane, a region named by its heading. */
const Part = ({ heading, children }: { readonly heading: string; readonly children: ReactNode }) => {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h3 id={id} className="text-sm font-semibold text-ink">
        {heading}
      </h3>
      {children}
    </section>
  );
};

/** One preference: its name, what it does, and its control, named by the name. */
const Preference = ({ name, detail, control }: { readonly name: string; readonly detail: string; readonly control: (label: string) => ReactNode }) => {
  const label = useId();
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line p-3">
      <div className="flex flex-col gap-0.5">
        <span id={label} className="text-sm text-ink">
          {name}
        </span>
        <span className="text-xs text-ink-muted">{detail}</span>
      </div>
      {control(label)}
    </div>
  );
};

/** Light or dark's choices, in the order drawn, and their words. */
const LIGHT_OR_DARK_CHOICES: readonly (readonly [LightOrDark, string])[] = [
  ["light", "Light"],
  ["dark", "Dark"],
  ["system", "The OS's"],
];

/** The reading widths' words. */
const READING_WIDTH_WORDS: Readonly<Record<ReadingWidth, string>> = { comfortable: "Comfortable", wide: "Wide", full: "The whole pane" };

/** Every text size a person may pick, in CSS pixels. */
const TEXT_SIZES = Array.from({ length: TEXT_SIZE_MOST - TEXT_SIZE_LEAST + 1 }, (_, at) => TEXT_SIZE_LEAST + at);

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
      detail="This client's own: the theme's light or dark ladder, or the one the OS prefers, followed as it switches."
      control={(label) => (
        <div role="radiogroup" aria-labelledby={label} className="flex gap-3 text-sm text-ink">
          {LIGHT_OR_DARK_CHOICES.map(([value, words]) => (
            <label key={value} className="flex items-center gap-1.5">
              <input type="radio" name={choice} checked={lightOrDark === value} onChange={() => setLightOrDark(value)} className="accent-beam" />
              {words}
            </label>
          ))}
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
        detail="The transcript's text, in CSS pixels; every size in it follows."
        control={(label) => (
          <Select aria-labelledby={label} value={String(textSize)} onChange={(event) => setTextSize(Number(event.target.value))}>
            {TEXT_SIZES.map((size) => (
              <option key={size} value={String(size)}>
                {size} px
              </option>
            ))}
          </Select>
        )}
      />
      <Preference
        name="Reading width"
        detail="How wide the transcript's column may grow."
        control={(label) => (
          <Select aria-labelledby={label} value={readingWidth} onChange={(event) => setReadingWidth(READING_WIDTHS.find((width) => width === event.target.value) ?? readingWidth)}>
            {READING_WIDTHS.map((width) => (
              <option key={width} value={width}>
                {READING_WIDTH_WORDS[width]}
              </option>
            ))}
          </Select>
        )}
      />
      <Preference
        name="Reasoning shown"
        detail="A run's reasoning is drawn unfolded."
        control={(label) => <Switch aria-labelledby={label} checked={reasoningShown} onCheckedChange={setReasoningShown} />}
      />
      <Preference
        name="Streaming fade"
        detail="Text still streaming fades in word by word."
        control={(label) => <Switch aria-labelledby={label} checked={streamingFade} onCheckedChange={setStreamingFade} />}
      />
    </Part>
  );
};

/** The home environment's theme as it read it, and the generic editor that writes it. */
const HomeTheme = ({ view }: { readonly view: EnvironmentView }) => (
  <Part heading="The home environment's theme">
    <EnvironmentTheme view={view} />
    <GenericEditor view={view} keys={rowKeys("appearance.theme")} />
  </Part>
);

/**
 * An environment's theme as this window read it (`settings.get` in the
 * request cache): on the Theme row the home environment's, on the
 * Appearance step's card the environment the checklist checks (#594).
 * Nothing until a theme is read.
 */
export const EnvironmentTheme = ({ view }: { readonly view: EnvironmentView }) => {
  const { values } = useSettingsValues(view.environmentId);
  const theme = Theme.safeParse(values?.["appearance.theme"]).data;
  return theme === undefined ? null : <ThemeShown theme={theme} on={view.name ?? THIS_MACHINE} />;
};

/** How a swatch group is named, by its ladder. */
const LADDER_WORDS: Readonly<Record<LadderName, string>> = { light: "Light ladder", dark: "Dark ladder" };

/** A theme: its name and where it is set, its seeds, a swatch of each in both ladders, and each seed the derivation clamped. */
const ThemeShown = ({ theme, on }: { readonly theme: Theme; readonly on: string }) => {
  const derived = useMemo(() => derive(theme), [theme]);
  const clamped = THEME_SEED_NAMES.flatMap((seed) => {
    const own = derived.clamps.filter((clamp) => clamp.seed === seed);
    return own.length === 0 ? [] : [`${seed}: ${clampWords(own)}`];
  });
  return (
    <>
      <p className="text-sm font-medium text-ink">
        {theme.name}, on {on}
      </p>
      <ul aria-label="Seeds" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
        {THEME_SEED_NAMES.map((seed) => (
          <li key={seed}>
            {seed}: hue {theme.seeds[seed].hue}, chroma {theme.seeds[seed].chroma}
          </li>
        ))}
      </ul>
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
    className="flex flex-col gap-2 rounded-md border border-line bg-abyss p-3"
  >
    <span className="text-xs text-ink-muted">{LADDER_WORDS[ladder]}</span>
    <div className="flex gap-2">
      {THEME_SEED_NAMES.map((seed) => (
        <span key={seed} role="img" aria-label={seed} title={seed} style={{ backgroundColor: `var(--${SEED_TOKENS[seed]})` }} className="size-6 rounded-sm border border-line" />
      ))}
    </div>
  </div>
);
