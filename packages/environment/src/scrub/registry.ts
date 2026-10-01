import { REGISTERED_VALUE_RULE, shapeRuleHits, type SecretRule } from "@agent-harness/contracts";

/** What stands in for a registered value, or a shape rule's hit, wherever the registry scrubs. */
export const REDACTED = "[redacted]";

/** How an owner registers a value. */
export interface ScrubRegistration {
  /** Who holds the value, as `kind:id` (`vault:<key>`, a forge account, a run). */
  readonly owner: string;
  /** Forms of the value the owner adds beside the ones the registry derives: the forge's Basic-auth form. */
  readonly forms?: readonly string[];
}

/** Ends one registration; calling it again does nothing. */
export type ScrubRelease = () => void;

/**
 * Output scrubbed as it comes, a chunk at a time, with a tail held back while
 * it could be the start of a registered value (key-managers spec, "Where it
 * applies": terminal output and assistant deltas). Registered values only, as they stand at each
 * call: one registered or released while a tail is held counts from the next.
 */
export interface ScrubStream {
  /**
   * Takes the stream's next text and answers what can be shown now, every
   * registered value in it replaced. The rest is held back: the longest
   * tail that is the start of a registered value's form (for a form matched
   * only whole, where it could stand alone), and any whole value that tail
   * overlaps, so no part of a value is shown before it can be replaced.
   */
  push(text: string): string;
  /** Answers what is held back, scrubbed, and holds nothing more. */
  flush(): string;
  /** Whether a tail is held back. */
  readonly holding: boolean;
}

/**
 * The scrub registry (ADR 0011; key-managers spec, "The scrub registry"): the
 * one list of values the environment holds as secrets, and the shape rules
 * (contracts) for secrets it never held. The event log's append scrubs
 * registered values only (`scrub`): a secret the model or the user handles
 * on their own is content, outside the registry. The logger, captured output
 * the harness keeps and error text scrub both (`scrubOutput`); terminal
 * output and assistant deltas scrub registered values as they come (`stream`); and a text the
 * harness would send out is refused `secret_shaped` on either (`check`).
 */
export interface ScrubRegistry {
  /**
   * Registers `value` for its owner, with its percent-encoded and
   * JSON-escaped forms and the owner's own forms (each of those encoded the
   * same ways), and answers its release: a scope, not an add and remove
   * pair. Registrations are counted, so a value two owners registered, or
   * one owner twice, stays registered until every registration of it is
   * released. An empty value or form registers nothing.
   */
  register(value: string, registration: ScrubRegistration): ScrubRelease;
  /**
   * `text` with every registered value, in each of its forms, replaced with
   * `[redacted]`: what the event log's append writes. A form under eight
   * characters is matched only whole, between characters that are not
   * letters or digits; a longer one anywhere. Occurrences that overlap, of
   * one value or of two, are replaced as one, so nothing of either is left.
   */
  scrub(text: string): string;
  /**
   * `text` with every registered value and every shape rule's hit replaced
   * with `[redacted]`, overlapping ones as one: what the logger writes
   * (`serve/start.ts`) and what the harness keeps of captured output (git's
   * standard error from the forge's operations) and of error text before it
   * becomes a status line or a wire error's message. The captured output of
   * verify commands (#375), tool runs (#376) and pre-checks (#92), and a
   * key-manager provider's error text (#366), pass it as those are built. A
   * rule that names its secret (a key assigned inline, a bearer token)
   * replaces only that.
   */
  scrubOutput(text: string): string;
  /**
   * Whether `text` holds a secret, by the rule that found it and never by
   * the value: `registered-value` when it holds a registered value in any
   * form, else the shape rule of its first hit; null when it holds neither.
   * The check behind every `secret_shaped` refusal.
   */
  check(text: string): SecretRule | null;
  /** A stream of output to scrub of registered values a chunk at a time. */
  stream(): ScrubStream;
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

/** Every text one registration hides, each once: the value and the owner's forms, each as it is, percent-encoded and JSON-escaped. */
const needlesOf = (value: string, forms: readonly string[]): readonly string[] => {
  const needles = new Set<string>();
  for (const form of [value, ...forms]) {
    for (const needle of [form, percentEncoded(form), jsonEscaped(form)]) if (needle) needles.add(needle);
  }
  return [...needles];
};

/** Texts shorter than this are matched only whole, between non-alphanumerics (key-managers spec, a chosen default). */
const WHOLE_MATCH_BELOW = 8;

const ALPHANUMERIC_AT_END = /[\p{L}\p{N}]$/u;
const ALPHANUMERIC_AT_START = /^[\p{L}\p{N}]/u;

/**
 * Whether `text[start, end)` stands alone: neither the character before it
 * nor the one after is a letter or a digit, in any script. Two code units
 * are read each side, so a character outside the basic plane counts whole.
 */
const standsAlone = (text: string, start: number, end: number): boolean =>
  !ALPHANUMERIC_AT_END.test(text.slice(Math.max(0, start - 2), start)) && !ALPHANUMERIC_AT_START.test(text.slice(end, end + 2));

/** Where a needle or a shape rule's hit sits in a text: `[start, end)`. */
type Span = readonly [start: number, end: number];

/** Where `needle` occurs in `text`, overlapping occurrences included. */
const occurrences = function* (text: string, needle: string): Generator<Span> {
  const whole = needle.length < WHOLE_MATCH_BELOW;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if (!whole || standsAlone(text, at, end)) yield [at, end];
  }
};

/** Every occurrence of every needle in `text`. */
const valueSpans = (text: string, needles: readonly string[]): Span[] => {
  const spans: Span[] = [];
  for (const needle of needles) for (const span of occurrences(text, needle)) spans.push(span);
  return spans;
};

/** `text` up to `upTo` with each span in it replaced: in order of start, a span starting past the ones before opens a replacement, one starting inside them extends it. */
const replaced = (text: string, spans: readonly Span[], upTo = text.length): string => {
  if (spans.length === 0) return text.slice(0, upTo);
  let scrubbed = "";
  let cursor = 0;
  for (const [start, end] of [...spans].sort(([a], [b]) => a - b)) {
    if (start >= upTo) break;
    if (start >= cursor) scrubbed += `${text.slice(cursor, start)}${REDACTED}`;
    cursor = Math.max(cursor, end);
  }
  return scrubbed + text.slice(cursor, Math.max(cursor, upTo));
};

/**
 * Where the tail of `text` a stream holds back starts: the longest tail
 * that is a needle's proper prefix and could begin a match there (a needle
 * matched only whole begins only after a character that is not a letter or
 * a digit), moved back over any whole occurrence it starts inside; the
 * text's length when there is none.
 */
const heldFrom = (text: string, needles: readonly string[], spans: readonly Span[]): number => {
  let from = text.length;
  for (const needle of needles) {
    const whole = needle.length < WHOLE_MATCH_BELOW;
    for (let at = Math.max(0, text.length - needle.length + 1); at < from; at += 1) {
      if (!needle.startsWith(text.slice(at))) continue;
      if (whole && ALPHANUMERIC_AT_END.test(text.slice(Math.max(0, at - 2), at))) continue;
      from = at;
      break;
    }
  }
  for (let moved = true; moved; ) {
    moved = false;
    for (const [start, end] of spans) {
      if (start < from && from < end) {
        from = start;
        moved = true;
      }
    }
  }
  return from;
};

/** One registration while it stands: who made it, and what it hides. */
interface Held {
  readonly owner: string;
  readonly needles: readonly string[];
}

export const createScrubRegistry = (): ScrubRegistry => {
  const held = new Set<Held>();
  /** Every held registration's needles, each once; worked out again after a registration or a release. */
  let needles: readonly string[] | undefined;
  const current = (): readonly string[] => (needles ??= [...new Set([...held].flatMap((entry) => entry.needles))]);
  const scrub = (text: string): string => replaced(text, valueSpans(text, current()));

  return {
    register(value, registration) {
      const entry: Held = { owner: registration.owner, needles: needlesOf(value, registration.forms ?? []) };
      held.add(entry);
      needles = undefined;
      return () => {
        if (held.delete(entry)) needles = undefined;
      };
    },
    scrub,
    scrubOutput(text) {
      const shapes = shapeRuleHits(text).map(({ start, end }): Span => [start, end]);
      return replaced(text, [...valueSpans(text, current()), ...shapes]);
    },
    check(text) {
      if (valueSpans(text, current()).length > 0) return REGISTERED_VALUE_RULE;
      return shapeRuleHits(text)[0]?.rule ?? null;
    },
    stream() {
      let tail = "";
      return {
        push(text) {
          const all = tail + text;
          const spans = valueSpans(all, current());
          const from = heldFrom(all, current(), spans);
          tail = all.slice(from);
          return replaced(all, spans, from);
        },
        flush() {
          const text = tail;
          tail = "";
          return scrub(text);
        },
        get holding() {
          return tail !== "";
        },
      };
    },
  };
};
