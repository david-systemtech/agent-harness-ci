/**
 * Phone redesign prototype kit (research only, docs/research/phone-redesign-audit.md).
 * Static mockups drawn with the theme's tokens and fonts; no runtime, no behaviour.
 * Type, spacing and radii follow the proposal's phone scale (§3 of the audit):
 *   title-lg 28/34 700, headline 17/22 600, body 16/24, callout 15/20, subhead 14/20,
 *   footnote 13/18, caption 12/16 500; spacing 4/8/12/16/20/24/32; radii 8/12/16/20/full.
 */
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";

export const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

/** A 390-wide phone canvas with zero insets, as the current gallery captures use. */
export const Phone = ({ children, height = 844 }: { readonly children: ReactNode; readonly height?: number }) => (
  <div data-proto-phone className="relative flex w-[390px] flex-col overflow-hidden bg-abyss font-sans text-ink antialiased" style={{ height, WebkitFontSmoothing: "antialiased" }}>{children}</div>
);

/** 44px hit area; the visible circle is 36px and only appears when pressed (shown here at rest). */
export const IconButton = ({ icon: Icon, label, badge, tone = "plain" }: { readonly icon: LucideIcon; readonly label: string; readonly badge?: string; readonly tone?: "plain" | "filled" }) => (
  <button type="button" aria-label={label} className="relative grid size-11 shrink-0 place-items-center rounded-full">
    <span className={cx("grid size-9 place-items-center rounded-full", tone === "filled" && "bg-panel")}><Icon aria-hidden="true" className="size-[22px]" strokeWidth={1.75} /></span>
    {badge !== undefined && <span className="absolute right-0.5 top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-amber px-1 text-[11px] font-semibold leading-none text-amber-ink">{badge}</span>}
  </button>
);

/** Back affordance: chevron plus a count of other sessions that need you. */
export const BackButton = ({ count }: { readonly count?: number }) => (
  <button type="button" aria-label="Sessions" className="flex h-11 shrink-0 items-center gap-0.5 pl-1 pr-2">
    <ChevronLeft aria-hidden="true" className="size-7 text-beam-text" strokeWidth={2} />
    {count !== undefined && <span className="grid h-[22px] min-w-[22px] place-items-center rounded-full bg-amber px-1.5 text-[13px] font-semibold text-amber-ink">{count}</span>}
  </button>
);

/** 52px bar: leading control, a two-line title block, trailing controls. No border; tone separates on scroll. */
export const TopBar = ({ leading, title, subtitle, trailing, centred = false }: { readonly leading?: ReactNode; readonly title: ReactNode; readonly subtitle?: ReactNode; readonly trailing?: ReactNode; readonly centred?: boolean }) => (
  <header className="flex h-[52px] shrink-0 items-center gap-1 px-1">
    <div className={cx("flex shrink-0 items-center", centred && "w-[88px]")}>{leading}</div>
    <div className={cx("min-w-0 flex-1", centred ? "text-center" : "pl-1")}>
      <div className="truncate text-[17px] font-semibold leading-[22px] tracking-[-0.01em]">{title}</div>
      {subtitle !== undefined && <div className="truncate text-[12px] leading-[16px] text-ink-muted">{subtitle}</div>}
    </div>
    <div className={cx("flex shrink-0 items-center justify-end", centred && "w-[88px]")}>{trailing}</div>
  </header>
);

export const LargeTitle = ({ children, trailing }: { readonly children: ReactNode; readonly trailing?: ReactNode }) => (
  <div className="flex items-end justify-between px-4 pb-2 pt-1"><h1 className="text-[30px] font-bold leading-[36px] tracking-[-0.02em]">{children}</h1>{trailing}</div>
);

export const SectionLabel = ({ children, trailing }: { readonly children: ReactNode; readonly trailing?: ReactNode }) => (
  <div className="flex items-center justify-between px-4 pb-1.5 pt-5"><span className="text-[13px] font-medium leading-[18px] text-ink-faint">{children}</span>{trailing}</div>
);

/** Grouped inset list: one panel surface, radius 12, separators inset past the icon column. */
export const Group = ({ children, footer }: { readonly children: ReactNode; readonly footer?: ReactNode }) => (
  <div className="px-4">
    <div className="overflow-hidden rounded-xl bg-panel [&>*+*]:shadow-[inset_0_1px_0_var(--hairline)]">{children}</div>
    {footer !== undefined && <p className="px-4 pt-1.5 text-[13px] leading-[18px] text-ink-faint">{footer}</p>}
  </div>
);

export const Row = ({ icon: Icon, iconTone = "bg-wash-strong text-ink", label, detail, value, chevron = true, trailing, danger = false }: {
  readonly icon?: LucideIcon; readonly iconTone?: string; readonly label: ReactNode; readonly detail?: ReactNode; readonly value?: ReactNode;
  readonly chevron?: boolean; readonly trailing?: ReactNode; readonly danger?: boolean;
}) => (
  <div className="flex min-h-12 items-center gap-3 py-2.5 pl-4 pr-3">
    {Icon !== undefined && <span className={cx("grid size-7 shrink-0 place-items-center rounded-lg", iconTone)}><Icon aria-hidden="true" className="size-[17px]" strokeWidth={1.9} /></span>}
    <div className="min-w-0 flex-1">
      <div className={cx("truncate text-[16px] leading-[22px]", danger && "text-signal")}>{label}</div>
      {detail !== undefined && <div className="truncate text-[13px] leading-[18px] text-ink-muted">{detail}</div>}
    </div>
    {value !== undefined && <span className="max-w-[45%] shrink-0 truncate text-[15px] leading-[20px] text-ink-muted">{value}</span>}
    {trailing}
    {chevron && <ChevronRight aria-hidden="true" className="size-[18px] shrink-0 text-ink-faint" strokeWidth={2} />}
  </div>
);

export const Toggle = ({ on }: { readonly on: boolean }) => (
  <span className={cx("relative inline-flex h-[30px] w-[50px] shrink-0 rounded-full p-0.5 transition-colors", on ? "bg-beam" : "bg-wash-strong")}>
    <span className={cx("size-[26px] rounded-full bg-beam-ink shadow-[0_2px_4px_var(--scrim)]", on && "translate-x-5")} />
  </span>
);

/** Bottom sheet: scrim over the page, grabber, 17px title, Done, 20px top radius, float fill, no border. */
export const Sheet = ({ title, children, footer, height, trailing = "Done", leading }: { readonly title: ReactNode; readonly children: ReactNode; readonly footer?: ReactNode; readonly height: number; readonly trailing?: ReactNode; readonly leading?: ReactNode }) => (
  <>
    <div className="absolute inset-0 bg-scrim/45" />
    <section className="absolute inset-x-0 bottom-0 flex flex-col rounded-t-[20px] bg-float shadow-[0_-8px_32px_color-mix(in_oklch,var(--scrim)_35%,transparent)]" style={{ height }}>
      <div className="flex justify-center pt-2"><span className="h-[5px] w-9 rounded-full bg-line" /></div>
      <div className="flex h-11 shrink-0 items-center px-4">
        <div className="w-16 text-[16px] text-beam-text">{leading}</div>
        <h2 className="min-w-0 flex-1 truncate text-center text-[17px] font-semibold leading-[22px]">{title}</h2>
        <div className="w-16 text-right text-[16px] font-semibold text-beam-text">{trailing}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      {footer}
    </section>
  </>
);

export const PrimaryButton = ({ children, wide = false }: { readonly children: ReactNode; readonly wide?: boolean }) => (
  <button type="button" className={cx("h-12 rounded-xl bg-beam px-5 text-[16px] font-semibold text-beam-ink", wide && "flex-1")}>{children}</button>
);
export const SecondaryButton = ({ children, wide = false }: { readonly children: ReactNode; readonly wide?: boolean }) => (
  <button type="button" className={cx("h-12 rounded-xl bg-wash-strong px-5 text-[16px] font-semibold text-ink", wide && "flex-1")}>{children}</button>
);

/** Background content dimmed behind a sheet keeps its real shape rather than a blur. */
export const Dimmed = ({ children }: { readonly children: ReactNode }) => <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
