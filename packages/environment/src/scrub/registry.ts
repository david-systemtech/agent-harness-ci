/** What stands in for a registered value wherever the registry scrubs. */
export const REDACTED = "[redacted]";

/** How an owner registers a value. */
export interface ScrubRegistration {
  /** Who holds the value, as `kind:id` (`vault:<key>`, a forge account, a run). */
  readonly owner: string;
  /** Forms of the value the owner adds beside the ones the registry derives: the forge's Basic-auth form. */
  readonly forms?: readonly string[];
}

/** Ends one registration. */
export type ScrubRelease = () => void;

/**
 * The scrub registry (ADR 0011; key-managers spec, "The scrub registry"): the
 * one list of values the environment holds as secrets, which the event log's
 * append and the diagnostic output consult so none of them is shown or stored.
 */
export interface ScrubRegistry {
  /** Registers `value` for its owner; the answer releases it. */
  register(value: string, registration: ScrubRegistration): ScrubRelease;
  /** `text` with every registered value, in each of its forms, replaced with `[redacted]`. */
  scrub(text: string): string;
}

/** A form as a URL or a form body carries it; none for a value `encodeURIComponent` refuses (a lone surrogate). */
const percentEncoded = (form: string): string | undefined => {
  try {
    return encodeURIComponent(form);
  } catch {
    return undefined;
  }
};

/** A form as it sits inside a JSON string. */
const jsonEscaped = (form: string): string => JSON.stringify(form).slice(1, -1);

/** Every text one registration hides: the value and the owner's forms, each as it is, percent-encoded and JSON-escaped. */
const needlesOf = (value: string, forms: readonly string[]): readonly string[] => {
  const needles = new Set<string>();
  for (const form of [value, ...forms]) {
    for (const needle of [form, percentEncoded(form), jsonEscaped(form)]) if (needle) needles.add(needle);
  }
  return [...needles];
};

/** Texts shorter than this are matched only whole, between non-alphanumerics (key-managers spec, a chosen default). */
export const WHOLE_MATCH_BELOW = 8;

const ALPHANUMERIC_AT_END = /[\p{L}\p{N}]$/u;
const ALPHANUMERIC_AT_START = /^[\p{L}\p{N}]/u;

/**
 * Whether `text[start, end)` stands alone: neither the character before it
 * nor the one after is a letter or a digit, in any script. Two code units
 * are read each side, so a character outside the basic plane counts whole.
 */
const standsAlone = (text: string, start: number, end: number): boolean =>
  !ALPHANUMERIC_AT_END.test(text.slice(Math.max(0, start - 2), start)) && !ALPHANUMERIC_AT_START.test(text.slice(end, end + 2));

/** Where `needle` occurs in `text`, overlapping occurrences included, as `[start, end)` spans. */
const occurrences = function* (text: string, needle: string): Generator<readonly [number, number]> {
  const whole = needle.length < WHOLE_MATCH_BELOW;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if (!whole || standsAlone(text, at, end)) yield [at, end];
  }
};

interface Held {
  readonly owner: string;
  readonly needles: readonly string[];
}

export const createScrubRegistry = (): ScrubRegistry => {
  const held = new Set<Held>();
  /** Every held registration's needles, each once; worked out again after a registration or a release. */
  let needles: readonly string[] | undefined;
  return {
    register(value, registration) {
      const entry: Held = { owner: registration.owner, needles: needlesOf(value, registration.forms ?? []) };
      held.add(entry);
      needles = undefined;
      return () => {
        if (held.delete(entry)) needles = undefined;
      };
    },
    scrub(text) {
      needles ??= [...new Set([...held].flatMap((entry) => entry.needles))];
      const spans: (readonly [number, number])[] = [];
      for (const needle of needles) for (const span of occurrences(text, needle)) spans.push(span);
      if (spans.length === 0) return text;
      spans.sort(([a], [b]) => a - b);
      let scrubbed = "";
      let cursor = 0;
      for (const [start, end] of spans) {
        if (start >= cursor) scrubbed += `${text.slice(cursor, start)}${REDACTED}`;
        cursor = Math.max(cursor, end);
      }
      return scrubbed + text.slice(cursor);
    },
  };
};
