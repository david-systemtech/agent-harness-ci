/** Prototype conversation screens: transcript, composer, docked permission request. */
import type { ReactNode } from "react";
import { ArrowUp, Check, ChevronDown, ChevronRight, Ellipsis, FileText, Plus, Shield, ShieldAlert, Square, Terminal } from "lucide-react";
import { BackButton, IconButton, Phone, TopBar, cx } from "./kit.js";

export const UserBubble = ({ children }: { readonly children: ReactNode }) => (
  <div className="flex justify-end pl-12"><div className="rounded-[20px] rounded-br-md bg-wash-strong px-4 py-2.5 text-[16px] leading-[22px]">{children}</div></div>
);
export const Prose = ({ children }: { readonly children: ReactNode }) => <div className="text-[16px] leading-[25px] [&_li]:pl-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:pt-1">{children}</div>;

/** One line per group of tool calls; tapping opens the calls as a page. */
export const ToolGroup = ({ label, open = false, children }: { readonly label: string; readonly open?: boolean; readonly children?: ReactNode }) => (
  <div>
    <div className="flex h-8 items-center gap-2 text-[14px] leading-[20px] text-ink-muted">
      <span className="grid size-5 place-items-center rounded-md bg-cyan/15 text-cyan"><Terminal aria-hidden="true" className="size-3" strokeWidth={2.2} /></span>
      <span className="min-w-0 truncate">{label}</span>
      {open ? <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-ink-faint" /> : <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />}
    </div>
    {open && <div className="ml-[9px] border-l-2 border-hairline-strong pl-4 pt-1">{children}</div>}
  </div>
);
export const ToolCall = ({ name, target, output }: { readonly name: string; readonly target: string; readonly output?: readonly string[] }) => (
  <div className="pb-2">
    <div className="flex h-7 items-center gap-2 text-[14px] leading-[20px]">
      <span className="font-medium">{name}</span><span className="min-w-0 truncate font-mono text-[13px] text-ink-muted">{target}</span>
      <Check aria-hidden="true" className="ml-auto size-4 shrink-0 text-mint" strokeWidth={2.4} />
    </div>
    {output !== undefined && <div className="whitespace-pre mt-1 overflow-hidden rounded-lg bg-inset px-3 py-2 font-mono text-[12px] leading-[18px] text-ink-muted">{output.join("\n")}</div>}
  </div>
);

export const Transcript = ({ children }: { readonly children: ReactNode }) => (
  <main className="flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-hidden px-4 pb-3">{children}</main>
);

export const ConversationBar = ({ waiting, status }: { readonly waiting?: number; readonly status: ReactNode }) => (
  <TopBar leading={<BackButton {...(waiting !== undefined && { count: waiting })} />} title="Check the receipts" subtitle={status} trailing={<IconButton icon={Ellipsis} label="Session actions" />} />
);

export const ReceiptsHistory = () => <>
  <UserBubble>Check the receipts and keep the original rounding rule.</UserBubble>
  <Prose>I&apos;ll read the receipts first, then compare each total with the summary.</Prose>
  <ToolGroup label="Read 2 files, ran 1 command" />
  <Prose>
    The receipts agree with the <strong className="font-semibold">summary</strong>.
    <ul><li>Read each amount</li><li>Compare the total</li><li>Keep the existing rounding rule</li></ul>
  </Prose>
  <div className="-mt-2 text-[12px] leading-[16px] text-ink-faint">Opus 5.5 · 1.0s</div>
</>;

/** Composer: one rounded surface; the text box above one row of attach, run chips and send. */
export const Composer = ({ text, running = false }: { readonly text?: string; readonly running?: boolean }) => (
  <div className="shrink-0 px-2 pb-2">
    <div className="rounded-[22px] bg-panel px-1.5 pb-1.5 pt-3 shadow-[0_0_0_1px_var(--hairline)]">
      <div className={cx("min-h-6 px-2.5 text-[16px] leading-[22px]", text === undefined && "text-ink-faint")}>{text ?? (running ? "Steer the run" : "Message")}</div>
      <div className="mt-2 flex items-center gap-1">
        <button type="button" aria-label="Attach" className="grid size-9 place-items-center rounded-full text-ink-muted"><Plus aria-hidden="true" className="size-[22px]" strokeWidth={1.75} /></button>
        <button type="button" className="flex h-8 min-w-0 items-center gap-1 rounded-full px-2.5 text-[14px] font-medium text-ink-muted">
          <span className="truncate">Opus 5.5 · High</span><ChevronDown aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2.2} />
        </button>
        <button type="button" className="flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[14px] font-medium text-ink-muted">
          <Shield aria-hidden="true" className="size-3.5" strokeWidth={2.2} />Edits
        </button>
        <span className="flex-1" />
        {running
          ? <button type="button" aria-label="Stop" className="grid size-9 place-items-center rounded-full bg-ink text-abyss"><Square aria-hidden="true" className="size-3.5 fill-current" /></button>
          : <button type="button" aria-label="Send" className={cx("grid size-9 place-items-center rounded-full", text === undefined ? "bg-wash-strong text-ink-faint" : "bg-beam text-beam-ink")}><ArrowUp aria-hidden="true" className="size-5" strokeWidth={2.4} /></button>}
      </div>
    </div>
  </div>
);

/** A pending permission request takes the composer's place; nothing else stacks above it. */
export const PermissionDock = () => (
  <div className="shrink-0 px-2 pb-2">
    <div className="rounded-[22px] bg-panel p-4 shadow-[0_0_0_1px_var(--hairline)]">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-amber/15 text-amber"><ShieldAlert aria-hidden="true" className="size-[18px]" strokeWidth={2} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold leading-[22px]">Run a command?</div>
          <div className="text-[14px] leading-[20px] text-ink-muted">Run the receipt-checking command</div>
        </div>
        <button type="button" className="h-8 shrink-0 rounded-full px-1 text-[15px] font-medium text-beam-text">Details</button>
      </div>
      <div className="whitespace-pre mt-3 overflow-hidden rounded-lg bg-inset px-3 py-2.5 font-mono text-[13px] leading-[20px]"><span className="text-ink-faint">$ </span>printf receipts</div>
      <div className="mt-3 flex gap-2">
        <button type="button" className="h-11 flex-1 rounded-xl bg-wash-strong text-[16px] font-semibold">Deny</button>
        <button type="button" className="h-11 flex-1 rounded-xl bg-beam text-[16px] font-semibold text-beam-ink">Allow once</button>
      </div>
      <button type="button" className="mt-1 h-11 w-full text-[15px] font-medium text-beam-text">Allow Bash for this session</button>
    </div>
  </div>
);

export const WaitingPill = () => (
  <div className="flex justify-center pb-1">
    <div className="flex h-9 items-center gap-2 rounded-full bg-panel pl-3 pr-1.5 text-[14px] shadow-[0_0_0_1px_var(--hairline),0_4px_12px_color-mix(in_oklch,var(--scrim)_25%,transparent)]">
      <span className="size-2 rounded-full bg-amber" /><span>Next receipt needs you</span>
      <span className="rounded-full bg-wash-strong px-2.5 py-1 text-[13px] font-semibold">Open</span>
    </div>
  </div>
);

export const ConversationPermission = () => (
  <Phone>
    <ConversationBar waiting={1} status={<><span className="text-amber">Waiting for you</span> · desk</>} />
    <Transcript>
      <ReceiptsHistory />
      <UserBubble>Now run the checker so we have the output.</UserBubble>
      <Prose>Running the receipt checker against the summary file.</Prose>
    </Transcript>
    <PermissionDock />
  </Phone>
);

export const ConversationIdle = () => (
  <Phone>
    <ConversationBar waiting={1} status="desk · Opus 5.5" />
    <WaitingPill />
    <Transcript>
      <ReceiptsHistory />
    </Transcript>
    <Composer />
  </Phone>
);

export const ConversationWorking = () => (
  <Phone>
    <ConversationBar status={<><span className="text-cyan">Working · 1m 02s</span> · desk</>} />
    <Transcript>
      <UserBubble>Check the receipts and keep the original rounding rule.</UserBubble>
      <Prose>I&apos;ll read the receipts first, then compare each total with the summary.</Prose>
      <ToolGroup label="Read 2 files, ran 1 command" open>
        <ToolCall name="Read" target="receipts/march.csv" />
        <ToolCall name="Read" target="receipts/summary.md" />
        <ToolCall name="Bash" target="printf receipts" output={["All receipt totals match.", "All receipt totals match.", "All receipt totals match.", "… 37 more lines"]} />
      </ToolGroup>
      <Prose>The totals agree. Checking the rounding rule next.</Prose>
      <div className="flex items-center gap-2 text-[14px] text-ink-muted"><FileText aria-hidden="true" className="size-4 text-cyan" />Reading src/totals.ts</div>
    </Transcript>
    <Composer running />
  </Phone>
);

export const ConversationKeyboard = () => (
  <Phone height={480}>
    <ConversationBar waiting={1} status="desk · Opus 5.5" />
    <Transcript>
      <ReceiptsHistory />
    </Transcript>
    <Composer text="Explain the receipt totals in the summary." />
  </Phone>
);
