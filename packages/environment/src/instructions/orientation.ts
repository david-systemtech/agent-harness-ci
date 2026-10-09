import type { ORIENTATION_SECTION_STEPS } from "@agent-harness/contracts";
import type { InjectionLevel } from "../adapter/process-environment.js";
import type { InstructionScope } from "../adapter/seams.js";
import type { Clock } from "../serve/clock.js";
import type { OrientationAnswer, OrientationSeam } from "./composer.js";

/**
 * The OrientationRenderer (key-managers spec, "The orientation block"; ADR
 * 0011; #380): what fills the composer's orientation seam. The block's
 * sections are rendered by providers the owning services register with it,
 * one per section, and it puts them in their fixed order (this environment,
 * accounts, key managers, forges, banks, other environments) under the
 * block's heading, each under its own; a section with no provider
 * registered is left out.
 *
 * A provider renders its section from state, never from a clock: for
 * unchanged state the text is byte-identical, since it is in a provider
 * process's spawn key and any other text costs a fresh process. Every
 * section is asked at once; one whose provider throws, or has not answered
 * a second after it was asked, renders "Could not be read." and is named in
 * the seam's answer, and the others render.
 */

/** The block's sections, in the order it holds them, each with the Set up step an unread one sends the person to. */
export const ORIENTATION_SECTIONS = ["environment", "accounts", "key-managers", "forges", "banks", "other-environments"] as const satisfies readonly (keyof typeof ORIENTATION_SECTION_STEPS)[];
export type OrientationSectionName = (typeof ORIENTATION_SECTIONS)[number];

/** A list in a section: its heading line, if it has one, over one line per item. A list with no item is left out, its heading with it. */
export interface OrientationList {
  readonly heading?: string;
  readonly items: readonly string[];
}

/** A section's paragraphs, in order: each a line of prose or a list. A blank paragraph is left out, and a section with none is. */
export type OrientationContent = readonly (string | OrientationList)[];

/** One section of the orientation block, as its provider gives it to the renderer. */
export interface OrientationSection {
  /** Its place in the block, and what the seam's answer names when it could not be read: `forges`. */
  readonly name: OrientationSectionName;
  /** Its heading in the block: `Forges`. */
  readonly title: string;
  /** Its paragraphs for a run, from state and never a clock, at once or within a second. */
  render(scope: InstructionScope): OrientationContent | Promise<OrientationContent>;
}

export interface OrientationRenderer {
  /** Adds a section's provider, asked from the next composition on; a section registered already is refused. */
  register(section: OrientationSection): void;
  /** The composer's orientation seam: the block for a run, and the sections it could not read. */
  readonly seam: OrientationSeam;
}

/**
 * An instant as the block states it (key-managers spec, "The orientation
 * block"): in UTC to the minute, `2026-09-28 09:14 UTC`, the time a status
 * last changed and never when it was last verified.
 */
export const utcMinute = (at: string): string => `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;

/**
 * Who denied a run injection, as every deny line in the block names them
 * (#714, #381): this environment's setting, or the account, routine or bot
 * by the id the run's instruction scope carries. #722 asks David whether a
 * label or name should replace the id; this is the one place that changes.
 */
export const injectionDenier = (level: InjectionLevel): string => (level.kind === "environment" ? "this environment's setting" : `the ${level.kind} ${level.id}`);

/** The block's heading, over its sections. */
const BLOCK_HEADING = "# Orientation";

/** What sits between two paragraphs, and between two sections. */
const PARAGRAPH_BREAK = "\n\n";

/** The most characters the block holds, heading included (chosen cap). */
export const ORIENTATION_CAP = 6000;

/** A section as the block lays it out: its title and the paragraphs it holds, none blank and no list empty. */
interface LaidSection {
  readonly title: string;
  readonly paragraphs: OrientationContent;
}

const isList = (paragraph: string | OrientationList): paragraph is OrientationList => typeof paragraph !== "string";

/** A section's paragraphs with the blank ones and the empty lists left out; null when none is left. */
const laidOut = (title: string, content: OrientationContent): LaidSection | null => {
  const paragraphs = content.filter((paragraph) => (isList(paragraph) ? paragraph.items.length > 0 : paragraph.trim() !== ""));
  return paragraphs.length === 0 ? null : { title, paragraphs };
};

const bullet = (item: string): string => `- ${item}`;

/** The line a cut list ends with. */
const moreLine = (hidden: number): string => bullet(`and ${hidden} more, see Settings.`);

/** A list's lines with its first `shown` items, ending with how many more there are when that cuts it. */
const listLines = ({ heading, items }: OrientationList, shown: number): string[] => [
  ...(heading === undefined ? [] : [heading]),
  ...items.slice(0, shown).map(bullet),
  ...(shown < items.length ? [moreLine(items.length - shown)] : []),
];

/** The block with every list cut to its first `shown` items. */
const layout = (sections: readonly LaidSection[], shown: number): string =>
  [
    BLOCK_HEADING,
    ...sections.map(({ title, paragraphs }) =>
      [`## ${title}`, ...paragraphs.map((paragraph) => (isList(paragraph) ? listLines(paragraph, shown).join("\n") : paragraph))].join(PARAGRAPH_BREAK),
    ),
  ].join(PARAGRAPH_BREAK);

/** How long a list's paragraph is with its first `shown` items, measured without laying it out: each line and the break after it, but the last's. */
const listLength = (list: OrientationList): ((shown: number) => number) => {
  const itemsBefore = [0];
  for (const item of list.items) itemsBefore.push((itemsBefore.at(-1) ?? 0) + bullet(item).length + 1);
  const heading = list.heading === undefined ? 0 : list.heading.length + 1;
  return (shown) => {
    const kept = Math.min(shown, list.items.length);
    const more = kept < list.items.length ? moreLine(list.items.length - kept).length + 1 : 0;
    return heading + (itemsBefore[kept] ?? 0) + more - 1;
  };
};

/**
 * The block within `ORIENTATION_CAP` (key-managers spec, "The orientation
 * block"): whole when it fits; otherwise every list longer than some count
 * is cut to its first that many items and ends "and N more, see
 * Settings.", the count the most that fits, so the longest lists are cut
 * first and to the same length. Prose is never cut: past the cap with every
 * list at its last line, the block is left longer.
 */
const fitted = (sections: readonly LaidSection[]): string => {
  const whole = layout(sections, Number.POSITIVE_INFINITY);
  const lists = sections.flatMap(({ paragraphs }) => paragraphs.filter(isList));
  if (whole.length <= ORIENTATION_CAP || lists.length === 0) return whole;
  const lengths = lists.map(listLength);
  const prose = whole.length - lengths.reduce((sum, length) => sum + length(Number.POSITIVE_INFINITY), 0);
  const lengthAt = (shown: number): number => prose + lengths.reduce((sum, length) => sum + length(shown), 0);
  let shown = Math.max(...lists.map((list) => list.items.length)) - 1;
  while (shown > 0 && lengthAt(shown) > ORIENTATION_CAP) shown -= 1;
  return layout(sections, shown);
};

/** What a section whose provider failed renders in place of its paragraphs. */
const COULD_NOT_BE_READ: OrientationContent = ["Could not be read."];

/** How long a section's provider may take, on the environment's clock, before the block shows its section as could not be read. */
export const SECTION_BUDGET_MS = 1000;

/**
 * A section's paragraphs as its provider answered them; null, logged, when
 * it threw, its promise rejected, or the promise had not settled a second on
 * `clock` after it was asked. A provider that answers at once is given no
 * timer.
 */
const readSection = (section: OrientationSection, scope: InstructionScope, clock: Clock): Promise<OrientationContent | null> => {
  const unread = (why: string, error?: unknown): null => {
    console.error(`The orientation block's ${section.name} section ${why}; the block shows it as could not be read.`, ...(error === undefined ? [] : [error]));
    return null;
  };
  let answered: OrientationContent | Promise<OrientationContent>;
  try {
    answered = section.render(scope);
  } catch (error) {
    return Promise.resolve(unread("failed", error));
  }
  if (Array.isArray(answered)) return Promise.resolve(answered);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (content: OrientationContent | null): void => {
      if (settled) return;
      settled = true;
      timer.cancel();
      resolve(content);
    };
    const timer = clock.setTimeout(() => settle(unread("did not answer within a second")), SECTION_BUDGET_MS);
    Promise.resolve(answered).then(settle, (error: unknown) => {
      if (!settled) settle(unread("failed", error));
    });
  });
};

export interface OrientationRendererOptions {
  /** The clock a section's second is measured on: the environment's. */
  readonly clock: Clock;
}

export const createOrientationRenderer = (options: OrientationRendererOptions): OrientationRenderer => {
  const { clock } = options;
  const sections = new Map<OrientationSectionName, OrientationSection>();

  const seam: OrientationSeam = async (scope): Promise<OrientationAnswer> => {
    const registered = ORIENTATION_SECTIONS.flatMap((name) => sections.get(name) ?? []);
    const answers = await Promise.all(registered.map(async (section) => ({ section, content: await readSection(section, scope, clock) })));
    const laid = answers.flatMap(({ section, content }) => laidOut(section.title, content ?? COULD_NOT_BE_READ) ?? []);
    return {
      text: laid.length === 0 ? "" : fitted(laid),
      unreadRegistries: answers.flatMap(({ section, content }) => (content === null ? [section.name] : [])),
    };
  };

  return {
    register(section) {
      if (sections.has(section.name)) throw new Error(`The orientation block's ${section.name} section is registered already.`);
      sections.set(section.name, section);
    },
    seam,
  };
};
