import { homeEnvironment, rowSteps } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { useId, type ReactNode } from "react";
import { READING_WIDTHS, TEXT_SIZE_LEAST, TEXT_SIZE_MOST, type LightOrDark, type ReadingWidth } from "../presentation.js";
import { StepLinks } from "../settings/step-links.js";
import { Select, Switch } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";
import { ThemePicker } from "./theme-picker.js";

/**
 * The Theme row, `appearance.theme` (docs/specs/gui.md, "Theme: tokens, the
 * setting and the lint" and "Settings"; ADR 0023, ADR 0027; #418), a
 * `client` row. This client's own preferences, each kept in presentation and
 * taking effect at once: light or dark, and the transcript's text size,
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
