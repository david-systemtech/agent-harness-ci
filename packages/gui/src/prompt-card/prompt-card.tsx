import { COUNTDOWN_TICK_MS, choiceRows, noteOf, oneLine, rowAnswer, ttlWords, type CapabilityAnswer, type ChoiceRow, type RowOutcome } from "@agent-harness/client-runtime";
import { actionById, describeDenylistMatch, type KeyActionId, type ParkedPrompt, type PromptAnswerInput, type PromptKind, type PromptOpenedPayload } from "@agent-harness/contracts";
import { useEffect, useId, useMemo, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useInFocusedPane } from "../grid/grid.js";
import { keyLabel } from "../keys/chords.js";
import { KeyContext, useKeyAction, useMacOS } from "../keys/key-dispatch.js";
import { Markdown } from "../transcript/markdown.js";
import { Button, Input } from "../ui/index.js";
import { classes } from "../ui/classes.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { useAnswering } from "./answering.js";
import { QuestionForm, questionAnswers, questionsOf, type Picks } from "./question.js";

export interface PromptCardProps {
  readonly environmentId: string;
  readonly sessionId: string;
}

/** What has been written and chosen on a prompt's card, kept while the prompt is parked, so an answer that failed comes back with it. */
interface CardFields {
  /** The note that rides the answer, as its `message`. */
  readonly note: string;
  /** A question's picks and own words. */
  readonly picks: Picks;
}

const NO_FIELDS: CardFields = { note: "", picks: {} };

/**
 * The parked prompt's card (docs/specs/gui.md, "A session pane"; story 10;
 * permissions spec, "Prompts, parked prompts and the TTL"): the session's
 * parked prompts wait here, between the transcript and the composer, the
 * oldest on the card, "1 of N waiting" while more wait, with its TTL
 * counted down in the environment's time. The transcript leaves a parked
 * prompt out; once answered it is drawn there where it was asked.
 *
 * - **An approval** only by a click on Allow once or Allow for this session
 *   (`remember: 'session'`, a `permission` prompt's only), or by Mod+Enter
 *   (`permission.allow`) for Allow once; never by a bare Enter, which an
 *   approving button refuses even with the focus on it. Esc
 *   (`permission.deny`) denies. A `denylist` prompt names what it matched.
 * - **A question** offers its options, several at once where it allows, and
 *   an answer in the person's own words; Mod+Enter sends, Esc skips (a deny).
 * - **A plan** offers Keep planning (Esc) and one approval per mode, the
 *   first (Mod+Enter) continuing in acceptEdits; a mode above the prompt's
 *   ceiling is greyed with its reason and sends nothing.
 * - **A note** rides whichever answer is given, as its message.
 *
 * The card takes the focus when a prompt comes to it, the card itself and
 * never a button, so nothing a stray Enter fires is under it; its keys are
 * its own, the `permission` context's, while the focus is in it. Every
 * answer is `permissions.prompts.answer`; while the connection cannot send
 * it the card is dim with the capability's line, and a refusal is one line
 * on the card.
 */
export const PromptCard = ({ environmentId, sessionId }: PromptCardProps) => {
  const runtime = useRuntime();
  // The connections' phases: whether the card can answer is asked again whenever one moves.
  useObservable(runtime.projections.environments);
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const parked = projection.parkedPrompts;
  const answering = useAnswering(environmentId, sessionId, parked);
  const [filled, setFilled] = useState<ReadonlyMap<string, CardFields>>(new Map());
  // What was filled in goes with its prompt once it is no longer parked.
  useEffect(() => {
    const still = new Set(parked.map((prompt) => prompt.promptId));
    if ([...filled.keys()].some((id) => !still.has(id))) setFilled((current) => new Map([...current].filter(([id]) => still.has(id))));
  }, [parked, filled]);

  const waiting = parked.filter((prompt) => !answering.sent.has(prompt.promptId));
  const shown = waiting[0];
  if (shown === undefined) return null;
  const { promptId } = shown;
  return (
    <ParkedCard
      key={promptId}
      environmentId={environmentId}
      parked={shown}
      place={waiting.length > 1 ? `1 of ${waiting.length} waiting` : undefined}
      capability={runtime.capability(environmentId, "permissions.prompts.answer")}
      fields={filled.get(promptId) ?? NO_FIELDS}
      setFields={(fields) => setFilled((current) => new Map(current).set(promptId, fields))}
      line={answering.lineOf(promptId)}
      say={(line) => answering.say(promptId, line)}
      answer={(input) => answering.answer(promptId, input)}
    />
  );
};

interface ParkedCardProps {
  readonly environmentId: string;
  readonly parked: ParkedPrompt;
  readonly place: string | undefined;
  /** Whether the connection can send `permissions.prompts.answer` now. */
  readonly capability: CapabilityAnswer;
  readonly fields: CardFields;
  setFields(fields: CardFields): void;
  /** The card's one line: why an answer failed or was not sent. */
  readonly line: string | undefined;
  say(line: string): void;
  answer(input: PromptAnswerInput): void;
}

/** What the card is headed with, by the prompt's kind. */
const HEADINGS: Readonly<Record<PromptKind, string>> = { permission: "Permission", denylist: "Denylist", question: "Question", plan: "Plan to approve" };

/** What Esc and Mod+Enter do on the card, by the prompt's kind, for its hint. */
const KEY_WORDS: Readonly<Record<PromptKind, { readonly deny: string; readonly allow: string }>> = {
  permission: { deny: "denies", allow: "allows once" },
  denylist: { deny: "denies", allow: "allows once" },
  question: { deny: "skips", allow: "sends the answer" },
  plan: { deny: "keeps planning", allow: "approves, continuing in acceptEdits" },
};

/** The edge of the card, by the prompt's kind: an approval in the warning's colour, a denylist prompt in the danger's; a dim card has none. */
const EDGES: Readonly<Record<PromptKind, string>> = { permission: "border-amber", denylist: "border-signal", question: "border-cyan", plan: "border-beam" };

/** One prompt's card. */
const ParkedCard = ({ environmentId, parked, place, capability, fields, setFields, line, say, answer }: ParkedCardProps) => {
  const { prompt } = parked;
  const self = useRef<HTMLElement>(null);
  const ttl = useTtlWords(environmentId, prompt.ttlExpiresAt);
  const rows = choiceRows(prompt);

  // The card takes the focus when its prompt comes to it: the card, never a button, so a stray Enter fires nothing. In a
  // pane the grid is not focused on it waits for the pane, rather than taking the focus from the one being typed in.
  const inFocusedPane = useInFocusedPane();
  useEffect(() => {
    const card = self.current;
    if (inFocusedPane && card !== null && card.closest("[inert]") === null) card.focus({ preventScroll: true });
    // Once, as the prompt comes to the card: not again when the pane is focused later.
  }, []);

  /** Sends what was chosen, unless the connection cannot, or the choice sends nothing and says why. */
  const settle = (outcome: RowOutcome) => {
    if (capability.status === "absent") return say(`Not answered: ${capability.message}`);
    if (outcome.kind === "say") return say(outcome.line);
    answer(outcome.answer);
  };
  const choose = (row: ChoiceRow | undefined) => settle(rowAnswer(prompt, row, fields.note));
  const allow = () => {
    if (prompt.kind === "question") return settle(questionAnswers(prompt, fields.picks, fields.note));
    choose(rows.find((row) => row.kind === "allow" || (row.kind === "approve" && row.mode === null)));
  };
  const deny = () => (prompt.kind === "question" ? settle({ kind: "answer", answer: { decision: "deny", ...noteOf(fields.note) } }) : choose(rows[0]));
  const dim = capability.status === "absent";
  const shownLine = line ?? (dim ? capability.message : undefined);
  const facts = [place, ttl].filter((fact) => fact !== undefined).join(" · ");

  return (
    <KeyContext context="permission">
      <CardKeys allow={allow} deny={deny} offer={capability} />
      <section
        ref={self}
        aria-label="Parked prompt"
        tabIndex={-1}
        className={classes(
          "flex max-h-[60vh] shrink-0 flex-col gap-2 overflow-y-auto border-t-2 bg-panel px-4 py-3 text-sm outline-none",
          dim ? "border-line text-ink-muted" : classes("text-ink", EDGES[prompt.kind]),
        )}
      >
        <header className="flex items-baseline gap-2">
          <h2 className="font-semibold">
            {HEADINGS[prompt.kind]}
            {(prompt.kind === "permission" || prompt.kind === "denylist") && prompt.toolName !== null && ` · ${prompt.toolName}`}
          </h2>
          {facts.length > 0 && <span className="text-xs text-ink-muted">{facts}</span>}
        </header>
        <PromptBody prompt={prompt} fields={fields} setFields={setFields} />
        <Input
          aria-label="Note"
          placeholder="A note for the agent, sent with the answer: why, or what to do after"
          maxLength={10_000}
          value={fields.note}
          onChange={(event) => setFields({ ...fields, note: event.target.value })}
        />
        {shownLine !== undefined && (
          <p role="status" className={line === undefined ? "text-xs text-ink-muted" : "text-xs text-signal"}>
            {shownLine}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {prompt.kind === "question" ? (
            <>
              <Answer dim={dim} onClick={deny}>
                Skip
              </Answer>
              <Answer dim={dim} approves onClick={allow}>
                {questionsOf(prompt).length > 1 ? "Send answers" : "Send answer"}
              </Answer>
            </>
          ) : (
            rows.map((row) => <RowButton key={row.label} row={row} dim={dim} onClick={() => choose(row)} />)
          )}
        </div>
        <KeysHint kind={prompt.kind} />
      </section>
    </KeyContext>
  );
};

/** What the prompt asks, by its kind. */
const PromptBody = ({ prompt, fields, setFields }: { readonly prompt: PromptOpenedPayload; readonly fields: CardFields; setFields(fields: CardFields): void }) => {
  if (prompt.kind === "question") return <QuestionForm prompt={prompt} picks={fields.picks} setPicks={(picks) => setFields({ ...fields, picks })} />;
  if (prompt.kind === "plan")
    return (
      <div className="max-h-72 overflow-y-auto rounded-md border border-hairline px-3 py-2">
        <Markdown text={prompt.plan ?? prompt.summary} />
      </div>
    );
  const input = inputText(prompt.input);
  return (
    <>
      <p>{oneLine(prompt.summary, 300)}</p>
      {prompt.reason !== null && <p className="text-amber">{oneLine(prompt.reason, 300)}</p>}
      {prompt.blockedPath !== null && <p className="text-xs text-ink-muted">Path: {prompt.blockedPath}</p>}
      {prompt.agentId !== null && <p className="text-xs text-ink-muted">Asked by the subagent {prompt.agentId}</p>}
      {prompt.denylist !== null && prompt.denylist.length > 0 && (
        <ul aria-label="On the denylist" className="flex flex-col gap-0.5 text-signal">
          {prompt.denylist.map((match, at) => (
            <li key={at}>{describeDenylistMatch(match)}</li>
          ))}
        </ul>
      )}
      {input !== undefined && (
        <pre className="max-h-48 overflow-auto rounded-md border border-hairline bg-inset px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-ink-muted">{input}</pre>
      )}
    </>
  );
};

/** A call's input as the card shows it, verbatim: a shell command as its lines, anything else as indented JSON; none when there is none. */
const inputText = (input: PromptOpenedPayload["input"]): string | undefined => {
  if (input === null) return undefined;
  const command = input["command"];
  if (typeof command !== "string") return JSON.stringify(input, null, 2);
  return command
    .split("\n")
    .map((line, at) => `${at === 0 ? "$" : " "} ${line}`)
    .join("\n");
};

interface AnswerProps {
  /** The connection cannot answer now: drawn dim, and a press says why. */
  readonly dim: boolean;
  /** It approves: a bare Enter never presses it, even with the focus on it. */
  readonly approves?: boolean;
  /** A mode above the ceiling: greyed, and a press says why. */
  readonly greyed?: boolean;
  readonly describedBy?: string | undefined;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

/** A bare Enter, which never approves. */
const bareEnter = (event: KeyboardEvent) => event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;

/**
 * One answer's button. Dim or greyed is `aria-disabled`, not `disabled`, so
 * it still takes the pointer and the focus, and a press says why nothing is
 * sent. An approving one refuses a bare Enter, which a button would
 * otherwise take as a click.
 */
const Answer = ({ dim, approves = false, greyed = false, describedBy, onClick, children }: AnswerProps) => (
  <Button
    tone={approves && !greyed ? "primary" : "quiet"}
    aria-disabled={dim || greyed ? true : undefined}
    aria-describedby={describedBy}
    className="border border-line aria-disabled:cursor-default aria-disabled:border-hairline aria-disabled:bg-transparent aria-disabled:text-ink-faint"
    onKeyDown={(event) => {
      if (approves && bareEnter(event)) event.preventDefault();
    }}
    onClick={onClick}
  >
    {children}
  </Button>
);

/** An approval's or a plan's row as a button, with what it does beside it: a greyed mode's reason. */
const RowButton = ({ row, dim, onClick }: { readonly row: ChoiceRow; readonly dim: boolean; readonly onClick: () => void }) => {
  const id = useId();
  const described = row.detail.length > 0 ? id : undefined;
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <Answer dim={dim} approves={row.kind !== "deny"} greyed={row.kind === "approve" && row.above} describedBy={described} onClick={onClick}>
        {row.label}
      </Answer>
      {described !== undefined && (
        <span id={described} className="text-xs text-ink-faint">
          {row.detail}
        </span>
      )}
    </span>
  );
};

/** The card's two keys, the `permission` context's, with whether the card can answer now. */
const CardKeys = ({ allow, deny, offer }: { readonly allow: () => void; readonly deny: () => void; readonly offer: CapabilityAnswer }) => {
  useKeyAction("permission.allow", allow, offer);
  useKeyAction("permission.deny", deny, offer);
  return null;
};

/** The first of an action's GUI keys in force, as this platform writes it. */
const firstKey = (id: KeyActionId, macOS: boolean): string | undefined => {
  const gui = actionById(id)?.gui;
  const key = gui?.status === "wired" && gui.off !== true ? gui.keys[0] : undefined;
  return key === undefined ? undefined : keyLabel(key, macOS);
};

/** What the card's keys do, in the keys this platform writes. */
const KeysHint = ({ kind }: { readonly kind: PromptKind }) => {
  const macOS = useMacOS();
  const said = [
    [firstKey("permission.deny", macOS), KEY_WORDS[kind].deny],
    [firstKey("permission.allow", macOS), KEY_WORDS[kind].allow],
  ].flatMap(([key, words]) => (key === undefined ? [] : [`${key} ${words}`]));
  return <p className="text-xs text-ink-faint">{said.join(" · ")}</p>;
};

/**
 * How long the prompt has before its TTL denies it, in words, counted down
 * on its environment's clock as this window reckons it (`environmentNow`),
 * drawn again every second while it runs; none when it never is.
 */
const useTtlWords = (environmentId: string, expiresAt: string | null): string | undefined => {
  const runtime = useRuntime();
  const clock = useClock();
  const [tick, redraw] = useReducer((count: number) => count + 1, 0);
  const remaining = expiresAt === null ? undefined : Date.parse(expiresAt) - runtime.environmentNow(environmentId).getTime();
  const running = remaining !== undefined && remaining > 0;
  useEffect(() => {
    if (!running) return;
    const timer = clock.setTimeout(redraw, COUNTDOWN_TICK_MS);
    return () => timer.cancel();
  }, [clock, running, tick]);
  return remaining === undefined ? undefined : ttlWords(remaining);
};

