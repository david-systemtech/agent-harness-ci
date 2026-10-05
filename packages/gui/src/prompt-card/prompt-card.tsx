import { useComposition } from "../composer/composition.js";
import { choiceRows, noteOf, oneLine, rowAnswer, ttlWords, type CapabilityAnswer, type ChoiceRow, type RowOutcome } from "@agent-harness/client-runtime";
import { describeDenylistMatch, type ParkedPrompt, type PromptAnswerInput, type PromptKind, type PromptOpenedPayload } from "@agent-harness/contracts";
import { ChevronDown, ChevronUp, ClipboardList, MessageCircleQuestionMark, ShieldAlert, StickyNote } from "lucide-react";
import { Kbd } from "../ui/kbd.js";
import { createContext, use, useEffect, useId, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useEnvironmentCountdown } from "../environment-countdown.js";
import { useInFocusedPane } from "../grid/grid.js";
import { KeyContext, useEscapeStep, useFirstKey, useKeyAction } from "../keys/key-dispatch.js";
import { Markdown } from "../transcript/markdown.js";
import { Button, Textarea } from "../ui/index.js";
import { classes } from "../ui/classes.js";
import { useObservable, useRuntime, useShell } from "../window-context.js";
import { Answer, PromptEscape, PromptTooltip } from "./answer-button.js";
import { usePhoneOverlay } from "../ui/phone.js";
import { PhonePromptDetails } from "./phone-details.js";
import "./phone-details.css";
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

type HeldFields = readonly [ReadonlyMap<string, CardFields>, Dispatch<SetStateAction<ReadonlyMap<string, CardFields>>>];
const FieldsContext = createContext<HeldFields | null>(null);

/** A conversation dialog may close without discarding answers still being composed. */
export const PromptFieldsProvider = ({ children }: { readonly children: ReactNode }) => {
  const fields = useState<ReadonlyMap<string, CardFields>>(new Map());
  return <FieldsContext value={fields}>{children}</FieldsContext>;
};

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
  const localFields = useState<ReadonlyMap<string, CardFields>>(new Map());
  const [filled, setFilled] = use(FieldsContext) ?? localFields;
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

/** The edge of the card, by the prompt's kind: an approval in the warning's colour, a denylist prompt in the danger's; a dim card uses the neutral edge. */
const EDGES: Readonly<Record<PromptKind, string>> = { permission: "border-amber/45 bg-amber/8", denylist: "border-signal/45 bg-signal/8", question: "border-cyan/45 bg-cyan/6", plan: "border-beam/45 bg-beam/6" };
const ICON_COLOURS: Readonly<Record<PromptKind, string>> = { permission: "text-amber", denylist: "text-signal", question: "text-cyan", plan: "text-beam-text" };
const ICONS = { permission: ShieldAlert, denylist: ShieldAlert, question: MessageCircleQuestionMark, plan: ClipboardList };

/** One prompt's card. */
const ParkedCard = ({ environmentId, parked, place, capability, fields, setFields, line, say, answer }: ParkedCardProps) => {
  const { onCompositionStart, onCompositionEnd, onKeyDownCapture } = useComposition();
  const { prompt } = parked;
  const self = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [details, setDetails] = useState(false);
  const narrow = usePhoneOverlay();
  const shell = useShell();
  // Authoring dialogs already bound their transcript and decision footer together.
  const inConversationDialog = use(FieldsContext) !== null;
  const phone = narrow && shell === undefined && !inConversationDialog;
  useEffect(() => { if (!phone) setDetails(false); }, [phone]);
  const bodyId = useId();
  const noteId = useId();
  const denyKey = useFirstKey("permission.deny");
  const allowKey = useFirstKey("permission.allow");
  const Icon = ICONS[prompt.kind];
  // How long the prompt has before its TTL denies it; none when it never is.
  const remaining = useEnvironmentCountdown(environmentId, prompt.ttlExpiresAt);
  const ttl = remaining === undefined ? undefined : ttlWords(remaining);
  const choices = choiceRows(prompt);
  const rows = prompt.kind === "denylist" ? choices.filter((row) => row.kind === "deny")
    : prompt.kind === "permission" ? [...choices.filter((row) => row.kind !== "allow"), ...choices.filter((row) => row.kind === "allow")] : choices;

  // The card takes the focus when its prompt comes to it: the card, never a button, so a stray Enter fires nothing. In a
  // pane the grid is not focused on it leaves the focus in the pane being typed in, and does not take it when its own
  // pane is focused later: it waits there to be answered.
  const inFocusedPane = useInFocusedPane();
  useEffect(() => {
    const card = self.current;
    if (inFocusedPane && card !== null && card.closest("[inert]") === null) card.focus({ preventScroll: true });
  }, []);

  /** Sends what was chosen, unless the connection cannot, or the choice sends nothing and says why. */
  const settle = (outcome: RowOutcome) => {
    if (capability.status === "absent") return say(`Not answered: ${capability.message}`);
    if (outcome.kind === "say") return say(outcome.line);
    answer(outcome.answer);
  };
  const choose = (row: ChoiceRow | undefined) => settle(rowAnswer(prompt, row, fields.note));
  const allow = () => {
    if (prompt.kind === "denylist") return;
    if (prompt.kind === "question") return settle(questionAnswers(prompt, fields.picks, fields.note));
    choose(rows.find((row) => row.kind === "allow" || (row.kind === "approve" && row.mode === null)));
  };
  const deny = () => (prompt.kind === "question" ? settle({ kind: "answer", answer: { decision: "deny", ...noteOf(fields.note) } }) : choose(rows[0]));
  const dim = capability.status === "absent";
  const permission = prompt.kind === "permission";
  const question = prompt.kind === "question";
  const pinnedDecision = permission || prompt.kind === "plan" || question;
  const shownLine = line ?? (dim ? capability.message : undefined);
  const facts = [place, ttl].filter((fact) => fact !== undefined).join(" · ");

  const note = <>
    <label htmlFor={noteId} className="flex items-center gap-2 text-xs font-medium"><StickyNote aria-hidden="true" className="size-3.5" />Note</label>
    <PromptTooltip content={["Note", denyKey, prompt.kind !== "denylist" && allowKey].filter(Boolean).join(" · ")}>
      <Textarea
        id={noteId}
        rows={2}
        className={classes("min-h-12", (prompt.kind === "plan" || question) && "max-h-24 resize-none overflow-y-auto")}
        aria-label="Note"
        placeholder="A note for the agent, sent with the answer: why, or what to do after"
        maxLength={10_000}
        value={fields.note}
        onChange={(event) => setFields({ ...fields, note: event.target.value })}
      />
    </PromptTooltip>
  </>;

  const request = <PromptBody prompt={prompt} fields={fields} setFields={setFields} full={phone} />;

  const actions = <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
    {prompt.kind === "question" ? <>
      <Answer dim={dim} keys={denyKey} hint={dim ? capability.message : undefined} onClick={deny}>Skip</Answer>
      <Answer dim={dim} approves keys={allowKey} hint={dim ? capability.message : undefined} onClick={allow}>
        {questionsOf(prompt).length > 1 ? "Send answers" : "Send answer"}
      </Answer>
    </> : rows.map((row) => <RowButton key={row.label} row={row} dim={dim} reason={dim ? capability.message : undefined} keys={row.kind === "deny" ? denyKey : row.kind === "allow" || (row.kind === "approve" && row.mode === null) ? allowKey : undefined} onClick={() => choose(row)} />)}
  </div>;

  if (phone) return <KeyContext context="permission">
    {!details && <CardKeys allow={allow} deny={deny} offer={capability} />}
    <section ref={self} aria-label="Parked prompt" tabIndex={-1} className="phone-prompt-summary rounded-lg border border-line bg-panel text-ink">
      <span className="min-w-0 truncate font-medium">{HEADINGS[prompt.kind]}{prompt.toolName && ` · ${prompt.toolName}`}{facts && ` · ${facts}`}</span>
      <Button size="sm" onClick={() => setDetails(true)}>Details</Button>
      {shownLine !== undefined && <p role="status" className="phone-prompt-line text-signal">{shownLine}</p>}
      <PhonePromptDetails open={details} onOpenChange={setDetails} title={HEADINGS[prompt.kind]} restore={self} keys={<CardKeys allow={allow} deny={deny} offer={capability} escape={false} />} footer={<>
        {shownLine !== undefined && <p role="status" className="text-xs text-signal">{shownLine}</p>}
        {actions}
      </>}>
        <div {...{ onCompositionStart, onCompositionEnd, onKeyDownCapture }} className="flex min-h-0 flex-col gap-2">
          {request}
          <div className="flex flex-col gap-2">{note}</div>
        </div>
      </PhonePromptDetails>
    </section>
  </KeyContext>;

  return (
    <KeyContext context="permission">
      <PromptEscape value={deny}>
      <CardKeys allow={allow} deny={deny} offer={capability} />
      <section
        ref={self}
        {...{ onCompositionStart, onCompositionEnd, onKeyDownCapture }}
        aria-label="Parked prompt"
        tabIndex={-1}
        className={classes(
          "mx-3 flex min-h-0 max-h-[60dvh] shrink flex-col gap-2 rounded-lg border px-3 py-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-beam/50",
          pinnedDecision ? "overflow-hidden" : "overflow-y-auto",
          dim ? "border-line bg-panel text-ink-muted" : classes("text-ink", EDGES[prompt.kind]),
        )}
      >
        <header className={classes("flex shrink-0 items-center gap-2 text-xs", prompt.kind === "question" ? "text-cyan" : "text-amber")}>
          <Icon aria-hidden="true" className={classes("size-3.5 shrink-0", ICON_COLOURS[prompt.kind])} />
          <h2 className="font-semibold text-ink">
            {HEADINGS[prompt.kind]}
            {(prompt.kind === "permission" || prompt.kind === "denylist") && prompt.toolName !== null && ` · ${prompt.toolName}`}
          </h2>
          {facts.length > 0 && <span>{facts}</span>}
          <PromptTooltip content={`${collapsed ? "Show request" : "Hide request"} · Enter or Space`}>
            <Button size="sm" className="ml-auto" aria-label={collapsed ? "Show request" : "Hide request"} aria-controls={bodyId} aria-expanded={!collapsed} onClick={() => {
              setCollapsed(!collapsed);
              if (collapsed) self.current?.focus({ preventScroll: true });
            }}>{collapsed ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}{collapsed ? "Show" : "Hide"}</Button>
          </PromptTooltip>
        </header>
        <div id={bodyId} hidden={collapsed} className={classes(pinnedDecision && !collapsed && "flex min-h-0 flex-col")}>
          <div className={classes("flex flex-col gap-2", pinnedDecision && "min-h-0")}>
            {permission ? <div role="region" aria-label="Permission request" className="flex min-h-0 flex-col gap-2">{request}</div> : question ? <div role="region" aria-label="Questions" className="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain"><div className="shrink-0">{request}</div><div className="flex shrink-0 flex-col gap-2">{note}</div></div> : request}
            <div role={permission || question ? "group" : undefined} aria-label={permission ? "Permission decision" : question ? "Question decision" : undefined} data-prompt-decision className="flex shrink-0 flex-col gap-2">
              {!question && note}
              {shownLine !== undefined && (
                <p role="status" className={line === undefined ? "text-xs text-ink-muted" : "text-xs text-signal"}>
                  {shownLine}
                </p>
              )}
              {actions}
              <KeysHint kind={prompt.kind} />
            </div>
          </div>
        </div>
      </section>
      </PromptEscape>
    </KeyContext>
  );
};

/** What the prompt asks, by its kind. */
const PromptBody = ({ prompt, fields, setFields, full = false }: { readonly prompt: PromptOpenedPayload; readonly fields: CardFields; setFields(fields: CardFields): void; readonly full?: boolean }) => {
  if (prompt.kind === "question") return <QuestionForm prompt={prompt} picks={fields.picks} setPicks={(picks) => setFields({ ...fields, picks })} />;
  if (prompt.kind === "plan") return <PlanBody text={prompt.plan ?? prompt.summary} />;
  const input = inputText(prompt.input);
  return (
    <>
      <p className="shrink-0">{full ? prompt.summary : oneLine(prompt.summary, 300)}</p>
      {prompt.reason !== null && <p className="shrink-0 text-amber">{full ? prompt.reason : oneLine(prompt.reason, 300)}</p>}
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
        <pre aria-label="Arguments" className={classes("max-h-[224px] overflow-auto rounded-none border border-hairline bg-inset px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-ink-muted", prompt.kind === "permission" && "min-h-0")}>{input}</pre>
      )}
    </>
  );
};

/** Fade only unread content, so a short plan and the last line remain legible. */
const PlanBody = ({ text }: { readonly text: string }) => {
  const body = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const measure = () => {
    const element = body.current;
    setClipped(element !== null && element.scrollHeight > element.clientHeight + element.scrollTop + 1);
  };
  useEffect(() => {
    const element = body.current;
    if (element === null) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild !== null) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [text]);
  return <div className="flex min-h-0 flex-col">
    <div ref={body} aria-label="Plan body" onScroll={measure} className={classes("min-h-0 max-h-[416px] overflow-y-auto", clipped && "[mask-image:linear-gradient(to_bottom,var(--ink)_calc(100%_-_24px),transparent)]")}>
      <Markdown text={text} />
    </div>
    {clipped && <p className="mt-1 flex shrink-0 items-center gap-1 text-xs text-ink-faint"><ChevronDown aria-hidden="true" className="size-3.5" />Scroll to read the plan</p>}
  </div>;
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

/** An approval's or a plan's row as a button, with what it does beside it: a greyed mode's reason. */
const RowButton = ({ row, dim, keys, reason, onClick }: { readonly row: ChoiceRow; readonly dim: boolean; readonly keys: string | undefined; readonly reason: string | undefined; readonly onClick: () => void }) => {
  const id = useId();
  const described = row.detail.length > 0 ? id : undefined;
  return (
    <span data-prompt-choice className="inline-flex items-baseline gap-1.5">
      <Answer dim={dim} approves={row.kind !== "deny"} greyed={row.kind === "approve" && row.above} describedBy={described} keys={keys} hint={reason ?? row.detail} onClick={onClick}>
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

/**
 * The card's two keys, the `permission` context's, with whether the card can answer now; and Esc from elsewhere in
 * the window, which denies the focused pane's prompt once no surface before it in Escape's order takes it (#418).
 */
const CardKeys = ({ allow, deny, offer, escape = true }: { readonly allow: () => void; readonly deny: () => void; readonly offer: CapabilityAnswer; readonly escape?: boolean }) => {
  useKeyAction("permission.allow", allow, offer);
  useKeyAction("permission.deny", deny, offer);
  useEscapeStep("prompt", deny, escape);
  return null;
};

/** What the card's keys do, in the keys in force as this platform writes them. */
const KeysHint = ({ kind }: { readonly kind: PromptKind }) => {
  const deny = useFirstKey("permission.deny");
  const allow = useFirstKey("permission.allow");
  return <p className="flex flex-wrap items-center gap-1 text-xs text-ink-faint">
    {deny !== undefined && <><Kbd>{deny}</Kbd>{KEY_WORDS[kind].deny}</>}
    {allow !== undefined && kind !== "denylist" && <><Kbd>{allow}</Kbd>{KEY_WORDS[kind].allow}</>}
  </p>;
};
