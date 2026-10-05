# The window's look

This is the appearance contract for the GUI and desktop shell. Values come from
**the reference measurements** and the owner decisions of 2026-10-03 in #1332,
#1333 and #1334. Rebuild from these values; no source is copied. [gui.md](gui.md)
owns commands, projections, capability reasons and session behaviour; this document
owns their drawing. Where the same concept is modelled, match these dimensions,
states and behaviour. Environments, accounts, pairing, Set up, queue and steer,
fork and rewind, and the per-session side column retain their decided semantics.
Clearly better improvements are allowed, including the picker in §10.6.

Section numbers are stable: surface tickets #1343–#1375 cite §9–§15 and the
foundations in §1–§8. Unless marked **fixed**, dimensions below are CSS pixels at
text size 14 and root size 16px, represented as rem lengths and scaled by §3.
One-pixel strokes, the 7px frame gaps, breakpoint thresholds and explicitly fixed
measurements stay in pixels. Viewport-bound formulas retain the units written
in the formula, including fixed pixel caps and rem-based viewport margins.
Horizontal/vertical pairs mean x/y, not top/right.
Examples and gallery data use neutral invented names and values.

## 1. Surfaces

The window ground and gaps between cards use `abyss`. The header also uses
`abyss`. Sidebar, session cards, dock and Settings chrome all use `panel`.
`raised` marks hover or pressed controls. `inset` holds code, output and troughs.
`float` is reserved for overlays. A surface's proximity does not change its fill.
Normal-flow cards have a hairline boundary and no elevation shadow. Overlays
may combine a lifted fill, boundary and shadow as specified in §4.

Person-operated controls and cards have rounded corners. Machine output is
square: diffs, raw output, quoted commands and redacted reasoning have radius 0.
A code fence in prose retains §8's rounded code-well treatment. All backgrounds,
text, borders, icons, shadows and selection colours use theme tokens. Native
preview content uses the isolated preview surface's existing colour exception.

## 2. Colour roles

The theme package derives both ladders from seven seeds. Keep that derivation;
these are the shipped default readings in OKLCH, not literal colours to paste
into GUI components. User themes keep the same roles and contrast rules.

| Token | Dark default | Light default | Role |
| --- | --- | --- | --- |
| abyss | 15.5% 0 0 | 96.5% 0 0 | Window ground |
| panel | 19.5% 0 0 | 100% 0 0 | Chrome |
| raised | 22.5% 0 0 | 94% 0 0 | Hover and press |
| float | 25% 0 0 | 100% 0 0 | Overlay |
| inset | 17% 0 0 | 95.5% 0 0 | Wells |
| line | 33.5% 0 0 | 89% 0 0 | Load-bearing rule |
| line-strong | 56.5% 0 0 | 64% 0 0 | Component edge and scrollbar thumb, at least 3:1 on panel |
| ink | 96% 0 0 | 22% 0 0 | Main text |
| ink-muted | 77% 0 0 | 43% 0 0 | Supporting text |
| ink-faint | 62% 0 0 | 52% 0 0 | Quiet chrome and metadata |
| beam | 52% 0.21 264 | 48% 0.19 264 | Primary action fill, focus and accent boundary |
| beam-dim | 44% 0.178 264 | 40% 0.161 264 | Primary fill hover/press |
| beam-ink | 97% 0.014 264 | 98% 0.005 264 | Text on primary fill |
| beam-text | 61.5% 0.14 264 | 48% 0.19 264 | Links, accent labels, syntax keywords and caret |
| cyan | 80% 0.1 210 | 48% 0.08 210 | Tools and machine activity |
| sage | 64% 0.035 310 | 50% 0.03 310 | Reasoning |
| mint | 84% 0.17 150 | 50% 0.13 150 | Success |
| amber | 85% 0.155 85 | 50% 0.098 85 | Warning and waiting |
| amber-ink | 18% 0.035 85 | 98% 0.005 85 | Text on amber fill |
| signal | 70% 0.18 25 | 52% 0.19 25 | Error and denial |
| signal-ink | 16% 0.03 25 | 98% 0.005 25 | Text on signal fill |
| scrim | 0% with Canvas hue/chroma | 0% with Canvas hue/chroma | Overlay and shadow tint |

`hairline` and `hairline-strong` are 7% and 12% ink mixed with transparent in
sRGB. `wash` and `wash-strong` are 3.5% and 8% ink; `wash-user` is 24% beam.
These washes work over the underlying surface in either ladder. Decorative
seams use hairline; controls requiring contrast, including unchecked radios,
use line-strong. A hover/selected menu surface is wash-strong in both ladders.

The semantic aliases are background→abyss, foreground→ink, card→panel,
card-foreground→ink, popover→float, popover-foreground→ink, primary→beam,
primary-foreground→beam-ink, secondary and muted→raised,
secondary-foreground and accent-foreground→ink, muted-foreground→ink-muted,
accent→wash-strong, destructive→signal, destructive-foreground→signal-ink,
border→hairline, input→hairline-strong and ring→beam. Chart slots 1–5 are cyan,
beam, mint, sage, signal. Sidebar aliases are panel/ink, primary beam/beam-ink,
hover raised/ink, border line, ring beam; the actual sidebar card uses hairline.
Each colour used through utilities must have a mapped token, including scrim.

Selection is 35% beam mixed in OKLCH with transparent, with ink text. Find hits
are 30% amber with ink text. Jumping to a transcript row flashes 22% beam mixed
in OKLab to transparent over 1400ms. Overlays use scrim/10; tinted tooltip and
floating-control shadows use scrim/40. Never substitute a light wash for scrim.
Warnings and errors name their state as well as colouring it.

## 3. Type

Bundle upright and italic Archivo Variable for text and JetBrains Mono Variable
for machine text, using the 5.3.x font packages (both OFL). Archivo supports
weights 100–900; JetBrains Mono 100–800. Serve emitted WOFF2 files from the app
origin, with the desktop scheme's font MIME type and CSP font permission. No
remote font request is needed. Sans fallback is UI sans/system; mono fallback
is UI monospace. Controls inherit font and colour. Chrome labels are sans.

| Step | Font size | Line height | Rem size / height |
| --- | --- | --- | --- |
| 2xs | 11px | 16px | 0.6875 / 1 |
| xs | 12px | 18px | 0.75 / 1.125 |
| sm | 13px | 20px | 0.8125 / 1.25 |
| base | 14px | 23px | 0.875 / 1.4375 |
| lg | 16px | 24px | 1 / 1.5 |
| xl | 20px | 28px | 1.25 / 1.75 |

Use weights 400 for body, 500 for labels and controls, 600 for headings; syntax
strong is 700. Chrome labels are 11/16, 500, tracking +0.01em. Titles track
−0.025em. Tight/snug/normal/relaxed leading ratios are 1.25/1.375/1.5/1.625;
Markdown 1.6, headings 1.3, diffs 1.45, terminal 1.3. Code, paths, file contents,
shell fragments, raw output, counts and durations use mono; numeric readouts
use tabular numerals. Do not introduce an undefined type step below 2xs;
meter digits and explicit tiny badges have the fixed sizes stated below.

The client text-size preference is an integer 11–20, preset 14; round and clamp
finite values, reset nonfinite values to 14. Set root size to 16px × size/14.
Thus sm is 13px at preset and about 18.57px at size 20. Rem spacing, radii,
control heights and type scale with it. Fixed 1px seams, 7px body/grid gaps,
10px scrollbars, 12px terminal type, 54/24px virtual-list slots, 17px tone badges,
22px chips, 30px dock headers and switch track dimensions do not scale.
Text enlargement must not clip labels, controls, footers or dialog content:
allow scrolling and whole-chip wrapping, and truncate titles with full text in
an accessible tooltip. The header never wraps labels into multiple lines.

Resolve system/light/dark before first paint; system follows OS changes.
Set the root's resolved ladder and colour-scheme together so portals, forms
and terminal themes agree. Root ladder state supplies dark and component-state
styling; dependencies must not create a second theme or duplicate overlay context.

## 4. Shape and depth

| Radius | sm | md | lg/base | xl | 2xl | 3xl | 4xl |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Default px | 4.8 | 6.4 | 8 | 11.2 | 14.4 | 17.6 | 20.8 |
| Base multiplier | 0.6 | 0.8 | 1 | 1.4 | 1.8 | 2.2 | 2.6 |

Base radius is 0.5rem. Ordinary controls/cards use lg; compact buttons md;
dialogs and generic bubbles xl; checkbox fixed 4px; pills full. Composer has a
fixed 10px radius. Machine output is square. Session user rows override the
generic bubble to lg. Controls use a transparent 1px border when no visible
border is needed, so focus and invalid states do not change their dimensions.

Menus, popovers and select lists use float, 1px ink/10 ring and medium shadow;
submenus use large shadow. Tooltips use hairline-strong and large scrim/40
shadow. Dialogs use float, xl and ink/10 ring, with no content shadow; their
full-window overlay is scrim/10 with 4px backdrop blur where supported.
Floating dock sheets use extra-large shadow.

Shadow geometry, expressed as x/y/blur/spread at preset: medium has
0/4/6/−1 plus 0/2/4/−2 at scrim/10; large has 0/10/15/−3 plus 0/4/6/−4
at scrim/10 (or scrim/40 where specified); extra-large has 0/25/50/−12 at
scrim/25. Overlays occupy layer 50; pane-local find layer 20; dock sheets and
drop targets layer 30. Tooltips and menus opened inside a modal remain above it.

Plain focus-visible is 2px solid beam, offset 1px, radius sm. Controls replace
that outline with beam border and 3px beam/50 ring; an editor puts it on the
frame. Invalid controls use signal border and signal/20 ring, signal/40 in
dark. Disabled controls are 50% opaque, refuse activation and expose their
capability reason through a focusable wrapper when native disabling removes
focus. Hover never activates or changes selection.

Scrollbars have fixed width/height 10px, transparent track, rounded thumb with
3px transparent border. Default thumb line, hover line-strong; thin native
scrollbars use line-strong. Required component contrast uses line-strong.
Scroll areas inherit corner radius and use a 3px beam/50 focus ring when focused.

## 5. Spacing and density

The spacing unit is 0.25rem, 4px at preset. Dense chrome uses 4/6/8px gaps,
body groups 12/16px. These recipes are the default primitives; surfaces below
state their exceptions. Preserve existing exports and the Button tone aliases:
primary→default, quiet→ghost, danger→destructive, warning→ghost with amber text.
Merge classes without dropping 2xs when a colour class is added.

| Structure | Height, padding and gap at preset |
| --- | --- |
| Header | 44; x 8; gap 4 |
| Body and grid | Fixed inset 7 and gap 7 |
| Caption | 32; x 10; gap 6 |
| Status | Minimum 28; x 12; gap x 8/y 4 |
| Sidebar session | Fixed slot 54; outer x 8/y 2; inner x 8/y 6; gap 2 |
| Sidebar heading | Fixed 24; x 6 |
| Dock header | Fixed 30; gap 8; x 12 for text or x 6 for controls |
| File row | x 8/y 4; gap 8; list inset 6 |
| Card | Padding/gap 16, compact 12; header internal gap 4 |
| Item | Default/sm x 12/y 10/gap 10; xs x 10/y 8/gap 8 |
| Tool header and raw output | x 10/y 8; header gap 8; output max 288 |
| Dialog | Padding/gap 16; default width 384 |
| Popover | Width 288; padding/gap 10 |
| Menu | Padding 4; item x 6/y 4/gap 6 |
| Tooltip | x 10/y 6; max 18rem; gap 6 |
| Bubble | x 12/y 8; wrapper gap 4 |
| Markdown editor | Minimum 128; x 12/y 10; toolbar x 6/y 4/gap 2 |

### 5.1 Buttons, badges and keycaps

All buttons have a single-line 500-weight label, no text selection, inherited
colour icon and shared focus/disabled/invalid states. Press moves a non-popup
button down 1px. Default size is 32 high, x 10, gap 6, type sm, 16px icon; lg is
36 with the same padding/gap. Sm is 28 high, x 10, gap 4, type 12.8px, 14px icon;
xs is 24 high, x 8, gap 4, type xs, 12px icon. Sm/xs radius is md capped at
12/10px respectively; grouped buttons keep the lg outer radius. Icon-only
sizes are square 24/28/32/36, in the same order. Leading/trailing icons reduce
their adjacent padding to 8px at default/lg or 6px at sm/xs.

| Variant | Rest | Hover / open |
| --- | --- | --- |
| Default | beam fill, beam-ink | beam-dim; primary primitive hover uses beam/80; app primary actions use beam-dim |
| Outline | hairline edge, abyss; dark hairline-strong and input/30 | raised; dark input/50; open keeps raised |
| Secondary | raised, ink | raised mixed with 5% ink; open raised |
| Ghost | Transparent, ink-muted | raised, ink; dark raised/50; open raised |
| Destructive | signal/10, signal; dark signal/20 | signal/20; dark signal/30; focus signal ring |
| Link | beam-text, no fill | Underline, offset 4px |

IconButton defaults to 28px with a 16px icon; compact is 24/12. ReasonButton
and WithReason keep disabled actions discoverable, naming why they cannot act.
Every control has an accessible name and tooltip with its effective keys.
ButtonGroup joins horizontal or vertical children, removes inner rounded corners
and duplicate borders; separators are 1px input, gaps between nested groups 8.

Badge is 20 high, x 8/y 2, gap 4, xs/500, pill corners, 12px icon; icon-side
padding 6. Its six tones follow the button table, without button press motion.
ToneBadge is fixed 17 high, mono 11px, semantic colour at 40% border and 10% fill,
compact padding and rounded corners. StatusDot is 6px and carries a text label;
running cyan pulses, waiting amber does not. Keycaps are 20 high/min 20 wide,
x 4, gap 4, sm radius, hairline/inset, sans 11px/500/faint; groups gap 4. The
welcome legend uses mono keycaps min 32 wide instead.

### 5.2 Fields and choices

Input is 32 high, x 10/y 4, lg, hairline-strong edge, transparent in light and
input/30 in dark; type base below 768px, sm above. Placeholder ink-muted.
Disabled adds input/50 (dark input/80) and 50% opacity. Textarea shares this
appearance with min 64, x 10/y 8, content sizing. Labels are sm/500, gap 8;
disabled labels follow their control. Each label is programmatically associated.

Select trigger is 32 high (sm 28/md radius), x 10 left/x 8 right, gap 6, sm type,
16px ChevronDown; truncate only the value. Draw native selects to this trigger
recipe while retaining native semantics; the menu version uses §11's select
list. InputGroup is a 32-high lg frame with the input's focus/invalid ring on
the group, no inner input border or ring. Inline add-ons use x 10/gap 8, faint
text; inline buttons 24 or 32; block add-ons x 10/y 8 and content may grow. Group
textarea has y 8 and no resizing; input next to an add-on uses 6px inner padding.

Checkbox and radio are 16px squares; checkbox fixed 4 radius with a 14px Check,
radio full round with an 8px beam-ink dot. Checked uses beam fill/border and
beam-ink. Unchecked radio border line-strong; checkbox input border with dark
input/30 fill. Invisible pointer target extends x 12/y 8, without overlapping
another action. Arrows select within a radio group; Space checks/toggles.
Switch tracks are fixed 32×18.4 or compact 24×14, full round; thumb 16 or 12,
unchecked at the start, checked moves its width minus 2px. Track checked beam,
unchecked input (dark input/80); light thumb abyss, dark checked beam-ink and
unchecked ink. State changes take 150ms.

Toggle has transparent or input-outline variant; pressed uses raised, default
32/min-width 32, sm 28/md/12.8px and lg 36, x 10, gap 4. Slider track 4, input,
beam range and 14px round thumb with beam edge/abyss fill; hover beam/30 ring,
focus beam/50. Vertical track min 176. Default range 0–100; explicit forms own
range/step and commit behavior. Progress is a 4px full-round raised track and
beam fill, clipped to the track and exposing its value.

Field stacks gap 8; FieldGroup gap 20, nested groups 16, checkbox/radio groups 12;
fieldset gap 16 (12 for choices). Legend base/500 with bottom 6, label variant
sm. FieldContent gap 2/snug. Horizontal fields align label/control; responsive
fields stack until their container is at least 448px. Description sm/normal,
muted; error signal/sm, multiple errors as a list with gap 4 and indent 16.
Settings overrides label/description type in §12.

### 5.3 Layout and feedback parts

Card is panel/ink, lg/hairline, column with 16px padding/gaps (compact 12).
Title base/500/snug (compact sm); description sm/muted. Header places action
top-right and description below title. Footer spans the width, raised/50 with
hairline top edge and card padding; omit duplicate bottom padding. Item is a
wrapping row with §5's sizes, transparent edge by default, hairline for outline,
raised/50 for muted. Content gap 4 (xs 0), action gap 8; title sm/500/snug, one
line; description sm/muted, two lines by default, xs uses xs. Settings allows
full descriptions. Item groups gap 16/10/8 by size, or gap 0 with dividing hairlines.
Image media 40/32/24, sm radius; icon media 16/16/14.

Alert is lg/hairline, panel, x 10/y 8, sm, gap 2; a 16px icon spans title and
message, horizontal gap 8. Title 500; message muted, destructive signal/90.
Reserve 72px right padding when an action is placed top 8/right 8. Empty is a
centred column, padding 24/gap 16, xl/dashed boundary, header max 384/gap 8,
sm/500/tight title and sm/relaxed muted sentence, content max 384/gap 10;
icon well 32/lg/raised with 16px icon and bottom 8. §14 overrides for welcome.

Separator is 1px hairline horizontal or vertical and decorative by default.
Skeleton is md/raised with 2s pulse and caller-sized geometry. Spinner is
16px LoaderCircle,1s spin, status name “Loading”. Fold uses a labelled button,
100ms chevron rotation, retained openness by stable identity; collapsed content
is unmounted and expanding reveals it in place. Fact is a label/value row,
label chrome-label/faint, value mono/ink, gap 12/y 3, values wrap anywhere;
copy controls use §8. Tabs have default raised/lg track 32 with fixed 3px inset
or transparent line variant/gap 4; triggers x 6/y 2/gap 6, sm/500/md, inactive
muted, active ink on abyss (dark input/30 with input edge). Line tabs mark
active with a 2px ink rule, bottom offset 5px (vertical right 4px). Arrow/Home/End
navigation and disabled/focus state remain available. Resizable panels use
accessible separators; generic seam 1px with a 4px hit area; window seams use 7px.
No avatar surface is required by the window's component map.

## 6. Motion

| Element | Timing and change |
| --- | --- |
| Streaming words | 150ms ease-out, opacity 0→1 and blur 1.5px→0; stagger 14ms capped 90ms per batch |
| Streaming pacing | About 115ms drain budget/frame 16.7ms; backlog over 220 words appears immediately; release a fragment over 64 characters |
| Caret | beam-text block 0.5em×1em; 1.1s steps, visible first 49%, hidden from 50% |
| Speech row entry | 160ms ease-out, opacity 0→1 and rise 3px→0 |
| Activity shuttle | 1.9s; enters to full at 46%, holds through 56%, exits by 100%; entry cubic-bezier(0.3,0,0.15,1), exit(0.55,0,0.2,1) |
| Overlays | 100ms fade and 95%→100% scale; directional travel 8px for menus/popovers,4px for tooltips |
| Controls | 150ms cubic-bezier(0.4,0,0.2,1), colour/opacity/transform |
| Fold chevron | 100ms |
| Activity seam | Height change 200ms |
| Usage meter arc | Stroke share change 300ms |
| Spinner | 1s linear, continuous |
| Pulse/skeleton | 2s cubic-bezier(0.4,0,0.6,1), opacity 1→0.5→1 |
| Jump flash | 1400ms ease-out, §2 colour to transparent |
| Copied tick | Holds 1500ms then returns to Copy |

Adopt already-present streaming text without replaying its entrance. Disable
word pacing/fade when the preference is off, reduced motion is requested, or
find needs the complete text. Reduced motion stops caret, speech entry and
word reveal and holds the shuttle at 75% width. As an accessibility improvement,
remove overlay travel/zoom and row flash under reduced motion; loading still
has a labelled static indicator. Gallery capture freezes all animations/carets.
Fold controls and card state changes must not move focus unexpectedly.

## 7. Icons

Use Lucide (1.30.x), stroke 2 on a 24-unit grid, no fill, currentColor, round
caps/joins. Default controls 16px, small 14, compact 12, sidebar chrome 10.
Decorative icons are hidden from accessibility; icon actions have a name and
tooltip with effective keys or disabled reason. No text glyph substitutes for
an icon. Key labels are still text in keycaps. Never carry a product or provider
mark; the working-name tile uses a neutral `SquareTerminal` glyph.

| Concept | Icon |
| --- | --- |
| Sidebar show/hide | PanelLeft / PanelLeftClose |
| Breadcrumb, disclosure | ChevronRight / ChevronDown |
| Search; refresh; copy done | Search; RefreshCw; Copy / Check |
| Update; More; Settings | ArrowDown / LoaderCircle; EllipsisVertical; Settings 2 |
| System/light/dark | Monitor / Sun / Moon |
| Minimize/maximize/restore/close | Minus / Square / Copy / X |
| Terminal/browser/files/documents/tasks/agent/file view | SquareTerminal / Globe / Folder / Files / Users / Bot / FileCode |
| Frame/Markdown preview; Diff | SquareArrowOutUpRight / FileText; FileDiff |
| Split right/down; new | SquareSplitHorizontal / SquareSplitVertical; Plus |
| Pin/group/archive/new group/branch/empty | Pin / Layers / Archive / FolderPlus / GitBranch / Inbox |
| Reasoning/fork/rewind/queued/read now | Brain / GitFork / Undo 2 / Hourglass / CircleStop |
| Attach/send/stop/hand-off | Paperclip / SendHorizontal / CircleStop / Hand |
| Tool command/edit/read/search/web/agent/plan/connection/other | Terminal / FilePenLine / FileText / Search / Globe / Bot / ListChecks / Plug / Wrench |
| Permission/plan/question | ShieldAlert / ClipboardList / MessageCircleQuestionMark |
| Account/model/fast/mode/usage | KeyRound / Cpu / Zap / Shield / Gauge |
| Info/warning/error | Info / TriangleAlert / CircleAlert |
| Routine/settled/snoozed/tags | CalendarClock / CircleCheck / Clock / Tags |
| Delete/restore | Trash 2 / ArchiveRestore |

Settings icons follow §12's row table. Redraw environment drawings on the same
24-unit stroke 2 grid: laptop (screen/base), desktop (screen/stand), server (two
racks), nas (stacked disks), cloud (cloud outline), container (cube), board
(chip/pins), home (house), office (building/windows), lab (flask). Display 14px
in badges,16px in picker rows. Unknown/missing icon uses a 6px dot; colour comes
from its environment token, with a textual name, never a literal SVG colour.

## 8. Markdown, code and terminal

### 8.1 Prose and copy

Markdown is sans sm (13px at preset),1.6 leading, wraps anywhere. Direct
siblings are 0.7em apart. h1/h2/h3–4 are 1.15/1.08/1em,600 weight,1.3 leading,
ink; quiet reasoning headings inherit muted text. Links beam-text, underline
offset 2px. Lists indent 1.35em with disc/decimal markers; later items top 0.25em.
Inline code mono 0.94em, inset,1px line, sm radius, x 0.32em/y 0.05em. Fences
inset/line/md, x 0.85em/y 0.7em, horizontally scroll; inner code has no second
fill/border/padding. Blockquote has 2px line-strong left edge, left 0.8em, muted.
Tables scroll horizontally, collapsed 1px line borders, cell x 0.55em/y 0.25em,
left alignment, raised header. Rules are 1px line with no other border.

Keep react-markdown/GFM and the GUI's current highlighting: use the named
fence language, never guess. Raw HTML remains text; external images remain
links, never fetched automatically. Reachable inline paths can open the file
pane; pull-request links retain their forge lookup and accessible rich tooltip.
Syntax colouring uses meanings, not a dump of highlighter classes:

| Syntax meaning | Token / style |
| --- | --- |
| Comments and quotes | ink-faint, italic |
| Keywords, selectors naming tags, literals, documentation tags, names | beam-text |
| Strings, regexps, additions, attributes, strings inside metadata | sage |
| Numbers, symbols, bullets, links, variables and template variables | cyan |
| Titles, sections, class/function titles | mint |
| Types, built-ins, class titles inside a class declaration, parameters | amber |
| Property/attribute keys, attribute/class/id selectors | ink |
| Metadata and markup tags | ink-muted |
| Highlighted diff deletion | amber |
| Emphasis / strong | Italic / weight 700 |

Fence copy control 24px at top/right 6,12px Copy icon, sm radius,
hairline-strong border, panel/85 and 2px backdrop blur. Reveal on hover or focus;
keyboard access remains possible. Success replaces icon with mint Check for
1500ms. Copy strips one trailing newline; failure says “Could not copy” with
manual selection guidance. Raw CodeBlock is square, hairline/wash, mono 11px
relaxed, x 10/y 8, max 288 and overflow-auto, prewrap and break long words.

### 8.2 Diff and file contents

Diff is square/hairline/wash. Header x 10/y 4: FilePlus 2 for a write or FilePenLine
for an edit, path, extension badge, mint additions and signal removals. Body
max 384px, mono 11px/1.45, two 40px nonselectable old/new gutters, prefix/content.
Addition mint/8 with mint text, removal signal/8 with signal text, context
faint, collapsed gap wash-strong. Character marks 25% semantic tint,2px radius,
x 1. Three context lines, at most 600 output rows and 20000 input lines; clipped
output says so. Syntax-diff additions/deletions above and this dedicated diff
recipe deliberately have different roles.

File view uses mono 2xs/relaxed, no wrapping, scroll both directions, y 4;
line x 12/gap 12,40px nonselectable gutter. Target line amber/10 with amber gutter,
centred once. Display cap 20000 lines. Copy whole file only when the read and
display are complete. Preserve the GUI's 2MiB read bound and binary-file message.

### 8.3 Terminal and the writing editor

Terminal is JetBrains Mono, fixed 12px/1.3, transparent over panel, scrollback
10000, beam cursor, panel cursor accent,28% beam selection. Slot x 8/y 6, wash,
square. Selection offers a small panel/hairline “Add to session” action without
stealing the selection. The owning session receives selected text; hiding the
pane retains its process and xterm mount. Fit on resize; explicit close closes
it. Split at most 4 visible terminals: two stacked;3–4 in a 2×2 grid with 1px gaps.

| ANSI slot | Token |
| --- | --- |
| Foreground | ink |
| Black | abyss in dark, ink in light |
| White / bright white | ink in dark, abyss in light |
| Red / bright red | signal |
| Green | mint |
| Bright green | sage |
| Yellow / bright yellow | amber |
| Blue / bright blue / cyan / bright cyan | cyan |
| Magenta / bright magenta | beam-text |
| Bright black | ink-faint |

Retheme existing terminals on ladder changes. Read tokens; background is
transparent, and any fallback belongs to the existing allowlisted terminal
fallback module. Do not add component colour literals.

The Markdown writing editor is for Instructions and similar Settings content,
not the session composer. Frame panel/hairline/lg, focus ring on frame, writing
area min 128/x 12/y 10 with §8 prose. Toolbar x 6/y 4/gap 2, hairline bottom/wash,
28px toggles: heading 2, heading 3, separator, bold, italic, inline code,
separator, unordered/ordered lists, quote, code block, separator, link.
Read-only hides toolbar. Link input 28×224, mono 2xs, md/line/panel/x 8; Enter or
blur applies, Escape closes that input. No raw HTML; headings 2/3 and tight lists
round-trip as Markdown; keep native rich-editor editing keys.

## 9. Window shell

### 9.1 Header and frame

Hidden desktop title bar;44px header with x 8/gap 4, hairline bottom, abyss.
Noninteractive space drags the window; every action is outside the drag region.
On macOS retain native traffic lights and reserve fixed 76px left in native,
non-fullscreen windows. Other native platforms draw three 28px window controls;
browser clients draw none. Unfocused controls 60% opaque; close hover signal.

Left-to-right order: collapsed-sidebar opener; focused environment chip;
workspace basename;12px ChevronRight; truncating session title; centred search;
update chip; waiting chip; compact Set up attention chip; More; Settings;1px
line separator 16 high with x 2 margin; system/light/dark segments; native
window controls. Long workspace caps 224px, environment label 160px; the title
shrinks first. Search is a button 24 high, x 8/gap 8, lg/hairline-strong/wash,
2xs/faint, maximum 448px, hidden below fixed 1024px viewport width. Tooltip says
“Search sessions and commands” and the effective palette shortcut.

More/Settings are 28px icon buttons. More menu 240px groups dock actions,
split right/down, New session/new pane and window-level Parked asks, with
icons, counts and effective shortcuts. Unsupported actions retain reasons.
Split respects eight-pane limit. Set up chip names attention count and opens
Set up; it truncates with full detail in its tooltip instead of printing all
failing steps in the header. No Report a bug entry.

Update chip fixed 22 high, x 8/gap 6, md/mono 2xs, ArrowDown or spinning LoaderCircle;
beam text/border except signal on failure. Pending 60% opaque and cannot repeat;
ready offers restart. Waiting chip fixed 22 high, amber/45 edge, amber/10 fill,
amber text/500,6px dot; hover amber/20, absent at zero, focuses first waiting
pane. Theme track inset/hairline/md, padding 2/gap 2; three 24px segments and 14px
Monitor/Sun/Moon, selected beam/30 edge, beam/10 fill, beam-text; unselected
faint, hover raised/muted. Radio keyboard behaviour changes the client ladder.

Body uses fixed 7px inset/gap, beneath header, min-width/height 0. At 1400×900:
sidebar x 7..231, grid starts x 238 and ends 1393, body y 51..893. These are default
border-box geometry targets. Cards lg/hairline/panel. Notice banners precede
the grid inside its column, so they occupy layout space without covering Send.

### 9.2 Sidebar and session rows

Sidebar default fixed 224px, persisted integer clamp 200–460, nonfinite reset 224.
Collapsed is absent, reopened by header.32px caption “Sessions”, chrome-label,
24px hide button; inset 8 around 28px full-width New session, beam/beam-ink.
Filter row x 6/top 8/bottom 6,24px field with 12px Search and left 26px inset;
show field above eight total sessions, keep New group 24px action at any count.
The By repository switch, environment headings, groups, shelves and restoration
or pairing footer actions keep the GUI's registry and projection semantics.
Footer rows use x 10/y 8,2xs/muted, hairline top and hover wash; no bug-report row.

Rows use fixed 54px slots, headings 24, overscan 6. Row outer x 8/y 2, button fills
available slot, md/x 8/y 6/gap 2. First line xs/18, gap 6:6px waiting amber dot
outranks running cyan pulse, title truncates; trailing mono 2xs/faint relative
age. Second line mono 2xs/faint:10px branch, account 8px square swatch/radius 3,
account label capped 176, environment badge and the GUI's tags/receipt/PR data.
Do not fabricate an account for unrecorded attribution. Hover wash; a session
shown in the grid uses wash-strong/ink, archived 60% opaque, unreachable dim with
its sentence. No active left rule. Counts have a gap, never join the heading.

Headings: ChevronDown 10 rotates−90° when folded, Pin/Layers/Folder 10 beam-text,
Archive 10 faint; label chrome-label, right count mono/faint. Rich row tooltip
opens right: full title capped 280 characters, running text, hairline, label/value
grid, directory, branch, account, model/count and activity where known;
paths mono/wrap-anywhere. Keep runtime ordering, merged-group membership,
search, shelves and command availability from gui.md; a view never duplicates
a session to express several states.

Session context menu 192px; group submenu 176. Organisation verbs remain those
in gui.md, with action icons, shortcuts and reasons. Rename autofocus/select,
Enter commits, Escape cancels; async failure preserves the prior title and says
why. Deletion uses confirmation. Resize target 8px wide/right 0/inset-y 8,
separator semantics with min/max/current; beam/30 hover, beam/40 focus. Pointer
capture updates DOM while moving and commits on release/cancel; keyboard
Left/Right changes 16px. Session/group drag uses beam 2px insertion line; grid
and heading drops retain their decided commands and disabled explanations.

Scheduled strip appears only with routines, CalendarClock 12, up to 4 rows and
an overflow count/link to Routines; running/paused/next-time/schedule text 2xs.
List loading, empty and failure use §14, not a permanently blank region.

### 9.3 Grid and per-session dock

Rows of columns, not a fixed matrix. At most 8 panes, fixed floors 360px wide and
220px high. A single pane has no caption or unnecessary divider. Multi-pane
caption 32/x 10/gap 6, draggable; focused beam/55 boundary/wash, other hairline.
Seven-pixel transparent dividers: beam/30 hover, beam/50 drag, keyboard-accessible
separator. A refused grid operation shows a compact amber status strip above
the grid until the next split, close or opening clears it; this is separate from
the runtime notice feed. Split actions in More and the palette show the same reason.
User resizing persists shares; closing a caption backgrounds a live
session and never closes the last pane or silently stops its run. Centre/right/
bottom session drop targets open or split; pane drag can move/swap. Valid target
beam/15 fill and beam/50 inset ring, dashed beam/70 label on panel x 12/y 6,
2xs and scrim/40 large shadow. Capacity-refused targets show the reason.

Each session pane owns its dock and retained arrangement. Dock min 240px with
40px icon rail, fixed 30px header,28px tab squares/md. Rail vertical padding 6,
gap 4; active wash-strong/ink, inactive faint/hover wash; muted 50% opacity.
Icon target 24; close target 14 with 10px X top-right, appears on hover or focus;
ended terminal 6px hollow dot. Tabs have selected state and roving focus,
arrows/Home/End; Enter activates, middle-click closes; file double-click pins.
Order terminal, browser, files/file views, Diff, documents, tasks, agent output,
preview; footer new-terminal/split actions remain outside rail scrolling.
Absent agent/preview tabs explain their availability. No window-wide shared dock.

When the owning pane's available width is below fixed 900px, its dock becomes
an internal right sheet, width min(480px,85%), inset 6, layer 30, lg/hairline/panel,
extra-large shadow. A24px close strip hides it, retaining tabs and exposing a
16px right-edge reopen handle. This breakpoint measures the pane, not viewport.
Switching sessions switches arrangements; a hidden terminal/browser remains
alive. Native browser views are hidden while a modal overlaps them; restoring
the modal restores visibility without navigating or closing the page.

Files use 6px list inset, x 8/y 4/gap 8 rows, xs filename, mono 2xs right size;
Folder beam, code cyan, data/config amber, prose muted, image sage, unknown faint.
Header up/folder/refresh; disabled root traversal explains why. Documents use
24px glyph wells, md/hairline/wash-strong, xs/500 title and 2xs metadata;
hover/focus actions open source or generating transcript row. Tasks put live
cards above finished folds, md/hairline, live stronger edge/wash-strong,
settled wash; row x 8/y 6, Play/Clock/Pause/Check/X status, capability-aware Stop,
phase folds and mono usage/time. Agent output reuses read-only transcript with
no composer/status, preserves rows on read failure. Diff uses §8.2 over the
GUI's session/working-tree reads. Browser header 24px buttons/14px icons,
mono xs address x 8/y 4/md/hairline-strong/wash; Enter navigates, Escape restores,
loading reload→Stop, failures amber/10 status strip. Preview uses the existing
sandboxed snapshot frame or Markdown x 20/y 16/max 768; preserve shell capability
reasons and snapshot refresh on reopening.

## 10. Session pane

### 10.1 Caption, column and scroll

Multi-pane caption follows §9: environment badge, workspace basename,
ChevronRight, session title, pull-request state, Run info 24px icon and Close 24px.
All titles truncate with full tooltip. Transcript, composer and status share
the centred reading column: Comfortable fixed 920px (preset), Wide 80rem
(1280px at preset), Full uncapped.
Transcript x 16/y 14, row gap 12; composer/status x 12. Transcript scroller contains
rows only; composer and status remain beneath it. A row has a 56px label/time
spine, gap 8, body gap 4; user row reverses the spine to the right. Ordinary labels
trade for a hover mono clock at 60% opacity; reasoning keeps label and puts clock
16px beneath. Keep row identities for search and jump, without re-rendering
all rows for a streaming delta. Closed fold children are unmounted.

Opening a session pins to end. Follow content growth while pinned; a user scroll
up at least 48px away unpins; within 48px re-pins. Unpinned “Jump to latest” is
centred 12px above bottom,24px outline pill/float/large scrim/40 shadow. Click
pins directly; no smooth scroll. Search/jump centres row within its owning
scroller and unpins; focus uses preventScroll and never pans ancestors.
On phone composer focus or keyboard opening, explicitly repin the latest line
after shell resizing. While pinned, observe scrollport as well as content
resizing; after deliberate scroll up, streaming preserves the reading position.
Browser-bar resizes after a focus-preserving keyboard close keep that reading
position; repin only for focus or a subsequent keyboard opening.

Phone web transcript selection also unpins following; later stream output keeps
history text/ranges and the reading anchor intact. Jump to latest explicitly
repins. Native selection/copy menus, long press, links and pinch zoom remain
usable. Contain transcript/root boundary overscroll without a global touch
blocker or swipe navigation. Uncapped code wells contain horizontal overscroll
and pass vertical gestures to the transcript; capped
input/detail wells are deliberate independently scrolling exceptions, with
contained overscroll. Tool disclosure preserves per-call folds and cannot pan
the outer page or dock.

### 10.2 Transcript recipes

| Kind | Anatomy and states |
| --- | --- |
| User | Right-aligned bubble max 80% of row body, lg, wash-user, ink/sm, x 12/y 8, prewrapped; “you” beam-text spine. Pending 70% opaque; sent attachments are named size chips, never fetched pictures. Hover/focus GitFork and Undo 2 actions; queued Hourglass label plus Read now/Withdraw remain visible and use runtime availability. |
| Reply | No fill, border or padding; full-width ink; streaming plain text/caret, settled Markdown. Over 80000 characters use prewrapped text. Subagent attribution only when supplied. Nonstandard stop note amber. |
| Reasoning | Sage “thinking” spine and 12px Brain, collapsed preview/chevron, live pulse. Default follows reasoningShown, with retained per-block choice; settled muted Markdown; streaming/long text prewrapped. Redacted body square, quiet notice. |
| Tool | Collapsed lg/hairline/wash card; open or artifact hairline-strong; failure signal/35 edge. Header x 10/y 8/gap 8, category icon, mono name, truncated summary, edit counts, duration, status badge. Running cyan pulse, success mint, error signal, denied amber, cancelled neutral. Expand in place. |
| Tool detail | Diff for edits; argument/input/raw folds retained by call identity, default input open except edits. Square formatted JSON/raw output max 288. Result fold defaults closed for success, open for failure. Preserve truncation, image-result and artifact controls; errors name code/message without replacing prior output. |
| Activity group | One chrome-label summary and chevron for contiguous quiet calls, cyan category icons/status, counts/time mono; collapsed hides child rows, open draws the same tool recipes. Running state visible while collapsed; reasoning keeps its own row. |
| Notice | Empty spine or hover clock, Info/TriangleAlert by severity, mono line plus faint detail; semantic tone, no modal. |
| Command/check | Terminal icon, mono command and muted args/output; running cyan, pass mint, failure/timeout signal and labelled exit/truncation. The check projection owns its content. |
| Turn end | “end” spine; lg/hairline/wash summary; failed signal/40 edge and signal/5 fill. Completed mint; interrupted/limit/permission denial amber; disposed neutral; error signal. Optional elapsed, turns, tokens/cache/cost; error text/code/retryability. Summary preference gates accounting; errors and silent runs keep a record. |
| Queue/steer, fork/rewind | §15's labels, folds and verbs retain runtime state; use the same spine, badges and fold recipes. |

A generic bubble is xl/x 12/y 8/sm/relaxed, wrapper gap 4/max 80%; ghost removes
fill/border/padding and width cap. Surface uses wash-user; outline hairline on
abyss; secondary/muted raised; primary beam/beam-ink; destructive signal/10
(dark 20). Interactive hover adds wash, without adding actions to a static row.
Tinted bubbles derive their fill from beam: lightness 0.93/chroma ×0.16 in light and 0.3/chroma ×0.4 in dark; hover 0.88/×0.25 or 0.35/×0.5, retaining beam hue. Reactions are raised pills, x6/y2/gap4, 3px panel ring, anchored 12px from start/end and three-quarters of their height beyond top/bottom. User rows use the lg exception above. No provider logo is required.

### 10.3 Inline asks

Cards lg, semantic 45% border, semantic fill and 14px icon, x 12/y 10/gap 8;
shared focus beam/50, pending answer controls 28px and notes min 48px/rows 2.
Arguments square mono max 224px; plan max 416px with bottom clipping fade and
scroll hint; parked-card stack max 60vh. The plan well shrinks within that
bound to keep the note, delivery error and decision footer visible without
scrolling the card; only the plan and a long note scroll. Keep draft/choices keyed by prompt
identity across collapse and failed delivery. Busy disables duplicate decisions;
failure one sentence inside the card, retaining the request and what was typed.
Permission cards keep the header and decision footer (note, refusal and actions)
visible within that bound; arguments scroll and shrink below their 224px cap
when the viewport leaves less room.
Settled cards keep the result/notes in compact form, not a second copy of a plan.

| Card | Tone and actions |
| --- | --- |
| Permission | amber/8, ShieldAlert; title/tool/reason, arguments, suggestions Fold and denial note. Deny, Deny and stop, optional session allowance only when ceiling/rules permit, Approve once. Escape denies; effective modified approval key approves once. |
| Plan | beam/6, ClipboardList; title, Markdown plan, optional path/allowed prompts, note. Keep planning, Stop, Approve plan; one approval per supported mode. Escape keeps planning. |
| Question | cyan/6, MessageCircleQuestionMark; divided questions, radio/checkbox label and description, selected wash, preview Fold, notes. Skip / Send answer(s); submit requires a selection or nonblank note through both button and shortcut. Escape skips. |
| Denylist | signal/8, ShieldAlert; exact matched entries and reason, Edit denylist and Deny/Stop as available; never offers Allow or Allow all. |

No bare Enter approves an ask. Prompt keyboard dispatch and capability ceilings
remain gui.md's, and tooltips show remaps/platform keys. “1 of N” and Hide/Show
strip preserve the focused pending prompt; question-only summary cyan, other
waiting amber. “Show request” focuses its card. Window-wide parked asks are §15.

### 10.4 Composer and activity

Below transcript: activity seam; optional hand-off strip; workspace and Hand off
row; pending cards; background-work and queue strip; composer; status. Composer
outer x 12, top row y 6, shared column width. Card fixed 10px radius, hairline-strong,
wash, focus 3px beam/50; file-drop 2px beam ring/offset 2 on abyss. Plain textarea,
sm/relaxed, x 12/y 10, min 44 to max 35vh, transparent/no inner border, autosizing,
spellcheck off; runtime draft handling remains unchanged. Workspace chip 22px,
Folder 12/optional GitBranch 12, mono 2xs basename, hover/open wash, full path and
stale state in tooltip. Hand off 22px/Hand 12; completed state amber strip with
24px Keep working here. Missing workspace offers Choose a workspace.

Bottom inside card: Paperclip 28 left; flexible space; effective Enter send /
Shift+Enter newline hint (hide below 640px); SendHorizontal 28 beam/beam-ink right.
Live and empty swaps to signal CircleStop; interrupt pending labelled spinner,
no duplicate stop. Locked composer exposes capability reason; empty Send is
50% opaque and does not accept activation. Never narrow the editor to make
room for button words beside it. New-session placeholder is “The first message
starts the session”; existing session “Continue the session…”; live steering
“Steer the run…”; pending asks point to the card above. Preserve `@`, `/`, `!`,
`!!`, `/check`, draft persistence, IME guard, Enter send and Shift+Enter newline.

Slash menu bottom-full/left 0,6px gap, full composer width, max 256, xl/float/
hairline-strong, padding 4, large shadow; row x 10/y 4/md/sm, mono command and
right 2xs provenance. Highlight wash-strong, arrows cycle, Tab accepts, Enter
accepts eligible leading token, Escape closes menu only; pointer acceptance
keeps textarea focus. File mentions use this appearance and the runtime's file
query. Attachment tray uses 56px local image previews or 56-high/max 224 file
chips,18px remove action; sent history always uses §10.2's metadata chips.
Bounds and submission refusals come from the contracts, not new visual limits.

Activity priority: stopping, waiting, starting, running, failed, settled.
Labelled status tail includes reason and mono elapsed time, ticking 1s while
active, minimum displayed 1s; settled tail absent. Seam fixed 1px settled/3px
otherwise,200ms height transition; live/start/stop shuttle, waiting amber,
failed signal. Background delegated-work strip opens Tasks; queue strip names
count and Read now/Withdraw using runtime queue semantics, never a bare
interrupt relabelled Read now. A static “idle” must not consume a second row.

### 10.5 Status and usage

Status outer bottom 4; shared column min 28/x 12, flex whole-chip wrap x 8/y 4.
Left group grows with 352px basis; meter right margin-auto and nonshrinking.
Chips fixed 22px high/md/wash, max 240px, hover/open wash-strong,2xs,12px icon,
truncating value with tooltip. Group order: environment badge; account/identity;
model/effort/fast; permission mode/clamp; containment/default; browser choice;
run status. No vertical separators or multiline labels. Account shrinks first;
mode remains legible. Unavailable stored model/mode amber with reason; absent
capability is a disabled chip with explanatory tooltip. Live cyan dot; pending
asks cyan question/amber permission with count; settled state absent.

Rings encode **used** share.24px wrapper,36×36 drawing grid, stroke 4,
start−90°, number fixed 9px (8px at 100), no percent glyph. Mint below 75%, amber
at 75%, signal at 90%; tint 12% disc. Unknown reading dash and empty track;
rejected limit signal/full arc, exclamation only when utilization unknown.
Arc transitions 300ms. Plan slots follow provider readings, not fabricated limits.
Context ring only when capability exists: contextTokens / contextWindow, else
learned model denominator; actual run model takes priority. Known denominator
and started run without usage shows 0; before run unknown. Clamp displayed share
to 100; no guessed context table.

Meter popover top/start,288/x 12, shows account identity and all meaningful
windows,4px bars, percent, absolute reset/time plus countdown, rejection,
age/staleness and labelled Refresh. Cached data initially, refresh on open or
request; clock runs only while open. Missing/unavailable/no limits each says
why. Context row shows tokens/window or unknown scale. Pool plan usage by
account identity across environments; distinct accounts do not manufacture
extra capacity. Usage Settings uses the same readings and drawing.

### 10.6 Account, model and effort picker

Improve the picker by making its dependencies visible. Use one popup opened
from either account or model chip, top/start,10px radius/float/ring, padding 0.
Columns divided by hairline, independent max 320px lists/padding 6. Stage 1 is
Account 224px; stage 2 Model 256px; stage 3 Effort 256px only when
supported. Choose the environment only in its environment chip. This popup
shows only that environment's accounts, with no environment headings or choices.
Account rows show 12px KeyRound or 8px swatch, label, identity, provider,
sign-in state and plan pressure. Label xs/500, note 2xs/muted, x 10/y 8/gap 8.
Selected wash, keyboard-focused wash-strong/ink with check indicator; disabled
50% opacity and visible reason. Use stable account/environment identities, not
list positions. “Add an account” opens inline sign-in for the chosen environment.

Changing the environment chip refreshes accounts/models as a single dependency choice;
retain explicit selection only where it remains valid. Do not silently pick a
similarly labelled account on another environment. Keep unavailable saved
choices visible with reason. An existing session's account is fixed: choosing
another account offers the runtime's fork action with that consequence named;
a live run cannot switch its environment/account/model. New-session choices
remain from its projection; an optional effort is sent with the first run only
when the chosen model supports it. Environment health is an explanation, not repeated
header warnings. Loading/error/empty for each column uses §14, with Refresh or
Sign in as appropriate, without clearing a valid earlier selection.

Model rows show friendly name, optional mono id beneath, recommendation,
quick-access state, supported effort/fast and capacity reason. Catalogue search
appears above long lists (over 12 models), full catalogue available alongside
quick choices. Effort rows label and explain each supported level; no invented
provider rung. Choosing a model updates its effort choices together and keeps
popup open for follow-on selection. Optional footer fast toggle, permission /
browser submenu, context and plan reading, plus Manage accounts/models link.
Keyboard arrows/Home/End within lists, Tab between stages, Enter selects,
Escape closes/returns focus. Below enough width for columns, stack the same
stages one at a time inside a 512px-max bounded dialog, with Back retaining
selections. Below 640px it is a bottom sheet: account, then model, then effort
only where supported. Rows are at least 44px high, labels wrap, and its lists
scroll within the viewport, including at 360px wide and with the keyboard
open. The gallery covers the desktop popup and all three phone sections.

## 11. Overlays

Dialog, confirmation, menu, context menu, popover, tooltip, select, command and
transient-toast parts are rebuilt primitives, using one Radix context family
(1.6.x), cmdk 1.1.1 and Sonner 2.0.7. Local class composition uses clsx 2.1.1,
tailwind-merge 3.6.x with the 2xs font-size group, variance tools 0.7.1 and
animation helpers 1.4.0. Existing package pins remain exact; these are the
measured dependency lines, not a request to update unrelated packages.

### 11.1 Dialog and confirmation

Centred, width min(384px,100vw−2rem), padding/gap 16, xl/float, ink/10 ring,
layer 50/scrim/10/4px blur,100ms entrance. Standard title base/500, description
sm/muted; header gap 6. Default close X24 top/right 8; accessible title/description.
Alert confirmation has no stock X, explicit Cancel/Action and optional 40px
raised/md media with 24px icon, bottom 8. Small confirmation max 320; standard
max 384 from 640px. Footer spans dialog padding, top hairline, raised/50, padding 16,
gap 8; right-align on wide windows, reverse stack on narrow. Destructive action
uses the destructive tint and names its effect. Busy guards duplicate submit
and closing where the operation requires it; errors keep entered values.

Run info and workspace/pairing pickers max 512; hand-off max 560. Run info
max-height 100dvh−4rem, padding 0, header/body x 16/y 12, scrolling body, sections
Run, Account, Usage, Capabilities, Tools; groups lg/hairline/inset 60/x 8/y 6,
mono values. Hand-off rows lg/hairline/x 12/y 8, candidate identity/auth/model/
capacity and blocked reason, fallback continuity action; busy protects dismissal.
Delete session warns if running, finishes running check before enabling delete.
Workspace picker names that a new session may be needed. Pairing forms put
labels above fields and actions below, never in a narrow side column.

Modal focus is trapped; background window keys do not act. Escape follows
the region and shared key dispatcher; closing restores opener focus. Hide any
native web view obscured by the modal. These rules hold even when Settings
keeps session components mounted behind it.

### 11.2 Menus, popovers and tooltips

| Surface | Width / placement |
| --- | --- |
| Header More | 240, below/end |
| Session context | 192 |
| Group chooser / compact group menu | 176 (organisation actions may use 192) |
| Status permission | Minimum 320, top/start |
| Workspace and usage | 288, top/start |
| Hand-off menu | 256, end |
| Generic popover | 288, padding/gap 10, centre offset 4 |
| Generic dropdown / context | Minimum 128 /144, bounded by available height |
| Select list | Minimum 144 and at least trigger width |

Menus float/lg/padding 4/medium shadow/ring; item md/x 6/y 4/gap 6/sm,16px icon,
selected/focused wash-strong/ink, destructive focus signal/10 (dark 20).
Inset labels left 28; radio/check indicator right 8, reserved 32px right padding.
Labels xs/500/muted; shortcuts right-aligned xs/muted/tracking 0.1em.
Separators 1px hairline, y 4, spanning padding. Submenus medium boundary/large
shadow, minimum 96 for dropdown or 128 context, offset 2/collision 8. Dropdown
trigger offset 4; all content scrolls within available height and repositions
at edges. Select labels/items use menu anatomy, scroll controls y 4 with 16px
chevrons; selected Check 16. Pointer and keyboard selection have the same gate.

Tooltip offset 6/collision 8, max 18rem, md/hairline-strong/float, x 10/y 6/gap 6,
xs/snug/wrap-anywhere, large scrim/40 shadow, no arrow. First delay 250ms,
skip window 400ms. With keycap right padding 6. Reasons remain readable from a
focusable disabled wrapper, not only on pointer hover. Session and PR tooltips
may include the rich facts described in §9 and gui.md.

### 11.3 Palette, banners and transient toasts

Palette horizontally centred at top one-third (y 300 at 900px), xl/float,
padding 0, overlay as dialogs. Compact default 384px from screenshot geometry;
content may widen up to a fixed 620px cap, bounded by viewport−2rem. List max 352px, scroll
without horizontal overflow, no stock close X. Search wrapper padding 4,
input 32 with 16px Search, input/30 fill/boundary, lg. Group labels xs/muted;
rows sm/x 8/y 6/gap 8,16px concept icon, selected wash-strong. Disabled labels
struck through with 2xs reason beneath. Keep the action registry's group order,
search, session page and gated verbs. No-match state centred/y 24. Arrows/Enter
select; empty Backspace returns from a subpage; Escape closes only palette.

Persistent runtime notices are **banners above the grid**, client-local until
dismissed; absence renders no space. Stack gap 6, bottom 7; lg fixed 8px radius,
x 12/y 8, mono 11 message/detail,16px Info or TriangleAlert. Info hairline/wash,
warning amber/45 edge and amber/10 fill, error signal/45 and signal/10. Action 24px
outline and close 24px; close top/right 4. Message flexes and wraps naturally;
put actions on another line when space is tight. Action success and Dismiss
use the existing runtime behaviour. Decision failures stay on their card too.

Transient copy/status feedback may use Sonner bottom-right, close enabled,
float/ink/hairline/base radius 8 and 16px status icons; loader spins. Theme follows
resolved ladder, rich status fills off. No persistent notice in this lane.
Default toast duration/width are dependency defaults, unmeasured; baseline
approval must record the adopted values before a surface relies on them.

## 12. Settings

### 12.1 Dialog and navigation

Settings overlays the visible session window, centred, xl/float/ring, padding
0/overflow-hidden. Below 1280px window width, keep width min(1000px,100vw−3rem)
and height min(660px,100dvh−3rem). From 1280px, grow to width
min(1440px,100vw−3rem) and height min(900px,100dvh−3rem). Phone geometry remains §17.
At 1400×900 its CSS box is x 24..1376/y 24..876; a ring may paint one pixel
outside. Header x 16/y 12, sm title,2xs muted explanation,24px Close. Say which
changes apply to future runs; appearance changes paint immediately. Open focus
in search. Mod+, Close and the existing Escape order close it; background keys
cannot create sessions, split or stop a run through the modal.

Nav 208px, hairline right boundary, inset 8, independently scrolling. Search 32px
and nonshrinking. Bands chrome-label/faint. Rows md/x 10/y 8/gap 10,16px icon,
xs/500 label,2xs/faint one-line hint, selected wash-strong with aria-current;
hover wash. Two-line row pitch about 52px at preset. Health 6px dot aligns with
the label, only on a step's home row. Long hints truncate with tooltip; reasons
may wrap. Eight bands retain registered rows/scopes and total address mapping
(ADR0027); do not replace them with another section registry.

| Band | Row | Icon |
| --- | --- | --- |
| Set up | Set up | ListChecks |
| Accounts | Accounts; Default account and model; Usage | KeyRound; Cpu; Gauge |
| Knowledge | Memory banks; Skills; Instructions | Brain; Sparkles; Bot |
| Access | Permissions; Browser; Key managers; Forges | Shield; Globe; Vault; GitPullRequest |
| Routines and bots | Routines; Bots | CalendarClock; Bot |
| Environments | Your machines; Access; Service | Laptop; KeyRound; Server |
| Appearance | Theme; Keyboard shortcuts | Palette; Keyboard |
| About | About | Info |

Search matches every word ignoring case against id/label/hint/old addresses;
empty bands hide, no results name the query. It filters navigation without
silently changing the current pane. If selected row is filtered out, keep pane
heading/breadcrumb and a Clear search action so the selection remains clear.
Bots is disabled with the existing capability sentence, no roadmap prose.
Unknown stored/deep-linked row follows registry fallback to Set up.

### 12.2 Body and building blocks

Selected body scrolls independently; content fills the available pane, x 24/y 20.
Single forms and groups retain a 768px maximum reading width, including nested
non-collection groups in panes that also hold card grids. Card collections
(machines, banks, accounts, key managers, forges, routines, skill sources and
members, repository trust records, usage, instructions and client sessions) use a responsive grid, gap 14,
with as many equal columns as fit a 26rem minimum card width. Below that minimum,
a card fills the available width; long facts wrap and controls fit their card.
At the default text size, 1400×900 shows two 541px cards per row, while
1024×768 keeps one 720px card per row. No pane scrolls horizontally. Reset body
scroll on row change; preserve explicit setting anchors. Environment-scoped
panes put the picker with their title; everywhere panes group by named/badged
environment; client panes have no irrelevant picker. About pins client version
above the environment picker. The home environment's theme keeps its own scope.
Picker uses §10.6 environment rows, no label/control separation across the page.

SettingsPane stack gap 14; h 2 sm/600/tight; description top 2,2xs/relaxed/faint;
actions gap 6. SettingsGroup lg/hairline, overflow-hidden, optional header
x 12/y 8/xs and hairline bottom, body rows divided by hairline. ChoiceList
padding 6/gap 2; row md/x 10/y 8/gap 10, radio top 3/line-strong and checked beam,
selected wash-strong, hover wash, disabled 50% with reason. Label xs, note 2xs.
Item rows use §5.3 with settings title xs and description 2xs/full-wrap.

Use a human setting label above its smaller mono key, plus a helpful sentence,
not a raw key as title. Place controls by their labels; at narrow body width
stack them. Scope, read-only and unreachable sentences appear once for their
group, retaining cached values. A failed write stays beneath the field as
“Not saved: …”; confirmation acknowledgements retain runtime ownership.

### 12.3 Pane recipes

Each pane uses the shared groups, fields, item rows and choices. Preserve the
GUI's data/actions and scopes; this table fixes the rebuilding anatomy.

| Pane | Drawing and states |
| --- | --- |
| Set up summary | Numbered step links with aligned 6px health dots and one concise status; counts, Re-run, Open full checklist and Set up another machine, no second notice feed. |
| Accounts | Title action Add account; panel/hairline/lg cards, selected wash-strong, swatch/name/identity, status and plan badges, usage ring, secondary Edit/Remove. Create/edit inside body with labelled provider/name/colour/plan/directory fields only where supported by this product; adoption remains in place. Sign-in card shows verification URL, code field, fallback command/copy, pending spinner, retryable error, expiry/cancel/success. One primary action for current stage, not a primary on every provider tile. |
| Default account and model | Staged picker §10.6 near labels; catalogue Refresh, friendly model name with mono id beneath, quick-access checkbox and supported capability badges, Use action/reason. No repeated provider prefix or catalogue jargon in primary value. Defaults remain runtime-owned. |
| Usage | Pooled identity groups,24px rings and 4px bars, reset/time/staleness, account/environment provenance; one sign-in/unavailable sentence per identity, not repeated empty cards. Hand-off controls described under their label. |
| Instructions | List with enable switches, New/Restore actions, selected name and scope; writing editor §8.3, built-in badge/lock, Reset/Delete confirmation, saving/error indicator. Show orientation as prose, its source/version in collapsed facts. |
| Skills | Labelled URL/folder fields, Add action, source cards with command/description/origin/licence/commit/count, enable switch, Pull/Remove secondary actions; missing enabled skill remains visible. Trust question uses confirmation recipe. Empty state explains how to add a procedure. |
| Memory banks | Title Sync all, master enable and optional follow-up switch; bank cards label/slug and format/default/role/access/key-manager badges; status, counts, repo/remote facts, scope choices, Sync/Turn off/Remove; memories and problems folds, filter/grouped entries and Retire confirmation. Setup choices Join/Create/Adopt use ChoiceList, preflight rows with status/required badge/remedy, remote or local path and credentials fields, Verify and mode-specific primary. Receipt raw well max 128. Remote URL/path fields max 320, slug/username 224. Success updates the projection; disabled actions give reasons. |
| Permissions | Described choices for supported modes and containment, signal on unattended bypass; clamp/read-only guidance; editable denylist rows with switches/Edit/Remove, Restore presets, labelled Test form and matched-entry result. TTL field and review groups retain current scopes. No invented six-mode options if the provider supports fewer. |
| Browser | Numbered extension installation rows, Show code/Stop, labelled fixed-lifetime code with copy/countdown, paired-browser rows/name/Unpair, site policy textarea and described switches. Installation progress uses status icons, not disabled checkboxes pretending to be steps. Errors one concise sentence and expandable technical detail. |
| Key managers / Forges | Provider chooser, selected card and one Add/sign-in primary; name/config/credential fields, connected status/facts, Verify/Edit/Remove secondary actions. Trust-certificate confirmation shows fingerprint/subject/expiry before accepting; retain the product's managers and forge accounts, no provider marks or live endpoint examples. |
| Routines | New routine title action, no-schedule Empty, lg cards with name/state/next time, Run/Pause/Edit/Delete and history Fold. Inline form hairline/lg/padding 12: name, environment/account/model/effort, workspace, schedule, instructions rows 4, permission choice, Cancel/Create/Save. Schedule choices daily/weekdays/some days/weekly/monthly/hourly/cron/manual; widths kind/weekday 128, day/minute 64, time 96, cron 176, Mon–Sun toggles. Name/prompt/account/workspace and schedule validation remain runtime-owned. |
| Your machines | Environment cards with 16px glyph/name/status, connection, updates, binding and workspace groups; pairing/install actions beneath their descriptions. Accessible labels use names, with raw addresses only in secondary mono facts. |
| Access / Service | Client/session cards with scopes/ceiling, This client badge, tinted Revoke confirmation; code form and paginated access log. Service status, Drain/Rebuild confirmation, labelled session settings. Read-only once; retain outbox/receipt/refusal semantics. |
| Theme | System/light/dark segments,11–20 stepper with mono value/−/+ icons and Reset; described reading-width choices, reasoning/fade switches; named seed controls, token swatches painted in each ladder, clamp guidance and import/export preview. |
| Keyboard shortcuts | §15 table/remapping, labelled search/reset and effective keys, accessible recording state. |
| About / Managed tools | Client version/platform mono facts, client-update primary when offered; environment version/channel/auto-update groups, tool versions/fallback status, release action. No duplicate client version under every environment. |

Memory-bank create/preflight gates, routine schedule validation, account gates
and removal consequences come from their runtime/specs. Use labelled pending,
empty, denied, error and success states, retain values on failure, and show
one primary per active form. Wide forms scroll inside Settings, never enlarge
the dialog beyond its bounds.

## 13. Set up

### 13.1 First frame: variant A

Show the introduction from the first frame while the environment on this machine
starts. Do not wait for a ready home environment before mounting it. It uses
the same 44px desktop frame and 7px body inset. Intro centred, width 720px/max 100%,
padding 28/gap 24,44px beam tile with neutral glyph, sans title and lede;
roadmap cards in two columns/gap 10, padding 18, stack when narrow. Intro title
28/36/600, tracking−0.025em; lede 16/24, max 60ch. This title is an explicit
first-run exception to the regular type scale.

The owner-approved copy is:

> Welcome to agent-harness
>
> A place to work with coding agents.
>
> Give an agent a task, follow its work, and keep the conversation with your
> project. agent-harness brings your accounts, sessions and tools into one
> window, on this machine or across your machines.

| Intro block | Description | Tag |
| --- | --- | --- |
| First, connect your account | Your agent needs a signed-in coding account to start a session. We will help you connect it. | Required to start |
| Then, make it yours | Bring over past work, connect tools and choose how agents work. Every step after Account is optional. | Skip now, return in Settings |

Service card padding 16, inset/hairline/lg/gap 12,32px raised icon well,
cyan LoaderCircle while starting, mint ready, amber failure. It says
“Starting the environment on this machine” and “This background service runs
your agents and keeps your sessions available. This usually takes a few seconds.”
While starting: “Waiting for this machine…” and “I’ll set up later”. Beneath:
“Only Account is required. The rest can wait until you need it.”

Failure: “The environment could not start on this machine.” and “Try again to
get this machine ready for your first session.” Offer “Try again”; preserve
the intro and defer action. Technical error is expandable, never raw IPC text
as the lead. Ready: “The environment on this machine is ready” and “You can
sign in and start a session here.” Enable “Begin set up”. Retry cannot start
duplicate service operations. Leaving now keeps Set up available in Settings.

### 13.2 Rail, step card and footer

Variant A uses a fixed 280px rail, with independently scrolling steps; no alternative
rail selector in the shipped window. Rail panel/hairline/lg, inset 10 with 16px
top; heading/information x 10/bottom 14. Numbered step rows padding 8/gap 10,
compact radius 6, minimum 50 high,2px between rows. Fixed 18px mono 11/20 number
column,14px concept icon,6px health dot aligned near label, label 12/20/500,
hint 11/16/faint, tag 11px compact pill. Required beam-text; Optional muted.
Selected wash-strong/hairline-strong; hover wash; focus §4. Keep number and
hint even while a health sentence changes; health details belong in the card.

| Step | Tag | Rail hint |
| --- | --- | --- |
| 1 Account | Required | Choose your agent’s account |
| 2 Carry over | Optional | Bring past work with you |
| 3 Your machines | Optional | Work here or elsewhere |
| 4 Forges | Optional | Open pull requests |
| 5 Key manager | Optional | Fetch keys when needed |
| 6 Memory bank | Optional | Keep a shared notebook |
| 7 Skills | Optional | Reuse working procedures |
| 8 Instructions | Optional | Guide every session |
| 9 Browser | Optional | See and use web pages |
| 10 Permissions | Optional | Choose when agents ask |
| 11 Appearance | Optional | Make the window feel right |

Card scrolls independently inside a column with min-width/height 0; padding
x 40/y 34, lede max 56ch, choice/form area max 620px. Title 20/28/600,20px concept
icon, short lead paragraph, one primary action and secondary check/open-pane
links. Use §12 pane anatomy inside steps; explain the user's outcome before
technical checks. Numbers, hints and tags do not replace health or permission
reasons. Environment picker in the Set up heading applies to its checked
projection, preserving per-environment setup state and all eleven actions.

Footer stays visible outside step scrolling, panel/hairline top, x 24/y 14,
min 67px, gap 14;24px top fade from panel to transparent. Back left; Skip for now
and Continue right, gap 8,32px buttons; last step Continue becomes Finish.
Back disabled only at first step. Skip remains visible but disabled on Account
with reason; steps 2–11 allow it. Continue on Account waits for a signed-in
account; selecting later steps in the rail remains possible. On narrow screens
wrap footer action groups as whole buttons and keep scroll height for content;
never clip Continue/Finish below the viewport. Below enough width for rail plus
card, expose the same numbered steps in a collapsible fixed 280px-max drawer and retain
current step/Back; do not reduce field/control text to fit.

### 13.3 Account gate and close

Close stays available. Without a signed-in account it asks once:

> Leave set up without an account?
>
> You can look around, but you will need to sign in before starting a session.
> Set up will be waiting in Settings.

Choices: “Leave for now” and “Keep setting up”. Dismissing the confirmation
keeps Set up; confirming leaves it. Do not repeatedly ask within one close
action or lock rail navigation. Account empty primary says “Sign in an account”,
not “another” before one exists. Optional steps can be revisited in Settings;
Finish marks walkthrough completion without pretending skipped health is ready.
There is no post-Finish guided tour. Existing setup projection owns checks,
restore, receipts and progress; the intro does not create a second checklist.

## 14. Empty, loading and error

Ready empty session: centred welcome min 60vh, x 32/y 48/gap 24, content max 512,
44px beam tile/22px neutral SquareTerminal, product name 16px/600, one sentence
about the chosen environment/account. Keep a composer present. “Not ready to
run” is a wash/hairline/lg alert with 16px amber TriangleAlert, short missing
account/workspace sentences and explicit Sign in/Choose workspace actions.
Do not repeat those sentences in the header. A resumed empty session can show
a secondary shortened id, not replace the welcome with a dump.

Eight-key legend in two responsive columns,2xs/faint descriptions, mono keycaps
min 32: Enter send, Shift+Enter newline, palette shortcut, Escape dismiss/deny
in its actual scope, New session, sidebar, Settings and Run info. Display keys
from the effective registry. Escape must not promise stop while that binding
is off. Narrow container changes to one column.

Sidebar and palette initial loading show three skeleton pairs in row geometry,
not a blank box; transcript catching-up shows labelled status, preserving known
rows. List empty uses Inbox well and one sentence appropriate to no history or
no query matches, with a relevant action when available. Unsupported reads show
capability reason while retaining other environments' rows. Errors say what
could not be read and offer Try again; retries preserve previous content.
Account/model picker loading and no-catalogue states follow the same recipe.

Local start uses §13.1 in first run, and the same service card later, with
Start/Try again/defer and readable failure. Missing desktop capability explains
the needed desktop action; boot failure retains restart/retry guidance rather
than exposing preload/IPC exceptions as the page title. Pairing dialog max 512,
fields stacked with labels, address/link/code in mono, expiry and granted scopes
below; pending “Connecting…” indicator, rejected/expired code sentence and
retry/cancel. No code or credentials are gallery production data. Denials
name the capability and retain the user's entered values where safe.

## 15. Product surfaces and deliberate differences

The same visual rules draw these already-decided concepts; colours and motion
follow §2/§6 and control sizing follows §5. Runtime projections remain the
only source of state. No copied stores, bridges or source modules are needed.

| Surface | Recipe and retained behaviour |
| --- | --- |
| Environment badge | Glyph 14/current environment token plus name in 22px wash/md chip, or 6px fallback dot; tooltip reachability. Never guess a machine name from a host path. |
| Merged groups and shelves | §9 headings with count/gap and state icon; primary ordering and each member command retained. Snooze includes wake time/Clock; settled/archive folded. View grouping does not manufacture duplicate sessions. |
| Pairing and Your machines | §12 group/card + §14 form; connection identity, scopes, expiry, updates and safe display of pairing code retained. No horizontal actions squeezed beside narrow text. |
| Queue and steer | User recipe with Hourglass/count and retained queued, delivered, steered or withdrawn label; Read now reads whole queue, Withdraw returns text to draft, interrupt re-owns without auto-start (ADR0022). |
| Fork and rewind | GitFork/Undo 2 controls with reasons, anchor shown, hidden-history fold with Undo and counts; no deleting visible history just to reproduce a visual collapse. |
| Workspace checks | Terminal/check row §10, running output and labelled pass/failure/timeout/exit/truncation; composer chip and configuration from check projection, no local executor. |
| Denylist and parked asks | Denylist signal card never Allow; window-wide parked list max 512 dialog with title/close, environment badge/session/kind/question/TTL, oldest first. Allow/Deny per permission; batch confirmation excludes denylist rows. Empty uses §14. |
| Theme picker | Settings choices/cards, seven named seeds and token-painted swatches in both ladders, previews and import/export; client mode/text size remain local presentation. |
| Shortcut tables | One table per group: action description with smaller mono id, terminal defaults, GUI keys in force; keycaps, condition/reason beneath, remap/Reset and visible recording state. Search and reset use shared controls; disable absent actions with reason; retain reserved-key/clash rules. |
| Eight Settings bands | §12 registry order/scopes/address map; no extra Routines checklist step, Bots placeholder only. |
| Per-session side column | §9 dock within owning pane, hidden terminal/browser kept alive, native view hidden under modal; session switching restores each arrangement. |
| New session | Welcome plus environment/account/model/workspace chips and composer, §10.6 dependency picker; first send creates the session through runtime; no session exists merely for opening pane. Browser choice retains its capability. |
| Attention and notices | Waiting chip and labelled 6px dots, OS notification activation opens owning session, banners until client-local dismissal, no persistent toast over composer. |

Escape does not stop a run by default. Focused menus/palette/Run info take it
first; then region handlers, pane find and parked card, Settings, then the
optional stop action. Keys displayed anywhere are the keys in force, including
remaps and platform Mod. Fenced code keeps highlighting. Sent attachments keep
metadata chips (bytes are not served in milestone 1). Settings remains a bounded
dialog; per-pane docks never become one window-wide dock. No Report a bug row
until the destination/identity is decided. These deliberate differences do not
relax the shared shape, density or accessibility rules.

## 16. Verification

Renderer behaviour is checked in the jsdom harness by roles, accessible names,
text, capability reasons, focus order and commands. Measurements are checked
by the CI scene gallery using real app components over the scripted runtime,
fake shell, in-memory documents and frozen manual clock. Geometry blocks from
the first check. Screenshot differences are advisory until #1343–#1347 all land;
after that shell wave they block merges. Packaging remains a separate desktop
checklist; builders do not run browsers, Electron or dev servers on the shared box.

Capture 1400×900, device scale 1, dark for every scene. Also capture 1024×768 for
narrow header, dock and modal/footer rules, and text sizes 11/20 for scaling
scenes. Wait for bundled fonts and scene steps before gallery-ready; pinned
Chromium, fixed clock, reduced motion and gallery-only animation/caret freeze.
Do not export gallery modules into the application bundle. Each scene owns its
script, geometry expectations and baseline; surface tickets add separate files.

| Scene family | States to capture | Required measurements |
| --- | --- | --- |
| window-empty / window-not-ready | Ready, no account/workspace, loading/error | Header 44±0.5; sidebar 224; frame inset/gap 7; welcome tile 44/glyph 22; composer/status column alignment |
| primitives | Every variant/size, rest/hover/focus/disabled/invalid/checked/open | Buttons 24/28/32/36; input 32; sm 13/20; radii; no unmapped colours |
| window-populated / window-multi-pane | Long titles, groups/shelves/filtered, right/down splits, waiting/update | Row 54, heading 24, caption 32 only with multiple panes, floors 360/220,7px seams; header child ≤30 at preset, no wrapping |
| transcript / inline-asks | User/reply/reasoning, streaming, tools/group/diff, notices/end, each prompt pending/busy/error/settled | Column 920/1280/full; spine 56/gap 8; code/raw max 288; diff gutters 40/max 384; argument 224/plan 416 |
| composer / status / run-picker | Slash/files, attachments, queue, stopping, unavailable account/model, high usage, narrow stages | Field min 44/max 35vh; send 28; chips 22/max 240; ring 24; independent picker lists max 320; no text overlap |
| dock-panes | Files/file/Diff/terminal/browser/documents/tasks/agent/preview, empty/loading/error | Rail 40, tabs 28, header 30, min 240; narrow sheet ≤480 and 85% pane; invisible native view behind modal |
| palette / dialogs / parked-asks / notices | Query/no-match/disabled, confirms and errors, long banners | Palette top third/default 384/max 620/list 352; dialogs 384/512/560; scrim blur 4; banners never cover composer |
| settings | Each registered pane, scope picker, filtered nav, read-only/unreachable, long forms | Box≤1440×900 at wide windows, ≤1000×660 below 1280px, and viewport−3rem; nav 208; search 32; forms≤768/x 24/y 20; responsive card grid; selected row/focus and labels |
| first-run | Intro starting/failure/ready, all 11 steps, account gate, close confirmation, long card | Rail 280, number 18, choices≤620; footer visible with Back/Skip/Continue or Finish in both captures |
| product-surfaces | Pairing, queue/fork/rewind/check, theme, shortcuts, banks/routines | Shared primitive dimensions, state labels and scope/command parity |

Light subset: window-empty, window-not-ready, primitives, transcript with diff,
inline-asks, composer/status/run-picker, palette/dialogs/notices, Settings
Accounts/Permissions/Theme and first-run intro/Account/Appearance. Other dark
scenes still test token resolution in both ladders through theme/harness checks.
Geometry tolerance±0.5px unless a scene states a reason for another tolerance;
no horizontal window overflow, cut footer, overlapping status values, shrinking
search input or control outside its region. At other text sizes compute rem
expectations with §3 scale; assert fixed measurements separately.

Pixel comparison uses threshold 0.1 and at most 0.05% differing pixels against
approved baselines. New/changed captures and baseline/capture/difference images
are attached to the PR; the author opens the PNGs, checks affected layout and
fixes visible faults. Accept a baseline by downloading the PR capture through
the gallery acceptance script, reviewing the image diff and recording approval;
never regenerate a baseline silently to erase a failure. A deliberate design
improvement names its geometry/state change and updates this contract if it
changes a stated value. Neither private screenshots nor private names are
committed as baselines; baseline scenes contain invented neutral data.

## 17. Phone browser projection (milestone 1)

The owner's 2026-10-04 milestone amendment is specified in
[web-client.md](web-client.md). Desktop dimensions above still govern the
wide layout; the following rules govern phone use and its gallery evidence.

Below 640px show one conversation with a session drawer and phone header
(More, Settings, attention). Preserve the desktop pane arrangement for return
to wide mode; disable Split with a width reason. The existing below-900px
pane-width dock rule becomes the side-column sheet, `min(480px, 85%)`. Closing
or switching hides work without stopping a run, delegated task or terminal.
Drawers/sheets trap and restore focus and close predictably.

Keep abyss/panel/float/hairline tokens, rounded human controls and square
machine output wells, the icon names, focus and contrast. Phone preset text
size 16 uses the existing 11–20 preference; inputs are at least 16 CSS px and
all tap hit areas at least 44px, including icons. Touch exposes actions that
otherwise need hover. Long labels wrap without horizontal page overflow;
keep pinch zoom and enlarged text at 20.

Use one phone web-frame viewport owner for VisualViewport height and offsetTop
at scale 1, with `100dvh`/window-height fallback, `viewport-fit=cover` and
`env(safe-area-inset-*)`. Composer/status sit in the bottom flex region above
the visible keyboard. Lock the phone web document/root and bound the shell;
retain unzoomed bounds during pinch zoom and clean locks/styles/listeners on
wide mode/unmount. Keep at least three readable transcript lines while composing; retain that
reservation through button taps so blur cannot move Send. Release it on keyboard
close even when Message keeps focus; later bar resizes must not restore it. Non-conversation
controls stay above the conversation dock. Keep activity/asks/composer order,
bound input/card focus scrolling to its owning scroller, and prevent notices from covering
composer or waiting cards. Send/Stop, Allow/Deny and Continue/Finish remain
visible at keyboard height, including long cards and IME composition. Settings
is full-height with registered-row drawer navigation; Set up keeps eleven
steps and its sticky Back/Continue footer.

Phone web root and transcript use `overscroll-behavior: none` to suppress
chaining/pull-to-refresh in supporting engines. Use explicit browser reload or
Reload client and explicit Copy/Jump to latest, preserving the manual copy
fallback on denial. No simulated haptics or synthetic refresh gesture. Native
selection handles, OS rubberband and unsuppressed refresh gestures require
engine-specific dated handset evidence under #1556; CSS alone proves no universal
OS guarantee. Capped input/detail wells keep their own contained scrolling.

Hosted gallery subsets at 390×844 and 360×740 cover dark/light, text 20,
keyboard-height viewport, safe areas and long content. #1636 additionally keeps
layout height 844 while visual height is 480 with offsetTop 0/120; focus,
streaming, scrollport resizing, banner/card insertion and keyboard close must
keep shell/dock/latest-line visible and document/window scroll stable. Real
animated keyboard, bars/settings, rotation/insets, focus zoom, selection and
Home Screen proof is handset-only dated evidence in #1556, never a builder gate.
Assert 44px hit areas,
no page overflow, visible Send/Allow/Continue, drawer/sheet focus and no notice
occlusion. Use web-platform scene mode exposing actual browser capabilities;
phone scenes do not silently use fake desktop capabilities. #1541 owns
capture/registry/report integration and budgets from 342 captures against the
400 cap, or shards publication/acceptance together without weakening validation.
Surface owners add uniquely named scene/baseline modules and inspect their PR
captures. Desktop captures remain gated with the same validation.

Gallery is rendering evidence. Hosted real-client Chromium/WebKit CI under an
ordinary uid against an isolated real environment/scripted provider proves
pairing, grants, wire/replay, storage, preview isolation, worker upgrades and
delivery transports; only #1556 proves actual handset keyboard/camera, Home
Screen storage and background/locked push/tap. That human evidence blocks no
builder or release. No browser/Electron/dev server or image runs on the shared
agent box; deployment/live QA belong to the coordinator.
