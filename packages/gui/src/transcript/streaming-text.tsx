import { memo, use, useCallback, useState, type CSSProperties } from "react";
import { usePresentation } from "../window-context.js";
import { FindQuery, Marked } from "./find.js";

/**
 * Text still streaming, each word fading in as it arrives (docs/specs/gui.md,
 * "A session pane": streamed text with the word fade) while the streaming
 * fade is on (`streamingFade`, presentation); plain text while it is off, or
 * while the system asks for reduced motion.
 *
 * A delta rarely ends on a word's end ("Looking at the par"), so only whole
 * words (those whitespace follows) are shown while the fade is on, the rest
 * held until its space arrives, or until it outgrows any word
 * (`LONGEST_HELD`), so a stalled stream is not left looking stuck. The words
 * one delta brings fade in together, each a little after the one before; a
 * backlog past `INSTANT_WORDS` is a whole message landing, not a sentence
 * being said, and shows at once. A word whose fade has ended is folded back
 * into one plain text node, so an answer of thousands of words is one node
 * and the few words still fading. What was there before the transcript was
 * watching (a session opened mid-run), or when the fade was turned on, was
 * not seen arriving: it is shown as it is, never replayed. While the find
 * bar looks for something the text is drawn whole, its matches marked. A
 * finished text is the markdown's to draw.
 */

/** How long one word's fade takes (the stylesheet's `word-in` keyframes). */
const WORD_MS = 150;
/** The gap between the words of one delta, and the most the whole delta's gaps may add up to. */
const STAGGER_MS = 14;
const STAGGER_BUDGET_MS = 90;
/** A backlog of more words than this arrives at once, with no fade. */
const INSTANT_WORDS = 220;
/** A held fragment longer than this is shown though no space has ended it. */
const LONGEST_HELD = 64;

/** A word and the whitespace around it, so the words joined are the text again. */
const WORD = /\s*\S+\s*/g;

/** The words that arrived together, fading. */
interface Batch {
  readonly key: number;
  readonly words: readonly string[];
  /** Each word's delay after the one before, in milliseconds. */
  readonly stagger: number;
}

interface Reveal {
  /** The text the reveal has taken in, and whether the fade was on when it did. */
  readonly text: string;
  readonly fade: boolean;
  /** Shown and no longer fading. */
  readonly settled: string;
  /** How much of `text` is shown, settled or fading: the rest is held. */
  readonly shown: number;
  readonly batches: readonly Batch[];
  readonly nextKey: number;
}

/** Where the whole words of `text` end, from `from`: after its last whitespace, or `from` when it has none since. */
const wholeThrough = (text: string, from: number): number => {
  for (let at = text.length - 1; at >= from; at--) if (/\s/.test(text.charAt(at))) return at + 1;
  return from;
};

/** `text` shown as it is, the fragment after its last whole word held: nothing fading. */
const adopt = (text: string, fade: boolean, nextKey = 0): Reveal => {
  const shown = wholeThrough(text, 0);
  return { text, fade, settled: text.slice(0, shown), shown, batches: [], nextKey };
};

/** The reveal once `text` has arrived: what is new and whole fades in as one batch. */
const advance = (reveal: Reveal, text: string): Reveal => {
  // Rewritten under the reveal, not added to: shown as it is.
  if (!text.startsWith(reveal.text.slice(0, reveal.shown))) return adopt(text, reveal.fade, reveal.nextKey);
  let through = wholeThrough(text, reveal.shown);
  if (through === reveal.shown && text.length - reveal.shown > LONGEST_HELD) through = text.length;
  if (through === reveal.shown) return { ...reveal, text };
  const arrived = text.slice(reveal.shown, through);
  // Whitespace alone (a paragraph's break sent on its own) is carried as it is: the pieces joined are always what arrived.
  const words = arrived.match(WORD) ?? [arrived];
  if (words.length >= INSTANT_WORDS) return { ...reveal, text, settled: reveal.settled + words.join(""), shown: through };
  const stagger = words.length > 1 ? Math.min(STAGGER_MS, STAGGER_BUDGET_MS / words.length) : 0;
  return { ...reveal, text, shown: through, batches: [...reveal.batches, { key: reveal.nextKey, words, stagger }], nextKey: reveal.nextKey + 1 };
};

/** The reveal with the batch `key` done fading, its words folded into the settled text with every batch before it. */
const retire = (reveal: Reveal, key: number): Reveal => {
  const done = reveal.batches.filter((batch) => batch.key <= key);
  if (done.length === 0) return reveal;
  return { ...reveal, settled: reveal.settled + done.flatMap((batch) => batch.words).join(""), batches: reveal.batches.filter((batch) => batch.key > key) };
};

const reducedMotion = (): boolean => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One delta's words, fading in; `onDone` once the last has. */
const Fading = memo(({ batch, onDone }: { readonly batch: Batch; readonly onDone: (key: number) => void }) => (
  <>
    {batch.words.map((word, index) => (
      <span
        // A batch's words never change once it is made, so their places are their keys.
        key={index}
        style={fadeStyle(index * batch.stagger)}
        onAnimationEnd={index === batch.words.length - 1 ? () => onDone(batch.key) : undefined}
      >
        {word}
      </span>
    ))}
  </>
));

const fadeStyle = (delay: number): CSSProperties => ({
  animationName: "word-in",
  animationDuration: `${WORD_MS}ms`,
  animationTimingFunction: "ease-out",
  animationFillMode: "both",
  animationDelay: `${delay}ms`,
});

export interface StreamingTextProps {
  readonly text: string;
  /** Whether the text began arriving while the transcript was watching: its first words fade in too. */
  readonly arrived: boolean;
}

export const StreamingText = ({ text, arrived }: StreamingTextProps) => {
  const [streamingFade] = usePresentation("streamingFade");
  // While the find bar looks for something, the text is drawn whole, so its matches are marked.
  const finding = use(FindQuery) !== "";
  const fade = streamingFade && !finding && !reducedMotion();
  const [reveal, setReveal] = useState(() => (arrived && fade ? advance(adopt("", fade), text) : adopt(text, fade)));
  const done = useCallback((key: number) => setReveal((was) => retire(was, key)), []);
  let current = reveal;
  if (current.fade !== fade) current = adopt(text, fade, current.nextKey);
  else if (current.text !== text) current = fade ? advance(current, text) : adopt(text, fade, current.nextKey);
  // Adjusted while rendering, as React has state follow a prop: no effect, and no frame drawn a delta behind.
  if (current !== reveal) setReveal(current);
  if (!fade) return <Marked text={text} />;
  return (
    <>
      {current.settled}
      {current.batches.map((batch) => (
        <Fading key={batch.key} batch={batch} onDone={done} />
      ))}
    </>
  );
};
