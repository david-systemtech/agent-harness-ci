import { DATA_DIRECTORY_PRESET_ID, type DenylistMatch, type DenylistSection, type PromptAnsweredPayload, type PromptOpenedPayload } from "@agent-harness/contracts";

/**
 * What a denylist prompt's card says beside its answers (ADR 0006: the
 * denylist holds in every mode, and a denylisted call parks for the person
 * present, who may allow it once; #1820), as the window's and the web
 * client's card says it:
 *
 * - **Each entry the call matched, in words**: the environment's data
 *   directory by name, any other entry by its pattern and note, and what the
 *   agent may do instead, by the entry's section.
 * - **The same entry again**: when the run asked about an entry this prompt
 *   matches before, how often and the last answer, so a person sees a loop
 *   rather than a new question.
 */

/** One matched entry in words: what it protects, and what the agent may do instead. */
export interface DenylistMatchWords {
  readonly protects: string;
  readonly instead: string;
}

/** Each section's name as a sentence says it. */
const SECTION_WORDS: Readonly<Record<DenylistSection, string>> = {
  browserDomains: "browser domains",
  paths: "paths",
  commandPatterns: "command patterns",
  hosts: "hosts",
};

/** What the agent may do instead of a call an entry of each section matched. */
const INSTEAD: Readonly<Record<DenylistSection, string>> = {
  browserDomains: "Instead, the agent may go on without this site, or ask you to do it in your own browser.",
  paths: "Instead, the agent may go on without this path, or ask you for what it needs from it.",
  commandPatterns: "Instead, the agent may go on without this command, or ask you to run it yourself.",
  hosts: "Instead, the agent may go on without reaching this host, or ask you for what it needs from it.",
};

const DATA_DIRECTORY: DenylistMatchWords = {
  protects: "This is the environment's data directory: its event log, keys and accounts.",
  instead: "Instead, the agent may work in its own working directory, and ask you for anything it needs from the environment's records.",
};

/** One matched entry in words: the data directory by name; any other by its pattern and note, or that it has none. */
export const denylistMatchWords = ({ section, entry }: DenylistMatch): DenylistMatchWords => {
  if (entry.id === DATA_DIRECTORY_PRESET_ID) return DATA_DIRECTORY;
  const note = entry.note.trim();
  return { protects: note === "" ? `Entry ${entry.pattern}, on the denylist's ${SECTION_WORDS[section]} with no note.` : `Entry ${entry.pattern}: ${note}`, instead: INSTEAD[section] };
};

/** A prompt the session asked, with its answer once given. */
export interface AskedPrompt {
  readonly prompt: PromptOpenedPayload;
  readonly answer: Pick<PromptAnsweredPayload, "decision"> | null;
}

const timesWords = (count: number): string => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`);

const DECISION_WORDS = { allow: "allowed", deny: "denied" } as const;

/**
 * When `prompt`'s run asked about an entry it matches before it, in
 * `asked` (the session's prompts in the order they were asked, `prompt`
 * among them): "The same entry as before: this run already asked about
 * <pattern> twice (last denied)."; undefined the first time.
 */
export const denylistRepeatWords = (prompt: PromptOpenedPayload, asked: readonly AskedPrompt[]): string | undefined => {
  const entries = new Map((prompt.denylist ?? []).map((match) => [match.entry.id, match.entry.pattern]));
  const at = asked.findIndex((earlier) => earlier.prompt.promptId === prompt.promptId);
  const before = (at === -1 ? asked : asked.slice(0, at)).filter(
    (earlier) => earlier.prompt.kind === "denylist" && earlier.prompt.runId === prompt.runId && (earlier.prompt.denylist ?? []).some((match) => entries.has(match.entry.id)),
  );
  const last = before.at(-1);
  if (last === undefined) return undefined;
  const shared = [...entries].filter(([id]) => before.some((earlier) => earlier.prompt.denylist?.some((match) => match.entry.id === id))).map(([, pattern]) => pattern);
  const answer = last.answer === null ? "" : ` (last ${DECISION_WORDS[last.answer.decision]})`;
  return `The same entry as before: this run already asked about ${shared.join(", ")} ${timesWords(before.length)}${answer}.`;
};
