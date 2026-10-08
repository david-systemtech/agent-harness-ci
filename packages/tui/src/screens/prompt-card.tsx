import { choiceRows, denylistCardWords, oneLine } from "@agent-harness/client-runtime";
import { Box, Text } from "ink";
import type { PromptOpenedPayload, PromptQuestion } from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import { currentQuestion, isQuestion, type CardState } from "../cards/prompt.js";

/**
 * The permission, question and plan card on screen (docs/specs/tui.md,
 * "Cards"): a bordered box below
 * the transcript and above the composer, in the colour of its kind, with
 * what is asked, the call's input, a denylist prompt's matches, each once
 * (#1905), with what each protects and what the agent may do instead, and when the run asked
 * about the same entry before (#1828), a plan's text, the rows with the
 * cursor, the note, and a hint line in the keys of the map in force. A
 * function of its props: the state is the app's.
 */

/** Lines of a call's input or a plan drawn before the rest is counted. */
const INPUT_LINES = 6;
const PLAN_LINES = 10;

const COLOURS: Readonly<Record<PromptOpenedPayload["kind"], string>> = { permission: TERMINAL_ROLES.warning, denylist: TERMINAL_ROLES.danger, question: TERMINAL_ROLES.accent, plan: TERMINAL_ROLES.thinking };

/** The input as the card shows it: a shell command as its line, anything else as indented JSON; none when there is none. */
const inputLines = (input: PromptOpenedPayload["input"]): readonly string[] => {
  if (input === null) return [];
  const command = input["command"];
  const lines = typeof command === "string" ? command.split("\n").map((line, at) => `${at === 0 ? "$" : " "} ${line}`) : JSON.stringify(input, null, 2).split("\n");
  return lines.length <= INPUT_LINES ? lines : [...lines.slice(0, INPUT_LINES - 1), `… +${lines.length - INPUT_LINES + 1} lines`];
};

/** The card's heading: its kind, and a question's header chip. */
const heading = (prompt: PromptOpenedPayload, question: PromptQuestion | undefined): string => {
  switch (prompt.kind) {
    case "permission":
      return "⚿ Permission";
    case "denylist":
      return "⛔ Denylist";
    case "plan":
      return "▤ Plan to approve";
    case "question":
      return `? ${question?.header || "Question"}`;
  }
};

export interface PromptCardProps {
  readonly prompt: PromptOpenedPayload;
  readonly state: CardState;
  /** "1 of 2 waiting" when more than one prompt is parked on the session. */
  readonly place: string | undefined;
  /** How long it has before its TTL denies it, in words ("2h 0m left"); none when it never is. */
  readonly ttl: string | undefined;
  /** The hint line, in the keys of the map in force. */
  readonly hint: string;
  /** The `e` and `s` keys, drawn dim with the reason they do nothing. */
  readonly absent: string | undefined;
  /** A denylist prompt's `denylistRepeatWords`: that the run already asked about the same entry; none the first time. */
  readonly repeat: string | undefined;
}

const Cursor = (props: { readonly selected: boolean }) => <Text color={TERMINAL_ROLES.machine}>{props.selected ? "❯ " : "  "}</Text>;

export const PromptCard = (props: PromptCardProps) => {
  const { prompt, state } = props;
  const colour = COLOURS[prompt.kind];
  const question = isQuestion(prompt) ? currentQuestion(prompt, state) : undefined;
  const count = prompt.questions?.length ?? 0;
  const facts = [props.place, props.ttl].filter((fact) => fact !== undefined).join(" · ");
  const planLines = prompt.kind === "plan" ? (prompt.plan ?? "").split("\n") : [];
  // A denylist prompt's summary and reason name its match as a sentence its entries say again; it says each thing once instead (#1905).
  const denylist = denylistCardWords(prompt);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colour} paddingX={1} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={colour} bold>
          {heading(prompt, question)}
        </Text>
        {prompt.kind !== "question" && prompt.kind !== "plan" && prompt.toolName !== null && <Text bold> · {prompt.toolName}</Text>}
        {question && count > 1 && <Text dimColor>{`  ${state.question + 1}/${count}`}</Text>}
        {facts.length > 0 && <Text dimColor>{`  ${facts}`}</Text>}
      </Text>
      {question ? <Text wrap="truncate-end">{question.question}</Text> : prompt.kind !== "plan" && <Text wrap="truncate-end">{oneLine(denylist?.asked ?? prompt.summary, 300)}</Text>}
      {denylist === undefined && prompt.reason !== null && <Text color={TERMINAL_ROLES.warning} wrap="truncate-end">{oneLine(prompt.reason, 300)}</Text>}
      {prompt.blockedPath !== null && <Text dimColor wrap="truncate-end">path: {prompt.blockedPath}</Text>}
      {denylist?.entries.map((entry, at) => (
        <Box key={at} flexDirection="column">
          {entry.heading !== undefined && (
            <Text color={TERMINAL_ROLES.danger} wrap="truncate-end">
              {entry.heading}
            </Text>
          )}
          <Box paddingLeft={2} flexDirection="column">
            <Text>{entry.protects}</Text>
            <Text dimColor>{entry.instead}</Text>
          </Box>
        </Box>
      ))}
      {props.repeat !== undefined && (
        <Text color={TERMINAL_ROLES.danger} bold>
          {props.repeat}
        </Text>
      )}
      {prompt.kind !== "question" &&
        inputLines(prompt.input).map((line, at) => (
          <Text key={at} dimColor wrap="truncate-end">
            {"  "}
            {line}
          </Text>
        ))}
      {prompt.previewLines?.map((line, at) => (
        <Text key={`preview-${at}`} color={TERMINAL_ROLES.warning} wrap="truncate-end">
          {"  "}{line}
        </Text>
      ))}
      {planLines.slice(0, PLAN_LINES).map((line, at) => (
        <Text key={at} wrap="truncate-end">
          {"  "}
          {line}
        </Text>
      ))}
      {planLines.length > PLAN_LINES && <Text dimColor>{`  … +${planLines.length - PLAN_LINES} lines of the plan · Ctrl+O shows it whole`}</Text>}
      {question
        ? question.options.map((option, at) => {
            const selected = at === state.cursor;
            const box = question.multiSelect ? (state.ticked.has(at) ? "[x] " : "[ ] ") : state.ticked.has(at) ? "(x) " : "( ) ";
            return (
              <Text key={at} wrap="truncate-end">
                <Cursor selected={selected} />
                <Text>{box}</Text>
                <Text bold={selected}>{option.label}</Text>
                {option.description.length > 0 && <Text dimColor>{`  ${option.description}`}</Text>}
              </Text>
            );
          })
        : choiceRows(prompt).map((row, at) => {
            const selected = at === state.cursor;
            const greyed = row.kind === "approve" && row.above;
            return (
              <Text key={at} wrap="truncate-end" dimColor={greyed}>
                <Cursor selected={selected} />
                <Text bold={selected}>{row.label}</Text>
                {row.detail.length > 0 && <Text dimColor>{`  ${row.detail}`}</Text>}
              </Text>
            );
          })}
      {question && question.options.length === 0 && <Text dimColor>No options: Tab answers it in your own words.</Text>}
      {state.line !== null ? (
        <Text wrap="truncate-start">
          <Text color={TERMINAL_ROLES.machine}>{"✎ "}</Text>
          {state.line}
          <Text inverse> </Text>
          {state.line.length === 0 && <Text dimColor>{question ? " your own answer" : " a note for the agent, sent with the answer"}</Text>}
        </Text>
      ) : (
        state.note.length > 0 && !question && <Text dimColor wrap="truncate-end">note: {state.note}</Text>
      )}
      <Text dimColor wrap="wrap">
        {props.hint}
      </Text>
      {props.absent !== undefined && state.line === null && (
        <Text dimColor wrap="truncate-end">
          {props.absent}
        </Text>
      )}
    </Box>
  );
};
