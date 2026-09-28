import { writable, type DocumentStore, type Observable } from "@agent-harness/client-runtime";

/**
 * The GUI's client-local presentation (ADR 0003, ADR 0004; glossary: Pane):
 * what is open, laid out, folded or preferred on this client, and never a
 * session's state. It is the one module where the organisation-state lint
 * allows its enumerated presentation keys
 * (`eslint-rules/no-client-organisation-state.ts`), and every key it holds
 * is on that list: a surface that keeps something here adds its key to
 * `PresentationValues`, `PRESENTATION_DEFAULTS`, `READERS` and the lint's
 * list together (docs/specs/gui.md, "How the renderer holds state").
 *
 * It is kept in the platform's documents (IndexedDB on the desktop) as one
 * document, written whole on each change, so what it holds survives the
 * window closing.
 */

/** Every key the presentation holds, and its value. */
export interface PresentationValues {
  /**
   * The sidebar region's width as a share of the window, in percent, as the
   * frame's divider last left it; null until it is first moved, when the
   * frame's preset width holds.
   */
  readonly sidebarWidth: number | null;
}

export type PresentationKey = keyof PresentationValues;

/** What each key holds before anything is set. */
export const PRESENTATION_DEFAULTS: PresentationValues = Object.freeze({ sidebarWidth: null });

/** The document the presentation is kept in, and the format this build writes. */
const DOCUMENT = "presentation";
const FORMAT = 1;

/** How each key's stored value is read back: undefined for a value this build cannot read, which takes the default. */
const READERS: { readonly [K in PresentationKey]: (stored: unknown) => PresentationValues[K] | undefined } = {
  sidebarWidth: (stored) => (stored === null || (typeof stored === "number" && stored > 0 && stored < 100) ? stored : undefined),
};

export interface Presentation {
  /** Everything held, one value per key; `read()` keeps its reference until a value changes. */
  readonly values: Observable<PresentationValues>;
  /** Holds `value` under `key` and writes the document; a value already held changes nothing. */
  set<K extends PresentationKey>(key: K, value: PresentationValues[K]): void;
  /** Settles once every write started so far has. */
  close(): Promise<void>;
}

/** The values a stored document holds, each unreadable one at its default; the keys that could not be read, named. */
const readDocument = (stored: unknown): { readonly values: PresentationValues; readonly unreadable: readonly string[] } => {
  if (stored === undefined) return { values: PRESENTATION_DEFAULTS, unreadable: [] };
  if (typeof stored !== "object" || stored === null || (stored as { readonly format?: unknown }).format !== FORMAT)
    return { values: PRESENTATION_DEFAULTS, unreadable: ["the document"] };
  const unreadable: string[] = [];
  const values = { ...PRESENTATION_DEFAULTS } as Record<PresentationKey, unknown>;
  for (const key of Object.keys(READERS) as PresentationKey[]) {
    if (!(key in stored)) continue;
    const value = READERS[key]((stored as Record<string, unknown>)[key]);
    if (value === undefined) unreadable.push(key);
    else values[key] = value;
  }
  return { values: values as unknown as PresentationValues, unreadable };
};

/**
 * The presentation kept in `documents`: read once now, written whole on each
 * change, the writes one after another. What cannot be read is reported
 * once through `report` and starts from its default; a write that fails is
 * reported, and the value stays held for this window.
 */
export const openPresentation = async (documents: DocumentStore, report: (error: unknown) => void = () => undefined): Promise<Presentation> => {
  let stored: unknown;
  try {
    stored = await documents.get(DOCUMENT);
  } catch (error) {
    report(error);
  }
  const { values: initial, unreadable } = readDocument(stored);
  if (unreadable.length > 0) report(new Error(`The presentation document could not be read in full (${unreadable.join(", ")}); what it could not read starts from its default.`));

  const values = writable<PresentationValues>(initial);
  let writes: Promise<void> = Promise.resolve();
  return {
    values,
    set(key, value) {
      const now = values.read();
      if (Object.is(now[key], value)) return;
      const next: PresentationValues = { ...now, [key]: value };
      values.set(next);
      writes = writes.then(() => documents.set(DOCUMENT, { format: FORMAT, ...next })).catch(report);
    },
    close: () => writes,
  };
};
