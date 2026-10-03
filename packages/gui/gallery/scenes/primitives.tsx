import { DEFAULT_THEME, ENVIRONMENT_ICONS } from "@agent-harness/contracts";
import { cssVariables, derive, type LadderName } from "@agent-harness/theme";
import { Bold, File, Info, Plus } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { glyphOf } from "../../src/connections/environment-glyphs.js";
import {
  Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardAction, CardFooter, CardHeader, CardTitle,
  Checkbox, CodeBlock, CopyButton, Empty, EmptyDescription, EmptyMedia, EmptyTitle, Field, Fold, IconButton, Input, Item, ItemActions,
  ItemContent, ItemDescription, ItemTitle, Kbd, KbdGroup, Progress, RadioGroup, RadioGroupItem, Select, Separator, Skeleton, Slider,
  Spinner, StatusDot, Swatch, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, Toggle, ToneBadge,
  type ButtonSize, type ButtonVariant, type StatusTone,
} from "../../src/ui/index.js";

const variants: readonly ButtonVariant[] = ["default", "outline", "secondary", "ghost", "destructive", "link"];
const sizes: readonly ButtonSize[] = ["xs", "sm", "default", "lg", "icon-xs", "icon-sm", "icon", "icon-lg"];
const tones: readonly StatusTone[] = ["neutral", "info", "thinking", "success", "warning", "danger"];
const copy = async () => {};
const Part = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => <section aria-label={title} className="flex min-w-0 flex-col gap-2"><h2 className="text-xs font-medium text-ink-muted">{title}</h2>{children}</section>;

/** A standalone scene, ready for the gallery's component-scene registration seam. */
export const PrimitivesScene = ({ ladder = "dark" }: { readonly ladder?: LadderName }) => {
  const [open, setOpen] = useState(false);
  const variables = cssVariables(derive(DEFAULT_THEME)[ladder]);
  return <main data-scene="primitives" data-ladder={ladder} style={{ ...variables, colorScheme: ladder } as CSSProperties} className="min-h-screen bg-abyss p-4 text-sm text-ink">
    <h1 className="mb-3 text-lg font-medium">Window primitives</h1>
    <div className="grid grid-cols-3 gap-5">
      <Part title="Buttons">
        {variants.map((variant) => <div key={variant} className="flex items-center gap-2"><Button variant={variant}><Plus aria-hidden="true" data-icon="inline-start" />{variant}</Button><Button variant={variant} disabled><Plus aria-hidden="true" />Disabled</Button><Button variant={variant} aria-expanded><Plus aria-hidden="true" />Expanded</Button></div>)}
        <div className="flex flex-wrap items-center gap-1">{sizes.map((size) => <IconButton key={size} label={`Size ${size}`} size={size} variant="outline"><Plus aria-hidden="true" /></IconButton>)}</div>
        <IconButton label="New session" keys="Ctrl+N" disabledReason="Sign in first"><Plus aria-hidden="true" /></IconButton>
      </Part>
      <Part title="Text controls">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Name" description="Shown in the window"><Input data-geometry="input" defaultValue="Desk" /></Field>
          <Field label="Invalid name" error="Choose a name"><Input aria-invalid defaultValue="" /></Field>
        </div>
        <Input aria-label="Disabled name" disabled defaultValue="Unavailable" />
        <div className="grid grid-cols-2 items-end gap-2">
          <Field label="Effort"><Select defaultValue="medium"><option>Low</option><option value="medium">Medium</option><option>High</option></Select></Field>
          <Select aria-label="Disabled choice" disabled><option>Unavailable</option></Select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Textarea aria-label="Notes" placeholder="Write a note" />
          <Textarea aria-label="Disabled notes" disabled defaultValue="Read only" />
        </div>
      </Part>
      <Part title="Choices">
        <div className="flex items-center gap-3"><Switch aria-label="Off" /><Switch aria-label="On" defaultChecked /><Switch aria-label="Disabled switch" defaultChecked disabled /><Switch aria-label="Small switch" size="sm" defaultChecked /></div>
        <div className="flex items-center gap-6"><Checkbox aria-label="Unchecked" /><Checkbox aria-label="Checked" defaultChecked /><Checkbox aria-label="Mixed" defaultChecked="indeterminate" /><Checkbox aria-label="Disabled checkbox" defaultChecked disabled /></div>
        <RadioGroup aria-label="Theme" defaultValue="dark" className="flex gap-6"><RadioGroupItem aria-label="Dark" value="dark" /><RadioGroupItem aria-label="Light" value="light" /><RadioGroupItem aria-label="Disabled radio" value="off" disabled /></RadioGroup>
        <div className="flex gap-2"><Toggle aria-label="Bold"><Bold aria-hidden="true" /></Toggle><Toggle aria-label="Bold selected" defaultPressed><Bold aria-hidden="true" /></Toggle><Toggle aria-label="Bold disabled" disabled variant="outline"><Bold aria-hidden="true" /></Toggle></div>
        <Slider aria-label="Text size" defaultValue={[14]} min={11} max={20} />
        <Slider aria-label="Disabled slider" disabled defaultValue={[50]} />
        <Tabs defaultValue="files"><TabsList aria-label="Side column"><TabsTrigger value="files"><File aria-hidden="true" />Files</TabsTrigger><TabsTrigger value="tasks"><Info aria-hidden="true" />Tasks</TabsTrigger><TabsTrigger value="off" disabled><Info aria-hidden="true" />Disabled</TabsTrigger></TabsList><TabsContent value="files">File list</TabsContent><TabsContent value="tasks">Task list</TabsContent></Tabs>
        <Fold summary="Details" open={open} onOpenChange={setOpen}><p>Fold contents</p></Fold>
        <Fold summary="Expanded details" open onOpenChange={() => {}}><p>Visible details</p></Fold>
      </Part>
      <Part title="Badges and feedback">
        <div className="flex flex-wrap gap-2">{variants.map((variant) => <Badge key={variant} variant={variant}>{variant}</Badge>)}</div>
        <div className="flex flex-wrap gap-2">{tones.map((tone) => <ToneBadge key={tone} tone={tone}><StatusDot tone={tone} />{tone}</ToneBadge>)}</div>
        <KbdGroup><Kbd>Ctrl</Kbd><Kbd>N</Kbd></KbdGroup>
        <div className="flex items-center gap-2"><Spinner label="Loading" /><Skeleton className="h-4 w-32" /></div>
        <Progress aria-label="Starting" value={0} /><Progress aria-label="Halfway" value={50} /><Progress aria-label="Complete" value={100} /><Progress aria-label="Unknown progress" value={null} />
        <Alert><Info aria-hidden="true" /><AlertTitle>Information</AlertTitle><AlertDescription>Keep working in this window.</AlertDescription></Alert>
        <div className="grid grid-cols-2 gap-2"><Alert variant="warning"><AlertTitle>Needs attention</AlertTitle><AlertDescription>Check the connection.</AlertDescription></Alert><Alert variant="destructive"><AlertTitle>Could not connect</AlertTitle><AlertDescription>Try again.</AlertDescription></Alert></div>
      </Part>
      <Part title="Cards and items">
        <Card size="sm"><CardHeader><CardTitle>Project</CardTitle><CardDescription>Work with a coding agent.</CardDescription><CardAction><Badge variant="secondary">Ready</Badge></CardAction></CardHeader><CardContent><Item variant="outline" size="xs"><ItemContent><ItemTitle>Session</ItemTitle><ItemDescription>A short description</ItemDescription></ItemContent><ItemActions><IconButton label="Add session" size="icon-xs"><Plus aria-hidden="true" /></IconButton></ItemActions></Item></CardContent><CardFooter><Button variant="outline" size="xs"><Plus aria-hidden="true" />New session</Button></CardFooter></Card>
        <Item variant="muted"><ItemContent><ItemTitle>Muted item</ItemTitle><ItemDescription>Supporting detail</ItemDescription></ItemContent></Item>
        <Empty><EmptyMedia><File aria-hidden="true" /></EmptyMedia><EmptyTitle>No files yet</EmptyTitle><EmptyDescription>Choose a project to see its files.</EmptyDescription></Empty>
      </Part>
      <Part title="Machine text and colour">
        <CodeBlock text="pnpm install" copy={copy} /><CopyButton text="pnpm lint" copy={copy} />
        <Separator />
        <div className="flex items-center gap-2">{(["beam", "cyan", "sage", "mint", "amber", "signal"] as const).map((token) => <Swatch key={token} token={token} label={token} />)}</div>
        <div className="flex gap-3">{ENVIRONMENT_ICONS.map((name) => { const glyph = glyphOf(name); return glyph === undefined ? null : <glyph.Icon key={name} role="img" aria-label={name} className="size-4 text-cyan" />; })}</div>
      </Part>
    </div>
  </main>;
};

/** Measured control heights at the default 16px root; both ladders use the same geometry. */
export const geometry = [
  { selector: "main[data-scene=primitives]", width: 1400, height: 900, tolerance: 0.1 },
  ...([["xs", 24], ["sm", 28], ["default", 32], ["lg", 36]] as const).map(([size, height]) => ({ selector: `button[data-variant][data-size="${size}"]`, height, tolerance: 0.1 })),
  ...([["icon-xs", 24], ["icon-sm", 28], ["icon", 32], ["icon-lg", 36]] as const).map(([size, dimension]) => ({ selector: `button[data-variant][data-size="${size}"]`, width: dimension, height: dimension, tolerance: 0.1 })),
  { selector: "input[data-geometry=input]", height: 32, tolerance: 0.1 },
  { selector: "[role=switch][data-size=default]", width: 32, height: 18.4, tolerance: 0.1 },
  { selector: "[role=switch][data-size=sm]", width: 24, height: 14, tolerance: 0.1 },
];
export const ladders = ["light", "dark"] as const;
export default PrimitivesScene;
