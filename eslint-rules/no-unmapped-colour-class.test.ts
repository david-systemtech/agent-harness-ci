import type { Rule } from "eslint";
import { rule } from "./no-unmapped-colour-class.js";
import { gui, markupTester, ruleTester, stylesheetTester } from "./rule-tester.js";

const unmapped = (colour: string) => ({ messageId: "unmapped" as const, data: { colour } });

ruleTester.run("no-unmapped-colour-class", rule, {
  valid: [
    { filename: gui("app.tsx"), code: 'const a = <div className="bg-radial bg-conic decoration-slice decoration-clone underline-offset-2 underline-offset-auto" />;' },
    { filename: gui("app.tsx"), code: 'const a = <div className="bg-panel text-ink-muted border-line-strong shadow-scrim/40 bg-environment-red" />;' },
    { filename: gui("app.tsx"), code: 'const a = <div className="group-hover/menu:bg-scrim/50 dark:hover:bg-scrim/50 data-[state=open]:text-beam [&:nth-child(2)]:border-line!" />;' },
    { filename: gui("app.tsx"), code: 'const a = <div className="text-sm text-center text-pretty bg-cover bg-no-repeat bg-center border-2 border-dashed border-x-4 border-b border-t border-r border-bs ring-2 ring-inset shadow-lg shadow-none outline-offset-2 decoration-wavy decoration-2 fill-none stroke-2 from-10% via-50% to-90% divide-x-2" />;' },
    { filename: gui("app.tsx"), code: 'const a = <div className="bg-transparent text-current border-inherit fill-current stroke-none bg-(--panel) text-[length:13px] border-[color:var(--line)] shadow-[0_1px_2px_var(--scrim)]" />;' },
    { filename: gui("app.ts"), code: 'const a = `bg-environment-${colour} text-ink ${active ? "bg-beam" : "bg-panel"}`;' },
  ],
  invalid: [
    ...["accent", "caret", "decoration", "divide", "drop-shadow", "fill", "from", "via", "to", "inset-ring", "inset-shadow", "outline", "placeholder", "ring", "ring-offset", "scrollbar-thumb", "scrollbar-track", "shadow", "stroke", "text-shadow", "border-x", "border-be", "mask-radial-from"].map((prefix) => ({
      filename: gui("app.ts"), code: `const a = "${prefix}-missing";`, errors: [unmapped(`${prefix}-missing`)],
    })),
    { filename: gui("app.ts"), code: 'const a = "group-hover/menu:bg-popover/50 bg-2 text-13";', errors: [unmapped("group-hover/menu:bg-popover/50"), unmapped("bg-2"), unmapped("text-13")] },
    { filename: gui("app.tsx"), code: 'const a = <div className="bg-popover text-muted-foreground" />;', errors: [unmapped("bg-popover"), unmapped("text-muted-foreground")] },
    { filename: gui("app.ts"), code: 'const a = clsx("dark:bg-popover/50", active && "data-[state=open]:text-muted-foreground!", { "hover:!border-missing": active });', errors: [unmapped("dark:bg-popover/50"), unmapped("data-[state=open]:text-muted-foreground!"), unmapped("hover:!border-missing")] },
    { filename: gui("app.ts"), code: 'const a = `text-ink ${active} [&:nth-child(2)]:bg-missing`;', errors: [unmapped("[&:nth-child(2)]:bg-missing")] },
  ],
});

stylesheetTester.run("no-unmapped-colour-class", rule as unknown as Rule.RuleModule, {
  valid: ['.edge { @apply bg-panel text-ink shadow-scrim/40; }'],
  invalid: [{ code: '.edge { @apply dark:bg-popover data-[state=open]:border-missing; }', errors: [unmapped("dark:bg-popover"), unmapped("data-[state=open]:border-missing")] }],
});

markupTester.run("no-unmapped-colour-class", rule as unknown as Rule.RuleModule, {
  valid: ['<div class="bg-panel text-ink"></div>'],
  invalid: [{ code: '<div class="bg-popover text-muted-foreground"></div>', errors: [unmapped("bg-popover"), unmapped("text-muted-foreground")] }],
});
