import { createContext, memo, use, useCallback, useMemo, useState, type ComponentPropsWithoutRef, type CSSProperties } from "react";
import type { Components, ExtraProps } from "react-markdown";
import { usePresentation } from "../window-context.js";
import { FindQuery } from "./find.js";
import { Markdown, type RehypePlugin } from "./markdown.js";

/**
 * Text still streaming, drawn as markdown as it arrives (#1754), each word
 * fading in as it arrives (docs/specs/gui.md, "A session pane": streamed text
 * with the word fade) while the streaming fade is on (`streamingFade`,
 * presentation); drawn whole while it is off, or while the system asks for
 * reduced motion. It is the same parse the settled text gets, so the end of a
 * turn reflows nothing already shown: a closed emphasis, a heading, a list or
 * a code span is formatted the moment it is whole, and an unclosed one at the
 * end reads as typed until it closes.
 *
 * A delta rarely ends on a word's end ("Looking at the par"), so only whole
 * words (those whitespace follows) are shown while the fade is on, the rest
 * held until its space arrives, or until it outgrows any word
 * (`LONGEST_HELD`), so a stalled stream is not left looking stuck. The words
 * one delta brings fade in together, each a little after the one before; a
 * backlog past `INSTANT_WORDS` is a whole message landing, not a sentence
 * being said, and shows at once. A word is found in the drawn markdown by
 * where it stands in the text (`fadeWords`), so the marks around it (`**`,
 * `#`, a list's dash) are never drawn and never fade. A word whose fade has
 * ended is folded back into plain text, so an answer of thousands of words is
 * a few text nodes and the few words still fading. What was there before the
 * transcript was watching (a session opened mid-run), or when the fade was
 * turned on, was not seen arriving: it is shown whole as it is, a half word
 * included, and never replayed; only what comes after it fades in. While the
 * find bar looks for something the text is drawn whole, its matches marked.
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
  /** Where in the text each word starts: each runs to the next, the last to `end`. */
  readonly words: readonly number[];
  readonly end: number;
  /** Each word's delay after the one before, in milliseconds. */
  readonly stagger: number;
}

interface Reveal {
  /** The text the reveal has taken in, and whether the fade was on when it did. */
  readonly text: string;
  readonly fade: boolean;
  /** How much of `text` is shown and no longer fading. */
  readonly settled: number;
  /** How much of `text` is shown, settled or fading: the rest is held. */
  readonly shown: number;
  readonly batches: readonly Batch[];
  /** The batches whose fade has ended while one before them still fades: folded once every batch before them is. */
  readonly ended: ReadonlySet<number>;
  readonly nextKey: number;
}

/** Where the whole words of `text` end, from `from`: after its last whitespace, or `from` when it has none since. */
const wholeThrough = (text: string, from: number): number => {
  for (let at = text.length - 1; at >= from; at--) if (/\s/.test(text.charAt(at))) return at + 1;
  return from;
};

/** `text` shown whole as it is, a half word included, nothing fading: it was there before, not seen arriving. */
const adopt = (text: string, fade: boolean, nextKey = 0): Reveal => ({ text, fade, settled: text.length, shown: text.length, batches: [], ended: new Set(), nextKey });

/** The reveal once `text` has arrived: what is new and whole fades in as one batch. */
const advance = (reveal: Reveal, text: string): Reveal => {
  // Rewritten under the reveal, not added to: shown as it is.
  if (!text.startsWith(reveal.text.slice(0, reveal.shown))) return adopt(text, reveal.fade, reveal.nextKey);
  let through = wholeThrough(text, reveal.shown);
  if (through === reveal.shown && text.length - reveal.shown > LONGEST_HELD) through = text.length;
  if (through === reveal.shown) return { ...reveal, text };
  // Whitespace alone (a paragraph's break sent on its own) is one word of no letters: the words joined are always what arrived.
  const starts = [...text.slice(reveal.shown, through).matchAll(WORD)].map((word) => reveal.shown + word.index);
  const words = starts.length === 0 ? [reveal.shown] : starts;
  // A burst lands at once, and what was still fading before it lands with it, so the text stays in order.
  if (words.length >= INSTANT_WORDS) return { ...reveal, text, settled: through, shown: through, batches: [], ended: new Set() };
  const stagger = words.length > 1 ? Math.min(STAGGER_MS, STAGGER_BUDGET_MS / words.length) : 0;
  return { ...reveal, text, shown: through, batches: [...reveal.batches, { key: reveal.nextKey, words, end: through, stagger }], nextKey: reveal.nextKey + 1 };
};

/**
 * The reveal with the batch `key` done fading: folded into the settled text
 * with every batch after it whose fade has ended too, once no batch before it
 * still fades (a short delta can end its fade before a long one before it).
 * A batch the markdown draws no word of (a list's dash, a paragraph's break)
 * has nothing to fade, so it never holds the ones after it back.
 */
const retire = (reveal: Reveal, key: number, drawn: ReadonlySet<number>): Reveal => {
  const ended = new Set(reveal.ended).add(key);
  const over = (batch: Batch) => ended.has(batch.key) || !drawn.has(batch.key);
  let done = 0;
  while (done < reveal.batches.length && over(reveal.batches[done] as Batch)) ended.delete((reveal.batches[done++] as Batch).key);
  if (done === 0) return { ...reveal, ended };
  return { ...reveal, settled: (reveal.batches[done - 1] as Batch).end, batches: reveal.batches.slice(done), ended };
};

const reducedMotion = (): boolean => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A node of the tree markdown is drawn from (hast), as much of it as the fade reads and writes. */
interface TreeNode {
  readonly type: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly position?: { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } };
  properties?: Record<string, unknown>;
  children?: TreeNode[];
}

/** A word, or the part of one a text node holds, fading: `start` is where it stands in the text, and keys it. */
const fadingPiece = (value: string, start: number, delay: number): TreeNode => ({
  type: "element",
  tagName: "span",
  properties: { dataWord: start, dataDelay: delay },
  children: [{ type: "text", value }],
});

/**
 * A rehype plugin cutting each text node of the drawn markdown where the
 * words of `batches` start and wrapping each word's part in a fading span;
 * what stands before `settled` is left as it is. A text node that does not
 * hold its source letter for letter (an entity, a code span's ticks) fades
 * whole as the word it starts in, or not at all if it starts in what has
 * settled. The
 * batches some word was drawn of are put in `drawn`, and the last piece drawn
 * of each says so (`dataDone`), its fade's end retiring the batch.
 */
const fadeWords = (settled: number, batches: readonly Batch[], drawn: Set<number>) => {
  const last = new Map<number, TreeNode>();
  const piece = (batch: Batch, index: number, value: string, start: number): TreeNode => {
    const made = fadingPiece(value, start, Math.round(index * batch.stagger));
    last.set(batch.key, made);
    return made;
  };
  const cut = (node: TreeNode): TreeNode[] => {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    const value = node.value ?? "";
    if (from === undefined || to === undefined || to <= settled) return [node];
    if (to - from !== value.length) {
      if (from < settled) return [node];
      for (const batch of batches) {
        const index = batch.words.findLastIndex((start) => start <= from);
        if (index !== -1 && from < batch.end) return [piece(batch, index, value, from)];
      }
      return [node];
    }
    const pieces: TreeNode[] = from < settled ? [{ type: "text", value: value.slice(0, settled - from) }] : [];
    for (const batch of batches) {
      batch.words.forEach((start, index) => {
        const begin = Math.max(start, from, settled);
        const end = Math.min(batch.words[index + 1] ?? batch.end, to);
        if (begin < end) pieces.push(piece(batch, index, value.slice(begin - from, end - from), begin));
      });
    }
    return pieces;
  };
  const walk = (node: TreeNode): void => {
    if (node.children === undefined) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return cut(child);
      walk(child);
      return [child];
    });
  };
  return () => (tree: unknown) => {
    walk(tree as TreeNode);
    for (const [key, node] of last) {
      drawn.add(key);
      node.properties = { ...node.properties, dataDone: key };
    }
  };
};

/** Told when a batch's last word has faded in. */
const FadeDone = createContext<(key: number) => void>(() => undefined);

/**
 * A span of the drawn markdown: a fading word's is keyed by where the word
 * stands, so a span given another word (one before it folded away) is a new
 * span whose fade starts, never one whose fade has ended.
 */
const Span = ({ node, ...props }: ComponentPropsWithoutRef<"span"> & ExtraProps) => {
  const done = use(FadeDone);
  const word = node?.properties["dataWord"];
  if (typeof word !== "number") return <span {...props} />;
  const batch = node?.properties["dataDone"];
  return (
    <span
      key={word}
      className="word-in"
      style={fadeStyle(Number(node?.properties["dataDelay"]))}
      onAnimationEnd={typeof batch === "number" ? () => done(batch) : undefined}
    >
      {props.children}
    </span>
  );
};

const FADE_COMPONENTS: Components = { span: Span };

// The stylesheet owns the animation so reduced-motion rules can stop an in-flight batch.
const fadeStyle = (delay: number): CSSProperties => ({
  "--word-ms": `${WORD_MS}ms`,
  animationDelay: `${delay}ms`,
} as CSSProperties);

/** What is shown of the reveal, its fading words fading. */
const Fading = memo(({ reveal, onDone }: { readonly reveal: Reveal; readonly onDone: (key: number, drawn: ReadonlySet<number>) => void }) => {
  const { text, shown, settled, batches } = reveal;
  const { plugin, drawn } = useMemo(() => {
    const drawn = new Set<number>();
    const plugin: RehypePlugin = fadeWords(settled, batches, drawn);
    return { plugin, drawn };
  }, [settled, batches]);
  const done = useCallback((key: number) => onDone(key, drawn), [onDone, drawn]);
  return (
    <FadeDone value={done}>
      <Markdown text={text.slice(0, shown)} plugin={plugin} components={FADE_COMPONENTS} />
    </FadeDone>
  );
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
  const done = useCallback((key: number, drawn: ReadonlySet<number>) => setReveal((was) => retire(was, key, drawn)), []);
  let current = reveal;
  if (current.fade !== fade) current = adopt(text, fade, current.nextKey);
  else if (current.text !== text) current = fade ? advance(current, text) : adopt(text, fade, current.nextKey);
  // Adjusted while rendering, as React has state follow a prop: no effect, and no frame drawn a delta behind.
  if (current !== reveal) setReveal(current);
  if (!fade) return <Markdown text={text} />;
  return <Fading reveal={current} onDone={done} />;
};
