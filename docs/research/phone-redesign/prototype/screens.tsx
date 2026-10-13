/** Prototype list, sheet and page screens. */
import type { ReactNode } from "react";
import {
  Archive, Bell, BookOpen, Box, CheckCheck, ChevronRight, Clock, Cpu, Ellipsis, Folder, FolderGit2, Gauge, GitBranch, Globe, KeyRound, Link, Lock,
  Moon, RefreshCw, Search, Server, Settings, Shield, Sparkles, SquarePen, Type, FileCode2, FileDiff,
} from "lucide-react";
import { BackButton, Group, IconButton, LargeTitle, Phone, Row, SectionLabel, Sheet, TopBar, cx } from "./kit.js";
import { ConversationBar, ReceiptsHistory, Transcript, Composer } from "./conversation.js";

const SessionRow = ({ title, line, time, dot, env, first = false }: { readonly title: string; readonly line: ReactNode; readonly time: string; readonly dot?: string; readonly env?: string; readonly first?: boolean }) => (
  <div className="flex gap-3 pl-4">
    <span className="flex w-2.5 shrink-0 justify-center pt-[19px]">{dot !== undefined && <span className={cx("size-2.5 rounded-full", dot)} />}</span>
    <div className={cx("min-w-0 flex-1 py-3 pr-4", !first && "border-t border-hairline-strong")}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[16px] font-medium leading-[22px]">{title}</span>
        <span className="shrink-0 text-[13px] leading-[18px] text-ink-faint">{time}</span>
      </div>
      <div className="truncate text-[14px] leading-[20px] text-ink-muted">{line}</div>
      {env !== undefined && <div className="pt-0.5 text-[12px] leading-[16px] text-ink-faint">{env}</div>}
    </div>
  </div>
);

export const Sessions = () => (
  <Phone>
    <TopBar leading={<IconButton icon={Settings} label="Settings" />} title="" trailing={<IconButton icon={SquarePen} label="New session" />} />
    <LargeTitle>Sessions</LargeTitle>
    <div className="px-4 pb-1">
      <div className="flex h-10 items-center gap-2 rounded-xl bg-wash-strong px-3 text-[16px] text-ink-faint"><Search aria-hidden="true" className="size-[18px]" strokeWidth={2} />Search</div>
    </div>
    <SectionLabel>Needs you</SectionLabel>
    <SessionRow first dot="bg-amber" title="Next receipt" time="now" line={<><span className="text-amber">Permission</span> · Run the receipt-checking command</>} env="desk" />
    <SectionLabel>Working</SectionLabel>
    <SessionRow first dot="bg-cyan" title="Find the parser" time="2m" line="Reading src/parser.ts" env="desk" />
    <SectionLabel trailing={<span className="text-[13px] text-ink-faint">2</span>}><span className="inline-flex items-center gap-1.5"><Folder aria-hidden="true" className="size-3.5" />Receipt checks</span></SectionLabel>
    <SessionRow first title="Check a very long receipt title that must truncate cleanly" time="9:12" line="The receipts agree with the summary." env="#review" />
    <SessionRow title="Rounding rule" time="Mon" line="Kept the existing rounding rule." />
    <SectionLabel>desk</SectionLabel>
    <SessionRow first title="Totals summary" time="Sun" line="You: explain the totals" />
    <div className="pt-5"><Group>
      <Row icon={Clock} label="Snoozed" value="1" />
      <Row icon={CheckCheck} label="Settled" value="1" />
      <Row icon={Archive} label="Archive" value="1" />
    </Group></div>
    <p className="px-4 pt-4 text-center text-[13px] leading-[18px] text-ink-faint">Paired with desk · Phone access</p>
  </Phone>
);

const Segmented = ({ options, selected }: { readonly options: readonly string[]; readonly selected: string }) => (
  <div className="flex h-8 rounded-[9px] bg-wash-strong p-0.5">
    {options.map(option => <span key={option} className={cx("grid min-w-[52px] place-items-center rounded-[7px] px-2 text-[13px] font-medium", option === selected ? "bg-float text-ink shadow-[0_1px_3px_color-mix(in_oklch,var(--scrim)_30%,transparent)]" : "text-ink-muted")}>{option}</span>)}
  </div>
);
const Meter = ({ label, value, tone }: { readonly label: string; readonly value: number; readonly tone: string }) => (
  <div className="min-w-0 flex-1">
    <div className="flex justify-between text-[13px] leading-[18px]"><span className="text-ink-muted">{label}</span><span className="font-mono text-[12px] tabular-nums">{value}%</span></div>
    <div className="mt-1.5 h-1 rounded-full bg-wash-strong"><div className={cx("h-1 rounded-full", tone)} style={{ width: `${value}%` }} /></div>
  </div>
);

const ConversationBehind = () => (
  <Phone>
    <ConversationBar status="desk · Opus 5.5" />
    <Transcript><ReceiptsHistory /></Transcript>
    <Composer />
  </Phone>
);

export const RunSettings = () => (
  <div className="relative">
    <ConversationBehind />
    <div className="absolute inset-0">
      <Sheet title="Run settings" height={736}>
        <div className="pb-6 pt-1">
          <Group>
            <Row icon={Cpu} iconTone="bg-beam/15 text-beam-text" label="Model" value="Opus 5.5" />
            <Row icon={Gauge} iconTone="bg-beam/15 text-beam-text" label="Effort" chevron={false} trailing={<Segmented options={["Auto", "Low", "Med", "High"]} selected="High" />} />
            <Row icon={Shield} iconTone="bg-amber/15 text-amber" label="Mode" value="Accept edits" />
            <Row icon={KeyRound} iconTone="bg-mint/15 text-mint" label="Account" value="work@example.test" />
          </Group>
          <SectionLabel>Workspace</SectionLabel>
          <Group>
            <Row icon={Folder} iconTone="bg-cyan/15 text-cyan" label="Folder" value="~/work/receipts" />
            <Row icon={GitBranch} iconTone="bg-cyan/15 text-cyan" label="Branch" value="main" chevron={false} />
            <Row icon={CheckCheck} iconTone="bg-cyan/15 text-cyan" label="After-edit check" value="Off" />
            <Row icon={Globe} iconTone="bg-cyan/15 text-cyan" label="Browser" value="Default" />
            <Row icon={Box} iconTone="bg-cyan/15 text-cyan" label="Containment" value="Off" />
          </Group>
          <SectionLabel trailing={<span className="text-[13px] text-ink-faint">Plan 95</span>}>Usage</SectionLabel>
          <Group footer="Weekly resets Thursday at 09:00.">
            <div className="flex gap-4 px-4 py-3.5">
              <Meter label="Context" value={42} tone="bg-mint" />
              <Meter label="5-hour" value={80} tone="bg-amber" />
              <Meter label="Weekly" value={95} tone="bg-signal" />
            </div>
          </Group>
          <div className="pt-4"><Group><Row label={<span className="text-beam-text">Hand off to another account</span>} chevron={false} /></Group></div>
        </div>
      </Sheet>
    </div>
  </div>
);

export const SettingsRoot = () => (
  <Phone>
    <TopBar leading={<BackButton />} title="" />
    <LargeTitle>Settings</LargeTitle>
    <div className="pt-2"><Group>
      <Row icon={Server} iconTone="bg-environment-teal/20 text-environment-teal" label="desk" detail="Connected · Phone access" value="Switch" />
    </Group></div>
    <SectionLabel>This phone</SectionLabel>
    <Group>
      <Row icon={Moon} iconTone="bg-sage/20 text-sage" label="Appearance" value="Dark" />
      <Row icon={Type} iconTone="bg-sage/20 text-sage" label="Text size" value="Default" />
      <Row icon={Bell} iconTone="bg-signal/15 text-signal" label="Notifications" value="On" />
      <Row icon={Lock} iconTone="bg-amber/15 text-amber" label="Access" value="Limited" />
    </Group>
    <SectionLabel>desk</SectionLabel>
    <Group>
      <Row icon={KeyRound} iconTone="bg-mint/15 text-mint" label="Accounts" value="2" />
      <Row icon={Cpu} iconTone="bg-beam/15 text-beam-text" label="Default model" value="Opus 5.5" />
      <Row icon={Shield} iconTone="bg-amber/15 text-amber" label="Permissions" />
      <Row icon={BookOpen} iconTone="bg-cyan/15 text-cyan" label="Memory banks" />
      <Row icon={Sparkles} iconTone="bg-cyan/15 text-cyan" label="Skills and instructions" />
      <Row icon={Clock} iconTone="bg-cyan/15 text-cyan" label="Routines" />
    </Group>
    <SectionLabel>Connections</SectionLabel>
    <Group>
      <Row icon={Link} iconTone="bg-beam/15 text-beam-text" label="Pair another environment" />
      <Row icon={RefreshCw} iconTone="bg-wash-strong text-ink-muted" label="Reload client" chevron={false} />
    </Group>
  </Phone>
);

export const PlanSheet = () => (
  <div className="relative">
    <ConversationBehind />
    <div className="absolute inset-0">
      <Sheet title="Plan" leading="Close" trailing={null} height={780} footer={
        <div className="shrink-0 px-4 pb-4 pt-3 shadow-[inset_0_1px_0_var(--hairline)]">
          <div className="flex h-11 items-center justify-between text-[15px]"><span className="text-ink-muted">Then run in</span><span className="flex items-center gap-1 font-medium">Accept edits<ChevronRight aria-hidden="true" className="size-4 text-ink-faint" /></span></div>
          <div className="mt-1 flex gap-2">
            <button type="button" className="h-12 flex-1 rounded-xl bg-wash-strong text-[16px] font-semibold">Keep planning</button>
            <button type="button" className="h-12 flex-[1.4] rounded-xl bg-beam text-[16px] font-semibold text-beam-ink">Approve plan</button>
          </div>
        </div>}>
        <div className="h-full overflow-hidden px-5 pt-2">
          <h3 className="text-[20px] font-semibold leading-[26px] tracking-[-0.01em]">Check the receipts</h3>
          <p className="pt-2 text-[15px] leading-[22px] text-ink-muted">14 steps · touches receipts/ and src/totals.ts</p>
          <ol className="list-decimal pl-5 pt-3 text-[16px] leading-[25px] marker:text-ink-faint">
            {Array.from({ length: 14 }, (_, i) => <li key={i} className="pb-2 pl-1">Compare the amount with the summary and explain any difference.</li>)}
          </ol>
        </div>
      </Sheet>
    </div>
  </div>
);

export const FilesPage = () => (
  <Phone>
    <TopBar leading={<BackButton />} title="Workspace" subtitle="~/work/receipts · main" trailing={<IconButton icon={Ellipsis} label="More" />} centred />
    <div className="px-4 pb-2 pt-1">
      <div className="flex h-9 rounded-[10px] bg-wash-strong p-0.5">
        {["Files", "Changes", "Tasks", "Docs"].map(tab => <span key={tab} className={cx("grid flex-1 place-items-center rounded-lg text-[14px] font-medium", tab === "Changes" ? "bg-float text-ink shadow-[0_1px_3px_color-mix(in_oklch,var(--scrim)_30%,transparent)]" : "text-ink-muted")}>{tab}</span>)}
      </div>
    </div>
    <SectionLabel>This session · 1 file</SectionLabel>
    <Group>
      <Row icon={FileDiff} iconTone="bg-cyan/15 text-cyan" label={<span className="font-mono text-[15px]">src/totals.ts</span>} detail={<><span className="text-mint">+1</span> <span className="text-signal">−1</span> · Edit, turn 1</>} />
    </Group>
    <div className="px-4 pt-3">
      <div className="overflow-hidden rounded-xl bg-inset font-mono text-[12px] leading-[20px]">
        <div className="px-3 py-1 text-ink-faint">@@ -1,2 +1,2 @@</div>
        <div className="bg-signal/15 px-3"><span className="text-signal">− </span>const total = 2;</div>
        <div className="bg-mint/15 px-3"><span className="text-mint">+ </span>const total = 3;</div>
        <div className="px-3 pb-1.5 text-ink-muted">  export {"{"} total {"}"};</div>
      </div>
    </div>
    <SectionLabel>Working tree against HEAD · 1 file</SectionLabel>
    <Group>
      <Row icon={FileCode2} iconTone="bg-cyan/15 text-cyan" label={<span className="font-mono text-[15px]">notes.md</span>} detail={<><span className="text-mint">+2</span> <span className="text-signal">−0</span> · new file</>} />
    </Group>
    <div className="flex-1" />
    <div className="px-4 pb-4"><div className="flex items-center gap-2 text-[13px] text-ink-faint"><FolderGit2 aria-hidden="true" className="size-4" />Terminal, Preview and Browser are in the ••• menu</div></div>
  </Phone>
);

export const Pairing = () => (
  <Phone>
    <div className="flex flex-1 flex-col items-center px-8 pt-24 text-center">
      <span className="grid size-16 place-items-center rounded-[18px] bg-beam text-beam-ink"><Link aria-hidden="true" className="size-8" strokeWidth={1.75} /></span>
      <h1 className="pt-6 text-[26px] font-bold leading-[32px] tracking-[-0.02em]">Pair this phone</h1>
      <p className="pt-3 text-[16px] leading-[24px] text-ink-muted">On your computer, open Set up and choose Add a device. Scan its code with the camera, or paste the link here.</p>
    </div>
    <div className="flex flex-col gap-2 px-4 pb-6">
      <button type="button" className="h-12 rounded-xl bg-beam text-[16px] font-semibold text-beam-ink">Paste pairing link</button>
      <button type="button" className="h-12 rounded-xl bg-wash-strong text-[16px] font-semibold">Type address and code</button>
      <p className="pt-2 text-center text-[13px] leading-[18px] text-ink-faint">On a server, run <span className="font-mono">agent-harness pair</span>.</p>
    </div>
  </Phone>
);
